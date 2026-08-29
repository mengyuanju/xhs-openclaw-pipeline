const DIMENSION_LABELS = Object.freeze({
  queryRelevance: '选题相关性',
  contentOriginality: '内容原创性',
  imageBaseQuality: '图片基础质量',
  imageTextQuality: '图片文字质量',
  imageConsistency: '图集一致性',
  noteTone: '笔记语气',
  platformAdaptation: '平台适配',
  informationValue: '信息价值',
  imageAesthetics: '图片美观度',
  imageDiversity: '图集多样性',
});

function timestamp(value) {
  const parsed = Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function sortedAssets(assets) {
  return assets.slice().sort((left, right) => {
    const leftPage = Number.isInteger(left.pageIndex) ? left.pageIndex : 99;
    const rightPage = Number.isInteger(right.pageIndex) ? right.pageIndex : 99;
    return leftPage - rightPage || Number(left.revision ?? left.id) - Number(right.revision ?? right.id);
  });
}

function rootAsset(asset, assetById) {
  let current = asset;
  const visited = new Set();
  while (current?.parentAssetId && !visited.has(current.id)) {
    visited.add(current.id);
    current = assetById.get(current.parentAssetId) ?? current;
    if (visited.has(current.id)) break;
  }
  return current;
}

export function buildImageBatches({ runs = [], assets = [], currentTextRevisionId = null }) {
  const orderedRuns = runs.slice().sort((left, right) => timestamp(left.createdAt) - timestamp(right.createdAt)
    || Number(left.id) - Number(right.id));
  const runBatches = orderedRuns.map((run) => ({
    id: `run-${run.id}`,
    kind: 'generation',
    run,
    assets: [],
    isCurrent: false,
  }));
  const assetById = new Map(assets.map((asset) => [asset.id, asset]));
  const runIndexByRootId = new Map();

  for (const asset of assets) {
    if (asset.kind !== 'GENERATED') continue;
    const createdAt = timestamp(asset.createdAt);
    const runIndex = orderedRuns.findIndex((run, index) => {
      const previousRunAt = index === 0 ? Number.NEGATIVE_INFINITY : timestamp(orderedRuns[index - 1].createdAt);
      return createdAt > previousRunAt && createdAt <= timestamp(run.createdAt);
    });
    if (runIndex >= 0) runIndexByRootId.set(asset.id, runIndex);
  }

  const historical = new Map();
  const references = [];
  for (const asset of assets) {
    if (asset.kind === 'REFERENCE') {
      references.push(asset);
      continue;
    }
    const root = rootAsset(asset, assetById);
    const runIndex = root ? runIndexByRootId.get(root.id) : undefined;
    if (runIndex !== undefined) {
      runBatches[runIndex].assets.push(asset);
      continue;
    }
    const key = `${root?.sourceTextRevisionId ?? 'none'}:${root?.visualPlanSha256 ?? root?.id ?? asset.id}`;
    if (!historical.has(key)) {
      historical.set(key, {
        id: `historical-${key}`,
        kind: 'historical',
        run: null,
        assets: [],
        isCurrent: false,
      });
    }
    historical.get(key).assets.push(asset);
  }

  const generationBatches = runBatches.reverse().map((batch) => ({
    ...batch,
    assets: sortedAssets(batch.assets),
    isCurrent: batch.assets.some((asset) => asset.sourceTextRevisionId === currentTextRevisionId),
  }));
  const historicalBatches = [...historical.values()].map((batch) => ({
    ...batch,
    assets: sortedAssets(batch.assets),
    isCurrent: batch.assets.some((asset) => asset.sourceTextRevisionId === currentTextRevisionId),
  })).sort((left, right) => timestamp(right.assets.at(-1)?.createdAt) - timestamp(left.assets.at(-1)?.createdAt));
  const referenceBatch = references.length > 0 ? [{
    id: 'reference-assets',
    kind: 'reference',
    run: null,
    assets: sortedAssets(references),
    isCurrent: false,
  }] : [];

  return [...generationBatches, ...historicalBatches, ...referenceBatch];
}

export function imageNeedsCrop(width, height) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return false;
  return Math.abs((width / height) - 0.75) > 0.005;
}

