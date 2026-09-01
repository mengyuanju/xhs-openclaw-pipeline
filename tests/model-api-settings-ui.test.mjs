import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

async function source(path) {
  return readFile(new URL(`../${path}`, import.meta.url), 'utf8');
}

describe('model API production settings UI', () => {
  it('accepts a strict nullable model API patch without credential fields', async () => {
    const route = await source('app/api/production-settings/route.ts');

    assert.match(route, /modelApi:\s*modelApiPatchSchema\.optional\(\)/u);
    assert.match(route, /textModel/u);
    assert.match(route, /screeningModel/u);
    assert.match(route, /reviewModel/u);
    assert.match(route, /visionModel/u);
    assert.match(route, /qualityModel/u);
    assert.match(route, /imageModel/u);
    assert.match(route, /modelProxyUrl/u);
    assert.match(route, /imageProxyUrl/u);
    assert.match(route, /imageTimeoutMs/u);
    assert.match(route, /copyGenerationProvider/u);
    assert.match(route, /dotsBaseUrl/u);
    assert.match(route, /dotsModel/u);
    assert.match(route, /\.nullable\(\)/u);
    assert.match(route, /\.strict\(\)/u);
    assert.doesNotMatch(route, /apiKey|accessToken|clientSecret/u);
  });

  it('renders model, proxy and timeout controls inside production settings', async () => {
    const [page, form, section] = await Promise.all([
      source('app/settings/page.tsx'),
      source('app/settings/production-settings-form.tsx'),
      source('app/settings/model-api-settings-section.tsx'),
    ]);

    assert.match(page, /publicModelApiStatus/u);
    assert.match(page, /effectiveModelApi=/u);
    assert.match(form, /<ModelApiSettingsSection/u);
    assert.match(form, /modelApi:\s*\{ \.\.\.current\.modelApi, \[key\]: value \}/u);
    assert.match(section, /模型 API 与网络/u);
    assert.match(section, /文本生成模型/u);
    assert.match(section, /需求检测模型/u);
    assert.match(section, /阶段审核模型/u);
    assert.match(section, /视觉验收模型/u);
    assert.match(section, /独立终审模型/u);
    assert.match(section, /图片生成模型/u);
    assert.match(section, /文本与视觉代理/u);
    assert.match(section, /图片生成代理/u);
    assert.match(section, /图片调用超时/u);
    assert.match(section, /独立文案提供方/u);
    assert.match(section, /Dots API 基础地址/u);
    assert.match(section, /Dots 模型/u);
    assert.match(section, /XHS_DOTS_API_KEY/u);
    assert.match(section, /不保存 API Key、Token 或 OAuth 授权码/u);
    assert.match(section, /恢复环境配置/u);
    assert.doesNotMatch(section, /name="(?:apiKey|accessToken|clientSecret)"/u);
  });
});
