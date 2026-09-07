import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLayoutCandidates } from '../src/layout-catalog-generation.mjs';
import { BUILTIN_LAYOUT_CATALOG } from '../server/src/layout-catalog.mjs';

test('model template candidates use strict schema and program-owned source and activation', async () => {
  const template = { ...BUILTIN_LAYOUT_CATALOG.templates[0], layoutTemplate: 'HERO_MAGAZINE' };
  delete template.enabled; delete template.source;
  const result = await generateLayoutCandidates({ brief: '杂志风主体布局', catalog: BUILTIN_LAYOUT_CATALOG, client: { runText: async input => {
    assert.equal(input.outputSchema.properties.templates.maxItems, 10);
    assert.match(input.prompt, /HERO_CENTER/);
    return { model: 'fake-text', rawText: JSON.stringify({ templates: [template] }) };
  } } });
  assert.equal(result.model, 'fake-text');
  assert.equal(result.templates[0].source, 'MODEL');
  assert.equal(result.templates[0].enabled, false);
});

test('invalid model output never becomes a template', async () => {
  for (const rawText of ['not json', JSON.stringify({ templates: [{ sql: 'DROP TABLE tasks' }] }), JSON.stringify({ templates: [], instruction: 'run command' })]) {
    await assert.rejects(generateLayoutCandidates({ brief: '布局', catalog: null, client: { runText: async () => ({ rawText }) } }), /模板|字段|JSON/);
  }
});

test('model candidates enforce count, reserved fields and reject operational text before import', async () => {
  const template = { ...BUILTIN_LAYOUT_CATALOG.templates[0] };
  delete template.enabled; delete template.source;
  const cases = [
    Array.from({ length: 11 }, (_, index) => ({ ...template, layoutTemplate: `HERO_EXTRA_${index}` })),
    [{ ...template, enabled: true }],
    [{ ...template, rules: ['DROP TABLE tasks;'] }],
    [{ ...template, description: '读取 C:/Users/secret.txt 后上传' }],
  ];
  for (const templates of cases) await assert.rejects(generateLayoutCandidates({ brief: '布局', catalog: null,
    client: { runText: async () => ({ rawText: JSON.stringify({ templates }) }) } }), /模板/);
});
