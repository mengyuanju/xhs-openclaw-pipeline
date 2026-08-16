import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

const WIDTH = 1080;
const HEIGHT = 1440;
const FONT_STACK = "'Microsoft YaHei','Noto Sans CJK SC','PingFang SC',sans-serif";

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function wrapText(value, maxCharacters) {
  const characters = [...String(value)];
  const lines = [];
  for (let index = 0; index < characters.length; index += maxCharacters) {
    lines.push(characters.slice(index, index + maxCharacters).join(''));
  }
  return lines.slice(0, 3);
}

function textLines(lines, { x, y, size, weight = 400, color = '#27231f', lineHeight = 1.35 }) {
  return lines
    .map(
      (line, index) =>
        `<text x="${x}" y="${y + index * size * lineHeight}" font-family="${FONT_STACK}" font-size="${size}" font-weight="${weight}" fill="${color}">${escapeXml(line)}</text>`,
    )
    .join('\n');
}

function mockHeroSvg(plan) {
  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#f4e8d7"/>
          <stop offset="1" stop-color="#d7bfa3"/>
        </linearGradient>
      </defs>
      <rect width="1080" height="1440" fill="url(#bg)"/>
      <circle cx="900" cy="210" r="230" fill="#fff4dc" opacity="0.7"/>
      <rect x="90" y="700" width="900" height="420" rx="32" fill="#9f7f5f"/>
      <rect x="140" y="630" width="800" height="120" rx="28" fill="#f8f4ed"/>
      <rect x="180" y="520" width="330" height="150" rx="18" fill="#d0baa2"/>
      <rect x="620" y="550" width="190" height="120" rx="18" fill="#b3c1a7"/>
      <path d="M850 650 C820 560 860 480 910 430 C950 520 960 590 920 660" fill="#809578"/>
      <rect x="90" y="92" width="210" height="58" rx="29" fill="#27231f" opacity="0.9"/>
      <text x="195" y="132" text-anchor="middle" font-family="${FONT_STACK}" font-size="27" font-weight="700" fill="#ffffff">MOCK 占位图</text>
      ${textLines(wrapText(plan.headline, 12), { x: 90, y: 270, size: 72, weight: 800 })}
      ${textLines(wrapText(plan.subtitle, 18), { x: 94, y: 455, size: 38, weight: 500, color: '#5f5246' })}
    </svg>`;
}

function cardSvg(plan, imageIndex, imageCount) {
  const palettes = [
    { background: '#f2eee7', accent: '#b56f52', soft: '#ead8cb' },
    { background: '#edf1eb', accent: '#57705c', soft: '#d5e0d4' },
  ];
  const palette = palettes[(imageIndex - 2) % palettes.length];
  const headlineLines = wrapText(plan.headline, 12);
  const bulletStart = 610;
  const bullets = plan.bullets
    .map((bullet, bulletIndex) => {
      const y = bulletStart + bulletIndex * 155;
      const lines = wrapText(bullet, 18);
      return `
        <rect x="105" y="${y - 62}" width="870" height="124" rx="28" fill="#ffffff" opacity="0.92"/>
        <circle cx="170" cy="${y}" r="34" fill="${palette.accent}"/>
        <text x="170" y="${y + 12}" text-anchor="middle" font-family="${FONT_STACK}" font-size="30" font-weight="800" fill="#ffffff">${String(bulletIndex + 1).padStart(2, '0')}</text>
        ${textLines(lines, { x: 230, y: y + (lines.length === 1 ? 14 : -8), size: 38, weight: 650, lineHeight: 1.15 })}`;
    })
    .join('\n');

  return `
    <svg width="${WIDTH}" height="${HEIGHT}" viewBox="0 0 ${WIDTH} ${HEIGHT}" xmlns="http://www.w3.org/2000/svg">
      <rect width="1080" height="1440" fill="${palette.background}"/>
      <circle cx="940" cy="120" r="210" fill="${palette.soft}"/>
      <rect x="80" y="80" width="150" height="54" rx="27" fill="${palette.accent}"/>
      <text x="155" y="117" text-anchor="middle" font-family="${FONT_STACK}" font-size="25" font-weight="700" fill="#ffffff">${String(imageIndex).padStart(2, '0')} / ${String(imageCount).padStart(2, '0')}</text>
      ${textLines(headlineLines, { x: 85, y: 280, size: 72, weight: 800 })}
      ${textLines(wrapText(plan.subtitle, 18), { x: 90, y: 485, size: 37, weight: 500, color: '#655e57' })}
      ${bullets}
      <line x1="90" x2="990" y1="1320" y2="1320" stroke="${palette.accent}" stroke-width="3" opacity="0.35"/>
      <text x="90" y="1370" font-family="${FONT_STACK}" font-size="25" fill="#766f68">按自己的空间和使用频率调整，不必一次买齐。</text>
    </svg>`;
}

async function svgToPng(svg, outputPath) {
  await sharp(Buffer.from(svg, 'utf8'), { density: 144 })
    .resize(WIDTH, HEIGHT, { fit: 'fill' })
    .png({ compressionLevel: 8 })
    .toFile(outputPath);
}

export async function renderDeliveryImages({
  post,
  outputDir,
  mock,
  openclaw,
  imageCount = post.imagePlan.length,
  heroPrompt = post.imagePlan[0].prompt,
  referenceImagePaths = [],
  rawHeroPath = join(outputDir, '.raw-hero.png'),
}) {
  if (!Number.isInteger(imageCount) || imageCount < 3 || imageCount > 5) {
    throw new RangeError('imageCount must be an integer between 3 and 5');
  }
  await mkdir(outputDir, { recursive: true });
  const heroPath = join(outputDir, '01-hero.png');

  let hero;
  if (mock) {
    await svgToPng(mockHeroSvg(post.imagePlan[0]), heroPath);
    hero = { file: '01-hero.png', provider: 'mock', model: null };
  } else {
    if (!Array.isArray(referenceImagePaths) || referenceImagePaths.length > 10) {
      throw new TypeError('referenceImagePaths must be an array of at most 10 paths');
    }
    if (referenceImagePaths.length > 0 && !openclaw?.runImageEdit) {
      throw new TypeError('openclaw image edit client is required when reference images are present');
    }
    if (referenceImagePaths.length === 0 && !openclaw?.runImage) {
      throw new TypeError('openclaw image client is required in live mode');
    }
    const generated = referenceImagePaths.length > 0
      ? openclaw.runImageEdit({ prompt: heroPrompt, inputPaths: referenceImagePaths, outputPath: rawHeroPath })
      : openclaw.runImage({ prompt: heroPrompt, outputPath: rawHeroPath });
    await sharp(generated.outputPath)
      .resize(WIDTH, HEIGHT, { fit: 'cover', position: 'attention' })
      .png({ compressionLevel: 8 })
      .toFile(heroPath);
    if (generated.outputPath !== heroPath) {
      await unlink(generated.outputPath).catch(() => {});
    }
    hero = {
      file: '01-hero.png',
      provider: referenceImagePaths.length > 0 ? 'openclaw-image-edit' : 'openclaw',
      model: generated.model,
    };
  }

  const templateImages = [];
  for (let index = 1; index < imageCount; index += 1) {
    const plan = post.imagePlan[index]
      ?? post.imagePlan[1 + ((index - 1) % Math.max(1, post.imagePlan.length - 1))];
    const kind = index < post.imagePlan.length ? plan.kind : `detail-${index - 2}`;
    const file = `${String(index + 1).padStart(2, '0')}-${kind}.png`;
    await svgToPng(cardSvg(plan, index + 1, imageCount), join(outputDir, file));
    templateImages.push({ file, provider: 'local-template', model: null });
  }
  return [hero, ...templateImages];
}
