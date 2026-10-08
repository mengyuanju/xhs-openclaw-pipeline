import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const reportRoot = resolve(process.env.XHS_FUNCTIONAL_REPORT_ROOT ?? 'reports/full-functional-2026-10-02');
const inventoryPath = resolve('docs/full-functional-test-inventory-2026-10-02.md');
const text = await readFile(inventoryPath, 'utf8');
const main = JSON.parse(await readFile(join(reportRoot, 'functional-100-results.json'), 'utf8'));
const supplemental = JSON.parse(await readFile(join(reportRoot, 'functional-browser-retests.json'), 'utf8'));
const features = [...text.matchAll(/^\| (F-[A-Z]+-\d{3}) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|$/gm)]
  .map(([, id, route, operation, expected, existingIndex]) => ({ id, route: route.trim(), operation: operation.trim(), expected: expected.trim(),
    existingIndex: existingIndex.trim(), status: 'NOT_EXECUTED_BY_THIS_RUNNER', api: [], browser: [], unit: [], routeLoad: [] }));
assert.ok(features.length >= 557); assert.equal(new Set(features.map(f => f.id)).size, features.length, 'Inventory feature IDs must be unique');
const byId = new Map(features.map(f => [f.id, f]));
function ids(group, ...numbers) { return numbers.map(n => `F-${group}-${String(n).padStart(3, '0')}`); }
function map(caseId, type, targetIds, verifiedScope) {
  const entry = main.cases.find(c => c.id === caseId); assert.ok(entry);
  for (const id of targetIds) { const feature = byId.get(id); assert.ok(feature, id);
    feature[type].push({ source: 'functional-100-results.json', caseId, caseStatus: entry.status, name: entry.name,
      verifiedScope, completeness: 'PARTIAL_FEATURE', ...(entry.screenshot ? { screenshot: entry.screenshot } : {}) }); }
}
map('F002', 'api', ids('CREATE', 2, 3, 5), '100 unique IDs created via real batch API; all synthetic tasks request three image pages. Browser parsing, alternative page counts and invalid input are separate.');
map('F003', 'api', ids('LIST', 2, 3, 10, 32), '100 IDs enumerated across four real HTTP pages; keyword and numeric ID filter assertions. State filter and other boundary directions are partial.');
map('F004', 'api', ids('VIEW', 3, 4), '75 synthetic copy completions and five failure results verified in real PostgreSQL; this is task state evidence, not UI filtering.');
map('F005', 'api', [...ids('LIST', 25), ...ids('ASSIGN', 1, 5)], '75 tasks assigned to a real test USER and stable account identity verified. Partial failure UI is separate.');
map('F006', 'api', ids('COPY', 14, 15, 16, 17, 25), 'Save and read one version-bound review draft; same stale base fingerprint conflict rejected. Other browser triggers and merge UX are separate.');
map('F007', 'api', ids('COPY', 4, 12, 25), '40 score-3 owner approvals produce IMAGE_QUEUED; exact repeated approval payload is idempotent.');
map('F008', 'api', ids('COPY', 4, 6, 10, 12), 'Unchanged score-2.5 copy approval returns QUALITY_SCORE_TOO_LOW; edited title with original2.5/final3 creates new revision and passes. Other scores/fields limits not exercised.');
map('F009', 'api', [...ids('COPY', 13), ...ids('LIST', 28)], 'Copy discard and admin restore verified, mandatory copy-QA flag remains.');
map('F010', 'api', [...ids('CFLOW', 1), ...ids('SETTING', 24)], 'Configured 100% copy sample and blind review through real configuration API; ten owner-approved candidate tasks verified.');
map('F011', 'api', [...ids('CFLOW', 6), ...ids('CQA', 3, 6, 10)], 'Manual V2 batch contains ten exact members; reviewer task/query/approver identities masked; eight PASS and two RETURN decisions complete batch. Other UI and reason taxonomy are separate.');
map('F012', 'api', ids('VIEW', 5, 6), '20 image runs claim and complete with 60 SHA-verified synthetic PNGs; each task reaches MANUAL_ARCHIVE.');
map('F013', 'api', [...ids('IREVIEW', 16), ...ids('DELIVERY', 1, 2)], 'Ten owner self-review submits reach REVIEWED, clear drafts and appear in delivery API. Self-review API has no score contract; it does not prove score validation.');
map('F014', 'api', [...ids('IREVIEW', 12, 17), ...ids('LIST', 28)], 'Stale imageRunId rejected; current image discard cancels and admin restore returns MANUAL_ARCHIVE.');
map('F015', 'api', ids('IQA', 7, 9, 10, 11, 13), 'One score2 QA PASS rejected; score2.5 and3 PASS, score2 IMAGE return with TEXT_ERROR and one actual problem asset. Other target combinations and UI are separate.');
map('F016', 'api', [...ids('IREVIEW', 9), ...ids('COPY', 12)], 'Five manual image failures; manual retry. Latest runner also verifies three automatic failures -> IMAGE_RETRY_EXHAUSTED -> changed copy -> mandatory single-member V2 full inspection -> QA -> IMAGE_QUEUED. Only claim this expanded scope if latest F016 evidence has exhaustedAfter:3.');
map('F017', 'api', ids('COPY', 18, 25), 'Failed copy is manually retried with a new execution ID; old completion returns STALE_EXECUTION.');
map('F018', 'api', ids('ASSIGN', 6, 9), 'PAUSE, HIGHEST and SYSTEM transitions verified with persisted audit/hash chain; HIGH/NORMAL/DEFER and browser confirms are separate.');
map('F019', 'api', ids('LIST', 27, 28), 'Cancel one task and restore; batch cancel two queued and discard two queued, returned IDs/states verified.');
map('F020', 'api', [...ids('LIST', 31), ...ids('DELIVERY', 11, 12), ...ids('DLEGACY', 7, 13)], 'Single ZIP saved and parsed PNG entries; batch ZIP response nonzero; frozen delivery ZIP saved and batch appears in history. Browser downloads/byte-for-byte/frozen metadata edge cases separate.');
if (byId.has('F-QPK-010')) {
  map('F021', 'api', ids('QPK', 10, 11, 12, 14, 32), 'Actual100-row XLSX import preview preserves issued/production Query and client batch; create one split package; ten REJECT decisions do not add production tasks. UI file/worksheet selection and other client-batch combinations separate.');
  map('F067', 'browser', ids('QPK', 17, 18, 21, 23, 24, 27, 32), 'Real assignment modal selects one worker, saves; screening modal search applies and loaded eligible Query rows are batch-rejected with synthetic reason. Package source task count remains100. Other strategies and empty/limit/conflict branches separate.');
}
map('F022', 'api', ids('PROMPT', 5, 6, 8, 9), 'Create, publish, list and republish previous TEXT_SYSTEM version via real APIs; central UI does not expose the local rollback control.');
map('F023', 'api', ids('SETTING', 47), 'Save unchanged production JSON as a new version and reject stale expectedVersion with409; structured module exclusivity and invalid JSON separate.');
map('F024', 'api', [...ids('EXEC', 1, 2), ...ids('PERSONAL', 1), ...ids('STAT', 1), ...ids('ANNOT', 1), ...ids('REPORT', 1)], 'Real endpoints load executor reports, task totals, personal statistics, admin performance, annotation jobs, copy-QA statistics, image items. This proves interface readability only, not every dashboard metric or UI.');
map('F026', 'api', ids('AUTH', 10, 11), 'Authenticated admin profile name saved; stale expectedVersion rejected409. Browser validation and length boundaries separate.');
map('F027', 'api', ids('LIST', 17, 19), 'Saved view creation/list/deletion verified via real API; no browser cancel or load in this API case.');
map('F028', 'api', ids('USER', 18, 20, 21, 24), 'Worker joins ACTIVE pool, moves PAUSED, removed and three events persist; UI, auto refill and quantitative mode separate.');
map('F029', 'api', ids('CQA', 11), 'Custom reason label created, publicly published, disabled and absent from selectable managed list; UI target/tag controls separate.');
map('F031', 'browser', ids('AUTH', 1), 'Real browser login for ADMIN enters personal workbench. next and unsafe external return boundaries are separate.');
map('F061', 'browser', ids('COPY', 1), 'Opens one real task review detail with synthetic copy input; no history operations claimed.');
map('F062', 'browser', ids('REPORT', 19, 20), 'Generate async task CSV, wait for completed download link, save nonzero CSV to task-data-100.csv and assert synthetic task input. Expiry separate.');
map('F063', 'browser', ids('USER', 3, 5), 'New USER entered in real modal; edit displayName; disable account; API confirms DISABLED. Role/sampling/capability boundary fields separate.');
map('F064', 'browser', ids('SETTING', 48), 'All four settings tabs/screenshots and Home/End navigation; save count optional in this case, cannot claim all configuration controls saved.');
map('F065', 'browser', ids('PROMPT', 5, 6, 12), 'TEXT_SYSTEM draft -> zero-model precheck -> new publication confirmed through page and API. Other directory entries/guards boundaries separate.');
map('F066', 'browser', ids('DLEGACY', 1, 4, 13), 'Expand legacy tool disclosure, select ALL delivery states, preview actual synthetic text/images then close, history member details open/close. Download in API F020 only.');
map('F068', 'browser', ids('KNOW', 1), 'Knowledge switch persisted and restored via real UI, no contents deleted.');
map('F069', 'browser', ids('AUTH', 8), 'Logout via authenticated API removes session; browser protected users page redirects login and sessionless usersAPI401. Visible logout button click separate.');

