import sharp from 'sharp';
import { analyzeTextRepairBackground } from './text-repair-background.mjs';

const failure = message => Object.assign(new TypeError(message), { code: 'TEXT_REPAIR_LOCALIZATION_UNCERTAIN' });
const contains = (outer, inner) => inner.x >= outer.x && inner.y >= outer.y
  && inner.x + inner.width <= outer.x + outer.width && inner.y + inner.height <= outer.y + outer.height;
function rectangle(value, width, height) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !['x', 'y', 'width', 'height'].includes(key))
    || ![value.x, value.y, value.width, value.height].every(Number.isSafeInteger)
    || value.x < 0 || value.y < 0 || value.width < 1 || value.height < 1
    || value.x + value.width > width || value.y + value.height > height) throw failure('错字定位区域越界或无效');
  return { x: value.x, y: value.y, width: value.width, height: value.height };
}
function searchArea(rect, region) {
  const padding = Math.max(4, Math.min(16, Math.round(rect.height * 0.12)));
  const x = Math.max(region.x, rect.x - padding), y = Math.max(region.y, rect.y - padding);
  return { x, y, width: Math.min(region.x + region.width, rect.x + rect.width + padding) - x,
    height: Math.min(region.y + region.height, rect.y + rect.height + padding) - y };
}
function components(mask, width, height) {
  const visited = new Uint8Array(mask.length), queue = new Int32Array(mask.length), result = [];
  for (let index = 0; index < mask.length; index++) {
    if (!mask[index] || visited[index]) continue;
    const points = []; let read = 0, written = 1, touchesBoundary = false;
    queue[0] = index; visited[index] = 1;
    while (read < written) {
      const current = queue[read++], x = current % width, y = Math.floor(current / width);
      points.push(current);
      if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBoundary = true;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
        const next = ny * width + nx;
        if (mask[next] && !visited[next]) { visited[next] = 1; queue[written++] = next; }
      }
    }
    result.push({ points, touchesBoundary });
  }
  return result;
}
function bounds(points, search) {
  let left = Infinity, top = Infinity, right = -1, bottom = -1;
  for (const index of points) {
    const x = index % search.width, y = Math.floor(index / search.width);
    left = Math.min(left, x); top = Math.min(top, y); right = Math.max(right, x); bottom = Math.max(bottom, y);
  }
  return { x: search.x + left, y: search.y + top, width: right - left + 1, height: bottom - top + 1 };
}
function columnRuns(points, search) {
  const columns = new Uint32Array(search.width);
  for (const index of points) columns[index % search.width]++;
  const runs = [];
  for (let x = 0; x < columns.length; x++) {
    if (!columns[x]) continue;
    const start = x;
    while (x + 1 < columns.length && columns[x + 1]) x++;
    runs.push({ start, end: x });
  }
  return { columns, runs };
}
function candidateFor(points, search, coarse, start, end, count, han) {
  const selected = points.filter(index => index % search.width >= start && index % search.width <= end);
  const ink = bounds(selected, search), widthRatio = ink.width / coarse.width, heightRatio = ink.height / coarse.height;
  if (widthRatio < 0.75 || widthRatio > 1.2 || heightRatio < 0.72 || heightRatio > 1.2) return null;
  const dx = (ink.x + ink.width / 2 - coarse.x - coarse.width / 2) / coarse.width;
  const dy = (ink.y + ink.height / 2 - coarse.y - coarse.height / 2) / coarse.height;
  if (Math.abs(dx) > 0.15 || Math.abs(dy) > 0.15) return null;
  const aspect = ink.width / ink.height;
  if (han && (aspect < count * 0.55 || aspect > count * 1.35)) return null;
  const density = selected.length / ink.width / ink.height;
  if (density < 0.08 || density > 0.9) return null;
  const score = Math.hypot(dx, dy) * 4 + Math.abs(Math.log(widthRatio)) + Math.abs(Math.log(heightRatio));
  return { ink, points: selected, start, end, score, density };
}
function safePadding(ink, search, allPoints, region) {
  let leftGap = Infinity, rightGap = Infinity;
  for (const index of allPoints) {
    const x = search.x + index % search.width;
    if (x < ink.x) leftGap = Math.min(leftGap, ink.x - x - 1);
    if (x >= ink.x + ink.width) rightGap = Math.min(rightGap, x - ink.x - ink.width);
  }
  const left = Math.min(3, ink.x - region.x, leftGap - 1);
  const right = Math.min(3, region.x + region.width - ink.x - ink.width, rightGap - 1);
  const top = Math.min(3, ink.y - region.y), bottom = Math.min(3, region.y + region.height - ink.y - ink.height);
  if (Math.min(left, right, top, bottom) < 2) throw failure('错字与邻字或框选边缘过近，无法保留安全背景余量，请重新框选');
  return { x: ink.x - left, y: ink.y - top, width: ink.width + left + right, height: ink.height + top + bottom };
}
function largestSolidSquare(candidate, search) {
  const { ink } = candidate, mask = new Uint8Array(ink.width * ink.height);
  for (const index of candidate.points) {
    const x = search.x + index % search.width - ink.x, y = search.y + Math.floor(index / search.width) - ink.y;
    mask[y * ink.width + x] = 1;
  }
  const previous = new Uint16Array(ink.width + 1); let maximum = 0;
  for (let y = 0; y < ink.height; y++) {
    let diagonal = 0;
    for (let x = 1; x <= ink.width; x++) {
      const above = previous[x];
      previous[x] = mask[y * ink.width + x - 1] ? Math.min(previous[x - 1], above, diagonal) + 1 : 0;
      maximum = Math.max(maximum, previous[x]); diagonal = above;
    }
  }
  return maximum;
}
function foregroundProfile(data, info, search, rgb) {
  const mask = new Uint8Array(search.width * search.height);
  for (let y = 0; y < search.height; y++) for (let x = 0; x < search.width; x++) {
    const offset = ((y + search.y) * info.width + x + search.x) * 4;
    if (data[offset + 3] === 255 && rgb.every((value, channel) => Math.abs(data[offset + channel] - value) <= 34)) mask[y * search.width + x] = 1;
  }
  const groups = components(mask, search.width, search.height);
  const complete = groups.filter(group => !group.touchesBoundary).flatMap(group => group.points);
  return { groups, complete, allPoints: groups.flatMap(group => group.points), runs: columnRuns(complete, search).runs };
}
function selectCandidate({ complete, runs }, search, coarse, count, han) {
  if (!complete.length || runs.length > 64) throw failure('前景像素无法分成可靠的完整文字，请重新框选');
  const candidates = [];
  for (let first = 0; first < runs.length; first++) for (let last = first; last < runs.length; last++) {
    const candidate = candidateFor(complete, search, coarse, runs[first].start, runs[last].end, count, han);
    if (candidate) candidates.push(candidate);
  }
  // Nested alternatives are incomplete parts of the same glyph; keep its full valid envelope.
  const full = candidates.filter(candidate => !candidates.some(other => other !== candidate && contains(other.ink, candidate.ink)
    && (other.ink.width > candidate.ink.width || other.ink.height > candidate.ink.height))).sort((a, b) => a.score - b.score);
  const selected = full[0];
  if (!selected || (full[1] && full[1].score - selected.score < 0.2)) throw failure('无法唯一分离完整错字与邻字，不能自动裁掉笔画，请缩小到目标词句');
  return selected;
}
async function targetCrossesSelectedRegion({ source, data, info, coarse, allowed, rgb, count, han }) {
  // Extra context is read only after a failure, solely to improve its diagnosis.
  // It must never enlarge the accepted write rectangle or rescue a failed crop.
  const image = { x: 0, y: 0, width: info.width, height: info.height };
  const probe = searchArea(coarse, image);
  if (contains(allowed, probe) || probe.width * probe.height > 1_000_000) return false;
  try {
    const profile = foregroundProfile(data, info, probe, rgb);
    const selected = selectCandidate(profile, probe, coarse, count, han);
    const { ink } = selected;
    if (largestSolidSquare(selected, probe) > ink.height * 0.45) return false;
    // A neighbor elsewhere on the selection edge is not evidence about this target.
    const nearBoundary = ink.x <= allowed.x + 1 || ink.y <= allowed.y + 1
      || ink.x + ink.width >= allowed.x + allowed.width - 1
      || ink.y + ink.height >= allowed.y + allowed.height - 1;
    if (!nearBoundary) return false;
    const readRect = safePadding(ink, probe, profile.allPoints, image);
    const analyzed = await analyzeTextRepairBackground({ source, rect: readRect });
    return analyzed.metrics.styleReliable === true && analyzed.style.glyphRect !== null
      && !contains(allowed, analyzed.style.glyphRect);
  } catch {
    return false;
  }
}

