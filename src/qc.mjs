import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';

import { DELIVERY_IMAGE_HEIGHT, DELIVERY_IMAGE_WIDTH } from './image-output-contract.mjs';
import {
  normalizeQualityDimensionAssessment,
  scoreQualityAssessment,
} from './quality-scoring.mjs';

const FORBIDDEN_TITLE_HOOKS = /(不看后悔|错过再等|完爆|吊打|跪着看完|一篇看懂|一文看懂|一次讲清|原因竟是|万万没想到)/u;
const EMOJI = /\p{Extended_Pictographic}|\u20E3/u;

function dimension(score, evidence, source = 'mechanical', applicable = true) {
  return { score, evidence: [evidence], source, applicable };
}

function checkPassed(checks, id) {
  return checks.find((check) => check.id === id)?.passed === true;
}

function mergeRubricAssessment(mechanical, external) {
  if (!external) return mechanical;
  const dimensions = { ...mechanical.dimensions };
  for (const [name, assessment] of Object.entries(external.dimensions ?? {})) {
    const normalizedExternal = normalizeQualityDimensionAssessment(name, assessment);
    const baseline = dimensions[name];
    if (!baseline) {
      dimensions[name] = normalizedExternal;
      continue;
    }
    if (!baseline.applicable) {
      dimensions[name] = {
        score: null,
        evidence: [...baseline.evidence, ...normalizedExternal.evidence],
        source: 'hybrid',
        applicable: false,
      };
      continue;
    }
    if (!normalizedExternal.applicable) {
      dimensions[name] = {
        ...baseline,
        evidence: [...baseline.evidence, ...normalizedExternal.evidence],
        source: 'hybrid',
      };
      continue;
    }
    if (baseline.score <= 1) {
      dimensions[name] = {
        ...normalizedExternal,
        score: Math.min(baseline.score, normalizedExternal.score),
        evidence: [...baseline.evidence, ...normalizedExternal.evidence],
        source: 'hybrid',
        applicable: baseline.applicable,
      };
      continue;
    }
    dimensions[name] = {
      ...normalizedExternal,
      evidence: [...baseline.evidence, ...normalizedExternal.evidence],
      source: 'hybrid',
    };
  }
  return {
    ...mechanical,
    dimensions,
    issueLabels: [...mechanical.issueLabels, ...(external.issueLabels ?? [])],
    typeAdjustments: external.typeAdjustments ?? [],
    platformSampleEvidence: ['human', 'vlm'].includes(
      external.dimensions?.platformAdaptation?.source,
    ) && external.dimensions?.platformAdaptation?.score === 3
      ? 'direct_review'
      : mechanical.platformSampleEvidence,
  };
}

function hasDirectPlatformReview(assessment) {
  const platform = assessment?.dimensions?.platformAdaptation;
  return ['human', 'vlm'].includes(platform?.source) && platform?.score === 3;
}

