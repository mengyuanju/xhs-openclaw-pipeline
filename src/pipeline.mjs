import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

import { renderDeliveryImages } from './images.mjs';
import { createOpenClawClient } from './openclaw.mjs';
import { buildPostPrompt, parsePostOutput } from './post-contract.mjs';
import { evaluateDelivery } from './qc.mjs';

export function createMockPost() {
  return parsePostOutput(JSON.stringify({
    taskJudgement: {
      admitted: true,
      demandLevel: 'strong',
      primaryType: '教程',
      reason: '需要按使用频率和空间限制给出可执行整理步骤。',
    },
    platform: {
      target: '小红书',
      expressionType: '信息型',
      audience: '租房且桌面空间有限、容易反复变乱的人',
      openingMethod: '先指出反复变乱的根因，再给低成本整理顺序。',
      bodyStructure: '直接判断—清空分类—高频分区—低成本收纳—复位检查',
      iconDictionary: { '📌': '重点', '✅': '步骤', '⚠': '误区' },
      sampleEvidence: 'not_provided',
    },
    title: '租房桌面整理，先别急着买收纳盒',
    body: `桌面总是收完没两天又乱，问题通常不在“收纳盒不够”，而是常用和低频物品没有分开。低成本整理可以先不买东西，把桌面按使用动作重新安排一遍。\n\n📌 第一步：把桌面彻底清空。垃圾、空包装直接处理；需要放回别处的东西先装进一个临时袋，不要边整理边跑去其他房间。这样能看清真正可用的桌面面积。\n\n✅ 第二步：按使用频率分三组。每天会拿的纸笔、充电线放在伸手能到的位置；每周才用的工具进入抽屉；低频物品离开桌面。分组依据是动作，不是物品看起来是否同类。\n\n✅ 第三步：先利用已有容器。杯子可以收笔，干净纸盒可以分隔线材，小托盘负责承接钥匙和耳机。确定位置确实好用以后，再决定是否需要购买尺寸合适的收纳件。\n\n⚠ 常见翻车点是把桌面塞满盒子。盒子过多会占掉操作空间，也会让取放步骤变长。每件高频物品最好能用一个动作拿到、一个动作放回。\n\n✅ 最后设置一分钟复位：睡前丢掉垃圾、把物品放回固定位置，并只留下第二天要用的东西。连续几天仍然无处可放的物品，才是真正需要新增收纳的位置。`,
    tags: ['#桌面整理', '#租房生活', '#低成本收纳'],
    imagePlan: [
      {
        kind: 'hero',
        headline: '桌面整理先做减法',
        subtitle: '低成本也能保持清爽',
        bullets: ['先清空', '再分区', '最后复位'],
        prompt: '真实租房卧室书桌整理后的生活方式摄影，暖色自然光，木质桌面，纸笔和台灯摆放克制，主体居中并留出裁切空间，无人物，无文字，无Logo，无水印。',
      },
      {
        kind: 'steps',
        headline: '四步整理顺序',
        subtitle: '别从买收纳盒开始',
        bullets: ['清空桌面', '按使用频率分类', '给高频物品定位置', '设置一分钟复位'],
        prompt: '',
      },
      {
        kind: 'checklist',
        headline: '睡前一分钟复位',
        subtitle: '只检查这三件事',
        bullets: ['垃圾离桌', '物品归位', '预留明天用品'],
        prompt: '',
      },
    ],
    sources: [],
    expressionReferences: [],
    riskFlags: [],
    fabricatedExperience: false,
    unverifiedClaims: [],
  }));
}

function safeTaskOutputDir(outputRoot, task) {
  const root = resolve(outputRoot);
  const outputDir = resolve(root, String(task.id), `attempt-${task.attempts}`);
  const child = relative(root, outputDir);
  if (child.startsWith('..') || child === '') throw new Error('task output path escaped the output root');
  return outputDir;
}

async function writeAtomic(path, content) {
  const temporaryPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporaryPath, content, { encoding: 'utf8', flag: 'wx' });
  await rename(temporaryPath, path);
}

function toMarkdown(task, post) {
  return `# ${post.title}\n\n> Query：${task.query}\n\n${post.body}\n\n${post.tags.join(' ')}\n`;
}

async function hashFiles(outputDir, files) {
  const manifestFiles = [];
  for (const file of files) {
    const content = await readFile(join(outputDir, file));
    manifestFiles.push({
      file,
      bytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
    });
  }
  return manifestFiles;
}

export async function processNext({
  queue,
  workerId,
  outputRoot,
  mock = false,
  openclaw,
}) {
  const task = queue.claimNext({ workerId });
  if (!task) return { status: 'idle' };
  const outputDir = safeTaskOutputDir(outputRoot, task);

  try {
    await mkdir(outputDir, { recursive: true });
    const client = mock ? null : (openclaw ?? createOpenClawClient());
    let post;
    let textModel = null;
    if (mock) {
      post = createMockPost();
    } else {
      const generated = client.runText({ prompt: buildPostPrompt(task) });
      post = parsePostOutput(generated.rawText);
      textModel = generated.model;
    }

    const images = await renderDeliveryImages({
      post,
      outputDir,
      mock,
      openclaw: client,
    });
    await writeAtomic(join(outputDir, 'post.json'), `${JSON.stringify(post, null, 2)}\n`);
    await writeAtomic(join(outputDir, 'post.md'), toMarkdown(task, post));
    const qc = await evaluateDelivery({ post, images, outputDir, mode: mock ? 'mock' : 'live' });
    await writeAtomic(join(outputDir, 'qc.json'), `${JSON.stringify(qc, null, 2)}\n`);

    const deliveryFiles = [
      'post.json',
      'post.md',
      ...images.map((image) => image.file),
      'qc.json',
    ];
    const manifest = {
      schemaVersion: 1,
      taskId: task.id,
      attempt: task.attempts,
      query: task.query,
      mode: mock ? 'mock' : 'live',
      generatedAt: new Date().toISOString(),
      text: { provider: mock ? 'mock' : 'openclaw', model: textModel },
      images,
      qc: { overallScore: qc.overallScore, disposition: qc.disposition },
      files: await hashFiles(outputDir, deliveryFiles),
    };
    await writeAtomic(join(outputDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

    if (qc.disposition === 'blocked') {
      throw new Error('quality gate blocked the delivery; inspect qc.json and manifest.json');
    }

    queue.complete(task.id, { workerId, outputDir });
    return { status: 'completed', taskId: task.id, outputDir, qc };
  } catch (error) {
    const failed = queue.fail(task.id, { workerId, error });
    return { status: 'failed', taskId: task.id, error: failed.error };
  }
}
