import { join } from 'node:path';
import sharp from 'sharp';

export async function evaluateDelivery({ post, images, outputDir, mode, expectedImageCount = 3 }) {
  const checks = [];
  const issues = [];

  checks.push({ id: 'title_length', passed: [...post.title].length <= 25 });
  checks.push({ id: 'body_length', passed: [...post.body].length >= 200 && [...post.body].length <= 1_200 });
  checks.push({
    id: 'image_count',
    passed: images.length === expectedImageCount,
    observed: { actual: images.length, expected: expectedImageCount },
  });
  checks.push({ id: 'fabricated_experience', passed: post.fabricatedExperience === false });
  checks.push({ id: 'risk_flags', passed: post.riskFlags.length === 0 });
  checks.push({ id: 'unverified_claims', passed: post.unverifiedClaims.length === 0 });

  for (const image of images) {
    const metadata = await sharp(join(outputDir, image.file)).metadata();
    const passed = metadata.format === 'png' && metadata.width === 1080 && metadata.height === 1440;
    checks.push({
      id: `image_${image.file}`,
      passed,
      observed: { format: metadata.format, width: metadata.width, height: metadata.height },
    });
  }

  if (post.expressionReferences.length === 0 || post.platform.sampleEvidence === 'not_provided') {
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

  const mechanicalFailure = checks.some((check) => !check.passed);
  const hasBlockingIssue = issues.some((issue) => issue.severity === 'blocking');
  let overallScore = 2;
  let disposition = 'manual_review_required';
  if (mode === 'mock') {
    overallScore = 1;
    disposition = 'mock_only';
    issues.unshift({
      severity: 'blocking',
      label: '图片来源-Mock',
      evidence: '主图是程序占位图，不是 OpenClaw 真实生成结果，禁止发布。',
    });
  } else if (mechanicalFailure || hasBlockingIssue) {
    overallScore = 1;
    disposition = 'blocked';
  }

  return {
    scene: 'production_acceptance',
    overallScore,
    disposition,
    targetPlatform: '小红书',
    expressionType: '信息型',
    checks,
    issues,
    limitations: [
      '机械质检不能判断 AI 结构异常、构图美观、版权来源或站内重复，发布前仍需人工看图。',
      '没有平台样本证据时，平台表达适配最高只能按 2 分处理。',
    ],
  };
}
