import assert from 'node:assert/strict';
import test from 'node:test';
import { parsePageNumber, paginationBounds } from '../src/control-plane/workbench-pagination.mjs';

test('pagination covers the full result set, last partial page and an empty result', () => {
  assert.deepEqual(paginationBounds(257, 20, 13), { page: 13, totalPages: 13, offset: 240, start: 241, end: 257 });
  assert.deepEqual(paginationBounds(257, 100, 3), { page: 3, totalPages: 3, offset: 200, start: 201, end: 257 });
  assert.deepEqual(paginationBounds(0, 50, 7), { page: 1, totalPages: 1, offset: 0, start: 0, end: 0 });
  assert.equal(paginationBounds(5, 20, 13).page, 1);
});

test('page jump accepts only whole page numbers within the available range', () => {
  assert.equal(parsePageNumber(' 13 ', 13), 13);
  assert.equal(parsePageNumber('1', 13), 1);
  for (const value of ['', '0', '-1', '14', '1.5', '1e1', 'Infinity', 'NaN', 'abc', '9007199254740993']) {
    assert.equal(parsePageNumber(value, 13), null, value);
  }
});
