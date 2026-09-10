import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  XIAOHONGSHU_SEARCH_DEFAULT_LIMIT,
  XiaohongshuSearchBlockedError,
  normalizeXiaohongshuLinks,
  rankXiaohongshuCandidatesByLikes,
  xiaohongshuSearchUrl,
} from '../xhs-query-search.mjs';

const NOTE_LINK_SELECTOR = [
  'section.note-item a[href*="/explore/"]',
  'section.note-item a[href*="/search_result/"]',
  'section.note-item a[href*="/discovery/item/"]',
  '[class~="note-item"] a[href*="/explore/"]',
  '[class~="note-item"] a[href*="/search_result/"]',
  '[class~="note-item"] a[href*="/discovery/item/"]',
].join(', ');
const STRUCTURED_NOTE_ID = /^[a-f0-9]{24}$/u;
const PROFILE_MARKER = '.xhs-query-search-profile-v1';
const PROFILE_MARKER_CONTENT = 'Dedicated Xiaohongshu query-search browser profile.\n';
const NAVIGATION_TIMEOUT_ERRORS = new WeakSet();
const CAPTCHA_SELECTORS = Object.freeze([
  'iframe[src*="captcha"]',
  '[class*="captcha"]',
  '[id*="captcha"]',
  '[class*="slide-verify"]',
]);
const LOGIN_SELECTORS = Object.freeze([
  'input[placeholder*="手机号"]',
  '[class*="login-container"]',
  '[class*="login-modal"]',
  '[role="dialog"] [class*="qrcode"]',
  '[class*="login"] [class*="qrcode"]',
]);

async function anyVisible(page, selectors) {
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible().catch(() => false)) return true;
  }
  return false;
}

async function pageBodyText(page) {
  return page.locator('body').innerText({ timeout: 2_000 }).catch(() => '');
}