const supplementalSources = [{ source: 'functional-browser-retests.json', report: supplemental }];
for (const source of ['functional-browser-targeted-retests.json', 'functional-browser-crud-date-retests.json', 'functional-auth-nav-supplement.json', 'functional-assignment-supplement.json', 'functional-list-filter-supplement.json', 'functional-task-report-supplement.json', 'functional-boundary-supplement.json', 'functional-statistics-supplement.json']) {
  const report = await readFile(join(reportRoot, source), 'utf8').then(JSON.parse, () => null);
  if (report) supplementalSources.push({ source, report });
}
for (const { source, report } of supplementalSources) for (const entry of report.cases) for (const id of entry.featureIds) {
  const feature = byId.get(id); assert.ok(feature, id);
  feature.browser.push({ source, caseId: entry.id, caseStatus: entry.status,
    name: entry.name, verifiedScope: entry.evidence ?? entry.error, completeness: 'PARTIAL_FEATURE', screenshot: entry.screenshot });
}
for (const feature of features) {
  feature.routeLoad = main.routes.filter(r => feature.route.includes(r.route) && (r.route !== '/' || feature.route === '全部后台路由'))
    .map(r => ({ source: 'functional-100-results.json', route: r.route, screenshot: r.screenshot, purpose: 'LOAD_ONLY_NOT_FEATURE_PASS' }));
  const evidence = [...feature.api, ...feature.browser];
  feature.status = evidence.some(e => e.caseStatus === 'PASS') ? 'PARTIALLY_EXECUTED_WITH_PASS_EVIDENCE'
    : evidence.some(e => e.caseStatus === 'FAIL') ? 'EXECUTED_WITH_FAILURE_ONLY' : 'NOT_EXECUTED_BY_THIS_RUNNER';
}
const output = { generatedAt: new Date().toISOString(), inventoryPath, totalFeatures: features.length,
  notice: 'This is an honest contribution map from the isolated100 runner only. Route loads and an existing test index never mean a feature passed. Unit evidence is empty until actual executed root suites are merged. Compound feature assertions need each subcondition reviewed.',
  sources: ['functional-100-results.json', ...supplementalSources.map(s => s.source)],
  counts: Object.fromEntries([...new Set(features.map(f => f.status))].map(s => [s, features.filter(f => f.status === s).length])), features };
await writeFile(join(reportRoot, 'feature-evidence-map.json'), JSON.stringify(output, null, 2));
console.log(JSON.stringify({ totalFeatures: output.totalFeatures, counts: output.counts }));
