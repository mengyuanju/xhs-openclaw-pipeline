import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAnnotationJobReport } from '../src/annotation-job-report.mjs';
import { buildPerformanceSnapshot, normalizePerformanceFilters } from '../src/operator-performance.mjs';

const now=Date.parse('2026-09-24T08:00:00Z');
const at='2026-09-24T03:00:00Z';
const fact=(id,accountId,kind,extra={})=>({id,taskId:Number(id.replace(/\D/gu,''))||1,accountId,
  username:`worker-${accountId}`,displayName:`标注${accountId}`,stage:'COPY',kind,at,...extra});

test('annotation job report counts direct discard work and ignores QA dispositions',()=>{
  const events=[
    fact('submit-1',11,'SUBMIT'),fact('submit-2',11,'SUBMIT',{rework:true,taskId:1}),
    fact('submit-3',11,'SUBMIT',{stage:'IMAGE',taskId:1}),
    fact('discard-1',11,'ACCOUNT_QUALITY',{bucket:'DISCARDED',taskId:99}),
    fact('discard-2',11,'ACCOUNT_QUALITY',{bucket:'DISCARDED',stage:'IMAGE',taskId:98}),
    fact('actor-discard-1',11,'ANNOTATION_DISCARD',{taskId:1,rework:true}),
    fact('pass-1',11,'ANNOTATION_QUALITY',{outcome:'PASS',firstPassed:true}),
    fact('return-1',11,'ANNOTATION_QUALITY',{outcome:'RETURN'}),
    fact('return-2',11,'ANNOTATION_QUALITY',{stage:'IMAGE',outcome:'RETURN'}),
    fact('submit-4',22,'SUBMIT'),
    fact('return-3',22,'ANNOTATION_QUALITY',{outcome:'RETURN'}),
    fact('excluded-1',22,'SUBMIT',{exclusion:'SIMULATED'}),
  ];
  const snapshot=buildPerformanceSnapshot(events,[],[],normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now),at);
  const report=buildAnnotationJobReport(snapshot,[{taskId:1,accountId:11,outcome:'PASS'}]);
  assert.deepEqual(report.summary,{workers:2,totalJobs:5,returned:3});
  assert.deepEqual(report.people.map(row=>row.accountId),[11,22]);
  assert.deepEqual(report.people[0],{
    accountId:11,username:'worker-11',displayName:'标注11',totalJobs:4,
    copyReview:1,copyRework:2,copyReworkTasks:1,
    imageReview:1,imageFirstReview:1,imageRework:0,imageReworkTasks:0,discarded:1,
    copyFirstPassRate:1,copyFirstPassed:1,copyDecided:1,returned:2,
  });
  assert.equal(report.people[1].totalJobs,1);
});

test('annotation job report respects the selected annotator and keeps return-only rows',()=>{
  const events=[fact('submit-1',11,'SUBMIT'),fact('return-2',22,'ANNOTATION_QUALITY',{outcome:'RETURN'})];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24',accountId:'22'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at));
  assert.deepEqual(report.summary,{workers:0,totalJobs:0,returned:1});
  assert.deepEqual(report.people.map(row=>row.accountId),[22]);
});
test('quality decisions remain visible when the submission was outside the selected dates',()=>{
  const events=[fact('pass-1',11,'ANNOTATION_QUALITY',{outcome:'PASS',firstPassed:true}),
    fact('pass-2',22,'ANNOTATION_QUALITY',{stage:'IMAGE',outcome:'PASS',firstPassed:true})];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at));
  assert.equal(report.summary.workers,0);
  assert.deepEqual(report.people.map(row=>row.accountId),[11,22]);
  assert.equal(report.people[0].copyFirstPassRate,0);
  assert.equal(report.people[0].copyDecided,0);
});

test('a QA-only discard does not count as the annotator\'s work or discarded task',()=>{
  const events=[fact('qa-discard-1',11,'ACCOUNT_QUALITY',{taskId:1,bucket:'DISCARDED'})];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at));
  assert.deepEqual(report.summary,{workers:0,totalJobs:0,returned:0});
  assert.deepEqual(report.people,[]);
});

test('direct discard decisions count as work and deduplicate discarded tasks',()=>{
  const events=[fact('actor-discard-1',11,'ANNOTATION_DISCARD',{taskId:1}),
    fact('actor-discard-2',11,'ANNOTATION_DISCARD',{taskId:1,stage:'IMAGE'})];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at));
  assert.equal(report.summary.workers,1);
  assert.equal(report.summary.totalJobs,2);
  assert.equal(report.people[0].copyReview,1);
  assert.equal(report.people[0].imageFirstReview,1);
  assert.equal(report.people[0].discarded,1);
});

test('first-pass rate follows first copy submissions and ignores rework verdicts',()=>{
  const events=[
    fact('submit-1',11,'SUBMIT',{taskId:1}),
    fact('submit-2',11,'SUBMIT',{taskId:2}),
    fact('rework-1',11,'SUBMIT',{taskId:1,rework:true}),
    fact('rework-2',11,'SUBMIT',{taskId:1,rework:true}),
    fact('pass-1',11,'ANNOTATION_QUALITY',{taskId:1,outcome:'PASS',firstPassed:true}),
    fact('return-1',11,'ANNOTATION_QUALITY',{taskId:1,outcome:'RETURN'}),
    fact('return-2',11,'ANNOTATION_QUALITY',{taskId:2,outcome:'RETURN'}),
    fact('pass-2',11,'ANNOTATION_QUALITY',{taskId:2,outcome:'PASS'}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const snapshot=buildPerformanceSnapshot(events,[],[],filters,at);
  const report=buildAnnotationJobReport(snapshot,[
    {taskId:1,accountId:11,outcome:'PASS'},
    {taskId:2,accountId:11,outcome:'RETURN'},
  ]);
  assert.equal(report.people[0].copyReview,2);
  assert.equal(report.people[0].copyRework,2);
  assert.equal(report.people[0].copyReworkTasks,1);
  assert.equal(report.people[0].copyDecided,2);
  assert.equal(report.people[0].copyFirstPassed,1);
  assert.equal(report.people[0].copyFirstPassRate,.5);
  assert.equal(report.people[0].returned,2);
});

test('image submissions split into first review and rework without changing total jobs',()=>{
  const events=[
    fact('image-first',11,'SUBMIT',{stage:'IMAGE',taskId:10}),
    fact('image-rework-1',11,'SUBMIT',{stage:'IMAGE',taskId:10,rework:true}),
    fact('image-rework-2',11,'SUBMIT',{stage:'IMAGE',taskId:10,rework:true}),
    fact('image-discard',11,'ANNOTATION_DISCARD',{stage:'IMAGE',taskId:10,rework:true}),
    fact('image-excluded',11,'SUBMIT',{stage:'IMAGE',taskId:11,exclusion:'SIMULATED'}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at));
  assert.equal(report.people[0].imageReview,4);
  assert.equal(report.people[0].imageFirstReview,1);
  assert.equal(report.people[0].imageRework,3);
  assert.equal(report.people[0].imageReworkTasks,1);
  assert.equal(report.people[0].discarded,1);
  assert.equal(report.people[0].totalJobs,4);
  assert.equal(report.summary.totalJobs,4);
});
