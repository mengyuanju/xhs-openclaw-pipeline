// Work counts valid submissions and direct discard decisions made in the workbench.
// The first-pass rate follows first copy submissions in the selected period.
// A task enters its denominator once its first QA verdict is available.
export function buildAnnotationJobReport(snapshot, firstCopyVerdicts = []) {
  const firstCopyByAccount = new Map();
  const reworkTasksByAccount = new Map();
  const imageReworkTasksByAccount = new Map();
  for (const row of snapshot.rows) if (['SUBMIT','ANNOTATION_DISCARD'].includes(row.kind)
    && !row.exclusion && row.accountId != null && row.taskId != null) {
    const tasks=row.stage==='COPY'?reworkTasksByAccount:imageReworkTasksByAccount;
    if (row.rework) {
      if (!tasks.has(row.accountId)) tasks.set(row.accountId,new Set());
      tasks.get(row.accountId).add(row.taskId);
    }
  }
  for (const verdict of firstCopyVerdicts) {
    const result = firstCopyByAccount.get(verdict.accountId) ?? {passed:0,decided:0};
    result.decided++;
    if (verdict.outcome === 'PASS') result.passed++;
    firstCopyByAccount.set(verdict.accountId,result);
  }
  const discardedTasks = new Map();
  const discardWorkByAccount = new Map();
  for (const row of snapshot.rows) if (row.kind === 'ANNOTATION_DISCARD'
    && !row.exclusion && row.accountId != null && row.taskId != null) {
    if (!discardedTasks.has(row.accountId)) discardedTasks.set(row.accountId, new Set());
    discardedTasks.get(row.accountId).add(row.taskId);
    const work=discardWorkByAccount.get(row.accountId)??{copyFirst:0,copyRework:0,imageFirst:0,imageRework:0};
    const key=row.stage==='COPY'?(row.rework?'copyRework':'copyFirst')
      :(row.rework?'imageRework':'imageFirst');
    work[key]++;
    discardWorkByAccount.set(row.accountId,work);
  }
  const people = snapshot.people.filter(person => person.COPY.submissions + person.IMAGE.submissions > 0
    || (discardedTasks.get(person.accountId)?.size ?? 0) > 0 || person.annotationOverallPass.decided > 0).map(person => {
    const work=discardWorkByAccount.get(person.accountId)??{copyFirst:0,copyRework:0,imageFirst:0,imageRework:0};
    const copyReview = person.COPY.submissions - person.COPY.reworkSubmissions + work.copyFirst;
    const copyRework = person.COPY.reworkSubmissions + work.copyRework;
    const imageFirstReview = person.IMAGE.submissions - person.IMAGE.reworkSubmissions + work.imageFirst;
    const imageRework = person.IMAGE.reworkSubmissions + work.imageRework;
    const imageReview = imageFirstReview + imageRework;
    const discarded = discardedTasks.get(person.accountId)?.size ?? 0;
    const firstCopy = firstCopyByAccount.get(person.accountId) ?? {passed:0,decided:0};
    return {
      accountId:person.accountId,username:person.username,displayName:person.displayName,
      totalJobs:copyReview + copyRework + imageFirstReview + imageRework,
      copyReview,copyRework,copyReworkTasks:reworkTasksByAccount.get(person.accountId)?.size ?? 0,
      imageReview,imageFirstReview,imageRework,
      imageReworkTasks:imageReworkTasksByAccount.get(person.accountId)?.size ?? 0,discarded,
      copyFirstPassRate:firstCopy.decided ? firstCopy.passed/firstCopy.decided : 0,
      copyFirstPassed:firstCopy.passed,
      copyDecided:firstCopy.decided,
      returned:person.annotationOverallPass.failed,
    };
  }).sort((a,b) => b.totalJobs-a.totalJobs || a.accountId-b.accountId);
  return {
    timezone:snapshot.timezone,asOf:snapshot.asOf,range:snapshot.range,
    summary:{workers:people.filter(person=>person.totalJobs>0).length,
      totalJobs:people.reduce((sum,person)=>sum+person.totalJobs,0),
      returned:people.reduce((sum,person)=>sum+person.returned,0)},
    people,
    dataQuality:{unknownIdentity:snapshot.dataQuality.unknownIdentity,
      unattributedAnnotationBatchReturns:snapshot.dataQuality.unattributedAnnotationBatchReturns,
      unattributedAnnotationBatchScopes:snapshot.dataQuality.unattributedAnnotationBatchScopes},
  };
}
