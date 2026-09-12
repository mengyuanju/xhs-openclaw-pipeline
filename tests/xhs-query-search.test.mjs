import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  XiaohongshuSearchBlockedError,
  normalizeXiaohongshuLinks,
  normalizeXiaohongshuSearchSettings,
  parseXiaohongshuLikeCount,
  rankXiaohongshuCandidatesByLikes,
  xiaohongshuSearchRateCapacity,
  xiaohongshuSearchExecutionOptions,
  xiaohongshuSearchUrl,
} from '../src/xhs-query-search.mjs';
import { executeXhsQuerySearchOnce } from '../src/executor/xhs-search-runner.mjs';
import {
  createXiaohongshuBrowser,
  prepareXiaohongshuProfileDirectory,
  searchXiaohongshuPage,
  waitForXiaohongshuBrowserClose,
  xiaohongshuCandidatesFromState,
} from '../src/executor/xhs-browser.mjs';
import { xhsSearchConfig } from '../src/executor/xhs-search-cli.mjs';

test('Xiaohongshu search URLs and note links are bounded, same-origin and deduplicated', () => {
  const search = new URL(xiaohongshuSearchUrl('  桌面   收纳  '));
  assert.equal(search.origin, 'https://www.xiaohongshu.com');
  assert.equal(search.searchParams.get('keyword'), '桌面 收纳');
  const links = normalizeXiaohongshuLinks([
    { url: 'https://www.xiaohongshu.com/explore/66f000000000000000000000', title: ' 第一条 ' },
    { url: '/explore/66f000000000000000000000?xsec_token=ABc9-safe_token%3D&xsec_source=pc_search&utm_source=drop', title: null },
    { url: 'https://evil.example/explore/77f000000000000000000000', title: '外站' },
    { url: 'javascript:alert(1)' },
    { url: '/discovery/item/77f000000000000000000000#fragment', title: '' },
  ]);
  assert.deepEqual(links, [
    {
      noteId: '66f000000000000000000000',
      url: 'https://www.xiaohongshu.com/explore/66f000000000000000000000?xsec_token=ABc9-safe_token%3D&xsec_source=pc_search',
      title: '第一条',
      rank: 1,
    },
    {
      noteId: '77f000000000000000000000',
      url: 'https://www.xiaohongshu.com/discovery/item/77f000000000000000000000',
      title: null,
      rank: 2,
    },
  ]);
});

test('Xiaohongshu candidates are ranked by localized like counts with stable ties', () => {
  assert.equal(parseXiaohongshuLikeCount('1.2万'), 12_000);
  assert.equal(parseXiaohongshuLikeCount('3千+'), 3_000);
  assert.equal(parseXiaohongshuLikeCount('赞'), 0);
  assert.equal(parseXiaohongshuLikeCount('1.2'), null);
  assert.equal(parseXiaohongshuLikeCount('未知'), null);
  const candidates = [
    { url: '/explore/a0000001', likeCount: '999' },
    { url: '/explore/a0000002', likeCount: '1.2万' },
    { url: '/explore/a0000003', likeCount: '3千+' },
    { url: '/explore/a0000004', likeCount: '1.2w' },
    { url: '/explore/a0000005', likeCount: '未知' },
  ];
  assert.deepEqual(
    rankXiaohongshuCandidatesByLikes(candidates).map((item) => new URL(item.url).pathname),
    ['/explore/a0000002', '/explore/a0000004', '/explore/a0000003', '/explore/a0000001'],
  );
});

