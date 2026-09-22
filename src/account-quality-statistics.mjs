// Each subject is one task, stage and actual operator, dated by its first QA.
// Allocate display rounding remainders so the three visible percentages sum 100.
export function summarizeAccountQuality(rows) {
  const subjects = new Map(rows.filter(row => row.kind === 'ACCOUNT_QUALITY' && !row.exclusion && row.accountId != null)
    .map(row => [`${row.taskId}:${row.stage}:${row.accountId}`, row]));
  const facts = [...subjects.values()];
  const counts = ['DISCARDED', 'FIRST_PASS', 'RETURNED'].map(bucket => facts.filter(row => row.bucket === bucket).length);
  const judged = counts.reduce((a,b) => a+b, 0);
  const units = counts.map(value => judged ? Math.floor(value * 10000 / judged) : 0);
  if (judged) {
    const order = counts.map((value,index) => ({ index, remainder: value * 10000 % judged }))
      .sort((a,b) => b.remainder-a.remainder || a.index-b.index);
    for (let i=0,remaining=10000-units.reduce((a,b)=>a+b,0); i<remaining; i++) units[order[i].index]++;
  }
  return { judged, discarded:counts[0], firstPassed:counts[1], returned:counts[2],
    reassigned:facts.filter(row=>row.reassigned).length, tasks:new Set(facts.map(row=>row.taskId)).size,
    discardedRate:judged ? units[0]/10000:null, firstPassRate:judged ? units[1]/10000:null,
    returnRate:judged ? units[2]/10000:null };
}
