import assert from 'node:assert/strict';
import test from 'node:test';
import { createReportQueryCache, readCachedReportAggregate, runLimitedReportExport,runHeavyReportQuery,runReportSingleFlight } from '../src/report-query-cache.mjs';

test('thirty matching report requests reuse one query and receive independent results', async () => {
  const cache = createReportQueryCache();
  let reads = 0, finish;
  const ready = new Promise(resolve => { finish = resolve; });
  const load = async () => { reads++; await ready; return { total:1, summary:{ passed:1 } }; };
  const pending = Array.from({length:30},()=>cache.read('same',load));
  await Promise.resolve();
  assert.equal(reads,1);
  finish();
  const values = await Promise.all(pending);
  values[0].summary.passed = 999;
  assert.equal(values[1].summary.passed,1);
  assert.equal((await cache.read('same',load)).summary.passed,1);
  assert.equal(reads,1);
});

test('report facts are isolated by identity, role, credential version and committed snapshot', async () => {
  const pool = {}, actor = {role:'ADMIN',userId:1,username:'admin',credentialVersion:1};
  let reads=0;
  const read = (identity,version) => readCachedReportAggregate(pool,'facts',identity,{stage:'COPY'},version,
    async()=>({total:++reads}));
  assert.equal((await read(actor,'10:20:')).total,1);
  assert.equal((await read(actor,'10:20:')).total,1);
  assert.equal((await read(actor,'10:21:')).total,2);
  assert.equal((await read({...actor,userId:2},'10:21:')).total,3);
  assert.equal((await read({...actor,role:'USER'},'10:21:')).total,4);
  assert.equal((await read({...actor,credentialVersion:2},'10:21:')).total,5);
  assert.equal((await read(actor,undefined)).total,6);
  assert.equal((await read(actor,undefined)).total,7);
});

test('fact caches retain the explicit snapshot for thirty seconds and manual refresh bypasses it',async()=>{
  let at=0,reads=0;
  const cache=createReportQueryCache({now:()=>at});
  const load=async()=>({total:++reads,asOf:new Date(at).toISOString()});
  const initial=await cache.read('same',load);
  at=29_999;
  assert.deepEqual(await cache.read('same',load),initial,'asOf remains the time of the reused facts');
  const refreshed=await cache.read('same',load,{forceRefresh:true});
  assert.equal(refreshed.total,2);
  assert.equal(refreshed.asOf,new Date(at).toISOString());
  at+=30_000;
  assert.equal((await cache.read('same',load)).total,3);
});

test('manual refresh joins a calculation already in flight without duplicating it',async()=>{
  const cache=createReportQueryCache();let finish,reads=0;
  const load=()=>{reads++;return new Promise(resolve=>{finish=resolve;});};
  const first=cache.read('same',load);
  await Promise.resolve();
  const second=cache.read('same',load,{forceRefresh:true});
  finish({asOf:'2026-10-02T00:00:00.000Z'});
  assert.deepEqual(await first,await second);assert.equal(reads,1);
});

test('aggregate cache expires, bounds retained bytes and never retains failed reads', async () => {
  let at=0,reads=0;
  const cache=createReportQueryCache({now:()=>at,ttlMs:2,maxEntries:2,maxBytes:100});
  const load=async()=>({total:++reads});
  await cache.read('a',load);
  at=3;
  await cache.read('a',load);
  assert.equal(reads,2);
  await cache.read('b',load);
  await cache.read('c',load);
  assert.equal(cache.size,2);
  await cache.read('large',async()=>({text:'x'.repeat(200)}));
  assert.ok(cache.bytes<=100);
  assert.equal(cache.size,1);
  await assert.rejects(cache.read('failure',async()=>{throw new Error('timeout');}),/timeout/);
  assert.equal((await cache.read('failure',load)).total,5);
});

test('clearing a pending read does not corrupt the replacement cache accounting', async () => {
  const cache=createReportQueryCache();
  let finish;
  const old=cache.read('a',()=>new Promise(resolve=>{finish=resolve;}));
  await Promise.resolve();
  cache.clear();
  await cache.read('a',async()=>({total:2}));
  const retainedBytes=cache.bytes;
  finish({total:1});
  assert.equal((await old).total,1);
  assert.equal((await cache.read('a',async()=>({total:3}))).total,2);
  assert.equal(cache.bytes,retainedBytes);
});

test('long report exports have a bounded per-pool admission limit and release slots after failure', async () => {
  const pool={};
  let finish;
  const first=runLimitedReportExport(pool,()=>new Promise(resolve=>{finish=resolve;}),{maximum:1});
  await assert.rejects(runLimitedReportExport(pool,async()=>0,{maximum:1}),{code:'REPORT_EXPORT_BUSY'});
  finish(1);
  assert.equal(await first,1);
  await assert.rejects(runLimitedReportExport(pool,async()=>{throw new Error('export failed');},{maximum:1}),/export failed/);
  assert.equal(await runLimitedReportExport(pool,async()=>2,{maximum:1}),2);
});

test('different heavy statistics share two slots while identical followers do not acquire a slot',async()=>{
  const pool={},finish=[];let started=0;
  const load=()=>{started++;return new Promise(resolve=>finish.push(resolve));};
  const same=Array.from({length:30},()=>runReportSingleFlight(pool,'operator',{stage:'COPY'},()=>runHeavyReportQuery(pool,load)));
  const annotation=runReportSingleFlight(pool,'annotation',{stage:'COPY'},()=>runHeavyReportQuery(pool,load));
  await Promise.resolve();await Promise.resolve();
  assert.equal(started,2);
  await assert.rejects(runReportSingleFlight(pool,'operator',{stage:'IMAGE'},()=>runHeavyReportQuery(pool,load)),{code:'REPORT_BUSY'});
  for(const resolve of finish)resolve(1);
  assert.deepEqual(await Promise.all(same),Array(30).fill(1));assert.equal(await annotation,1);
  await assert.rejects(runHeavyReportQuery(pool,async()=>{throw new Error('failed');}),/failed/);
  assert.equal(await runHeavyReportQuery(pool,async()=>2),2,'failure releases the bounded admission slot');
});
