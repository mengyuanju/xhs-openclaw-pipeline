import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import sharp from 'sharp';

import {
  createDeterministicTextOverlaySvg,
  renderDeliveryImages,
} from '../src/images.mjs';

const directories = [];

async function makeDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'xhs-images-'));
  directories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function postFixture(imageCount = 3) {
  const imagePlan = [
    {
      kind: 'hero',
      headline: '桌面整理先做减法',
      subtitle: '低成本也能保持清爽',
      bullets: ['先清空', '再分区', '最后复位'],
      prompt: '真实租房卧室桌面，暖色自然光，展示给定标题和要点。',
    },
    {
      kind: 'steps',
      headline: '四步整理顺序',
      subtitle: '别从买收纳盒开始',
      bullets: ['清空桌面', '按频率分类', '给高频物品定位置', '设置复位区'],
      prompt: '呈现四步整理过程，严格使用给定步骤文字，保持暖色生活感。',
    },
    {
      kind: 'checklist',
      headline: '每天一分钟复位',
      subtitle: '睡前检查这三件事',
      bullets: ['垃圾离桌', '物品归位', '明天用品预留'],
      prompt: '呈现睡前复位检查场景，突出三个给定检查项，不新增内容。',
    },
    {
      kind: 'comparison',
      headline: '整理前后差在哪',
      subtitle: '位置比容器更重要',
      bullets: ['高频物品伸手可取', '低频物品移入抽屉'],
      prompt: '生成整理前后对比页，突出高频和低频物品的位置差异。',
    },
    {
      kind: 'summary',
      headline: '一张图记住复位法',
      subtitle: '每天照着做即可',
      bullets: ['清垃圾', '放回原位', '预留明日用品'],
      prompt: '生成整篇方法总结页，用三个给定动作形成清晰信息层级。',
    },
  ].slice(0, imageCount);
  return {
    title: '租房桌面整理，先别急着买收纳盒',
    imagePlan,
  };
}

