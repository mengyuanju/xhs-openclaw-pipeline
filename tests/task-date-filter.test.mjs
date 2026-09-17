import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeTaskDateRange, shanghaiCalendarDate } from '../src/control-plane/task-date-filter.mjs';
import { normalizeSavedTaskView } from '../server/src/task-view-filters.mjs';

test('task date ranges accept real calendar dates and inclusive single-day ranges', () => {
  assert.deepEqual(normalizeTaskDateRange('2024-02-29', '2024-02-29'), {
    createdDateFrom: '2024-02-29', createdDateTo: '2024-02-29',
  });
  assert.deepEqual(normalizeTaskDateRange('', undefined), {
    createdDateFrom: null, createdDateTo: null,
  });
});

test('default task date follows the Shanghai calendar day', () => {
  assert.equal(shanghaiCalendarDate('2026-09-16T15:59:59.999Z'), '2026-09-16');
  assert.equal(shanghaiCalendarDate('2026-09-16T16:00:00.000Z'), '2026-09-17');
  assert.throws(() => shanghaiCalendarDate('not-a-date'), /invalid/u);
});

test('task date ranges reject impossible dates, non-date input and reversed ranges', () => {
  for (const [from, to] of [
    ['2026-02-29', null], ['2026-13-01', null], ['17/09/2026', null],
    ['2026-09-18', '2026-09-17'], [[], null],
  ]) {
    assert.throws(() => normalizeTaskDateRange(from, to), /date|after|YYYY/ui);
  }
});

test('saved administrator views retain creation date filters and default old views safely', () => {
  const base = { name: '九月失败作业', viewKey: 'ALL_JOBS', filters: { state: 'IMAGE_FAILED' } };
  assert.deepEqual(
    normalizeSavedTaskView(base).filters.createdDateFrom,
    '',
  );
  const saved = normalizeSavedTaskView({
    ...base,
    filters: { ...base.filters, createdDateFrom: '2026-09-01', createdDateTo: '2026-09-17' },
  });
  assert.equal(saved.filters.createdDateFrom, '2026-09-01');
  assert.equal(saved.filters.createdDateTo, '2026-09-17');
});