test('Xiaohongshu settings default to fastest and allow administrators to choose the search strategy', () => {
  const defaultPacing = {
    minimumIntervalSeconds: 60,
    hourlyLimit: 30,
    dailyLimit: 150,
  };
  assert.deepEqual(normalizeXiaohongshuSearchSettings(), {
    resultLimit: 3,
    searchMode: 'FASTEST',
    ...defaultPacing,
  });
  assert.deepEqual(normalizeXiaohongshuSearchSettings({ resultLimit: 1 }), {
    resultLimit: 1,
    searchMode: 'FASTEST',
    ...defaultPacing,
  });
  assert.deepEqual(normalizeXiaohongshuSearchSettings({ resultLimit: 10, searchMode: 'THOROUGH' }), {
    resultLimit: 10,
    searchMode: 'THOROUGH',
    ...defaultPacing,
  });
  assert.deepEqual(xiaohongshuSearchExecutionOptions({ resultLimit: 10, searchMode: 'FASTEST' }), {
    limit: 1,
    scrolls: 0,
    settleMs: 3_000,
    navigationTimeoutMs: 10_000,
  });
  assert.deepEqual(xiaohongshuSearchExecutionOptions({ resultLimit: 5, searchMode: 'THOROUGH' }), {
    limit: 5,
  });
  for (const value of [0, 11, 1.5, '5', null]) {
    assert.throws(() => normalizeXiaohongshuSearchSettings({ resultLimit: value }), /resultLimit/u);
  }
  for (const searchMode of ['', 'QUICK', null, 1]) {
    assert.throws(
      () => normalizeXiaohongshuSearchSettings({ resultLimit: 3, searchMode }),
      /searchMode/u,
    );
  }
  assert.throws(() => normalizeXiaohongshuSearchSettings([]), /must be an object/u);
  assert.throws(
    () => normalizeXiaohongshuSearchSettings({ resultLimit: 3, unexpected: true }),
    /unsupported fields/u,
  );
});

test('Xiaohongshu pacing limits are administrator-controlled but cannot exceed mathematical capacity', () => {
  assert.deepEqual(xiaohongshuSearchRateCapacity(30, 80), {
    maximumPerHour: 120,
    maximumPerDay: 1920,
  });
  assert.deepEqual(normalizeXiaohongshuSearchSettings({
    minimumIntervalSeconds: 30,
    hourlyLimit: 120,
    dailyLimit: 2000,
  }), {
    resultLimit: 3,
    searchMode: 'FASTEST',
    minimumIntervalSeconds: 30,
    hourlyLimit: 120,
    dailyLimit: 2000,
  });
  assert.throws(
    () => normalizeXiaohongshuSearchSettings({
      minimumIntervalSeconds: 30,
      hourlyLimit: 200,
      dailyLimit: 150,
    }),
    /hourlyLimit cannot exceed 120/u,
  );
  assert.throws(
    () => normalizeXiaohongshuSearchSettings({
      minimumIntervalSeconds: 60,
      hourlyLimit: 2,
      dailyLimit: 49,
    }),
    /dailyLimit cannot exceed 48/u,
  );
  for (const settings of [
    { minimumIntervalSeconds: 9 },
    { minimumIntervalSeconds: 3601 },
    { minimumIntervalSeconds: '30' },
    { hourlyLimit: 0 },
    { hourlyLimit: '30' },
    { dailyLimit: 0 },
    { dailyLimit: '150' },
  ]) {
    assert.throws(() => normalizeXiaohongshuSearchSettings(settings), /Interval|Limit/u);
  }
});

test('search runner saves browser results without adding them to any model request', async () => {
  const calls = [];
  const claim = {
    id: 12,
    queryPackageItemId: 91,
    query: '桌面收纳',
    status: 'RUNNING',
    attempt: 1,
    resultLimit: 5,
    searchMode: 'FASTEST',
    nodeId: 'search-node',
    leaseToken: '11111111-1111-4111-8111-111111111111',
  };
  const controlPlane = {
    claimXhsQuerySearch: async (input) => { calls.push(['claim', input]); return claim; },
    completeXhsQuerySearch: async (id, input) => {
      calls.push(['complete', id, input]);
      return { status: 'SUCCEEDED', resultCount: input.links.length };
    },
  };
  const browser = { search: async (query, options) => {
    calls.push(['browser', query, options]);
    return [{
      noteId: '66f000000000000000000000',
      url: 'https://www.xiaohongshu.com/explore/66f000000000000000000000?xsec_token=token%3D&xsec_source=pc_search',
      title: null,
      rank: 1,
    }];
  } };
  const outcome = await executeXhsQuerySearchOnce({
    controlPlane,
    browser,
    nodeId: 'search-node',
    nodeName: '中心搜索节点',
    accountLabel: '品牌主账号',
    hostKind: 'CENTER',
  });
  assert.equal(outcome.status, 'SUCCEEDED');
  assert.deepEqual(calls[0], ['claim', {
    nodeId: 'search-node',
    nodeName: '中心搜索节点',
    accountLabel: '品牌主账号',
    hostKind: 'CENTER',
    protocolVersion: XIAOHONGSHU_SEARCH_PROTOCOL_VERSION,
  }]);
  assert.deepEqual(calls[1], ['browser', '桌面收纳', {
    limit: 1,
    scrolls: 0,
    settleMs: 3_000,
    navigationTimeoutMs: 10_000,
  }]);
  assert.equal(calls[2][0], 'complete');
  assert.deepEqual(Object.keys(calls[2][2]).sort(), ['leaseToken', 'links']);
  assert.equal(
    new URL(calls[2][2].links[0].url).searchParams.get('xsec_token'),
    'token=',
  );
});

