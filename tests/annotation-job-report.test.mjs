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
    copyReview:1,copyReviewTasks:1,copyRework:2,copyReworkTasks:1,
    copyReworkOfFirstTasks:1,copyReworkOtherTasks:0,
    imageReview:1,imageFirstReview:1,imageRework:0,imageReworkTasks:0,discarded:1,
    copyFirstPassRate:1,copyFirstPassed:1,copyDecided:1,
    copyFirstReturned:0,copyFirstQaDiscarded:0,copyFirstUnjudged:0,copyFirstDirectDiscarded:0,
    copyFirstPending:0,copyFirstBypassed:0,copyFirstUnjudgedOther:0,returned:2,
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
  assert.equal(report.people[0].copyFirstDirectDiscarded,1);
  assert.equal(report.people[0].copyFirstUnjudged,0);
  assert.equal(report.trend.rows[0].copyFirstPassRate,null);
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

test('released unsampled first submissions join the numerator and denominator only once per personal cycle',()=>{
  const events=Array.from({length:13},(_,index)=>fact(`first-${index+1}`,11,
    index<9?'SUBMIT':'ANNOTATION_DISCARD',{
      taskId:index+1,annotationCycleKey:`cycle-${index+1}`,annotationFirst:true,
    }));
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const verdict=(taskId,outcome,extra={})=>({cycleKey:`cycle-${taskId}`,taskId,accountId:11,
    submitted:taskId<=9,outcome,...extra});
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    verdict(1,'PASS'),
    verdict(2,'PASS',{source:'LEGACY_BATCH_RELEASE'}),
    verdict(3,'PASS',{source:'COPY_V2_BATCH_RELEASE'}),
    verdict(4,'PASS',{source:'BATCH_RELEASE_FACT'}),
    verdict(4,'PASS',{source:'COPY_V2_BATCH_RELEASE'}),
    verdict(5,'RETURN',{source:'BATCH_AFFECTED'}),
    verdict(6,'RETURN'),verdict(7,'RETURN'),
    verdict(8,null,{reason:'PENDING'}),verdict(9,null,{reason:'PENDING'}),
    ...[10,11,12,13].map(taskId=>verdict(taskId,null)),
  ]);
  const person=report.people[0];
  assert.equal(person.copyReview,13);
  assert.equal(person.totalJobs,13);
  assert.equal(person.copyFirstPassed,4);
  assert.equal(person.copyDecided,7);
  assert.equal(person.copyFirstPassRate,4/7,
    'four first passes, including released unsampled work, are divided by seven decided first cycles');
  assert.equal(person.copyFirstReturned,3,'an affected first batch submission remains a failed verdict');
  assert.equal(person.copyFirstQaDiscarded,0);
  assert.equal(person.copyFirstPending,2);
  assert.equal(person.copyFirstUnjudged,2);
  assert.equal(person.copyFirstDirectDiscarded,4);
  assert.equal(person.copyFirstBypassed,0);
  assert.equal(person.copyFirstUnjudgedOther,0);
  assert.equal(person.copyFirstPassed+person.copyFirstReturned+person.copyFirstQaDiscarded,
    person.copyDecided);
  assert.equal(person.copyDecided+person.copyFirstUnjudged+person.copyFirstDirectDiscarded,
    person.copyReview,'the thirteen first cycles occupy mutually exclusive categories');
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

