const key = (stage, id) => `${stage}:${id}`;
const effective = row => row && !row.exclusion && row.submitterId != null && ['PASS','RETURN'].includes(row.outcome);

// An inspection round follows parent links, never task state transitions or the
// number of rows inside the selected reporting period.
export function inspectionContexts(links) {
  const byId = new Map(links.map(row => [key(row.stage,row.itemId),row]));
  const cache = new Map();
  function resolve(stage,id) {
    const identity=key(stage,id);
    if(cache.has(identity)) return cache.get(identity);
    const chain=[],seen=new Set();
    let row=byId.get(identity),complete=false;
    while(row && chain.length<100 && !seen.has(key(row.stage,row.itemId))) {
      seen.add(key(row.stage,row.itemId)); chain.push(row);
      if(row.sampleKind==='RANDOM' && row.parentItemId==null) {complete=true;break;}
      const parent=byId.get(key(stage,row.parentItemId));
      if(!parent || parent.taskId!==row.taskId || row.sampleKind!=='MANDATORY_RECHECK') break;
      row=parent;
    }
    const current=chain[0],root=chain.at(-1);
    let consecutiveReturns=0;
    if(complete && effective(current) && current.outcome==='RETURN') {
      for(const entry of chain) {
        if(!effective(entry) || entry.outcome!=='RETURN' || entry.submitterId!==current.submitterId) break;
        consecutiveReturns++;
      }
    }
    const result={reviewRound:complete?chain.length:null,
      returnRound:complete?chain.filter(entry=>effective(entry)&&entry.outcome==='RETURN').length:null,
      consecutiveReturns,roundKnown:complete,
      firstRecheck:complete && chain.length===2 && effective(root) && root.outcome==='RETURN',
      rootItemId:complete?root.itemId:null};
    cache.set(identity,result);return result;
  }
  return {get:resolve};
}

export function annotateInspectionRounds(events,links) {
  const contexts=inspectionContexts(links);
  const byApproval=new Map(links.map(row=>[key(row.stage,row.approvalId),row]));
  return events.map(event=>{
    const itemId=event.samplingItemId??(event.kind==='SUBMIT'?byApproval.get(key(event.stage,event.approvalId))?.itemId:null);
    if(!itemId) return {...event,...(event.kind==='QUALITY'||event.kind==='RETURN'?{returnRound:null,roundKnown:false}:{} )};
    const context=contexts.get(event.stage,itemId);
    return {...event,...context};
  });
}

export function needsReassignment(current,decision) {
  return current.phase==='HUMAN' && current.accountId!=null && decision?.accountId===current.accountId
    && decision.stage===current.stage && decision.outcome==='RETURN' && !decision.exclusion
    && decision.roundKnown===true && decision.consecutiveReturns>=2
    && (!current.assignedAt || Date.parse(decision.submittedAt)>=Date.parse(current.assignedAt));
}
