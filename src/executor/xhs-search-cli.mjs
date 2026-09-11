#!/usr/bin/env node
import { homedir, hostname } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createControlPlaneClient } from '../control-plane/client.mjs';
import { createXiaohongshuBrowser } from './xhs-browser.mjs';
import { runXhsQuerySearch } from './xhs-search-runner.mjs';

function integer(value, name, fallback, minimum, maximum) {
  const normalized = Number(value ?? fallback);
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new RangeError(`${name} must be an integer from ${minimum} to ${maximum}`);
  }
  return normalized;
}

function assertSecureMachineUrl(value) {
  const url = new URL(value);
  const serverHost = url.hostname.toLowerCase();
  const loopback = serverHost === 'localhost' || serverHost === '[::1]' || serverHost === '::1'
    || /^127(?:\.\d{1,3}){3}$/u.test(serverHost);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('小红书搜索执行机连接非本机中心服务时必须使用 HTTPS');
  }
}

export function xhsSearchConfig(environment = process.env, args = process.argv.slice(2), cwd = process.cwd()) {
  const hasFlag = (name) => args.includes(`--${name}`);
  const option = (name) => args.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  const login = hasFlag('login');
  if (hasFlag('retry-failed')) {
    throw new Error('请使用 --retry-task-id=<任务ID> 或 --retry-job-id=<搜索任务ID> 精确重试');
  }
  const retryJobIdValue = option('retry-job-id');
  const retryTaskIdValue = option('retry-task-id');
  if (retryJobIdValue !== undefined && retryTaskIdValue !== undefined) {
    throw new Error('--retry-job-id and --retry-task-id cannot be used together');
  }
  const retryFailedRequest = retryJobIdValue !== undefined
    ? { jobId: integer(retryJobIdValue, 'retry job ID', undefined, 1, Number.MAX_SAFE_INTEGER) }
    : retryTaskIdValue !== undefined
      ? { taskId: integer(retryTaskIdValue, 'retry task ID', undefined, 1, Number.MAX_SAFE_INTEGER) }
      : null;
  const configuredNodeId = option('node-id') ?? environment.XHS_SEARCH_NODE_ID?.trim();
  const hostSegment = hostname().toLowerCase().replace(/[^a-z0-9._:-]+/gu, '-').replace(/^-+|-+$/gu, '') || 'local';
  const baseNodeId = configuredNodeId
    || `${(environment.EXECUTOR_NODE_ID?.trim() || hostSegment).slice(0, 89)}-xhs-search`;
  const configuredProfileDir = option('profile-dir') ?? environment.XHS_SEARCH_PROFILE_DIR?.trim();
  if (configuredProfileDir && !isAbsolute(configuredProfileDir)) {
    throw new Error('XHS_SEARCH_PROFILE_DIR must be an absolute path outside the repository');
  }
  const profileDir = resolve(configuredProfileDir
    || join(environment.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'xhs-query-search', 'edge-profile'));
  const workspaceRoot = resolve(cwd);
  const profileRelation = relative(workspaceRoot, profileDir);
  if (!profileRelation || (!profileRelation.startsWith('..') && !isAbsolute(profileRelation))) {
    throw new Error('XHS_SEARCH_PROFILE_DIR must be outside the repository because it contains login state');
  }
  if (!/^[a-zA-Z0-9._:-]{1,100}$/u.test(baseNodeId)) {
    throw new TypeError('XHS_SEARCH_NODE_ID must be a valid executor node identifier');
  }
  if (configuredNodeId && configuredNodeId === environment.EXECUTOR_NODE_ID?.trim()) {
    throw new TypeError('XHS_SEARCH_NODE_ID must not reuse the ordinary executor node identifier');
  }
  const channel = option('browser') || environment.XHS_SEARCH_BROWSER_CHANNEL?.trim() || 'msedge';
  if (!['msedge', 'chrome'].includes(channel)) {
    throw new TypeError('XHS_SEARCH_BROWSER_CHANNEL must be msedge or chrome');
  }
  const accountLabel = (option('account-label') ?? environment.XHS_SEARCH_ACCOUNT_LABEL)?.trim() || null;
  if (accountLabel && [...accountLabel].length > 100) {
    throw new RangeError('XHS_SEARCH_ACCOUNT_LABEL cannot exceed 100 characters');
  }
  const hostKind = (option('host-kind') || environment.XHS_SEARCH_HOST_KIND?.trim() || 'EXECUTOR').toUpperCase();
  if (!['CENTER', 'EXECUTOR'].includes(hostKind)) {
    throw new TypeError('XHS_SEARCH_HOST_KIND must be CENTER or EXECUTOR');
  }
  const serverUrl = option('server-url') || environment.CONTROL_PLANE_URL?.trim();
  if (!login && !serverUrl) throw new Error('CONTROL_PLANE_URL or --server-url is required');
  if (!login) assertSecureMachineUrl(serverUrl);
  const machineToken = environment.XHS_SEARCH_MACHINE_TOKEN?.trim();
  if (!login && (!machineToken || machineToken.length < 32 || machineToken.length > 512)) {
    throw new Error('XHS_SEARCH_MACHINE_TOKEN must contain between 32 and 512 characters');
  }
  return {
    login,
    resume: hasFlag('resume'),
    retryFailedRequest,
    once: hasFlag('once'),
    serverUrl,
    machineToken: machineToken || null,
    nodeId: baseNodeId,
    nodeName: option('node-name') || environment.XHS_SEARCH_NODE_NAME?.trim() || '小红书 Query 搜索执行机',
    accountLabel,
    hostKind,
    profileDir,
    channel,
    pollMs: integer(option('poll-ms') || environment.XHS_SEARCH_POLL_MS?.trim(), 'XHS_SEARCH_POLL_MS', 8_000, 3_000, 60_000),
  };
}

