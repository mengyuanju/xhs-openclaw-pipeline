// Summary relations retain typed metric columns, never complete detail objects.
// Small source JSON remains available to the canonical ancestry/timing rules.
const TEXT_FIELDS = ['outcome','firstSubmission','rework','sampleKind','firstRecheck','first',
  'deliveryBatchId','returnRound','bucket','reassigned','firstPassed','finalPassed','blocked',
  'unknownCount','unknownScope','username','displayName','exclusion'];
const JSON_FIELDS = ['reasons','affectedTaskIds','sampleSelected'];
const BOOLEAN_FIELDS = new Set(['firstSubmission','rework','firstRecheck','first',
  'reassigned','firstPassed','finalPassed','blocked','unknownScope']);
const INTEGER_FIELDS = new Set(['returnRound','unknownCount']);
const column = name => `metric_${name.replace(/[A-Z]/gu, value => `_${value.toLowerCase()}`)}`;

export function summaryMetricCte() {
  return `summary_metric_facts AS MATERIALIZED (
    SELECT event_key,task_id,account_id,stage,kind,occurred_at,valid,qa_activity,qa_order,
      submission,returned,qa_review,qa_batch,qa_special,first_sample,recheck,annotation_quality,
      affected_count,submitted_at,human_ms,quality_wait_ms,rework_ms,day,
      ${TEXT_FIELDS.map(name => `${BOOLEAN_FIELDS.has(name) ? `(data->>'${name}'='true')`
        : INTEGER_FIELDS.has(name) ? `report_safe_integer(data->>'${name}')`
          : `data->>'${name}'`} AS ${column(name)}`).join(',\n      ')},
      ${JSON_FIELDS.map(name => `data->'${name}' AS ${column(name)}`).join(',\n      ')}
    FROM classified
  )`;
}

export function useSummaryMetricColumns(sql) {
  // Only aggregate expressions use these aliases. The repair lookup continues
  // to read its own event JSON, preserving cross-account recheck attribution.
  sql = sql.replace(/FROM classified f\b/gu, 'FROM summary_metric_facts f')
    .replace(/FROM selected_facts\b/gu, 'FROM summary_metric_facts');
  for (const name of TEXT_FIELDS) {
    sql = sql.replaceAll(`f.data->>'${name}'`, `f.${column(name)}`)
      .replace(new RegExp(`(?<![.\\w])data->>'${name}'`, 'gu'), column(name));
  }
  for (const name of JSON_FIELDS) {
    sql = sql.replaceAll(`f.data->'${name}'`, `f.${column(name)}`)
      .replace(new RegExp(`(?<![.\\w])data->'${name}'`, 'gu'), column(name))
      .replace(new RegExp(`(?<![.\\w])data->>'${name}'`, 'gu'), `${column(name)} #>> '{}'`);
  }
  for (const name of INTEGER_FIELDS) sql = sql.replaceAll(`report_safe_integer(${column(name)})`, column(name));
  return sql;
}

const DETAIL_KEYS = new Set(['id','taskId','accountId','stage','kind','at','canOpen','query',
  'batchId','copyRevisionId','imageRunId','samplingItemPublicId','qaBatchPublicId',
  'qaBatchDisplayName','outcomeChangedAt','outcomeVersion','firstQaAt','passBlocked',
  'rootItemId','consecutiveReturns','roundKnown','reviewRound']);

/** Split generated SQL arguments while respecting SQL strings and nested calls. */
function objectArguments(text) {
  const parts=[]; let start=0,depth=0,quoted=false;
  for(let i=0;i<text.length;i++) {
    const char=text[i];
    if(char==="'") { if(quoted&&text[i+1]==="'")i++;else quoted=!quoted; }
    else if(!quoted) {
      if(char==='('||char==='[')depth++;
      else if(char===')'||char===']')depth--;
      else if(char===','&&depth===0){parts.push(text.slice(start,i));start=i+1;}
    }
  }
  parts.push(text.slice(start));return parts;
}

/** Omit presentation fields only in raw fact builders, before ancestry runs. */
export function slimSummaryRawFacts(sql) {
  const start=sql.indexOf('raw_facts AS ('),end=sql.indexOf('), round_source_base',start);
  if(start<0||end<0)throw new Error('Summary fact boundaries are missing');
  const raw=sql.slice(start,end).replace(/jsonb_build_object\(/gu, '\u0001(');
  let output='',at=0;
  while(at<raw.length) {
    const next=raw.indexOf('\u0001(',at);
    if(next<0){output+=raw.slice(at);break;}
    output+=raw.slice(at,next);let depth=1,quoted=false,cursor=next+2;
    for(;cursor<raw.length&&depth;cursor++) {
      const char=raw[cursor];
      if(char==="'"){if(quoted&&raw[cursor+1]==="'")cursor++;else quoted=!quoted;}
      else if(!quoted){if(char==='(')depth++;else if(char===')')depth--;}
    }
    const argumentsList=objectArguments(raw.slice(next+2,cursor-1));const kept=[];
    for(let i=0;i<argumentsList.length;i+=2) {
      const key=argumentsList[i].trim().match(/^'([^']+)'$/u)?.[1];
      if(!DETAIL_KEYS.has(key))kept.push(argumentsList[i],argumentsList[i+1]);
    }
    output+=kept.length?`jsonb_build_object(${kept.join(',')})`:"'{}'::jsonb";
    at=cursor;
  }
  output=output.replaceAll('\u0001(', 'jsonb_build_object(')
    .replace(/\|\|\s*'\{\}'::jsonb/gu,'');
  return sql.slice(0,start)+output+sql.slice(end);
}
