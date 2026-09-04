import assert from 'node:assert/strict';
import test from 'node:test';

import sharp from 'sharp';

import { createDeepSeekResponsesClient } from '../src/deepseek-responses-client.mjs';
import {
  downloadPublicImage,
  executeDeepSeekImageSimulation,
  normalizePublicImageUrl,
  renderFallbackSimulationImage,
} from '../src/executor/deepseek-image-simulator.mjs';

function responsePayload(text) {
  return {
    status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text }] }],
  };
}

function candidate(pageIndex, suffix = '') {
  return {
    imageUrl: `https://images.example.com/${pageIndex}${suffix}.jpg`,
    sourcePageUrl: `https://example.com/photos/${pageIndex}${suffix}`,
    title: `候选图片 ${pageIndex}${suffix}`,
    attribution: 'Example Photographer',
    license: 'Example open license',
  };
}

test('DeepSeek image search returns one bounded candidate group for every plan page', async () => {
  let request;
  const fetchImpl = async (_url, init) => {
    request = JSON.parse(init.body);
    const pages = [1, 2, 3].map((pageIndex) => ({
      pageIndex,
      searchQuery: `桌面整理 ${pageIndex}`,
      candidates: [candidate(pageIndex, 'a'), candidate(pageIndex, 'b')],
    }));
    return new Response(JSON.stringify(responsePayload(JSON.stringify({ pages }))), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createDeepSeekResponsesClient({ apiKey: 'test-secret-value', fetchImpl });
  const result = await client.runImageSearch({
    query: '租房桌面整理',
    copy: { title: '低成本桌面整理', body: '测试正文' },
    imagePlan: [
      { kind: 'hero', headline: '封面' },
      { kind: 'steps', headline: '步骤' },
      { kind: 'summary', headline: '总结' },
    ],
  });

  assert.equal(result.model, 'deepseek-v4-pro');
  assert.equal(result.attempts, 1);
  assert.equal(result.result.pages.length, 3);
  assert.equal(result.result.pages[2].candidates.length, 2);
  assert.deepEqual(request.tools, [{ type: 'web_search' }]);
  assert.deepEqual(request.tool_choice, { type: 'web_search' });
  assert.ok(!JSON.stringify(request).includes('test-secret-value'));
});

test('DeepSeek image search retries an empty response and accepts common compatible fields', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) {
      return new Response(JSON.stringify(responsePayload('')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    const images = [1, 2, 3].map((pageIndex) => ({
      page_index: pageIndex,
      search_query: `兼容检索词 ${pageIndex}`,
      image_url: `https://images.example.com/compatible-${pageIndex}.jpg`,
      source_url: `https://example.com/compatible/${pageIndex}`,
      name: `兼容图片 ${pageIndex}`,
      author: '兼容作者',
      licence: '兼容许可证',
    }));
    return new Response(JSON.stringify({
      status: 'completed',
      output_text: `已完成检索，结果如下：\n\`\`\`json\n${JSON.stringify({ images })}\n\`\`\`\n请核验授权。`,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  const client = createDeepSeekResponsesClient({ apiKey: 'test-secret-value', fetchImpl });
  const result = await client.runImageSearch({
    query: '租房桌面整理',
    copy: { title: '低成本桌面整理', body: '测试正文' },
    imagePlan: [
      { kind: 'hero', headline: '封面' },
      { kind: 'steps', headline: '步骤' },
      { kind: 'summary', headline: '总结' },
    ],
  });

  assert.equal(calls, 2);
  assert.equal(result.attempts, 2);
  assert.equal(result.result.pages[0].searchQuery, '兼容检索词 1');
  assert.equal(result.result.pages[0].candidates[0].sourcePageUrl, 'https://example.com/compatible/1');
  assert.equal(result.result.pages[0].candidates[0].attribution, '兼容作者');
});

test('DeepSeek image search stops after three invalid responses', async () => {
  let calls = 0;
  const client = createDeepSeekResponsesClient({
    apiKey: 'test-secret-value',
    fetchImpl: async () => {
      calls += 1;
      return new Response(JSON.stringify(responsePayload('not json')), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  await assert.rejects(client.runImageSearch({
    query: '租房桌面整理',
    copy: { title: '低成本桌面整理', body: '测试正文' },
    imagePlan: [
      { kind: 'hero', headline: '封面' },
      { kind: 'steps', headline: '步骤' },
      { kind: 'summary', headline: '总结' },
    ],
  }), /after 3 attempts/u);
  assert.equal(calls, 3);
});

test('image simulation rejects local URLs before any download', () => {
  for (const value of [
    'http://127.0.0.1/private.png',
    'http://10.2.3.4/private.png',
    'http://localhost/private.png',
    'file:///tmp/private.png',
  ]) {
    assert.throws(() => normalizePublicImageUrl(value), /public HTTP\(S\) host/u);
  }
  assert.equal(
    normalizePublicImageUrl('https://images.example.com/photo.jpg#fragment').toString(),
    'https://images.example.com/photo.jpg',
  );
});

test('image downloader verifies and normalizes a public image to a 3:4 PNG', async () => {
  const source = await sharp({
    create: { width: 640, height: 480, channels: 3, background: '#8a9cab' },
  }).jpeg().toBuffer();
  const result = await downloadPublicImage({ imageUrl: 'https://images.example.com/photo.jpg' }, {
    lookupImpl: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (_url, init) => {
      assert.equal(init.redirect, 'manual');
      return new Response(source, {
        status: 200,
        headers: {
          'content-type': 'image/jpeg',
          'content-length': String(source.length),
        },
      });
    },
  });
  const metadata = await sharp(result.content).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 1_200);
  assert.equal(result.downloadedFrom, 'https://images.example.com/photo.jpg');
});

test('fallback simulation renderer always creates a valid 3:4 PNG', async () => {
  const content = await renderFallbackSimulationImage({
    copy: { title: '黄山怎么玩' },
    page: { headline: '黄山路线', subtitle: '用于流程联调', bullets: ['第一步', '第二步'] },
    pageIndex: 1,
    pageCount: 3,
  });
  const metadata = await sharp(content).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 900);
  assert.equal(metadata.height, 1_200);
});

test('DeepSeek image simulation completes with local fallback images when search fails', async () => {
  const uploads = [];
  let completed;
  const imagePlan = [
    { kind: 'hero', headline: '封面', subtitle: '总览', bullets: ['一', '二'], prompt: '桌面总览' },
    { kind: 'steps', headline: '步骤', subtitle: '整理', bullets: ['一', '二'], prompt: '整理步骤' },
    { kind: 'summary', headline: '总结', subtitle: '完成', bullets: ['一', '二'], prompt: '整理结果' },
  ];
  const claim = {
    task: { id: 10 },
    execution: {
      id: '6d8fc410-6c8d-4cb9-b77e-9adb32f345c8',
      snapshot: {
        task: { id: 10, query: '租房桌面整理', requestedImageCount: 3 },
        copyRevision: {
          content: {
            copy: { title: '低成本桌面整理', body: '测试正文', tags: ['#整理'] },
            imagePlan,
          },
        },
      },
    },
  };
  const controlPlane = {
    updateProgress: async () => {},
    uploadAsset: async (_executionId, value) => {
      uploads.push(value);
      return { id: uploads.length, url: `/v1/assets/${uploads.length}` };
    },
    completeImage: async (_executionId, result) => {
      completed = result;
      return result;
    },
  };

  await executeDeepSeekImageSimulation({
    claim,
    controlPlane,
    client: { runImageSearch: async () => { throw new TypeError('invalid search response'); } },
  });

  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((upload) => /-fallback-simulation\.png$/u.test(upload.fileName)));
  assert.equal(completed.images.length, 3);
  assert.ok(completed.images.every((image) => image.provider === 'deterministic-fallback-simulation'));
  assert.equal(completed.simulation.fallbackImages, 3);
  assert.equal(completed.visualPlan.warning.code, 'LOCAL_FALLBACK_SIMULATION');
});

test('DeepSeek image simulation uploads every searched image to the control plane', async () => {
  const progress = [];
  const uploads = [];
  let completed;
  const imagePlan = [
    { kind: 'hero', headline: '封面', subtitle: '总览', bullets: ['一', '二'], prompt: '桌面总览' },
    { kind: 'steps', headline: '步骤', subtitle: '整理', bullets: ['一', '二'], prompt: '整理步骤' },
    { kind: 'summary', headline: '总结', subtitle: '完成', bullets: ['一', '二'], prompt: '整理结果' },
  ];
  const claim = {
    task: { id: 9 },
    execution: {
      id: '5d8fc410-6c8d-4cb9-b77e-9adb32f345c8',
      snapshot: {
        task: { id: 9, query: '租房桌面整理', requestedImageCount: 3 },
        copyRevision: {
          content: {
            copy: { title: '低成本桌面整理', body: '测试正文', tags: ['#整理'] },
            imagePlan,
          },
        },
      },
    },
  };
  const client = {
    runImageSearch: async () => ({
      provider: 'deepseek',
      model: 'deepseek-v4-pro',
      result: {
        pages: imagePlan.map((_item, index) => ({
          pageIndex: index + 1,
          searchQuery: `整理图片 ${index + 1}`,
          candidates: [candidate(index + 1)],
        })),
      },
    }),
  };
  const controlPlane = {
    updateProgress: async (_executionId, value) => { progress.push(value); },
    uploadAsset: async (executionId, value) => {
      uploads.push({ executionId, ...value });
      return { id: uploads.length, url: `/v1/assets/${uploads.length}` };
    },
    completeImage: async (executionId, result) => {
      completed = { executionId, result };
      return result;
    },
  };

  await executeDeepSeekImageSimulation({
    claim,
    controlPlane,
    client,
    loadImage: async (selected) => ({
      content: Buffer.from(`normalized-${selected.title}`),
      downloadedFrom: selected.imageUrl,
      sourceMediaType: 'image/jpeg',
    }),
  });

  assert.equal(uploads.length, 3);
  assert.ok(uploads.every((upload) => upload.mediaType === 'image/png'));
  assert.deepEqual(uploads.map((upload) => upload.fileName), [
    '01-search-simulation.png',
    '02-search-simulation.png',
    '03-search-simulation.png',
  ]);
  assert.equal(completed.executionId, claim.execution.id);
  assert.equal(completed.result.mode, 'DEEPSEEK_IMAGE_SEARCH_SIMULATION');
  assert.equal(completed.result.images[0].assetId, 1);
  assert.equal(completed.result.images[0].source.pageUrl, 'https://example.com/photos/1');
  assert.equal(completed.result.simulation.enabled, true);
  assert.equal(completed.result.qc.disposition, 'manual_review_required');
  assert.ok(progress.every((item) => item.details.simulation === true));
});
