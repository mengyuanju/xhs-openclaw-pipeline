// Summarize authoritative results without adding overlapping runs together.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root=resolve('reports/full-functional-2026-10-02');
const json=async name=>JSON.parse((await readFile(join(root,name),'utf8')).replace(/^\uFEFF/u,''));
const names=['functional-100-results.json','functional-browser-retests.json','functional-auth-nav-supplement.json','functional-assignment-supplement.json','functional-list-filter-supplement.json','functional-task-report-supplement.json','functional-boundary-supplement.json','functional-statistics-supplement.json','report-supplement-results.json','functional-admin-supplement.json','functional-prompt-supplement.json','functional-delivery-filter-supplement.json','functional-compatibility-route-supplement.json'];
const scenarioFiles=[];
for(const name of names){const r=await json(name);assert.ok(r.cases.length&&r.cases.every(c=>c.status==='PASS'),name);scenarioFiles.push({source:name,cases:r.cases.length,passed:r.cases.filter(c=>c.status==='PASS').length});}
const browser=await json('browser-regressions-summary.json');
assert.equal(browser.skipped,0);assert.equal(browser.tests,browser.passed+browser.failed);
const parse=source=>[...source.matchAll(/^\s*(not )?ok \d+ - (.+)$/gmu)].map(m=>({name:m[2],status:m[1]?'FAIL':'PASS'}));
const original=parse(await readFile(join(root,'browser-regressions.tap'),'utf8'));
assert.equal(original.length,browser.tests,'Every counted browser case must have an exact TAP record');
const fixes=parse(await readFile(join(root,'reassignment-final-auto-close-retest.tap'),'utf8'));
const finalByName=new Map(original.map(r=>[r.name,{...r,source:'browser-regressions.tap'}]));const resolutions=[];
for(const r of original.filter(r=>r.status==='FAIL')){const repair=fixes.find(c=>c.name===r.name&&c.status==='PASS');assert.ok(repair,`Unresolved browser case: ${r.name}`);finalByName.set(r.name,{...repair,source:'reassignment-final-auto-close-retest.tap'});resolutions.push({name:r.name,originalStatus:'FAIL',finalStatus:'PASS',source:'reassignment-final-auto-close-retest.tap',reason:'Successful batch processing automatically closes the real dialog. The test now waits for that closure rather than clicking a button during its removal; original result/state/UUID assertions remain.'});}
assert.equal(finalByName.size,browser.tests,'No duplicate browser test names may inflate the total');
assert.ok([...finalByName.values()].every(r=>r.status==='PASS'));
const baseline=await json('baseline-summary.json'),audit=await json('browser-feature-action-audit.json'),models=await json('live-model/final-summary.json'),preview=await json('preview/results.json');
assert.equal(models.status,'PASS');assert.ok(preview.cases.every(r=>r.status==='PASS'));
assert.equal(audit.total,598);assert.equal(audit.counts.NO_BROWSER_ACTION_EVIDENCE??0,0);assert.equal(audit.counts.AWAITING_PASS_OR_FINAL_MATCH??0,0);
const run=name=>{const r=baseline.runs.find(r=>r.name===name);assert.ok(r&&r.counts.fail===0);return{source:r.log,...r.counts};};
const summary={generatedAt:new Date().toISOString(),status:'PASS_WITH_DOCUMENTED_SCOPE_LIMITS',taskCount:100,scenarioFiles,scenarioTotals:{executed:scenarioFiles.reduce((n,r)=>n+r.cases,0),passed:scenarioFiles.reduce((n,r)=>n+r.passed,0)},browser:{originalRun:browser,finalByExactCaseName:{tests:browser.tests,passed:finalByName.size,unresolved:0,skipped:0},resolutions,cases:[...finalByName.values()]},automated:{root:run('root-final'),serverStandard:run('server-final'),postgres:run('postgres-final-comprehensive')},features:{stableIds:audit.total,centerUiWithExecutedActionEvidence:audit.counts.PARTIAL_BROWSER_PASS_EVIDENCE,conditionalLocalUiWithExecutedActionEvidence:audit.counts.CONDITIONAL_LOCAL_UI_PASS_EVIDENCE,unmounted:audit.counts.NOT_APPLICABLE_CURRENT_UI,unmatched:0,notice:'Action evidence is a contribution to a feature; complete representative scope is reviewed in the inventory and per-case scope, not inferred from counts.'},realModels:{capabilityChecks:models.checks,includesReadinessCheck:true,source:'live-model/final-summary.json'},preview:{cases:preview.cases.length,passed:preview.cases.length,source:'preview/results.json'},systemDefectsFixed:10,cleanup:await json('environment-cleanup-summary.json'),countingRule:'Do not add standard server and full PostgreSQL runs. Scenario, browser and model counts have separate meanings; 100 task inputs are synthetic and are not 100 live model generations.',scopeLimits:['Current unmounted features are recorded separately.','Screen color picker uses an EyeDropper fixture; all thirteen external search providers are not all live integrations.','Historical local Windows Wrangler connection-loss behavior is retained as a vendor-runtime limitation; final scoped preview cases passed.'],typecheck:baseline.typecheck,productionBuild:baseline.productionBuild};
const reviewNodeSupplement = await json('review-node-fix-summary.json').catch(error => {
  if (error.code === 'ENOENT') return null;
  throw error;
});
if (reviewNodeSupplement) {
  assert.equal(reviewNodeSupplement.status, 'PASS');
  summary.systemDefectsFixed += reviewNodeSupplement.additionalSystemDefectsFixed;
  summary.postReportValidation = reviewNodeSupplement;
}
await writeFile(join(root,'final-summary.json'),JSON.stringify(summary,null,2));console.log(JSON.stringify({status:summary.status,scenarios:summary.scenarioTotals,browser:summary.browser.finalByExactCaseName,features:summary.features,systemDefectsFixed:summary.systemDefectsFixed}));