test('login and captcha gates block the queue and never report a generic failure', async () => {
  for (const reason of ['LOGIN_REQUIRED', 'CAPTCHA_REQUIRED']) {
    const reports = [];
    const claim = {
      id: 12,
      query: '桌面收纳',
      leaseToken: 'lease',
      resultLimit: 3,
      searchMode: 'THOROUGH',
    };
    const outcome = await executeXhsQuerySearchOnce({
      nodeId: 'search-node',
      browser: { search: async () => { throw new XiaohongshuSearchBlockedError(reason); } },
      controlPlane: {
        claimXhsQuerySearch: async () => claim,
        blockXhsQuerySearch: async (id, input) => {
          reports.push(['block', id, input]);
          return { status: 'BLOCKED', blockedReason: reason };
        },
        failXhsQuerySearch: async () => assert.fail('gate was reported as a generic failure'),
        completeXhsQuerySearch: async () => assert.fail('blocked search was completed'),
      },
    });
    assert.equal(outcome.status, 'BLOCKED');
    assert.equal(outcome.reason, reason);
    assert.deepEqual(reports, [['block', 12, { leaseToken: 'lease', reason }]]);
  }
});

test('browser profile configuration rejects repository-local login state', () => {
  const workspace = 'C:\\workspace\\xhs-pipeline';
  assert.throws(() => xhsSearchConfig({ CONTROL_PLANE_URL: 'http://127.0.0.1:4310' }, [
    '--profile-dir=C:\\workspace\\xhs-pipeline\\browser-profile',
  ], workspace), /outside the repository/u);
  const config = xhsSearchConfig({
    CONTROL_PLANE_URL: 'http://127.0.0.1:4310',
    LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
    XHS_SEARCH_MACHINE_TOKEN: 'test-only-machine-token-32-characters',
    XHS_SEARCH_ACCOUNT_LABEL: '品牌主账号',
    XHS_SEARCH_HOST_KIND: 'CENTER',
  }, ['--once', '--retry-task-id=42'], workspace);
  assert.equal(config.once, true);
  assert.deepEqual(config.retryFailedRequest, { taskId: 42 });
  assert.equal(Object.hasOwn(config, 'resultLimit'), false);
  assert.equal(config.accountLabel, '品牌主账号');
  assert.equal(config.hostKind, 'CENTER');
  assert.equal(config.profileDir, join('C:\\Users\\worker\\AppData\\Local', 'xhs-query-search', 'edge-profile'));
  const legacyOverride = xhsSearchConfig({
    CONTROL_PLANE_URL: 'http://127.0.0.1:4310',
    LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
    XHS_SEARCH_MACHINE_TOKEN: 'test-only-machine-token-32-characters',
    XHS_SEARCH_RESULT_LIMIT: '10',
  }, ['--once', '--result-limit=1'], workspace);
  assert.equal(Object.hasOwn(legacyOverride, 'resultLimit'), false);
  assert.throws(() => xhsSearchConfig({
    CONTROL_PLANE_URL: 'http://192.168.1.10:4310',
    LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
    XHS_SEARCH_MACHINE_TOKEN: 'test-only-machine-token-32-characters',
  }, ['--once'], workspace), /必须使用 HTTPS/u);
  assert.throws(() => xhsSearchConfig({
    CONTROL_PLANE_URL: 'http://127.0.0.1:4310',
    LOCALAPPDATA: 'C:\\Users\\worker\\AppData\\Local',
    XHS_SEARCH_MACHINE_TOKEN: 'test-only-machine-token-32-characters',
    XHS_SEARCH_HOST_KIND: 'UNKNOWN',
  }, ['--once'], workspace), /CENTER or EXECUTOR/u);
});

