import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import sharp from 'sharp';

import {
  createDeepSeekResponsesClient,
  DEEPSEEK_SIMULATION_MODEL,
} from '../deepseek-responses-client.mjs';

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_REDIRECTS = 3;
const IMAGE_MEDIA_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const FALLBACK_COLORS = Object.freeze([
  ['#f4c7b8', '#8f302f', '#fff8f4'],
  ['#bfd7ea', '#24506a', '#f5fbff'],
  ['#cde2cc', '#295c42', '#f7fff7'],
  ['#ead8ad', '#745416', '#fffaf0'],
  ['#d7c9ea', '#543d75', '#fcf9ff'],
]);

function xmlText(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function boundedLine(value, maximum = 22) {
  const characters = [...String(value ?? '').trim()];
  return xmlText(characters.length > maximum
    ? `${characters.slice(0, maximum - 1).join('')}…`
    : characters.join(''));
}

export async function renderFallbackSimulationImage({ copy, page, pageIndex, pageCount }) {
  const [background, accent, surface] = FALLBACK_COLORS[(pageIndex - 1) % FALLBACK_COLORS.length];
  const bullets = Array.isArray(page?.bullets) ? page.bullets.slice(0, 4) : [];
  const bulletSvg = bullets.map((bullet, index) => `
    <circle cx="105" cy="${600 + index * 105}" r="11" fill="${accent}"/>
    <text x="140" y="${615 + index * 105}" class="bullet">${boundedLine(bullet, 28)}</text>`).join('');
  const svg = `
  <svg width="900" height="1200" viewBox="0 0 900 1200" xmlns="http://www.w3.org/2000/svg">
    <rect width="900" height="1200" fill="${background}"/>
    <circle cx="785" cy="115" r="175" fill="${surface}" opacity="0.55"/>
    <circle cx="85" cy="1100" r="220" fill="${surface}" opacity="0.38"/>
    <rect x="62" y="72" width="776" height="1056" rx="40" fill="${surface}" opacity="0.94"/>
    <rect x="88" y="104" width="174" height="46" rx="23" fill="${accent}"/>
    <text x="175" y="136" text-anchor="middle" class="badge">流程联调兜底图</text>
    <text x="92" y="235" class="page">第 ${pageIndex} / ${pageCount} 页</text>
    <text x="92" y="330" class="title">${boundedLine(page?.headline ?? copy?.title ?? '笔记配图', 18)}</text>
    <line x1="92" y1="382" x2="808" y2="382" stroke="${accent}" stroke-width="8" stroke-linecap="round"/>
    <text x="92" y="460" class="subtitle">${boundedLine(page?.subtitle ?? '用于验证图片上传与审核流程', 24)}</text>
    ${bulletSvg}
    <text x="92" y="1060" class="note">DeepSeek 搜图不可用时生成 · 仅供内部流程测试</text>
    <style>
      text { font-family: "Microsoft YaHei", "Noto Sans CJK SC", Arial, sans-serif; fill: ${accent}; }
      .badge { fill: #fff; font-size: 23px; font-weight: 700; }
      .page { font-size: 28px; font-weight: 700; letter-spacing: 2px; }
      .title { font-size: 50px; font-weight: 800; }
      .subtitle { font-size: 29px; font-weight: 600; }
      .bullet { font-size: 27px; font-weight: 600; }
      .note { font-size: 20px; opacity: .72; }
    </style>
  </svg>`;
  return sharp(Buffer.from(svg))
    .png({ compressionLevel: 9 })
    .toBuffer();
}

function copySource(snapshot) {
  const content = snapshot?.copyRevision?.content;
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new TypeError('approved copy revision is unavailable for image simulation');
  }
  const copy = content.copy ?? content.reviewed?.copy;
  const imagePlan = content.imagePlan ?? content.reviewed?.imagePlan;
  if (!copy || typeof copy !== 'object' || !Array.isArray(imagePlan)
    || imagePlan.length < 3 || imagePlan.length > 5) {
    throw new TypeError('approved copy revision has no usable copy or image plan');
  }
  return { copy, imagePlan };
}

function isPrivateIpv4(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  return a === 0
    || a === 10
    || a === 127
    || (a === 100 && b >= 64 && b <= 127)
    || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31)
    || (a === 192 && (b === 0 || b === 168))
    || (a === 198 && (b === 18 || b === 19))
    || a >= 224;
}