export function qualityDimensionRows(run) {
  const dimensions = run?.qcDetail?.rubric?.dimensions;
  if (!dimensions || typeof dimensions !== 'object' || Array.isArray(dimensions)) return [];
  return Object.entries(DIMENSION_LABELS).flatMap(([key, label]) => {
    const dimension = dimensions[key];
    if (!dimension || dimension.applicable === false) return [];
    return [{
      key,
      label,
      score: Number.isInteger(dimension.score) ? dimension.score : null,
      evidence: Array.isArray(dimension.evidence)
        ? dimension.evidence.filter((item) => typeof item === 'string' && item.trim() !== '')
        : [],
    }];
  });
}

function summarizeRunFailure(error) {
  const value = String(error ?? '').replace(/\s+/g, ' ').trim();
  if (/requires Node|PATH searched|Detected: node/i.test(value)) {
    return '运行环境版本不兼容，请检查 Node.js 与 OpenClaw 配置。';
  }
  if (/blocked URL fetch|SsrFBlockedError|private\/internal\/special-use|Blocked hostname/i.test(value)) {
    return '模型网络请求被安全策略拦截，请检查网络与代理配置。';
  }
  if (/does not contain a valid JSON object|invalid JSON|结构校验/i.test(value)) {
    return '模型返回格式不符合要求，未生成可用结果。';
  }
  if (/Unknown model|legacy provider ID|model configuration/i.test(value)) {
    return '模型配置不可用，请检查当前模型与服务商配置。';
  }
  if (/UND_ERR_SOCKET|terminated|other side closed|socket/i.test(value)) {
    return '图片生成连接中断，请检查网络后重试。';
  }
  if (/quality gate blocked/i.test(value)) {
    return '本批次未通过质量门禁，请查看本批次质检结果后修正。';
  }
  if (!value) return '运行未完成，且没有保存具体原因。';
  return value.length > 160 ? `${value.slice(0, 157)}…` : value;
}

export function qualityReasons(run) {
  if (!run) return ['尚无生成和质检记录。'];
  const rubric = run.qcDetail?.rubric;
  const rows = qualityDimensionRows(run);
  const rowByKey = new Map(rows.map((row) => [row.key, row]));
  const issueLabels = Array.isArray(rubric?.issueLabels) ? rubric.issueLabels : [];
  const issuesByLabel = new Map(issueLabels.map((issue) => [issue.label, issue]));
  const obstacles = Array.isArray(rubric?.lowestObstacleDimensions)
    ? rubric.lowestObstacleDimensions
    : [];
  const reasons = [];

  for (const obstacle of obstacles) {
    if (typeof obstacle !== 'string') continue;
    if (obstacle.startsWith('issue:')) {
      const label = obstacle.slice('issue:'.length);
      const issue = issuesByLabel.get(label);
      if (issue?.evidence) reasons.push(`${label}：${issue.evidence}`);
      continue;
    }
    const row = rowByKey.get(obstacle);
    if (row) reasons.push(`${row.label}：${row.evidence[0] ?? `${row.score ?? '—'} 分是当前最低项。`}`);
  }

  if (reasons.length === 0 && rows.length > 0) {
    const numericScores = rows.map(({ score }) => score).filter(Number.isInteger);
    const minimum = numericScores.length > 0 ? Math.min(...numericScores) : null;
    const candidates = minimum === null ? rows : rows.filter(({ score }) => score === minimum);
    for (const row of candidates.slice(0, 3)) {
      reasons.push(`${row.label}：${row.evidence[0] ?? `${row.score ?? '—'} 分。`}`);
    }
  }
  if (reasons.length > 0) return [...new Set(reasons)].slice(0, 4);
  if (run.qcScore !== null && run.qcScore !== undefined) {
    return ['该历史批次只保存了总分，未保存逐项评分证据；请结合图片和人工审核结果复核。'];
  }
  if (run.error) return [`运行失败：${summarizeRunFailure(run.error)}`];
  return ['本批次尚未产生可用评分。'];
}

export { DIMENSION_LABELS };