function fakeSearchPage({
  bodyText = '', candidates = [], candidateBatches = null, stateFeeds = [], stateFeedBatches = null,
  visible = [], finalUrl = null, waits = null, navigations = null, responseStatus = 200,
} = {}) {
  const visibleSelectors = new Set(visible);
  let currentUrl = 'about:blank';
  let extractionAttempt = -1;
  return {
    url: () => currentUrl,
    goto: async (target, options) => {
      navigations?.push({ target, options });
      currentUrl = finalUrl || target;
      return { status: () => responseStatus };
    },
    waitForTimeout: async (milliseconds) => { waits?.push(milliseconds); },
    evaluate: async (callback) => {
      if (!String(callback).includes('__INITIAL_STATE__')) return undefined;
      extractionAttempt += 1;
      return stateFeedBatches?.[Math.min(extractionAttempt, stateFeedBatches.length - 1)] ?? stateFeeds;
    },
    locator(selector) {
      if (selector === 'body') return { innerText: async () => bodyText };
      if (selector.includes('a[href*=')) return { evaluateAll: async () => (
        candidateBatches?.[Math.min(Math.max(extractionAttempt, 0), candidateBatches.length - 1)] ?? candidates
      ) };
      return { first: () => ({ isVisible: async () => visibleSelectors.has(selector) }) };
    },
  };
}

function stateFeed(noteId, xsecToken, title, likeCount, modelType = 'note') {
  return { modelType, noteId, xsecToken, hasNoteCard: true, title, likeCount };
}

function timeoutError(message = 'navigation timed out') {
  const error = new Error(message);
  error.name = 'TimeoutError';
  return error;
}

function interactivePage(page, { onBringToFront } = {}) {
  return Object.assign(page, {
    isClosed: () => false,
    bringToFront: async () => { onBringToFront?.(); },
  });
}

test('visible login gates win over links rendered behind the modal', async () => {
  const page = fakeSearchPage({
    bodyText: '登录后查看搜索结果',
    candidates: [{ url: '/search_result/66f000000000000000000000', title: '遮罩后的推荐' }],
  });
  await assert.rejects(
    searchXiaohongshuPage(page, '桌面收纳', { scrolls: 0, settleMs: 0 }),
    (error) => error instanceof XiaohongshuSearchBlockedError && error.code === 'LOGIN_REQUIRED',
  );
});

test('only an explicit empty state can complete a search with zero links', async () => {
  await assert.rejects(
    searchXiaohongshuPage(fakeSearchPage(), '桌面收纳', { scrolls: 0, settleMs: 0 }),
    /未识别到小红书搜索结果/u,
  );
  assert.deepEqual(await searchXiaohongshuPage(
    fakeSearchPage({ bodyText: '没有找到相关内容，换个关键词试试' }),
    '桌面收纳',
    { scrolls: 0, settleMs: 0 },
  ), []);
});

test('search pages wait fifteen seconds for results by default', async () => {
  const waits = [];
  const links = await searchXiaohongshuPage(fakeSearchPage({
    waits,
    candidates: [{
      url: '/explore/66f000000000000000000000?xsec_token=token%3D&xsec_source=pc_search',
      title: '加载完成',
      likeCount: '1.2万',
    }],
  }), '桌面收纳', { scrolls: 0 });
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0].url).searchParams.get('xsec_token'), 'token=');
  assert.equal(new URL(links[0].url).searchParams.get('xsec_source'), 'pc_search');
  assert.deepEqual(waits, [15_000]);
});

test('search navigation waits only for the response commit and still checks its status', async () => {
  const navigations = [];
  const page = fakeSearchPage({ navigations, responseStatus: 429 });
  await assert.rejects(
    searchXiaohongshuPage(page, '桌面收纳', {
      navigationTimeoutMs: 12_345,
      scrolls: 0,
      settleMs: 0,
    }),
    (error) => error instanceof XiaohongshuSearchBlockedError && error.code === 'CAPTCHA_REQUIRED',
  );
  assert.deepEqual(navigations, [{
    target: xiaohongshuSearchUrl('桌面收纳'),
    options: { waitUntil: 'commit', timeout: 12_345 },
  }]);
});

