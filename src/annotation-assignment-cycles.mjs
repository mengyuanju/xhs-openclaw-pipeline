const time = value => value instanceof Date ? value.getTime() : Date.parse(value);
const identityMatches = (left,right) => left.accountId != null && right.accountId != null
  ? left.accountId === right.accountId
  : Boolean(left.username && right.username && left.username === right.username);

export function isAnnotationWork(row) {
  return ['SUBMIT','ANNOTATION_DISCARD'].includes(row.kind) && !row.exclusion
    && ['COPY','IMAGE'].includes(row.stage) && Number.isSafeInteger(row.taskId) && row.taskId>0
    && Number.isSafeInteger(row.accountId) && row.accountId>0 && Number.isFinite(time(row.at));
}

function canonicalTransitions(rows) {
  const ordered=rows.toSorted((a,b)=>a.at-b.at||(a.priority??0)-(b.priority??0)||(a.order??0)-(b.order??0));
  const unique=[],positions=new Map();
  for (const row of ordered) {
    const previous=unique.at(-1);
    const bothUnassigned=previous && previous.accountId==null && !previous.username
      && row.accountId==null && !row.username;
    if (!previous || !bothUnassigned && !identityMatches(previous,row)) unique.push(row);
    positions.set(row.id,unique.length-1);
    if (row.sourceRecordId) positions.set(row.sourceRecordId,unique.length-1);
  }
  return {rows:unique,positions};
}

function lastTransitionIndex(rows,at) {
  let low=0,high=rows.length;
  while (low<high) {
    const middle=Math.floor((low+high)/2);
    if (rows[middle].at<=at) low=middle+1;
    else high=middle;
  }
  return low-1;
}

function assignmentTransitions(assignments) {
  const byTask = new Map();
  for (const row of assignments) {
    if (!byTask.has(row.taskId)) byTask.set(row.taskId,[]);
    byTask.get(row.taskId).push(row);
  }
  const result = new Map();
  for (const [taskId,rows] of byTask) {
    const events=rows.filter(row=>row.kind==='EVENT').sort((a,b)=>time(a.at)-time(b.at)||a.order-b.order);
    const records=rows.filter(row=>row.kind==='RECORD');
    const transitions=[];
    const firstEvent=events[0];
    if (firstEvent?.previousAccountId!=null || firstEvent?.previousUsername) {
      transitions.push({id:'initial',at:-Infinity,accountId:firstEvent.previousAccountId,
        username:firstEvent.previousUsername,order:0});
    } else if (!events.length) {
      // A migration baseline describes an existing assignment. Its timestamp
      // must not restart that person's contribution history.
      const baseline=records.find(row=>row.baseline);
      if (baseline) transitions.push({...baseline,id:'initial',sourceRecordId:baseline.id,at:-Infinity,order:0});
    }
    for (const event of events) transitions.push({...event,at:time(event.at),priority:1});
    for (const record of records) {
      if (!record.baseline && Number.isFinite(time(record.at)))
        transitions.push({...record,at:time(record.at),priority:2});
    }
    const starts=canonicalTransitions(transitions);
    for (const record of records) {
      const end=time(record.endedAt);
      const startPosition=starts.positions.get(record.id)??lastTransitionIndex(starts.rows,time(record.at));
      // assigned_at/assignment events use transaction time; the old record's
      // ended_at uses clock time and can be a few milliseconds later. Once a
      // new handoff has replaced it, that old end must not unassign the new owner.
      if (Number.isFinite(end) && lastTransitionIndex(starts.rows,end)<=startPosition)
        transitions.push({id:`${record.id}:end`,at:end,accountId:null,username:null,order:record.order,priority:0});
    }
    result.set(taskId,canonicalTransitions(transitions).rows);
  }
  return result;
}

// Call with complete work history through the report time, before filtering by
// date or person. COPY and IMAGE each start a new first operation per handoff.
export function annotateAssignmentCycles(workRows,assignments) {
  const transitions=assignmentTransitions(assignments);
  const pointers=new Map();
  const seen=new Set();
  const metadata=new Map();
  const ordered=workRows.filter(isAnnotationWork).toSorted((a,b)=>time(a.at)-time(b.at)
    || (a.sequence??0)-(b.sequence??0) || String(a.id).localeCompare(String(b.id)));
  for (const row of ordered) {
    const history=transitions.get(row.taskId)??[];
    let pointer=pointers.get(row.taskId)??-1;
    while (pointer+1<history.length && history[pointer+1].at<=time(row.at)) pointer++;
    pointers.set(row.taskId,pointer);
    const assignment=history[pointer];
    const epoch=assignment?.id??'initial';
    const key=`${row.taskId}:${epoch}:${row.accountId}:${row.stage}`;
    metadata.set(row.id,{annotationCycleKey:key,annotationFirst:!seen.has(key)});
    seen.add(key);
  }
  return workRows.map(row=>metadata.has(row.id)?{...row,...metadata.get(row.id)}:{...row});
}

export function firstCopyAssignmentCohort(allWork,periodRows) {
  const current=new Set(periodRows.filter(row=>isAnnotationWork(row) && row.stage==='COPY'
    && row.annotationFirst===true).map(row=>row.annotationCycleKey));
  const cohort=new Map();
  for (const row of allWork) if (isAnnotationWork(row) && row.stage==='COPY'
    && row.annotationFirst===true && current.has(row.annotationCycleKey)) {
    cohort.set(row.annotationCycleKey,{cycleKey:row.annotationCycleKey,taskId:row.taskId,accountId:row.accountId,
      firstAt:row.at,submitted:false,approvalId:null,copyRevisionId:null,submittedAt:null});
  }
  for (const row of allWork.filter(isAnnotationWork).toSorted((a,b)=>time(a.at)-time(b.at)
    || (a.sequence??0)-(b.sequence??0) || String(a.id).localeCompare(String(b.id)))) {
    const cycle=cohort.get(row.annotationCycleKey);
    if (cycle && row.kind==='SUBMIT' && !cycle.submitted) {
      cycle.submitted=true;
      cycle.approvalId=Number.isSafeInteger(row.approvalId)?row.approvalId:null;
      cycle.copyRevisionId=Number.isSafeInteger(row.copyRevisionId)?row.copyRevisionId:null;
      cycle.submittedAt=row.at;
    }
  }
  return [...cohort.values()];
}
