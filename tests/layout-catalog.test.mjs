import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_LAYOUT_CATALOG, normalizeLayoutCatalog, importLayoutTemplates, matchingLayoutTemplates } from '../server/src/layout-catalog.mjs';
import { layoutGeometry } from '../src/layout-contract.mjs';

test('reference catalog contains 27 templates in 10 families without changing legacy geometry', () => {
  const catalog = normalizeLayoutCatalog(BUILTIN_LAYOUT_CATALOG);
  assert.equal(catalog.templates.length, 27);
  assert.equal(new Set(catalog.templates.map(item => item.layoutKind)).size, 10);
  assert.match(catalog.templates.find(item => item.layoutTemplate === 'HERO_LEFT').subjectRegion, /左/);
  assert.match(layoutGeometry('HERO_LEFT').subjectRegion, /右/);
});

test('matching uses content role and actual bullet count, allowing radial detail pages', () => {
  const page = { kind: 'detail', bullets: ['A', 'B', 'C'] };
  const templates = matchingLayoutTemplates(BUILTIN_LAYOUT_CATALOG, page);
  assert.ok(templates.some(item => item.layoutKind === 'radial'));
  assert.ok(!templates.some(item => item.layoutKind === 'hero'));
  const steps = matchingLayoutTemplates(BUILTIN_LAYOUT_CATALOG, { kind: 'steps', bullets: ['A', 'B', 'C', 'D'] });
  assert.ok(!steps.some(item => item.layoutTemplate === 'STEPS_TRIANGLE'));
  assert.ok(steps.some(item => item.layoutTemplate === 'STEPS_VERTICAL'));
});

test('imports are atomic, idempotent and do not overwrite a template version', () => {
  const empty = { schemaVersion: 2, selectionMode: 'MODEL', templates: [] };
  const first = importLayoutTemplates(empty, BUILTIN_LAYOUT_CATALOG.templates);
  assert.equal(first.added, 27);
  const again = importLayoutTemplates(first.catalog, BUILTIN_LAYOUT_CATALOG.templates);
  assert.equal(again.added, 0);
  assert.equal(again.unchanged, 27);
  assert.deepEqual(first.catalog, again.catalog);
  const changed = { ...first.catalog.templates[0], subjectRegion: '改动已存在的版本' };
  assert.throws(() => importLayoutTemplates(first.catalog, [changed]), /版本.*冲突/);
  assert.throws(() => importLayoutTemplates(empty, [first.catalog.templates[0], { ...changed, layoutTemplate: '../bad' }]), /编码/);
  assert.equal(empty.templates.length, 0);
});

test('model imports force candidates disabled and reject unknown fields', () => {
  const item = BUILTIN_LAYOUT_CATALOG.templates[0];
  const result = importLayoutTemplates(null, [item], { source: 'MODEL' });
  assert.equal(result.catalog.templates[0].enabled, false);
  assert.equal(result.catalog.templates[0].source, 'MODEL');
  assert.throws(() => importLayoutTemplates(null, [{ ...item, sql: 'DROP TABLE tasks' }]), /字段/);
  assert.throws(() => normalizeLayoutCatalog({ ...BUILTIN_LAYOUT_CATALOG, templates: [{ ...item, minItems: 7, maxItems: 2 }] }), /数量/);
});

test('pasted model JSON can omit program fields and reimport preserves activation and provenance', () => {
  const item = { ...BUILTIN_LAYOUT_CATALOG.templates[0] };
  delete item.enabled; delete item.source;
  const first = importLayoutTemplates(null, [item], { source: 'MANUAL' });
  assert.equal(first.catalog.templates[0].enabled, false);
  assert.equal(first.catalog.templates[0].source, 'MANUAL');
  const again = importLayoutTemplates(first.catalog, [{ ...BUILTIN_LAYOUT_CATALOG.templates[0], enabled: true }]);
  assert.deepEqual(again.catalog, first.catalog);
  assert.equal(again.unchanged, 1);
});