test('structured search state supplies signed URLs when rendered card anchors are bare', async () => {
  const links = await searchXiaohongshuPage(fakeSearchPage({
    stateFeeds: [stateFeed('66f000000000000000000000', 'state_token=', '结构化结果', null)],
    candidates: [{
      url: '/explore/66f000000000000000000000',
      title: '裸链接卡片',
      likeCount: '2万',
    }],
  }), '桌面收纳', { scrolls: 0, settleMs: 0 });
  assert.equal(links.length, 1);
  assert.equal(new URL(links[0].url).searchParams.get('xsec_token'), 'state_token=');
  assert.equal(links[0].title, '结构化结果');
});

test('search keeps only the three most-liked signed results', async () => {
  const result = await searchXiaohongshuPage(fakeSearchPage({
    stateFeeds: [
      stateFeed('66f000000000000000000001', 'one=', '一', '999'),
      stateFeed('66f000000000000000000002', 'two=', '二', '3万'),
      stateFeed('66f000000000000000000003', 'three=', '三', '1.2万'),
      stateFeed('66f000000000000000000004', 'four=', '四', '2千'),
    ],
  }), '桌面收纳', { scrolls: 0, settleMs: 0 });
  assert.deepEqual(result.map((link) => [link.title, link.rank]), [
    ['二', 1],
    ['三', 2],
    ['四', 3],
  ]);
});

test('search honors an administrator result limit above the default', async () => {
  const stateFeeds = Array.from({ length: 7 }, (_, index) => stateFeed(
    `66f0000000000000000000${String(index + 1).padStart(2, '0')}`,
    `token-${index}=`,
    `结果 ${index + 1}`,
    String((index + 1) * 100),
  ));
  const result = await searchXiaohongshuPage(fakeSearchPage({ stateFeeds }), '桌面收纳', {
    limit: 5,
    scrolls: 0,
    settleMs: 0,
  });
  assert.deepEqual(result.map((link) => link.title), [
    '结果 7', '结果 6', '结果 5', '结果 4', '结果 3',
  ]);
});

test('later scroll results can displace lower-liked first-page candidates', async () => {
  const result = await searchXiaohongshuPage(fakeSearchPage({
    stateFeedBatches: [
      [
        stateFeed('66f000000000000000000001', 'one=', '一', '100'),
        stateFeed('66f000000000000000000002', 'two=', '二', '200'),
        stateFeed('66f000000000000000000003', 'three=', '三', '300'),
      ],
      [stateFeed('66f000000000000000000004', 'four=', '四', '1万')],
    ],
  }), '桌面收纳', { scrolls: 1, settleMs: 0 });
  assert.deepEqual(result.map((link) => link.title), ['四', '三', '二']);
});

test('structured state rejects non-note entries before URL construction', () => {
  assert.deepEqual(xiaohongshuCandidatesFromState([
    stateFeed('66f000000000000000000001', 'valid=', '有效笔记', '1万'),
    stateFeed('not-a-note-id', 'hot=', '热搜词', '9万', 'hot_query'),
    { ...stateFeed('66f000000000000000000002', 'missing-card=', '无卡片', '8万'), hasNoteCard: false },
  ]).map((candidate) => candidate.title), ['有效笔记']);
});

test('bare or unranked search cards fail instead of storing unusable links', async () => {
  await assert.rejects(searchXiaohongshuPage(fakeSearchPage({
    candidates: [{ url: '/explore/66f000000000000000000000', title: '裸链接', likeCount: '2万' }],
  }), '桌面收纳', { scrolls: 0, settleMs: 0 }), /未识别到小红书搜索结果/u);
  await assert.rejects(searchXiaohongshuPage(fakeSearchPage({
    candidates: [{
      url: '/explore/66f000000000000000000000?xsec_token=token%3D&xsec_source=pc_search',
      title: '无点赞量',
    }],
  }), '桌面收纳', { scrolls: 0, settleMs: 0 }), /未识别到小红书搜索结果/u);
});

