import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const page = readFileSync(new URL('../app/openclaw-traces/page.tsx', import.meta.url), 'utf8');
const dashboard = readFileSync(new URL('../app/openclaw-traces/trace-dashboard.tsx', import.meta.url), 'utf8');
const styles = readFileSync(new URL('../app/openclaw-traces/openclaw-traces.module.css', import.meta.url), 'utf8');
const route = readFileSync(new URL('../app/api/openclaw-traces/[id]/route.ts', import.meta.url), 'utf8');
const navigation = readFileSync(new URL('../app/components/side-nav.tsx', import.meta.url), 'utf8');
const topbar = readFileSync(new URL('../app/components/app-topbar.tsx', import.meta.url), 'utf8');

describe('OpenClaw trace diagnostics UI', () => {
  it('adds an administrator navigation entry and a readable trace dashboard', () => {
    const ui = `${page}\n${dashboard}`;
    assert.match(navigation, /href: '\/openclaw-traces'/u);
    assert.match(navigation, /label: '模型链路'/u);
    assert.match(topbar, /pathname\.startsWith\('\/openclaw-traces'\)/u);
    assert.match(ui, /OpenClaw → Codex/u);
    assert.match(ui, /aria-label="链路阶段"/u);
    assert.match(ui, /完整脱敏 JSON/u);
    assert.match(ui, /原始 capability envelope/u);
    assert.match(ui, /<details/u);
    assert.match(dashboard, /typeof value !== 'number'/u);
  });

  it('keeps the full trace download authenticated, bounded to a numeric job and non-cacheable', () => {
    assert.match(route, /apiHandler\(request, \{\}/u);
    assert.match(route, /parsePositiveId/u);
    assert.match(route, /collectOpenClawCodexTrace/u);
    assert.match(route, /OpenClawTraceNotFoundError/u);
    assert.match(route, /notFound\('链路任务不存在'\)/u);
    assert.match(route, /application\/json/u);
    assert.match(route, /attachment; filename=/u);
    assert.match(route, /private, no-store/u);
    assert.match(route, /nosniff/u);
  });

  it('adapts the diagnostics layout for narrow screens and reduced motion', () => {
    assert.match(styles, /@media \(max-width: 760px\)/u);
    assert.match(styles, /@media \(prefers-reduced-motion: reduce\)/u);
    assert.match(styles, /overflow-wrap: anywhere/u);
  });
});