export async function main() {
  const config = xhsSearchConfig();
  const browser = await createXiaohongshuBrowser({
    profileDir: config.profileDir,
    channel: config.channel,
  });
  const controller = new AbortController();
  const stop = () => {
    controller.abort();
    void browser.close().catch(() => {});
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    if (config.login) {
      await browser.openLogin();
      console.log('请在打开的浏览器中完成人工登录；确认登录成功后关闭浏览器窗口。登录状态只保存在仓库外的专用目录。');
      await browser.waitForClose();
      return;
    }
    const controlPlane = createControlPlaneClient({
      baseUrl: config.serverUrl,
      headers: { 'X-XHS-Search-Token': config.machineToken },
    });
    const health = await controlPlane.health();
    if (Number(health?.capabilities?.xiaohongshuQuerySearchVersion) < 3) {
      throw new Error('请先升级中心服务：小红书 Query 搜索条数现由管理员统一配置');
    }
    if (config.resume) {
      const resumed = await controlPlane.resumeXhsQuerySearch({
        nodeId: config.nodeId,
        nodeName: config.nodeName,
        ...(config.accountLabel ? { accountLabel: config.accountLabel } : {}),
        hostKind: config.hostKind,
      });
      console.log(`已恢复 ${resumed.resumedCount} 条等待人工处理的小红书搜索任务。`);
    }
    if (config.retryFailedRequest) {
      const retried = await controlPlane.retryFailedXhsQuerySearch(config.retryFailedRequest);
      console.log(`已将 ${retried.retriedCount} 条搜索失败任务放回待处理队列。`);
    }
    const outcome = await runXhsQuerySearch({
      controlPlane,
      browser,
      nodeId: config.nodeId,
      nodeName: config.nodeName,
      accountLabel: config.accountLabel,
      hostKind: config.hostKind,
      pollMs: config.pollMs,
      once: config.once,
      signal: controller.signal,
      onOutcome(result) {
        if (result.status === 'SUCCEEDED') {
          console.log(`Query 搜索任务 ${result.claim.id} 已保存 ${result.job.resultCount} 条小红书链接。`);
        } else if (result.status === 'FAILED') {
          console.error(`Query 搜索任务 ${result.claim.id} 搜索失败，已停止自动重试。`);
        }
      },
    });
    if (outcome.status === 'BLOCKED') {
      console.error(outcome.reason === 'CAPTCHA_REQUIRED'
        ? '检测到小红书安全验证，已停止领取后续 Query。请人工处理后关闭浏览器，再使用 --resume 重启。'
        : '小红书登录状态已失效，已停止领取后续 Query。请人工登录后关闭浏览器，再使用 --resume 重启。');
      await browser.waitForClose();
    }
  } finally {
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    await browser.close().catch(() => {});
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