function isPrivateAddress(address) {
  const normalized = String(address ?? '').trim().toLowerCase();
  if (isIP(normalized) === 4) return isPrivateIpv4(normalized);
  if (isIP(normalized) !== 6) return true;
  if (normalized === '::' || normalized === '::1'
    || normalized.startsWith('fc') || normalized.startsWith('fd')
    || /^fe[89ab]/u.test(normalized)) return true;
  const mapped = normalized.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/u)?.[1];
  return mapped ? isPrivateIpv4(mapped) : false;
}

export function normalizePublicImageUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ''));
  } catch {
    throw new TypeError('image URL must be absolute');
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
    || ['localhost', 'localhost.localdomain'].includes(url.hostname.toLowerCase())
    || url.hostname.toLowerCase().endsWith('.local')
    || (isIP(url.hostname) && isPrivateAddress(url.hostname))) {
    throw new TypeError('image URL must point to a public HTTP(S) host');
  }
  url.hash = '';
  return url;
}

async function assertPublicDns(url, lookupImpl) {
  if (isIP(url.hostname)) return;
  const addresses = await lookupImpl(url.hostname, { all: true, verbatim: true });
  if (!Array.isArray(addresses) || addresses.length < 1
    || addresses.some((entry) => isPrivateAddress(entry.address))) {
    throw new TypeError('image host did not resolve exclusively to public addresses');
  }
}

async function cappedBody(response, maximum = MAX_IMAGE_BYTES) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maximum) {
    throw new RangeError('remote image exceeds the size limit');
  }
  if (!response.body) throw new TypeError('remote image body is missing');
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maximum) {
      await reader.cancel().catch(() => {});
      throw new RangeError('remote image exceeds the size limit');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

export async function downloadPublicImage(candidate, {
  fetchImpl = fetch,
  lookupImpl = lookup,
  timeoutMs = 45_000,
} = {}) {
  if (typeof fetchImpl !== 'function' || typeof lookupImpl !== 'function') {
    throw new TypeError('image downloader dependencies are invalid');
  }
  let url = normalizePublicImageUrl(candidate?.imageUrl);
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicDns(url, lookupImpl);
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        Accept: 'image/avif,image/webp,image/png,image/jpeg,image/gif;q=0.8',
        'User-Agent': 'xhs-openclaw-image-simulation/0.1',
      },
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      if (!location || redirects === MAX_REDIRECTS) throw new Error('remote image redirected too many times');
      url = normalizePublicImageUrl(new URL(location, url).toString());
      continue;
    }
    if (!response.ok) throw new Error(`remote image returned HTTP ${response.status}`);
    const mediaType = String(response.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (!IMAGE_MEDIA_TYPES.has(mediaType)) throw new TypeError('remote URL did not return a supported image');
    const source = await cappedBody(response);
    const pipeline = sharp(source, { failOn: 'error', limitInputPixels: 40_000_000 }).rotate();
    const metadata = await pipeline.metadata();
    if (!metadata.width || !metadata.height || metadata.width < 320 || metadata.height < 320) {
      throw new RangeError('remote image dimensions are too small');
    }
    const content = await pipeline
      .resize({ width: 900, height: 1_200, fit: 'cover', position: 'attention' })
      .png({ compressionLevel: 9 })
      .toBuffer();
    if (content.length > MAX_IMAGE_BYTES) throw new RangeError('normalized image exceeds the size limit');
    return { content, downloadedFrom: url.toString(), sourceMediaType: mediaType };
  }
  throw new Error('remote image could not be downloaded');
}

async function report(controlPlane, executionId, stage, progressPercent, message, details = {}) {
  await controlPlane.updateProgress(executionId, {
    stage,
    progressPercent,
    message,
    details: { simulation: true, provider: 'DEEPSEEK_IMAGE_SEARCH', ...details },
  });
}