function buildMechanicalRubricAssessment({ post, images, checks, issues, mode }) {
  const imageFilesPassed = checks
    .filter((check) => check.id.startsWith('image_')
      && !['image_count', 'image_text_alignment'].includes(check.id))
    .every((check) => check.passed);
  const modelSourcesPassed = checkPassed(checks, 'model_image_sources');
  const alignmentPassed = checkPassed(checks, 'image_text_alignment');
  const duplicateImagesPassed = checkPassed(checks, 'duplicate_images');
  const imageCountPassed = checkPassed(checks, 'image_count');
  const contentShapePassed = [
    'title_length',
    'body_length',
    'title_quality',
    'body_emoji',
    'fabricated_experience',
  ].every((id) => checkPassed(checks, id));
  const factsPassed = checkPassed(checks, 'unverified_claims') && checkPassed(checks, 'risk_flags');
  const imageBasePassed = mode === 'live' && imageFilesPassed && modelSourcesPassed && factsPassed;
  const platformSampleEvidence = post.platform.sampleEvidence === 'sufficient'
    ? 'sufficient'
    : post.platform.sampleEvidence === 'limited'
      ? 'limited'
      : 'missing';
  return {
    dimensions: {
      queryRelevance: dimension(
        2,
        '机械检查只能确认结构和主题字段存在，不能完成 Query 语义终审，保守记 2。',
      ),
      contentOriginality: dimension(
        duplicateImagesPassed ? null : 1,
        duplicateImagesPassed
          ? '交付图片文件哈希均不同；未提供站内正文和图集候选，保留未核验标识，但不参与最终评分。'
          : '交付图片存在字节级重复，内容重复性记 1。',
        'mechanical',
        !duplicateImagesPassed,
      ),
      imageBaseQuality: dimension(
        imageBasePassed ? 2 : 1,
        imageBasePassed
          ? '图片来源、PNG 尺寸和机械安全字段通过；清晰度、版权和红线仍需终审，最高记 2。'
          : mode === 'mock'
            ? 'Mock 图片不是模型真实生成结果，基础质量不可通过。'
            : '至少一项图片来源、尺寸、格式或机械安全检查失败。',
      ),
      imageTextQuality: dimension(
        alignmentPassed && factsPassed ? 2 : 1,
        alignmentPassed && factsPassed
          ? '图文视觉验收和事实字段通过；完整语义质量仍需人工终审，最高记 2。'
          : '图文视觉验收失败，或成稿仍包含待核验事实/风险。',
      ),
      imageConsistency: dimension(
        alignmentPassed ? 2 : 1,
        alignmentPassed
          ? '逐页风格和布局验收通过；机械证据不足以认证高标准一致性，最高记 2。'
          : '至少一页未通过风格、布局或图文一致性验收。',
      ),
      noteTone: dimension(
        contentShapePassed ? 2 : 1,
        contentShapePassed
          ? '标题、正文长度、标题质量、emoji 和虚构经历检查通过；自然度仍需人工终审。'
          : '标题、正文、emoji、标题质量或虚构经历检查失败。',
      ),
      platformAdaptation: dimension(
        2,
        platformSampleEvidence === 'sufficient'
          ? '已提供平台表达样本，但机械检查不足以认证 3 分平台表达。'
          : '平台样本不足或未核验，平台表达适配按规则最高记 2。',
      ),
      informationValue: dimension(
        factsPassed && checkPassed(checks, 'body_length') ? 2 : 1,
        factsPassed && checkPassed(checks, 'body_length')
          ? '正文长度与事实字段通过；信息完整性和行动价值仍需人工终审，最高记 2。'
          : '正文基础长度失败，或仍包含待核验事实/风险。',
      ),
      imageAesthetics: dimension(
        imageFilesPassed && alignmentPassed ? 2 : 1,
        imageFilesPassed && alignmentPassed
          ? '图片格式、尺寸和视觉验收通过；机械检查不能认证高标准美观度，最高记 2。'
          : '图片格式、尺寸或视觉验收失败。',
      ),
      imageDiversity: dimension(
        duplicateImagesPassed && imageCountPassed ? 2 : 1,
        duplicateImagesPassed && imageCountPassed
          ? `${images.length} 张图片文件内容不同且数量符合要求；信息形态多样性仍需终审。`
          : '图片数量不足或存在重复图片。',
      ),
    },
    issueLabels: issues
      .filter(({ severity }) => severity === 'warning')
      .map((issue) => ({ severity: 'minor', label: issue.label, evidence: issue.evidence })),
    typeAdjustments: [],
    targetPlatform: post.platform.target ?? '小红书',
    platformSampleEvidence,
  };
}

