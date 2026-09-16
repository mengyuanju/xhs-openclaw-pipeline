import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isPersonalStateFilter,
  personalStateFilterCount,
  personalStateFilterStates,
} from '../app/workbench/personal-state-filters.ts';

test('simplified personal filters map only to existing lifecycle states', () => {
  assert.deepEqual(personalStateFilterStates('personalReview'), [
    'COPY_REVIEW_PENDING', 'COPY_QC_PENDING', 'MANUAL_ARCHIVE', 'IMAGE_QC_PENDING', 'IMAGE_REWORK_PENDING',
  ]);
  assert.deepEqual(personalStateFilterStates('personalProduction'), [
    'COPY_QUEUED', 'IMAGE_QUEUED', 'COPY_RUNNING', 'IMAGE_RUNNING',
  ]);
  assert.deepEqual(personalStateFilterStates('COPY_QC_PENDING'), ['COPY_QC_PENDING']);
  assert.deepEqual(personalStateFilterStates('copyQaReturned'), ['COPY_REVIEW_PENDING', 'COPY_QC_PENDING']);
  assert.equal(isPersonalStateFilter('personalReview'), true);
  assert.equal(isPersonalStateFilter('NOT_A_STATE'), false);
});

test('primary personal counts remain disjoint and derive from the existing summary', () => {
  const summary = {
    total: 28,
    states: {
      queued: 3, running: 4, copyReview: 5, imageReview: 6, failed: 2, completed: 7, cancelled: 1,
    },
  };
  assert.equal(personalStateFilterCount('ALL', summary), 28);
  assert.equal(personalStateFilterCount('personalProduction', summary), 7);
  assert.equal(personalStateFilterCount('personalReview', summary), 11);
  assert.equal(personalStateFilterCount('failed', summary), 2);
  assert.equal(personalStateFilterCount('completed', summary), 7);
});
