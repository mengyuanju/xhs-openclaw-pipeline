import assert from 'node:assert/strict';
import test from 'node:test';
import { summarizePersonalToday } from '../src/personal-workspace.mjs';
import { normalizeRange } from '../src/web-statistics/summary.mjs';

const now=Date.parse('2026-09-29T12:00:00+08:00');
const range=normalizeRange({period:'custom',from:'2026-09-15',to:'2026-09-16'},now);
const discard=(id,extra={})=>({id,kind:'ANNOTATION_DISCARD',stage:'COPY',
  at:'2026-09-15T10:00:00+08:00',exclusion:null,...extra});

test('first copy reviews add every annotation discard while submitted work and image metrics keep their meaning',()=>{
  const submitted=[
    {kind:'COMPLETE',stage:'COPY',firstSubmission:true,rework:false},
    {kind:'COMPLETE',stage:'COPY',firstSubmission:false,rework:true},
    {kind:'COMPLETE',stage:'COPY',firstSubmission:false,rework:false},
    {kind:'COMPLETE',stage:'IMAGE',firstSubmission:true,rework:false},
  ];
  const discards=[discard('initial'),discard('rework',{rework:true}),
    discard('qa',{kind:'QA_DISCARD'}),discard('image',{stage:'IMAGE'}),
    discard('excluded',{exclusion:'SIMULATED'})];
  const summary=summarizePersonalToday(submitted,[],[],range,now,[],discards);
  assert.equal(summary.annotation.COPY.firstSubmissions,1);
  assert.equal(summary.annotation.COPY.discarded,2);
  assert.equal(summary.annotation.COPY.firstReviews,3);
  assert.equal(summary.annotation.COPY.firstReviews,
    summary.annotation.COPY.firstSubmissions+summary.annotation.COPY.discarded);
  assert.equal(summary.annotation.COPY.submissions,3);
  assert.equal(summary.annotation.COPY.reworkSubmissions,1);
  assert.equal(summary.annotation.IMAGE.firstReviews,1);assert.equal(summary.annotation.IMAGE.discarded,0);
  assert.equal(summary.qa.COPY.discarded,0,'annotation discards do not become QA discards');
});

test('copy discard summary uses inclusive Shanghai start and exclusive end and preserves old callsites',()=>{
  const discards=[discard('before',{at:new Date(range.startMs-1).toISOString()}),
    discard('start',{at:new Date(range.startMs).toISOString()}),
    discard('last',{at:new Date(range.endMs-1).toISOString()}),
    discard('end',{at:new Date(range.endMs).toISOString()}),discard('invalid',{at:null})];
  const summary=summarizePersonalToday([],[],[],range,now,[],discards);
  assert.equal(summary.annotation.COPY.discarded,2);assert.equal(summary.annotation.COPY.firstReviews,2);
  assert.equal(summarizePersonalToday([],[],[],range,now).annotation.COPY.firstReviews,0);
});