test('rework tasks reconcile with first review tasks without implying first-pass failures',()=>{
  const events=[
    fact('first-1',11,'SUBMIT',{taskId:1}),
    fact('first-2',11,'SUBMIT',{taskId:2}),
    fact('rework-1',11,'SUBMIT',{taskId:1,rework:true}),
    fact('rework-2',11,'SUBMIT',{taskId:3,rework:true}),
    fact('rework-3',11,'SUBMIT',{taskId:3,rework:true}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {taskId:1,accountId:11,outcome:'PASS'},
    {taskId:2,accountId:11,outcome:'RETURN'},
    {taskId:3,accountId:11,outcome:'RETURN'},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReviewTasks,2);
  assert.equal(person.copyRework,3);
  assert.equal(person.copyReworkTasks,2);
  assert.equal(person.copyReworkOfFirstTasks,1);
  assert.equal(person.copyReworkOtherTasks,1);
  assert.equal(person.copyFirstPassed,1);
  assert.equal(person.copyFirstReturned,1);
  assert.equal(person.copyDecided,2);
  assert.equal(person.copyFirstPassRate,.5);
});

test('a first QA discard is a failed verdict while a direct discard is outside the QA denominator',()=>{
  const events=[
    fact('first-1',11,'SUBMIT',{taskId:1}),
    fact('first-2',11,'SUBMIT',{taskId:2}),
    fact('discard-3',11,'ANNOTATION_DISCARD',{taskId:3}),
    fact('first-4',11,'SUBMIT',{taskId:4}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {taskId:1,accountId:11,outcome:'PASS'},
    {taskId:2,accountId:11,outcome:'DISCARD'},
    {taskId:2,accountId:11,outcome:'DISCARD'},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReviewTasks,4);
  assert.equal(person.copyDecided,2);
  assert.equal(person.copyFirstPassed,1);
  assert.equal(person.copyFirstQaDiscarded,1);
  assert.equal(person.copyFirstReturned,0);
  assert.equal(person.copyFirstUnjudged,1);
  assert.equal(person.copyFirstDirectDiscarded,1);
  assert.equal(person.copyFirstPassRate,.5);
  assert.equal(person.discarded,1);
});

test('restored direct discards follow their later submissions without overlapping first-review categories',()=>{
  const events=[
    fact('discard-1',11,'ANNOTATION_DISCARD',{taskId:1}),
    fact('restored-1',11,'SUBMIT',{taskId:1}),
    fact('discard-2',11,'ANNOTATION_DISCARD',{taskId:2}),
    fact('restored-2',11,'SUBMIT',{taskId:2}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {taskId:1,accountId:11,outcome:'PASS'},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReview,4);
  assert.equal(person.copyReviewTasks,2);
  assert.equal(person.copyDecided,1);
  assert.equal(person.copyFirstUnjudged,1);
  assert.equal(person.copyFirstDirectDiscarded,0);
  assert.equal(person.copyFirstPassRate,1);
  assert.equal(person.discarded,2);
});

test('personal first operations override workflow rework flags in both stages',()=>{
  const events=[
    fact('copy-first',11,'SUBMIT',{taskId:1,rework:true,annotationCycleKey:'copy-new',annotationFirst:true}),
    fact('copy-next',11,'SUBMIT',{taskId:1,rework:false,annotationCycleKey:'copy-new',annotationFirst:false}),
    fact('image-first',11,'SUBMIT',{stage:'IMAGE',taskId:1,rework:true,annotationCycleKey:'image-new',annotationFirst:true}),
    fact('image-next',11,'ANNOTATION_DISCARD',{stage:'IMAGE',taskId:1,rework:false,annotationCycleKey:'image-new',annotationFirst:false}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {cycleKey:'copy-new',taskId:1,accountId:11,submitted:true,outcome:'PASS'},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReview,1);
  assert.equal(person.copyRework,1);
  assert.equal(person.imageFirstReview,1);
  assert.equal(person.imageRework,1);
  assert.equal(person.totalJobs,4);
  assert.equal(person.copyFirstPassRate,1);
});

test('returning to the same task starts a separate personal first and QA denominator',()=>{
  const events=[
    fact('first-cycle-1',11,'SUBMIT',{taskId:1,annotationCycleKey:'assignment-1',annotationFirst:true}),
    fact('rework-cycle-1',11,'SUBMIT',{taskId:1,annotationCycleKey:'assignment-1',annotationFirst:false}),
    fact('first-cycle-2',11,'SUBMIT',{taskId:1,annotationCycleKey:'assignment-2',annotationFirst:true}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {cycleKey:'assignment-1',taskId:1,accountId:11,submitted:true,outcome:'RETURN'},
    {cycleKey:'assignment-2',taskId:1,accountId:11,submitted:true,outcome:'PASS'},
    {cycleKey:'assignment-before-period',taskId:1,accountId:11,submitted:true,outcome:'RETURN'},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReview,2);
  assert.equal(person.copyReviewTasks,1);
  assert.equal(person.copyRework,1);
  assert.equal(person.copyDecided,2);
  assert.equal(person.copyFirstPassed,1);
  assert.equal(person.copyFirstReturned,1);
  assert.equal(person.copyFirstPassRate,.5);
});

test('first discard restored and submitted after the period follows its own first QA',()=>{
  const events=[fact('initial-discard',11,'ANNOTATION_DISCARD',{
    taskId:1,annotationCycleKey:'restored-cycle',annotationFirst:true,
  })];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    {cycleKey:'restored-cycle',taskId:1,accountId:11,submitted:true,outcome:'PASS'},
  ]);
  const person=report.people[0];
  assert.equal(person.totalJobs,1);
  assert.equal(person.copyReview,1);
  assert.equal(person.copyFirstDirectDiscarded,0);
  assert.equal(person.copyDecided,1);
  assert.equal(person.copyFirstPassRate,1);
});

test('unjudged personal cycles keep pending, unsampled-unreleased, administrative bypass and absent records out of the denominator',()=>{
  const events=[1,2,3,4,5].map(id=>fact(`first-${id}`,11,id===5?'ANNOTATION_DISCARD':'SUBMIT',{
    taskId:id,annotationCycleKey:`cycle-${id}`,annotationFirst:true,
  }));
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-24',to:'2026-09-24'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,at),[
    ...['PENDING','ADMIN_DIRECT','NOT_SELECTED','NO_RECORD'].map((reason,index)=>({
      cycleKey:`cycle-${index+1}`,taskId:index+1,accountId:11,submitted:true,outcome:null,reason,
    })),
    {cycleKey:'cycle-5',taskId:5,accountId:11,submitted:false,outcome:null},
  ]);
  const person=report.people[0];
  assert.equal(person.copyReview,5);
  assert.equal(person.copyDecided,0);
  assert.equal(person.copyFirstUnjudged,4);
  assert.equal(person.copyFirstPending,1);
  assert.equal(person.copyFirstBypassed,2);
  assert.equal(person.copyFirstUnjudgedOther,1);
  assert.equal(person.copyFirstDirectDiscarded,1);
});

test('daily trend uses Beijing operation dates and attributes first QA to the earliest first operation',()=>{
  const events=[
    fact('restored-2',11,'SUBMIT',{taskId:2,annotationCycleKey:'cycle-2',annotationFirst:true,
      at:'2026-09-24T16:10:00Z'}),
    fact('first-1',11,'SUBMIT',{taskId:1,annotationCycleKey:'cycle-1',annotationFirst:true,
      at:'2026-09-23T15:59:00Z'}),
    fact('image-1',11,'SUBMIT',{taskId:1,stage:'IMAGE',annotationCycleKey:'image-1',annotationFirst:true,
      at:'2026-09-23T16:00:00Z'}),
    fact('discard-2',11,'ANNOTATION_DISCARD',{taskId:2,annotationCycleKey:'cycle-2',annotationFirst:true,
      at:'2026-09-23T16:30:00Z'}),
    fact('rework-1',11,'SUBMIT',{taskId:1,annotationCycleKey:'cycle-1',annotationFirst:false,
      at:'2026-09-24T16:15:00Z'}),
    fact('first-22',22,'SUBMIT',{taskId:1,annotationCycleKey:'cycle-22',annotationFirst:true,
      at:'2026-09-24T16:20:00Z'}),
    fact('return-33',33,'ANNOTATION_QUALITY',{taskId:4,outcome:'RETURN',at:'2026-09-24T03:00:00Z'}),
    fact('excluded-11',11,'SUBMIT',{taskId:9,exclusion:'SIMULATED',at:'2026-09-23T17:00:00Z'}),
  ];
  const filters=normalizePerformanceFilters({period:'custom',from:'2026-09-23',to:'2026-09-26'},now);
  const report=buildAnnotationJobReport(buildPerformanceSnapshot(events,[],[],filters,'2026-09-26T00:00:00Z'),[
    {cycleKey:'cycle-1',taskId:1,accountId:11,submitted:true,outcome:'PASS'},
    {cycleKey:'cycle-2',taskId:2,accountId:11,submitted:true,outcome:'PASS'},
    {cycleKey:'cycle-22',taskId:1,accountId:22,submitted:true,outcome:'RETURN'},
  ]);
  assert.deepEqual(report.trend.dates,['2026-09-23','2026-09-24','2026-09-25','2026-09-26']);
  assert.deepEqual(report.trend.rows,[
    {date:'2026-09-23',accountId:11,totalJobs:1,copyReview:1,imageFirstReview:0,
      copyFirstPassed:1,copyDecided:1,copyFirstPassRate:1},
    {date:'2026-09-24',accountId:11,totalJobs:2,copyReview:1,imageFirstReview:1,
      copyFirstPassed:1,copyDecided:1,copyFirstPassRate:1},
    {date:'2026-09-25',accountId:11,totalJobs:2,copyReview:1,imageFirstReview:0,
      copyFirstPassed:0,copyDecided:0,copyFirstPassRate:null},
    {date:'2026-09-25',accountId:22,totalJobs:1,copyReview:1,imageFirstReview:0,
      copyFirstPassed:0,copyDecided:1,copyFirstPassRate:0},
  ]);
  assert.equal(report.summary.totalJobs,report.trend.rows.reduce((sum,row)=>sum+row.totalJobs,0));
  for (const person of report.people) {
    const rows=report.trend.rows.filter(row=>row.accountId===person.accountId);
    for (const metric of ['totalJobs','copyReview','imageFirstReview','copyFirstPassed','copyDecided']) {
      assert.equal(rows.reduce((sum,row)=>sum+row[metric],0),person[metric]);
    }
  }
});
