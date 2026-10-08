import assert from 'node:assert/strict';
import test from 'node:test';
import { readOperatorPerformance } from '../src/operator-performance.mjs';
import { runHeavyReportQuery } from '../src/report-query-cache.mjs';

const actor={userId:1,username:'audit',role:'ADMIN',credentialVersion:1};
const options={now:()=>Date.parse('2026-10-02T03:00:00Z')};
function fixture(){
 let computations=0,releases=0,workMem=0;
 const pool={async connect(){return{release(){releases++;},async query(sql){
  if(sql.includes('clock_timestamp()'))return{rows:[{at:new Date(options.now()),data_cutoff:'2026-10-02 03:00:00+00'}]};
  if(sql.includes('AS snapshot_version'))return{rows:[{snapshot_version:'operator:1'}]};
  if(sql.includes('SET LOCAL work_mem'))workMem++;
  if(/\bAS report\b/iu.test(sql)){computations++;return{rows:[{report:{groups:[],current:[],affected:[],reasons:[],trend:[],identities:[],dataQuality:{}}}]};}
  return{rows:[],rowCount:0};
 }}}};
 return{pool,get computations(){return computations;},get releases(){return releases;},get workMem(){return workMem;}};
}

test('three distinct warm report scopes can read while both heavy calculation slots are occupied',async()=>{
 const f=fixture(),read=(stage='',refresh=false)=>readOperatorPerformance(f.pool,actor,{period:'7d',stage},{...options,forceRefresh:refresh});
 for(const stage of ['', 'COPY', 'IMAGE'])await read(stage);
 const finish=[],heavy=[1,2].map(()=>runHeavyReportQuery(f.pool,()=>new Promise(resolve=>finish.push(resolve))));
 try{
  const reports=await Promise.all(['','COPY','IMAGE'].map(stage=>read(stage)));
  assert.equal(reports.length,3);assert.equal(f.computations,3);assert.equal(f.workMem,3,'cache reads receive no extra work_mem budget');
  await assert.rejects(read('',true),{code:'REPORT_BUSY'},'a real forced calculation still obeys admission');
 }finally{finish.forEach(resolve=>resolve());await Promise.all(heavy);}
 await read('',true);assert.equal(f.computations,4);assert.equal(f.releases,8,'cache hits and a rejected calculation release their connections');
});