/** Refine a coarse visual box using a foreground-color profile without changing pixels or recognizing new text. */
export async function refineTextRepairLocalization({ source, rect, region, correctText, color }) {
  if (!Buffer.isBuffer(source) || !source.length || source.length > 40 * 1024 * 1024) throw failure('错字定位源图无效或过大');
  if (typeof correctText !== 'string' || [...correctText].length < 1 || [...correctText].length > 8 || /[\s\u0000-\u001f]/u.test(correctText)
    || typeof color !== 'string' || !/^#[a-f0-9]{6}$/iu.test(color)) throw failure('缺少可靠的正确文字或前景颜色，不能校准字形范围');
  const decoder = sharp(source, { failOn: 'warning', limitInputPixels: 16_000_000, animated: true });
  const metadata = await decoder.metadata();
  if (!['png', 'jpeg', 'webp'].includes(metadata.format) || (metadata.pages ?? 1) !== 1) throw failure('错字定位源图必须是静态位图');
  const { data, info } = await decoder.toColourspace('srgb').ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const coarse = rectangle(rect, info.width, info.height), allowed = rectangle(region, info.width, info.height);
  if (!contains(allowed, coarse)) throw failure('粗定位超出用户框选段落');
  const search = searchArea(coarse, allowed);
  if (search.width * search.height > 1_000_000) throw failure('错字定位搜索范围过大，请缩小到对应词句');
  const rgb = [1, 3, 5].map(offset => parseInt(color.slice(offset, offset + 2), 16));
  const count = [...correctText].length, han = [...correctText].every(character => /\p{Script=Han}/u.test(character));
  try {
    const { groups, allPoints, ...profile } = foregroundProfile(data, info, search, rgb);
    const selected = selectCandidate(profile, search, coarse, count, han);
    const solidSquare = largestSolidSquare(selected, search);
    if (solidSquare > selected.ink.height * 0.45) throw failure('前景更接近实心背景物体，无法可靠判定为完整文字');
    const refined = safePadding(selected.ink, search, allPoints, allowed);
    if (!contains(allowed, refined) || refined.width / coarse.width > 1.25 || refined.height / coarse.height > 1.25) throw failure('字形校准变化过大，不能安全扩大或压缩目标字');
    const background = await analyzeTextRepairBackground({ source, rect: refined });
    if (background.metrics.styleReliable !== true || background.metrics.reason === 'INK_CROSSES_BOUNDARY') throw failure(`字形颜色或笔画边界不可靠（${background.metrics.reason}），请调整框选后重试`);
    return { rect: refined, metrics: { mode: 'FOREGROUND_PIXEL_PROFILE', confidence: Math.max(0.9, 0.98 - selected.score * 0.05),
      originalRect: coarse, searchRect: search, inkRect: selected.ink, foregroundColor: color.toLowerCase(),
      corePixels: selected.points.length, componentCount: groups.length, rejectedBoundaryComponents: groups.length - groups.filter(group => !group.touchesBoundary).length,
      characterCount: count, largestSolidSquare: solidSquare,
      background: { simple: background.simple, reason: background.metrics.reason, residual: background.metrics.backgroundResidual } } };
  } catch (error) {
    if (error.code === 'TEXT_REPAIR_LOCALIZATION_UNCERTAIN'
      && await targetCrossesSelectedRegion({ source, data, info, coarse, allowed, rgb, count, han })) {
      throw failure('框选区域切到原字笔画，请扩大句段选区');
    }
    throw error;
  }
}