export async function evaluateDelivery({
  post,
  images,
  outputDir,
  mode,
  expectedImageCount = 3,
  rubricAssessment = null,
}) {
  const checks = [];
  const issues = [];

  checks.push({ id: 'title_length', passed: [...post.title].length <= 25 });
  checks.push({ id: 'body_length', passed: [...post.body].length >= 200 && [...post.body].length <= 700 });
  checks.push({
    id: 'body_recommended_length',
    passed: [...post.body].length >= 400 && [...post.body].length <= 600,
    blocking: false,
    observed: { characters: [...post.body].length, recommended: '400-600' },
  });
  checks.push({
    id: 'title_quality',
    passed: !FORBIDDEN_TITLE_HOOKS.test(post.title) && !/[!！~～]/u.test(post.title) && !EMOJI.test(post.title),
  });
  checks.push({ id: 'body_emoji', passed: !EMOJI.test(post.body) });
  checks.push({
    id: 'image_count',
    passed: images.length === expectedImageCount,
    observed: { actual: images.length, expected: expectedImageCount },
  });
  const nonModelImages = images.filter((image) =>
    !['openclaw', 'openclaw-image-edit'].includes(image.provider));
  checks.push({
    id: 'model_image_sources',
    passed: mode !== 'live' || nonModelImages.length === 0,
    observed: { providers: images.map((image) => image.provider ?? null) },
  });
  const unalignedImages = images.filter((image) => image.alignment?.passed !== true);
  checks.push({
    id: 'image_text_alignment',
    passed: mode !== 'live' || unalignedImages.length === 0,
    observed: {
      validationMode: mode === 'live' ? 'required' : 'not_run_for_mock',
      failedFiles: mode === 'live' ? unalignedImages.map((image) => image.file) : [],
      failureClasses: mode === 'live'
        ? unalignedImages.map((image) => image.alignment?.failureClass ?? 'NOT_VALIDATED')
        : [],
    },
  });
  checks.push({ id: 'fabricated_experience', passed: post.fabricatedExperience === false });
  checks.push({ id: 'risk_flags', passed: post.riskFlags.length === 0 });
  checks.push({ id: 'unverified_claims', passed: post.unverifiedClaims.length === 0 });

  const imageHashes = [];
  for (const image of images) {
    const imagePath = join(outputDir, image.file);
    const [metadata, content] = await Promise.all([sharp(imagePath).metadata(), readFile(imagePath)]);
    const passed = metadata.format === 'png'
      && metadata.width === DELIVERY_IMAGE_WIDTH
      && metadata.height === DELIVERY_IMAGE_HEIGHT;
    imageHashes.push(createHash('sha256').update(content).digest('hex'));
    checks.push({
      id: `image_${image.file}`,
      passed,
      observed: { format: metadata.format, width: metadata.width, height: metadata.height },
    });
  }
  const uniqueImageHashes = new Set(imageHashes);
  checks.push({
    id: 'duplicate_images',
    passed: uniqueImageHashes.size === imageHashes.length,
    observed: { total: imageHashes.length, unique: uniqueImageHashes.size },
  });

  if (!hasDirectPlatformReview(rubricAssessment)
    && (post.expressionReferences.length === 0 || post.platform.sampleEvidence === 'not_provided')) {
    issues.push({
      severity: 'warning',
      label: '平台表达适配-材料不足',
      evidence: '未提供或未核验同题/同类型平台表达样本，不能声称完成平台表达终审。',
    });
  }
  if (post.unverifiedClaims.length > 0) {
    issues.push({
      severity: 'blocking',
      label: '参考资料-缺失',
      evidence: `存在 ${post.unverifiedClaims.length} 条待核验事实。`,
    });
  }
  if (post.riskFlags.length > 0) {
    issues.push({
      severity: 'blocking',
      label: '安全合规-严重问题',
      evidence: `模型标记 ${post.riskFlags.length} 条风险。`,
    });
  }
  if (FORBIDDEN_TITLE_HOOKS.test(post.title)) {
    issues.push({
      severity: 'blocking',
      label: '内容-标题问题',
      evidence: '标题包含原始规则明令禁止的夸张悬念表达。',
    });
  }
  if (uniqueImageHashes.size !== imageHashes.length) {
    issues.push({
      severity: 'blocking',
      label: '配图-重复配图',
      evidence: `交付图片 ${imageHashes.length} 张，其中仅 ${uniqueImageHashes.size} 个不同文件内容。`,
    });
  }
  if (mode === 'live' && nonModelImages.length > 0) {
    issues.push({
      severity: 'blocking',
      label: '图片来源-非模型生成',
      evidence: `Live 交付中有 ${nonModelImages.length} 张图片不是由图像模型生成。`,
    });
  }
  if (mode === 'live' && unalignedImages.length > 0) {
    issues.push({
      severity: 'blocking',
      label: '图文匹配-视觉验收失败',
      evidence: `${unalignedImages.length} 张图片未通过正文、简体中文、风格或布局验收。`,
    });
  }

  if (mode === 'mock') {
    issues.unshift({
      severity: 'blocking',
      label: '图片来源-Mock',
      evidence: '主图是程序占位图，不是 OpenClaw 真实生成结果，禁止发布。',
    });
  }
  const rubric = scoreQualityAssessment(mergeRubricAssessment(
    buildMechanicalRubricAssessment({ post, images, checks, issues, mode }),
    rubricAssessment,
  ));
  const overallScore = rubric.finalScore;
  const disposition = mode === 'mock'
    ? 'mock_only'
    : overallScore <= 1
      ? 'blocked'
      : 'manual_review_required';

  return {
    scene: 'production_acceptance',
    overallScore,
    disposition,
    targetPlatform: '小红书',
    expressionType: '信息型',
    checks,
    issues,
    rubric,
    limitations: [
      '机械质检不能判断 AI 结构异常、构图美观、版权来源或站内重复；未提供站内候选时保留原创度未核验标识，但不参与最终评分。',
      '没有平台样本证据时，平台表达适配最高只能按 2 分处理。',
    ],
  };
}
