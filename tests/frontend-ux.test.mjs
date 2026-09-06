import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const projectFile = (path) => new URL(`../${path}`, import.meta.url);

function relativeLuminance(hex) {
  const channels = hex.match(/[\da-f]{2}/gi).map((value) => Number.parseInt(value, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrastRatio(foreground, background) {
  const values = [relativeLuminance(foreground), relativeLuminance(background)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('mobile navigation stays compact and exposes the active page', async () => {
  const [navigation, styles] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(navigation, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(navigation, /aria-expanded=\{isMenuOpen\}/);
  assert.match(navigation, /aria-controls="primary-navigation"/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.nav-list\[data-open="true"\] \{ display: grid/);
  assert.match(styles, /@media \(max-width: 760px\)[\s\S]*\.nav-group-items \{[^}]*grid-template-columns: repeat\(2/);
  assert.match(styles, /\.nav-list \{[^}]*scrollbar-color: #5d5954 transparent;[^}]*scrollbar-width: thin;[^}]*scrollbar-gutter: stable;/);
  assert.match(styles, /\.nav-list::-webkit-scrollbar \{ width: 6px; \}/);
  assert.match(styles, /\.nav-list::-webkit-scrollbar-track \{ background: transparent; \}/);
  assert.match(styles, /\.nav-list::-webkit-scrollbar-button \{[^}]*display: none;/);
});

test('application shell groups product areas and keeps page context visible', async () => {
  const [frame, navigation, topbar, styles, packageJson] = await Promise.all([
    readFile(projectFile('app/components/app-frame.tsx'), 'utf8'),
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-topbar.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    readFile(projectFile('package.json'), 'utf8'),
  ]);

  assert.match(frame, /<AppTopbar\s*\/>/);
  assert.match(frame, /id="main-content"/);
  assert.match(navigation, /const navigationGroups[^=]*= \[/);
  for (const group of ['创作工作台', '内容资产', '运营与系统']) {
    assert.match(navigation, new RegExp(`label: '${group}'`));
  }
  assert.match(navigation, /aria-label="切换主导航"/);
  assert.match(navigation, /aria-expanded=\{isMenuOpen\}/);
  assert.match(topbar, /const routeMeta/);
  assert.match(topbar, /aria-label="当前位置"/);
  assert.match(topbar, /aria-current="page"/);
  assert.doesNotMatch(topbar, /本地工作区|导入选题|topbar-actions/);
  assert.doesNotMatch(navigation, /hidden: true|reviewNavigation/);
  assert.match(styles, /\.app-workspace\s*\{/);
  assert.match(styles, /\.app-topbar\s*\{/);
  assert.match(styles, /\.skip-link\s*\{/);
  assert.match(packageJson, /"lucide-react"/);
});

test('the unified knowledge base remains grouped with reusable content assets', async () => {
  const navigation = await readFile(projectFile('app/components/side-nav.tsx'), 'utf8');

  assert.match(navigation, /label: '内容资产',[\s\S]*href: '\/prompts'[\s\S]*href: '\/knowledge'/);
  assert.ok(navigation.indexOf("href: '/prompts'") < navigation.indexOf("href: '/knowledge'"));
  assert.ok(navigation.indexOf("href: '/knowledge'") < navigation.indexOf("href: '/settings'"));
});

test('primary section pages omit visible display headlines while keeping an accessible page name', async () => {
  const sectionPages = [
    ['app/prompts/page.tsx', '提示词'],
    ['app/settings/page.tsx', '生产配置'],
    ['app/knowledge/page.tsx', '知识库'],
  ];

  for (const [path, accessibleName] of sectionPages) {
    const page = await readFile(projectFile(path), 'utf8');
    assert.match(page, new RegExp(`<h1 className="sr-only">${accessibleName}<\\/h1>`));
    assert.doesNotMatch(page, /<h1(?! className="sr-only")/);
  }
});

test('file uploads use the branded, keyboard-focusable control', async () => {
  const [knowledgeWorkbench, styles] = await Promise.all([
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(knowledgeWorkbench, /className="input file-input" id="knowledge-image"/);
  assert.match(styles, /\.file-input::file-selector-button\s*\{/);
  assert.match(styles, /\.file-input:focus-visible\s*\{/);
});

test('generated assets open in an accessible centered Radix dialog preview', async () => {
  const [preview, imageBatch, dialog, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('components/ui/dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(preview, /export function ImagePreview/);
  assert.match(preview, /type="button"/);
  assert.match(preview, /<Dialog open=/);
  assert.match(preview, /<DialogContent/);
  assert.match(preview, /<DialogTitle/);
  assert.doesNotMatch(preview, /<dialog|showModal\(\)/);
  assert.match(preview, /aria-label="关闭图片预览"/);
  assert.match(preview, /预览与调整/);
  assert.match(imageBatch, /import \{ ImagePreview \}/);
  assert.match(dialog, /@radix-ui\/react-dialog/);
  assert.match(dialog, /fixed inset-0/);
  assert.match(dialog, /left-1\/2 top-1\/2/);
  assert.match(dialog, /-translate-x-1\/2 -translate-y-1\/2/);
  assert.match(styles, /\.image-preview-dialog/);
  assert.doesNotMatch(styles, /\.dialog-content\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.doesNotMatch(styles, /\.confirm-dialog-content\s*\{[^}]*transform:\s*translate\(-50%,\s*-50%\)/s);
  assert.match(styles, /\.image-preview-full/);
});

test('application dropdowns use the shared Radix select instead of native selects', async () => {
  const paths = [
    'app/knowledge/knowledge-workbench.tsx',
    'app/settings/production-settings-form.tsx',
  ];
  const [select, styles, ...screens] = await Promise.all([
    readFile(projectFile('components/ui/select.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
    ...paths.map((path) => readFile(projectFile(path), 'utf8')),
  ]);

  assert.match(select, /@radix-ui\/react-select/);
  assert.match(select, /SelectPrimitive\.Portal/);
  assert.match(select, /SelectPrimitive\.Viewport/);
  assert.match(select, /SelectPrimitive\.ItemIndicator/);
  assert.match(styles, /\.select-trigger\s*\{[^}]*min-width:\s*0/s);
  assert.match(
    styles,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*?\.select-trigger[^{}]*\.select-content[^{}]*\.dialog-overlay[^{}]*\.dialog-content[^{}]*\.confirm-dialog-content\s*\{[^}]*animation:\s*none/s,
  );
  for (const screen of screens) {
    assert.doesNotMatch(screen, /<select/);
    assert.match(screen, /<Select/);
    assert.match(screen, /<SelectTrigger/);
    assert.match(screen, /<SelectContent/);
  }
});

test('confirmation prompts use one accessible Radix alert dialog provider', async () => {
  const paths = [
    'app/knowledge/knowledge-workbench.tsx',
    'app/prompts/prompt-editor.tsx',
  ];
  const [confirmation, frame, ...screens] = await Promise.all([
    readFile(projectFile('components/ui/confirm-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-frame.tsx'), 'utf8'),
    ...paths.map((path) => readFile(projectFile(path), 'utf8')),
  ]);

  assert.match(confirmation, /@radix-ui\/react-alert-dialog/);
  assert.match(confirmation, /export function ConfirmDialogProvider/);
  assert.match(confirmation, /export function useConfirmDialog/);
  assert.match(confirmation, /<AlertDialogPrimitive\.Title/);
  assert.match(confirmation, /<AlertDialogPrimitive\.Description/);
  assert.match(confirmation, /returnFocusRef/);
  assert.match(confirmation, /requestAnimationFrame/);
  assert.match(frame, /<ConfirmDialogProvider>/);
  for (const screen of screens) {
    assert.doesNotMatch(screen, /window\.confirm/);
    assert.match(screen, /useConfirmDialog/);
  }
});

test('reviewers can switch image previews between 100 percent and full-image modes', async () => {
  const [preview, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(preview, /type PreviewMode = 'actual' \| 'fit'/);
  assert.match(preview, /useState<PreviewMode>\('actual'\)/);
  assert.match(preview, /aria-label="图片显示模式"/);
  assert.match(preview, />100% 查看</);
  assert.match(preview, />完整显示</);
  assert.match(preview, /aria-pressed=\{viewMode === 'fit'\}/);
  assert.match(preview, /disabled=\{viewMode === 'fit'\}/);
  assert.match(styles, /\.image-preview-viewport\.is-fit/);
  assert.match(styles, /\.image-preview-full\.is-fit[^}]*object-fit:\s*contain/s);
});

test('image previews navigate within a batch and keep fitted landscape images geometrically centered', async () => {
  const [preview, imageBatch, styles] = await Promise.all([
    readFile(projectFile('app/components/image-preview.tsx'), 'utf8'),
    readFile(projectFile('app/workbench/task-review-dialog.tsx'), 'utf8'),
    readFile(projectFile('app/globals.css'), 'utf8'),
  ]);

  assert.match(imageBatch, /useState<number \| null>\(null\)/);
  assert.match(imageBatch, /isOpen=\{activeAssetIndex === index\}/);
  assert.match(imageBatch, /onPrevious=\{index > 0/);
  assert.match(imageBatch, /onNext=\{index < assets\.length - 1/);
  assert.match(preview, /aria-label="上一张图片"/);
  assert.match(preview, /aria-label="下一张图片"/);
  assert.match(preview, /\{position\} \/ \{total\}/);
  assert.match(preview, /className=\{`image-preview-stage/);
  assert.match(styles, /\.image-preview-stage\.is-fit\s*\{[^}]*place-items:\s*unsafe center/s);
  assert.match(styles, /\.image-preview-stage\.is-fit\s*\{[^}]*grid-template:\s*minmax\(0, 1fr\) \/ minmax\(0, 1fr\)/s);
  assert.match(styles, /\.image-preview-full\.is-fit\s*\{[^}]*width:\s*auto[^}]*height:\s*auto[^}]*margin:\s*0/s);
  assert.match(styles, /\.image-preview-full\.is-fit\.is-quarter-turn\s*\{[^}]*max-width:\s*100cqh[^}]*max-height:\s*100cqw/s);
});

test('image previews retain local zoom and rotation', async () => {
  const preview = await readFile(projectFile('app/components/image-preview.tsx'), 'utf8');
  assert.match(preview, /type="range"/);
  assert.match(preview, /aria-label="调整预览倍数"/);
  assert.match(preview, /setRotation/);
});

test('current editors announce results and use explicit button behavior', async () => {
  for (const file of ['app/prompts/prompt-editor.tsx', 'app/knowledge/knowledge-workbench.tsx']) {
    const source = await readFile(projectFile(file), 'utf8');
    assert.match(source, /role=\{messageIsError \? 'alert' : 'status'\}/);
    assert.doesNotMatch(source, /<button(?![^>]*type=)[^>]*onClick=/);
  }
});

test('prompt editors allow publishing an unchanged non-empty version', async () => {
  const promptEditor = await readFile(projectFile('app/prompts/prompt-editor.tsx'), 'utf8');

  assert.match(promptEditor, /disabled=\{busy \|\| !content\.trim\(\)\}/);
  assert.doesNotMatch(promptEditor, /content\.trim\(\) === published\?\.content/);
});

test('primary actions and small login copy meet WCAG AA text contrast', async () => {
  const styles = await readFile(projectFile('app/globals.css'), 'utf8');
  const primaryRed = styles.match(/--red:\s*(#[\da-f]{6})/i)?.[1];
  const footnote = styles.match(/\.login-story \.login-footnote \{[^}]*color:\s*(#[\da-f]{6})/i)?.[1];

  assert.ok(primaryRed, 'primary red token must be a six-digit hex color');
  assert.ok(footnote, 'login footnote must use an explicit six-digit hex color');
  assert.ok(contrastRatio(primaryRed, '#ffffff') >= 4.5, 'white primary-button text needs 4.5:1 contrast');
  assert.ok(contrastRatio(footnote, '#20201f') >= 4.5, 'small login footnote text needs 4.5:1 contrast');
});

test('the unified knowledge base exposes visual and copy modules with accessible controls', async () => {
  const [navigation, topbar, page, tabs, workbench] = await Promise.all([
    readFile(projectFile('app/components/side-nav.tsx'), 'utf8'),
    readFile(projectFile('app/components/app-topbar.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/page.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-tabs.tsx'), 'utf8'),
    readFile(projectFile('app/knowledge/knowledge-workbench.tsx'), 'utf8'),
  ]);

  assert.match(navigation, /href: '\/knowledge', label: '知识库'/);
  assert.match(topbar, /pathname\.startsWith\('\/knowledge'\)[\s\S]*title: '知识库'/u);
  assert.match(tabs, /SHOW_KNOWLEDGE_TYPE_SWITCHER = false/u);
  assert.match(tabs, /useState<KnowledgeView>\('COPY'\)/u);
  assert.match(tabs, /role="tablist"/u);
  assert.match(tabs, /aria-selected/u);
  assert.match(tabs, /aria-controls/u);
  assert.match(workbench, /htmlFor="knowledge-image"/);
  assert.match(workbench, /PROMPT_ONLY/);
  assert.match(workbench, /IMAGE_AND_PROMPT/);
  assert.match(workbench, /role=\{messageIsError \? 'alert' : 'status'\}/);
  assert.doesNotMatch(workbench, /<button(?![^>]*type=)[^>]*onClick=/);
});