async function blockReason(page) {
  const currentUrl = page.url().toLowerCase();
  if (/captcha|verify|security/u.test(currentUrl)) return 'CAPTCHA_REQUIRED';
  if (await anyVisible(page, CAPTCHA_SELECTORS)) return 'CAPTCHA_REQUIRED';
  const bodyText = await pageBodyText(page);
  if (/请完成(?:安全)?验证|拖动滑块|访问频繁|异常访问|操作频繁/u.test(bodyText)) {
    return 'CAPTCHA_REQUIRED';
  }
  if (/\/login(?:[/?#]|$)/u.test(currentUrl)
      || /登录后(?:查看|浏览).*搜索|请先登录/u.test(bodyText)
      || await anyVisible(page, LOGIN_SELECTORS)) {
    return 'LOGIN_REQUIRED';
  }
  return null;
}

async function isExplicitEmptyResult(page) {
  const bodyText = await pageBodyText(page);
  return /暂无(?:相关)?搜索结果|没有找到(?:相关)?(?:内容|结果)|未找到相关(?:内容|笔记)|换个关键词试试/u.test(bodyText);
}

export function xiaohongshuCandidatesFromState(rawFeeds) {
  if (!Array.isArray(rawFeeds)) return [];
  return rawFeeds.flatMap((feed) => {
    if (!feed || typeof feed !== 'object' || Array.isArray(feed)
        || feed.modelType !== 'note' || feed.hasNoteCard !== true
        || typeof feed.noteId !== 'string' || !STRUCTURED_NOTE_ID.test(feed.noteId)
        || typeof feed.xsecToken !== 'string' || !feed.xsecToken) return [];
    const url = new URL(`/explore/${feed.noteId}`, 'https://www.xiaohongshu.com');
    url.searchParams.set('xsec_token', feed.xsecToken);
    url.searchParams.set('xsec_source', 'pc_search');
    return [{ url: url.toString(), title: feed.title ?? null, likeCount: feed.likeCount ?? null }];
  });
}

async function extractCandidates(page) {
  const stateFeeds = await page.evaluate(() => {
    function unwrapRef(value) {
      let current = value;
      for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth += 1) {
        if (Object.hasOwn(current, 'value')) current = current.value;
        else if (Object.hasOwn(current, '_value')) current = current._value;
        else if (Object.hasOwn(current, '_rawValue')) current = current._rawValue;
        else break;
      }
      return current;
    }
    const state = unwrapRef(window.__INITIAL_STATE__);
    const search = unwrapRef(state?.search);
    const feeds = [search?.feeds, search?.items, search?.notes]
      .map(unwrapRef)
      .find((value) => Array.isArray(value) && value.length > 0) ?? [];
    return feeds.flatMap((rawFeed) => {
      const feed = unwrapRef(rawFeed);
      if (!feed || typeof feed !== 'object') return [];
      const noteId = feed?.id ?? feed?.noteId ?? feed?.note_id;
      const xsecToken = feed?.xsecToken ?? feed?.xsec_token;
      const noteCard = unwrapRef(feed?.noteCard ?? feed?.note_card);
      const interactInfo = unwrapRef(noteCard?.interactInfo ?? noteCard?.interact_info);
      return [{
        modelType: feed?.modelType ?? feed?.model_type ?? null,
        noteId,
        xsecToken,
        hasNoteCard: Boolean(noteCard && typeof noteCard === 'object'),
        title: noteCard?.displayTitle ?? noteCard?.display_title ?? feed?.title ?? null,
        likeCount: interactInfo?.likedCount ?? interactInfo?.liked_count ?? feed?.likeCount ?? null,
      }];
    });
  }).catch(() => []);
  const stateCandidates = xiaohongshuCandidatesFromState(stateFeeds);
  const domCandidates = await page.locator(NOTE_LINK_SELECTOR).evaluateAll((nodes) => nodes.map((node) => {
    const card = node.closest('section.note-item, [class~="note-item"]');
    const titleNode = node.querySelector('[class*="title"], [class*="desc"], img[alt]');
    const likeNode = card?.querySelector('[class~="like-wrapper"] [class~="count"], [class*="like-wrapper"] [class~="count"]');
    const title = node.getAttribute('title')
      || titleNode?.getAttribute?.('alt')
      || titleNode?.textContent
      || node.textContent;
    return { url: node.href, title: title?.trim() || null, likeCount: likeNode?.textContent?.trim() || null };
  }));
  return [...stateCandidates, ...domCandidates];
}

function assertExpectedSearchPage(page, expectedUrl) {
  let current;
  try {
    current = new URL(page.url());
  } catch {
    throw new Error('小红书搜索后的页面地址无效，未保存任何链接');
  }
  const expected = new URL(expectedUrl);
  const pathname = current.pathname.replace(/\/+$/u, '') || '/';
  if (current.origin !== expected.origin || pathname !== '/search_result'
      || current.searchParams.get('keyword') !== expected.searchParams.get('keyword')) {
    throw new Error('小红书页面已离开当前 Query 的搜索结果页，未保存任何链接');
  }
}

export async function searchXiaohongshuPage(page, query, {
  limit = XIAOHONGSHU_SEARCH_DEFAULT_LIMIT,
  navigationTimeoutMs = 45_000,
  settleMs = 15_000,
  scrolls = 3,
} = {}) {
  const expectedUrl = xiaohongshuSearchUrl(query);
  let response;
  try {
    response = await page.goto(expectedUrl, {
      waitUntil: 'commit',
      timeout: navigationTimeoutMs,
    });
  } catch (error) {
    if (error && typeof error === 'object' && error.name === 'TimeoutError') {
      NAVIGATION_TIMEOUT_ERRORS.add(error);
    }
    throw error;
  }
  if ([401, 403, 429].includes(response?.status?.())) {
    throw new XiaohongshuSearchBlockedError(
      response.status() === 401 ? 'LOGIN_REQUIRED' : 'CAPTCHA_REQUIRED',
    );
  }
  const candidates = [];
  for (let attempt = 0; attempt <= scrolls; attempt += 1) {
    await page.waitForTimeout(settleMs);
    const reason = await blockReason(page);
    if (reason) throw new XiaohongshuSearchBlockedError(reason);
    assertExpectedSearchPage(page, expectedUrl);
    if (await isExplicitEmptyResult(page)) return [];
    candidates.push(...await extractCandidates(page));
    const rankedCandidates = rankXiaohongshuCandidatesByLikes(candidates, {
      limit,
      requireAccessParameters: true,
    });
    const links = normalizeXiaohongshuLinks(rankedCandidates, { limit, requireAccessParameters: true });
    if (attempt === scrolls) {
      if (links.length > 0) return links;
      throw new Error('未识别到小红书搜索结果或明确的空结果页面，请检查页面结构');
    }
    await page.evaluate(() => window.scrollBy(0, Math.max(window.innerHeight, 900)));
  }
  throw new Error('小红书搜索没有得到可确认的页面状态');
}

export function waitForXiaohongshuBrowserClose(context) {
  return context.waitForEvent('close', { timeout: 0 });
}

export async function prepareXiaohongshuProfileDirectory(profileDir) {
  await mkdir(profileDir, { recursive: true });
  const entries = await readdir(profileDir);
  if (entries.includes(PROFILE_MARKER)) {
    const marker = await readFile(join(profileDir, PROFILE_MARKER), 'utf8').catch(() => '');
    if (marker === PROFILE_MARKER_CONTENT) return;
    throw new Error('小红书搜索登录目录的专用标记无效');
  }
  if (entries.length > 0) {
    throw new Error('小红书搜索登录目录不是空的专用目录；请勿使用日常浏览器 User Data');
  }
  await writeFile(
    join(profileDir, PROFILE_MARKER),
    PROFILE_MARKER_CONTENT,
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
}

export async function createXiaohongshuBrowser({
  profileDir,
  channel = 'msedge',
  headless = false,
  launchOptions = {},
  chromium: injectedChromium,
} = {}) {
  if (typeof profileDir !== 'string' || !profileDir.trim()) {
    throw new TypeError('profileDir is required');
  }
  if (!['msedge', 'chrome'].includes(channel)) {
    throw new TypeError('Xiaohongshu browser channel must be msedge or chrome');
  }
  if (headless !== false) throw new TypeError('Xiaohongshu search requires a visible browser');
  await prepareXiaohongshuProfileDirectory(profileDir);
  const chromium = injectedChromium ?? (await import('playwright-core')).chromium;
  let context = await chromium.launchPersistentContext(profileDir, {
    ...launchOptions,
    channel,
    headless: false,
    viewport: null,
  });
  let page = context.pages()[0] ?? await context.newPage();
  let fallbackBrowser = null;
  let fallbackAttempted = false;

  async function retryWithTransferredLoginState(query, options) {
    fallbackAttempted = true;
    const storageState = await context.storageState({ indexedDB: true });
    await context.close();
    let browser;
    try {
      browser = await chromium.launch({
        ...launchOptions,
        channel,
        headless: false,
      });
      const nextContext = await browser.newContext({
        storageState,
        viewport: null,
      });
      const nextPage = nextContext.pages()[0] ?? await nextContext.newPage();
      await nextPage.bringToFront();
      context = nextContext;
      fallbackBrowser = browser;
      page = nextPage;
    } catch (error) {
      await browser?.close().catch(() => {});
      throw error;
    }
    return searchXiaohongshuPage(page, query, options);
  }

  return {
    async openLogin() {
      page = page.isClosed() ? await context.newPage() : page;
      await page.goto('https://www.xiaohongshu.com/', {
        waitUntil: 'domcontentloaded',
        timeout: 45_000,
      });
      await page.bringToFront();
    },
    async search(query, options) {
      page = page.isClosed() ? await context.newPage() : page;
      await page.bringToFront();
      try {
        return await searchXiaohongshuPage(page, query, options);
      } catch (error) {
        if (fallbackAttempted || !NAVIGATION_TIMEOUT_ERRORS.has(error)) throw error;
        return retryWithTransferredLoginState(query, options);
      }
    },
    async waitForClose() {
      if (!fallbackBrowser) return waitForXiaohongshuBrowserClose(context);
      if (page.isClosed()) return undefined;
      return page.waitForEvent('close', { timeout: 0 });
    },
    async close() {
      if (fallbackBrowser) await fallbackBrowser.close();
      else await context.close();
    },
  };
}