describe('delivery images', () => {
  it('builds an escaped deterministic Simplified Chinese overlay with AI disclosure', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '<桌面整理>',
        subtitle: '先清空再分类',
        bullets: ['清空桌面', '固定位置'],
        labels: ['高频区'],
      },
      disclosure: 'AI生成',
      pageKind: 'steps',
    });

    assert.match(svg, /&lt;桌面整理&gt;/);
    assert.doesNotMatch(svg, /<桌面整理>/);
    assert.match(svg, /先清空再分类/);
    assert.match(svg, /AI生成/);
    assert.match(svg, /Microsoft YaHei/);
  });

  it('omits the disclosure layer when the production setting disables it', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '桌面整理',
        subtitle: '先清空再分类',
        bullets: ['清空桌面', '固定位置'],
        labels: [],
      },
      disclosure: '',
      pageKind: 'steps',
    });

    assert.doesNotMatch(svg, /AI生成/u);
    assert.doesNotMatch(svg, /data-overlay-role="disclosure"/u);
  });

  it('honors a right-top title contract without recreating a full-width bottom text panel', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '下单前问清规则',
        subtitle: '口头承诺尽量转成记录',
        bullets: ['明确返工范围', '确认订单凭证', '问清联系渠道', '确认相关费用'],
        labels: ['订单备注', '聊天记录'],
      },
      disclosure: 'AI生成',
      pageKind: 'steps',
      layoutDirection: '标题置于右上，文字区不超过画面高度的16%；左侧为四个纵向步骤节点。',
    });

    const titlePanel = svg.match(
      /<rect data-overlay-role="title-panel" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"/u,
    );
    assert.ok(titlePanel, 'expected a measurable title panel');
    const [, x, y, width, height] = titlePanel.map(Number);
    assert.ok(x >= 500, `expected right-side title panel, got x=${x}`);
    assert.ok(y < 1440 * 0.16, `expected top title panel, got y=${y}`);
    assert.ok(height <= 1440 * 0.16, `expected title height within 16%, got ${height}`);
    assert.ok(width < 1080, `expected a bounded title panel, got width=${width}`);
    assert.match(svg, /data-content-layout="vertical-flow"/u);
    assert.doesNotMatch(svg, /data-overlay-role="full-width-bottom-panel"/u);
  });

  it('keeps a detail page split when its lower region is also a horizontal sequence', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '贴完这样检查留证',
        subtitle: '先看整体位置，再补拍近景',
        bullets: ['熄屏检查边缘', '亮屏检查触控', '拍整体照片', '补拍近景', '说明售后信息'],
        labels: ['熄屏', '亮屏'],
      },
      pageKind: 'detail',
      layoutDirection: '左右分栏加底部横向序列骨架，左栏熄屏，右栏亮屏。',
    });

    assert.match(svg, /data-content-layout="split-sequence"/u);
  });

  it('does not add numbered text outside the visible-text whitelist', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '就业前景这样看',
        subtitle: '三项一起核对',
        bullets: ['结合毕业证书一起看', '结合教师资格要求一起看', '结合课程与实践经历一起看'],
        labels: [],
      },
      pageKind: 'hero',
      layoutDirection: '标题置于左上，左下放三条要点。',
    });

    assert.doesNotMatch(svg, />[123]<\/text>/u);
  });

  it('places step labels beside separate flow nodes instead of one bottom row', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '第一步，确认项目身份',
        subtitle: '招生宣传页不能替代正式简章',
        bullets: ['核对学校全称', '核对合作院校', '核对颁发证书', '核验办学项目'],
        labels: ['招生网', '正式简章', '教育主管部门'],
      },
      pageKind: 'steps',
      layoutDirection: '标题位于顶部左侧，中部为从左上到右下的折线动线串联三个核验节点。',
    });
    const labelY = [...svg.matchAll(
      /<g data-overlay-role="object-label">\s*<rect x="[\d.]+" y="([\d.]+)"/gu,
    )].map((match) => Number(match[1]));

    assert.equal(labelY.length, 3);
    assert.equal(new Set(labelY).size, 3);
    assert.ok(labelY.every((y) => y < 1_000));
  });

  it('places checklist cards in the middle grid reserved by the visual plan', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '报考前检查清单',
        subtitle: '逐项核对材料',
        bullets: ['确认项目备案', '核对证书模式', '查看就业报告', '核对招聘限制', '估算成本与支持'],
        labels: ['招生部门', '实习证明'],
      },
      pageKind: 'checklist',
      layoutDirection: '标题置于顶部居中，中上部为两列网格勾选卡。',
    });
    const firstCard = svg.match(
      /<g data-overlay-role="bullet-card">\s*<rect x="[\d.]+" y="([\d.]+)"/u,
    );

    assert.ok(firstCard);
    assert.ok(Number(firstCard[1]) < 600, `expected middle-grid cards, got y=${firstCard[1]}`);
    assert.equal((svg.match(/data-overlay-role="bullet-checkbox"/gu) ?? []).length, 5);
    assert.equal((svg.match(/data-overlay-role="bullet-checkmark"/gu) ?? []).length, 5);
  });

  it('moves a requested reminder subtitle into its own bottom strip', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '第一步，确认项目身份',
        subtitle: '招生宣传页不能替代正式简章',
        bullets: ['核对学校全称', '核对合作院校', '核对颁发证书'],
        labels: [],
      },
      pageKind: 'steps',
      layoutDirection: '标题位于顶部左侧，中部为步骤动线，底部横条承载提醒。',
    });
    const subtitlePanel = svg.match(
      /<rect data-overlay-role="subtitle-panel" x="[\d.]+" y="([\d.]+)"/u,
    );

    assert.ok(subtitlePanel);
    assert.ok(Number(subtitlePanel[1]) > 1_000);
  });

  it('uses a diagonal flow when the steps run from top-left to bottom-right', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '三步倒推就业',
        subtitle: '按顺序核验',
        bullets: ['确认项目身份', '倒推就业岗位', '判断实际优势'],
        labels: [],
      },
      pageKind: 'steps',
      layoutDirection: '主体视觉从左上向右下依次连接3个大型步骤节点。',
    });

    assert.match(svg, /data-content-layout="diagonal-flow"/u);
  });

  it('uses a two-column comparison matrix with a bottom conclusion card', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '培养与成本一起看',
        subtitle: '最后再做判断',
        bullets: ['培养模式', '课程实践', '学费成本', '时间投入', '结合家庭情况判断'],
        labels: [],
      },
      pageKind: 'comparison',
      layoutDirection: '主体为左右两列对比矩阵，左列2项，右列2项，底部横向放置结论条。',
    });

    assert.match(svg, /data-content-layout="comparison-matrix"/u);
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);
    assert.deepEqual(cardPositions.slice(0, 4), [
      [54, 380],
      [54, 520],
      [554, 380],
      [554, 520],
    ]);
  });

  it('groups a three-item project record left and two certificate notes right', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '先核对项目身份',
        subtitle: '证书结构不要直接理解为双学位',
        bullets: ['专业代码040106H', '学制4年', '招生年份为2023—2027年', '本科毕业证书和学位证书', '外方不颁发证书'],
        labels: [],
      },
      pageKind: 'detail',
      layoutDirection: '左右分栏，左侧3项项目信息，右侧2条证书说明。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.match(svg, /data-content-layout="detail-split"/u);
    assert.deepEqual(cardPositions, [
      [52, 360], [52, 500], [52, 640],
      [558, 360], [558, 500],
    ]);
  });

  it('uses four explicit comparison columns when the visual plan requests four columns', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '用招聘公告判断就业',
        subtitle: '逐条核对条件',
        bullets: ['记录地区', '核对学历', '核对专业', '整理教师资格要求', '以每则招聘公告为准'],
        labels: [],
      },
      pageKind: 'comparison',
      layoutDirection: '下半区为4列匹配矩阵，每列对应1条检查内容。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.match(svg, /data-content-layout="four-column-matrix"/u);
    assert.deepEqual(cardPositions.slice(0, 4), [
      [42, 760], [294, 760], [546, 760], [798, 760],
    ]);
  });

  it('places checklist steps in a right-side vertical flow when requested', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '报考前做完这份清单',
        subtitle: '学费为25000元/学年',
        bullets: ['确认毕业证书', '核算4年学费', '抽查招聘公告', '整理教师资格', '不编造就业率'],
        labels: ['招生章程'],
      },
      pageKind: 'checklist',
      layoutDirection: '纵向步骤动线，右侧由上至下排列5个勾选节点。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.match(svg, /data-content-layout="right-checklist"/u);
    assert.ok(cardPositions.every(([x]) => x >= 570));
    assert.equal(new Set(cardPositions.map(([, y]) => y)).size, 5);
  });

  it('places detail information cards in a right-side vertical stack when requested', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '先把项目性质看清',
        subtitle: '学前教育专业本科项目',
        bullets: ['专业代码040106H', '招生年份为2023—2027年', '外方不颁发证书'],
        labels: ['绍兴文理学院'],
      },
      pageKind: 'detail',
      layoutDirection: '左侧为项目档案，右侧纵向排列3张信息卡。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.match(svg, /data-content-layout="right-detail"/u);
    assert.ok(cardPositions.every(([x]) => x >= 550));
  });

  it('uses the structured template instead of contradictory prose layout hints', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '先把项目性质看清',
        subtitle: '学前教育专业本科项目',
        bullets: ['专业代码040106H', '招生年份为2023—2027年', '外方不颁发证书'],
        labels: [],
      },
      pageKind: 'detail',
      layoutTemplate: 'DETAIL_RIGHT_STACK',
      layoutDirection: '把所有文字放在左下角的自由描述。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.equal(svg.match(/data-layout-template="([A-Z_]+)"/u)?.[1], 'DETAIL_RIGHT_STACK');
    assert.ok(cardPositions.every(([x]) => x >= 550));
  });

  it('places comparison bars in a right-side vertical stack when requested', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '成本与调整空间',
        subtitle: '不要把转专业当兜底',
        bullets: ['学费为25000元/学年', '不得转入其他招生类型', '考虑兴趣和职业方向'],
        labels: [],
      },
      pageKind: 'comparison',
      layoutDirection: '标题位于左侧，右侧自上而下排列3个横向比较条。',
    });
    const cardPositions = [...svg.matchAll(
      /<g data-overlay-role="bullet-card">\s*<rect x="([\d.]+)" y="([\d.]+)"/gu,
    )].map((match) => [Number(match[1]), Number(match[2])]);

    assert.match(svg, /data-content-layout="right-comparison"/u);
    assert.ok(cardPositions.every(([x]) => x >= 570));
  });

  it('moves a requested conclusion prompt to the bottom subtitle strip', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '报考前五项清单',
        subtitle: '以当次招聘公告为准',
        bullets: ['一', '二', '三', '四', '五'],
        labels: [],
      },
      pageKind: 'checklist',
      layoutDirection: '右侧排列5个检查项，底部放置结论提示。',
    });

    assert.match(svg, /data-overlay-role="subtitle-panel"/u);
  });

  it('keeps checklist cards in the lower half when the plan reserves an upper visual', () => {
    const svg = createDeterministicTextOverlaySvg({
      visibleText: {
        headline: '报考前检查清单',
        subtitle: '逐项核对材料',
        bullets: ['确认项目备案', '核对证书模式', '查看就业报告', '核对招聘限制', '估算成本与支持'],
        labels: [],
      },
      pageKind: 'checklist',
      layoutDirection: '上半区为文件特写，下半区为5张横向错落的检查卡。',
    });
    const firstCard = svg.match(
      /<g data-overlay-role="bullet-card">\s*<rect x="[\d.]+" y="([\d.]+)"/u,
    );

    assert.match(svg, /data-content-layout="lower-grid"/u);
    assert.ok(Number(firstCard?.[1]) >= 700);
  });

  it('renders three 1086x1448 PNG files in mock mode', async () => {
    const directory = await makeDirectory();

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: true,
    });

    assert.deepEqual(images.map((image) => image.file), [
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
    ]);
    for (const image of images) {
      const metadata = await sharp(join(directory, image.file)).metadata();
      assert.equal(metadata.format, 'png');
      assert.equal(metadata.width, 1086);
      assert.equal(metadata.height, 1448);
    }
    assert.ok(images.every((image) => image.provider === 'mock'));
  });

  it('escapes model text before rendering SVG-backed cards', async () => {
    const directory = await makeDirectory();
    const post = postFixture();
    post.imagePlan[1].headline = '<image href="file:///secret">';

    await renderDeliveryImages({ post, outputDir: directory, mock: true });

    const png = await readFile(join(directory, '02-steps.png'));
    assert.ok(png.length > 1_000);
  });

  it('calls the image model for every live delivery image and uses the first image as later style reference', async () => {
    const directory = await makeDirectory();
    const rawImages = await Promise.all(['#d7c7b0', '#c7d7b0', '#b0c7d7'].map((background) => sharp({
      create: { width: 1024, height: 1536, channels: 3, background },
    }).png().toBuffer()));
    const calls = [];
    const openclaw = {
      runImage({ prompt, outputPath }) {
        calls.push({ method: 'generate', prompt, inputPaths: [] });
        writeFileSync(outputPath, rawImages[calls.length - 1]);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        calls.push({ method: 'edit', prompt, inputPaths });
        writeFileSync(outputPath, rawImages[calls.length - 1]);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
    };
    const imagePrompts = [
      '第一页完整模型图片生成提示词',
      '第二页完整模型图片生成提示词',
      '第三页完整模型图片生成提示词',
    ];

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imagePrompts,
      visibleTextPlans: postFixture().imagePlan.map((page) => ({
        headline: page.headline,
        subtitle: page.subtitle,
        bullets: page.bullets,
        labels: [],
      })),
      layoutDirections: [
        '标题置于右上，文字区不超过画面高度的24%。',
        '标题置于左上，左侧为纵向步骤动线。',
        '标题置于顶部中央，中部为卡片清单。',
      ],
      complianceDisclosure: 'AI生成',
      textRenderingMode: 'model-native',
    });

    assert.equal(calls.length, 3);
    assert.deepEqual(calls.map(({ prompt }) => prompt), imagePrompts);
    assert.deepEqual(calls.map(({ method }) => method), ['generate', 'edit', 'edit']);
    for (const call of calls.slice(1)) {
      assert.ok(call.inputPaths.includes(join(directory, '.style-reference.png')));
      assert.ok(!call.inputPaths.includes(join(directory, '01-hero.png')));
    }
    assert.ok(images.every((image) => image.model === 'openai/gpt-image-2'));
    assert.ok(images.every((image) => image.provider !== 'local-template'));
    assert.ok(images.every((image) => image.textRenderer === 'gpt-image-native'));
    for (const image of images) {
      const metadata = await sharp(join(directory, image.file)).metadata();
      assert.deepEqual([metadata.width, metadata.height], [1086, 1448]);
    }
    const { data: firstPixels, info } = await sharp(join(directory, images[0].file))
      .raw()
      .toBuffer({ resolveWithObject: true });
    const rightTitlePixel = (150 * info.width + 750) * info.channels;
    assert.ok(firstPixels[rightTitlePixel] > 100, 'live output must not receive a dark Sharp title overlay');
  });

  it('finishes the first image before starting at most two later pages concurrently', async () => {
    const directory = await makeDirectory();
    const rawImage = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#c9d8c0' },
    }).png().toBuffer();
    let firstCompleted = false;
    let laterStarted = 0;
    let activeLater = 0;
    let maxActiveLater = 0;
    let releaseLater;
    let signalLaterStarted;
    const laterCallsStarted = new Promise((resolve) => { signalLaterStarted = resolve; });
    const laterGate = new Promise((resolve) => { releaseLater = resolve; });
    const openclaw = {
      async runImage({ outputPath }) {
        writeFileSync(outputPath, rawImage);
        firstCompleted = true;
        return { outputPath, model: 'fake-image' };
      },
      async runImageEdit({ inputPaths, outputPath }) {
        assert.equal(firstCompleted, true);
        assert.ok(inputPaths.includes(join(directory, '.style-reference.png')));
        laterStarted += 1;
        activeLater += 1;
        maxActiveLater = Math.max(maxActiveLater, activeLater);
        if (laterStarted === 1) signalLaterStarted();
        await laterGate;
        writeFileSync(outputPath, rawImage);
        activeLater -= 1;
        return { outputPath, model: 'fake-image-edit' };
      },
    };

    const rendering = renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imageConcurrency: 2,
      imagePrompts: ['第一页完整图片生成提示词', '第二页完整图片生成提示词', '第三页完整图片生成提示词'],
    });
    const signal = await Promise.race([
      laterCallsStarted.then(() => 'started'),
      rendering.then(() => 'completed', () => 'failed'),
    ]);
    let assertionError;
    try {
      assert.equal(signal, 'started');
      assert.equal(laterStarted, 2);
      assert.equal(maxActiveLater, 2);
    } catch (error) {
      assertionError = error;
    } finally {
      releaseLater();
    }
    const images = await rendering;
    if (assertionError) throw assertionError;
    assert.deepEqual(images.map(({ file }) => file), ['01-hero.png', '02-steps.png', '03-checklist.png']);
  });

  it('caps live image concurrency at two', async () => {
    const directory = await makeDirectory();
    await assert.rejects(
      () => renderDeliveryImages({
        post: postFixture(),
        outputDir: directory,
        mock: false,
        openclaw: {},
        imageConcurrency: 3,
        imagePrompts: ['第一页完整图片生成提示词', '第二页完整图片生成提示词', '第三页完整图片生成提示词'],
      }),
      /imageConcurrency must be an integer between 1 and 2/,
    );
  });

  it('falls back to standalone generation after a referenced edit exhausts transient transport retries', async () => {
    const directory = await makeDirectory();
    const rawImage = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#c9d8c0' },
    }).png().toBuffer();
    const calls = [];
    const openclaw = {
      runImage({ outputPath }) {
        calls.push('generate');
        writeFileSync(outputPath, rawImage);
        return { outputPath, model: 'openai/gpt-image-2' };
      },
      runImageEdit() {
        calls.push('edit');
        throw new Error('OpenClaw image edit failed: terminated | other side closed | UND_ERR_SOCKET');
      },
    };

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imagePrompts: ['第一页完整图片生成提示词', '第二页完整图片生成提示词', '第三页完整图片生成提示词'],
    });

    assert.equal(calls[0], 'generate');
    assert.equal(calls.filter((method) => method === 'edit').length, 2);
    assert.equal(calls.filter((method) => method === 'generate').length, 3);
    assert.ok(images.every((image) => image.provider === 'openclaw'));
  });

  it('retries a failed aligned page with a bounded repair instruction and records the final evidence', async () => {
    const directory = await makeDirectory();
    const rawImage = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#d7c7b0' },
    }).png().toBuffer();
    const imageCalls = [];
    const validationCalls = [];
    const heartbeats = [];
    const openclaw = {
      runImage({ prompt, outputPath }) {
        imageCalls.push({ prompt, inputPaths: [] });
        writeFileSync(outputPath, rawImage);
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ prompt, inputPaths, outputPath }) {
        imageCalls.push({ prompt, inputPaths });
        writeFileSync(outputPath, rawImage);
        return { outputPath, model: 'fake-image' };
      },
    };

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imagePrompts: ['第一页完整模型图片提示词', '第二页完整模型图片提示词', '第三页完整模型图片提示词'],
      maxGenerationAttempts: 3,
      textRenderingMode: 'model-native',
      async heartbeat(event) {
        heartbeats.push(event);
      },
      async validateImage({ pageIndex, attempt }) {
        validationCalls.push({ pageIndex, attempt });
        if (pageIndex === 2 && attempt === 1) {
          return { passed: false, failureClass: 'MINOR_TEXT', repairInstruction: '修正标题中的简体中文错字' };
        }
        return { passed: true, failureClass: 'PASS', repairInstruction: '' };
      },
    });

    assert.equal(imageCalls.length, 4);
    const repairCall = imageCalls.find(({ prompt }) => prompt.includes('修正标题中的简体中文错字'));
    assert.ok(repairCall);
    assert.deepEqual(repairCall.inputPaths, [join(directory, '02-steps.png')]);
    assert.equal(images[1].generationAttempts, 2);
    assert.equal(images[1].alignment.passed, true);
    assert.deepEqual(validationCalls.filter(({ pageIndex }) => pageIndex === 2), [
      { pageIndex: 2, attempt: 1 },
      { pageIndex: 2, attempt: 2 },
    ]);
    for (const event of [
      { stage: 'image_generation', pageIndex: 1, attempt: 1 },
      { stage: 'image_alignment', pageIndex: 1, attempt: 1 },
      { stage: 'image_generation', pageIndex: 2, attempt: 1 },
      { stage: 'image_alignment', pageIndex: 2, attempt: 1 },
      { stage: 'image_generation', pageIndex: 2, attempt: 2 },
      { stage: 'image_alignment', pageIndex: 2, attempt: 2 },
    ]) {
      assert.ok(heartbeats.some((candidate) => candidate.stage === event.stage
        && candidate.pageIndex === event.pageIndex && candidate.attempt === event.attempt));
    }
  });

  it('returns a failed alignment after the retry limit so QC can block the task', async () => {
    const directory = await makeDirectory();
    const rawImage = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: '#c7d7b0' },
    }).png().toBuffer();
    const openclaw = {
      runImage({ outputPath }) {
        writeFileSync(outputPath, rawImage);
        return { outputPath, model: 'fake-image' };
      },
      runImageEdit({ outputPath }) {
        writeFileSync(outputPath, rawImage);
        return { outputPath, model: 'fake-image' };
      },
    };

    const images = await renderDeliveryImages({
      post: postFixture(),
      outputDir: directory,
      mock: false,
      openclaw,
      imagePrompts: ['第一页完整模型图片提示词', '第二页完整模型图片提示词', '第三页完整模型图片提示词'],
      maxGenerationAttempts: 2,
      validateImage: async () => ({
        passed: false,
        failureClass: 'SEMANTIC',
        repairInstruction: '重新生成与当前页正文一致的场景',
      }),
    });

    assert.equal(images[0].generationAttempts, 2);
    assert.equal(images[0].alignment.passed, false);
    assert.ok(images.every((image) => image.alignment.passed === false));
  });

  it('requires an explicit plan for every requested delivery image', async () => {
    const directory = await makeDirectory();

    await assert.rejects(
      () => renderDeliveryImages({
        post: postFixture(3),
        outputDir: directory,
        mock: true,
        imageCount: 5,
      }),
      /imagePlan.*5/i,
    );
  });

  it('renders five explicitly planned mock delivery images without local template providers', async () => {
    const directory = await makeDirectory();
    const images = await renderDeliveryImages({
      post: postFixture(5),
      outputDir: directory,
      mock: true,
      imageCount: 5,
    });

    assert.deepEqual(images.map((image) => image.file), [
      '01-hero.png',
      '02-steps.png',
      '03-checklist.png',
      '04-comparison.png',
      '05-summary.png',
    ]);
    assert.ok(images.every((image) => image.provider === 'mock'));
  });
});