export async function executeDeepSeekImageSimulation({
  claim,
  controlPlane,
  environment = process.env,
  client = createDeepSeekResponsesClient({ apiKey: environment.DEEPSEEK_API_KEY }),
  loadImage = downloadPublicImage,
  renderFallback = renderFallbackSimulationImage,
}) {
  const { execution } = claim;
  const snapshot = execution.snapshot;
  const { copy, imagePlan } = copySource(snapshot);
  await report(controlPlane, execution.id, 'SEARCHING_IMAGES', 8, 'DeepSeek 正在联网搜索相关图片');
  let search = null;
  let searchError = null;
  try {
    search = await client.runImageSearch({
      query: snapshot.task.query,
      copy,
      imagePlan,
    });
  } catch (error) {
    searchError = String(error?.message ?? error ?? 'unknown search failure').slice(0, 300);
  }
  await report(
    controlPlane,
    execution.id,
    'SELECTING_IMAGES',
    20,
    search
      ? '正在校验搜索结果和图片来源'
      : '联网搜图不可用，正在生成本地流程联调兜底图',
    { fallback: !search },
  );

  const images = [];
  let fallbackImages = 0;
  const pages = search?.result?.pages ?? imagePlan.map((plan, index) => ({
    pageIndex: index + 1,
    searchQuery: null,
    candidates: [],
    plan,
  }));
  for (const page of pages) {
    let selected = null;
    for (const candidate of page.candidates) {
      try {
        const downloaded = await loadImage(candidate);
        selected = { candidate, ...downloaded };
        break;
      } catch {
        // Model-provided URLs are untrusted. Try the next bounded candidate.
      }
    }
    if (!selected) {
      fallbackImages += 1;
      selected = {
        candidate: null,
        content: await renderFallback({
          copy,
          page: imagePlan[page.pageIndex - 1],
          pageIndex: page.pageIndex,
          pageCount: imagePlan.length,
        }),
        downloadedFrom: null,
        sourceMediaType: 'image/png',
        fallback: true,
      };
    }
    const beforeUpload = 20 + Math.round(((page.pageIndex - 0.5) / imagePlan.length) * 70);
    await report(
      controlPlane,
      execution.id,
      'UPLOADING_IMAGES',
      beforeUpload,
      `正在上传第 ${page.pageIndex} / ${imagePlan.length} 张${selected.fallback ? '兜底' : '搜索'}模拟图片到中心服务`,
      {
        currentPage: page.pageIndex,
        completedImages: page.pageIndex - 1,
        fallback: selected.fallback === true,
      },
    );
    const fileName = `${String(page.pageIndex).padStart(2, '0')}-${selected.fallback ? 'fallback' : 'search'}-simulation.png`;
    const asset = await controlPlane.uploadAsset(execution.id, {
      content: selected.content,
      mediaType: 'image/png',
      fileName,
    });
    images.push({
      pageIndex: page.pageIndex,
      kind: imagePlan[page.pageIndex - 1].kind,
      file: fileName,
      url: asset.url,
      assetId: asset.id,
      provider: selected.fallback
        ? 'deterministic-fallback-simulation'
        : 'deepseek-web-image-simulation',
      model: search?.model ?? DEEPSEEK_SIMULATION_MODEL,
      generationAttempts: 0,
      alignmentPassed: null,
      searchQuery: page.searchQuery,
      source: selected.candidate ? {
        title: selected.candidate.title,
        pageUrl: selected.candidate.sourcePageUrl,
        imageUrl: selected.downloadedFrom ?? selected.candidate.imageUrl,
        attribution: selected.candidate.attribution,
        license: selected.candidate.license,
      } : {
        title: '本地流程联调兜底图',
        pageUrl: null,
        imageUrl: null,
        attribution: '系统确定性兜底渲染',
        license: '仅供内部流程联调',
      },
    });
  }

  await report(controlPlane, execution.id, 'FINALIZING', 96, '正在保存模拟图片清单');
  return controlPlane.completeImage(execution.id, {
    runId: execution.id,
    mode: 'DEEPSEEK_IMAGE_SEARCH_SIMULATION',
    status: 'COMPLETED',
    imageCount: images.length,
    images,
    visualPlan: {
      model: search?.model ?? DEEPSEEK_SIMULATION_MODEL,
      degraded: true,
      warning: {
        code: fallbackImages > 0 ? 'LOCAL_FALLBACK_SIMULATION' : 'SEARCH_IMAGE_SIMULATION',
        message: fallbackImages > 0
          ? `其中 ${fallbackImages} 张是联网搜图不可用后的本地兜底图，仅用于流程联调，并非 OpenClaw 生成结果。`
          : '这些图片来自联网搜索，仅用于流程联调，并非 OpenClaw 生成结果。',
      },
    },
    qc: {
      passed: false,
      disposition: 'manual_review_required',
      overallScore: null,
      summary: '模拟图片尚未经过原生生图质量与图文对齐检查，必须人工审核。',
      issues: [],
      dimensions: [],
      limitations: [fallbackImages > 0
        ? '本地兜底图仅验证图片上传和审核链路，不代表正式图片质量。'
        : '联网图片的授权范围、画面相关性和文字内容需要人工确认。'],
    },
    simulation: {
      enabled: true,
      provider: fallbackImages > 0 ? 'DEEPSEEK_IMAGE_SEARCH_WITH_LOCAL_FALLBACK' : 'DEEPSEEK_IMAGE_SEARCH',
      model: search?.model ?? DEEPSEEK_SIMULATION_MODEL,
      searchAttempts: search?.attempts ?? 3,
      fallbackImages,
      searchError,
    },
  });
}