test('manual login waits until the operator closes the browser without a timeout', async () => {
  const calls = [];
  const expected = { closed: true };
  const result = await waitForXiaohongshuBrowserClose({
    waitForEvent: async (...args) => { calls.push(args); return expected; },
  });
  assert.equal(result, expected);
  assert.deepEqual(calls, [['close', { timeout: 0 }]]);
});

test('search navigation timeout transfers login state once to a visible ordinary browser', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-search-fallback-'));
  const profileDir = join(root, 'dedicated');
  const calls = [];
  const storageState = {
    cookies: [{ name: 'test-cookie', value: 'not-a-real-secret', domain: '.xiaohongshu.com', path: '/' }],
    origins: [],
  };
  const persistentPage = interactivePage({
    goto: async () => {
      calls.push('persistent-goto');
      throw timeoutError();
    },
  }, { onBringToFront: () => calls.push('persistent-front') });
  let fallbackShouldTimeout = false;
  let fallbackShowsLogin = false;
  const fallbackPage = interactivePage(fakeSearchPage({
    stateFeeds: [stateFeed('66f000000000000000000001', 'fallback=', '回退结果', '1.2万')],
  }), { onBringToFront: () => calls.push('fallback-front') });
  const fallbackLocator = fallbackPage.locator.bind(fallbackPage);
  fallbackPage.locator = (selector) => {
    if (selector === 'body' && fallbackShowsLogin) return { innerText: async () => '请先登录' };
    return fallbackLocator(selector);
  };
  fallbackPage.waitForEvent = async (...args) => {
    calls.push(['fallback-page-wait', ...args]);
    return 'fallback-page-closed';
  };
  const fallbackGoto = fallbackPage.goto;
  fallbackPage.goto = async (...args) => {
    calls.push('fallback-goto');
    if (fallbackShouldTimeout) throw timeoutError('fallback navigation timed out');
    return fallbackGoto(...args);
  };
  const persistentContext = {
    pages: () => [persistentPage],
    storageState: async (options) => { calls.push(['storage-state', options]); return storageState; },
    close: async () => { calls.push('persistent-close'); },
    waitForEvent: async () => 'persistent-closed',
  };
  const fallbackContext = {
    pages: () => [],
    newPage: async () => { calls.push('fallback-new-page'); return fallbackPage; },
  };
  const fallbackBrowser = {
    newContext: async (options) => {
      calls.push(['fallback-new-context', options]);
      return fallbackContext;
    },
    close: async () => { calls.push('fallback-browser-close'); },
  };
  let ordinaryLaunches = 0;
  const chromium = {
    launchPersistentContext: async (actualProfileDir, options) => {
      calls.push(['persistent-launch', actualProfileDir, options]);
      return persistentContext;
    },
    launch: async (options) => {
      ordinaryLaunches += 1;
      calls.push(['fallback-launch', options]);
      return fallbackBrowser;
    },
  };
  let browser;
  try {
    browser = await createXiaohongshuBrowser({ profileDir, chromium });
    const links = await browser.search('桌面收纳', { scrolls: 0, settleMs: 0 });
    assert.equal(links.length, 1);
    assert.equal(links[0].title, '回退结果');
    assert.equal(ordinaryLaunches, 1);
    const storageStateCallIndex = calls.findIndex((call) => Array.isArray(call) && call[0] === 'storage-state');
    assert.ok(storageStateCallIndex < calls.indexOf('persistent-close'));
    assert.deepEqual(calls[storageStateCallIndex], ['storage-state', { indexedDB: true }]);
    assert.ok(calls.indexOf('persistent-close') < calls.findIndex((call) => Array.isArray(call) && call[0] === 'fallback-launch'));
    const newContextCall = calls.find((call) => Array.isArray(call) && call[0] === 'fallback-new-context');
    assert.equal(newContextCall[1].storageState, storageState);
    assert.equal(newContextCall[1].viewport, null);
    const launchCall = calls.find((call) => Array.isArray(call) && call[0] === 'fallback-launch');
    assert.equal(launchCall[1].channel, 'msedge');
    assert.equal(launchCall[1].headless, false);
    assert.equal(await browser.waitForClose(), 'fallback-page-closed');
    assert.ok(calls.some((call) => Array.isArray(call)
      && call[0] === 'fallback-page-wait' && call[1] === 'close' && call[2]?.timeout === 0));

    fallbackShowsLogin = true;
    await assert.rejects(
      browser.search('桌面收纳', { scrolls: 0, settleMs: 0 }),
      (error) => error instanceof XiaohongshuSearchBlockedError && error.code === 'LOGIN_REQUIRED',
    );
    assert.equal(calls.filter((call) => call === 'fallback-browser-close').length, 0);
    fallbackShowsLogin = false;

    fallbackShouldTimeout = true;
    await assert.rejects(
      browser.search('桌面收纳', { scrolls: 0, settleMs: 0 }),
      (error) => error?.name === 'TimeoutError',
    );
    assert.equal(ordinaryLaunches, 1);
    await browser.close();
    browser = null;
    assert.equal(calls.filter((call) => call === 'fallback-browser-close').length, 1);
  } finally {
    await browser?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('a timeout after navigation does not trigger login-state transfer', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-search-no-fallback-'));
  const profileDir = join(root, 'dedicated');
  const page = interactivePage(fakeSearchPage());
  page.waitForTimeout = async () => { throw timeoutError('settling timed out'); };
  let storageStateCalls = 0;
  let ordinaryLaunches = 0;
  const persistentContext = {
    pages: () => [page],
    storageState: async () => { storageStateCalls += 1; return { cookies: [], origins: [] }; },
    close: async () => {},
  };
  const chromium = {
    launchPersistentContext: async () => persistentContext,
    launch: async () => { ordinaryLaunches += 1; throw new Error('must not launch fallback'); },
  };
  let browser;
  try {
    browser = await createXiaohongshuBrowser({ profileDir, chromium });
    await assert.rejects(
      browser.search('桌面收纳', { scrolls: 0, settleMs: 0 }),
      (error) => error?.name === 'TimeoutError' && error.message === 'settling timed out',
    );
    assert.equal(storageStateCalls, 0);
    assert.equal(ordinaryLaunches, 0);
  } finally {
    await browser?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('manual login keeps using the persistent profile context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-search-login-profile-'));
  const profileDir = join(root, 'dedicated');
  const calls = [];
  const page = interactivePage({
    goto: async (url, options) => { calls.push(['goto', url, options]); },
  });
  const persistentContext = {
    pages: () => [page],
    close: async () => { calls.push('persistent-close'); },
    waitForEvent: async (...args) => { calls.push(['wait', ...args]); return 'closed'; },
  };
  let ordinaryLaunches = 0;
  const chromium = {
    launchPersistentContext: async () => persistentContext,
    launch: async () => { ordinaryLaunches += 1; throw new Error('must not launch fallback'); },
  };
  let browser;
  try {
    browser = await createXiaohongshuBrowser({ profileDir, chromium });
    await browser.openLogin();
    assert.equal(await browser.waitForClose(), 'closed');
    assert.equal(ordinaryLaunches, 0);
    assert.deepEqual(calls[0], ['goto', 'https://www.xiaohongshu.com/', {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    }]);
    assert.deepEqual(calls[1], ['wait', 'close', { timeout: 0 }]);
  } finally {
    await browser?.close().catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test('redirected or mismatched search pages never bind recommendation links to a Query', async () => {
  const candidate = [{ url: '/explore/66f000000000000000000000', title: '首页推荐' }];
  for (const finalUrl of [
    'https://www.xiaohongshu.com/explore',
    'https://www.xiaohongshu.com/search_result?keyword=另一个词',
  ]) {
    await assert.rejects(
      searchXiaohongshuPage(fakeSearchPage({ candidates: candidate, finalUrl }), '桌面收纳', {
        scrolls: 0,
        settleMs: 0,
      }),
      /离开当前 Query 的搜索结果页/u,
    );
  }
});

test('browser login state requires an empty dedicated profile directory', async () => {
  const root = await mkdtemp(join(tmpdir(), 'xhs-search-profile-'));
  const dedicated = join(root, 'dedicated');
  try {
    await prepareXiaohongshuProfileDirectory(dedicated);
    await prepareXiaohongshuProfileDirectory(dedicated);
    await writeFile(join(root, 'ordinary-profile.txt'), 'daily browser data');
    await assert.rejects(
      prepareXiaohongshuProfileDirectory(root),
      /不是空的专用目录/u,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
