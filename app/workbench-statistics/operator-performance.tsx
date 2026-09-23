'use client';
import { useEffect,useId,useRef,useState,type FormEvent,type ReactNode } from 'react';
import { RefreshCw,Download,ArrowUpDown,Info,X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Select,SelectContent,SelectItem,SelectTrigger,SelectValue } from '@/components/ui/select';
import { apiRequest } from '../components/api-client';
import { Chart,number } from './shared';
import { useOperatorPerformance,OPERATOR_API } from './use-operator-performance';
import { OperatorDetailDialog } from './operator-detail';
import type { OperatorPerson,OperatorReport,QualityOutcomes,QaStage } from './operator-types';
import styles from './operator-performance.module.css';

const defaults={period:'7d',from:'',to:'',stage:'',query:'',accountId:'',batchId:'',page:'1',pageSize:'20',sort:'submitted',order:'desc',activity:'ALL'};
const stages=[['COPY','文案'],['IMAGE','图片']] as const;
type AccountOption={id:number;username:string;displayName?:string;status?:string};
type MetricColumn={key:string;label:string};
const percent=(rate:number|null)=>rate===null?'—':(rate*100).toFixed(2)+'%';
const qaPass=(value:Pick<QaStage,'passed'|'returned'|'batchImpactReturns'>)=>{
  const decided=value.passed+value.returned+value.batchImpactReturns;
  return {passed:value.passed,decided,rate:decided?value.passed/decided:0};
};

function MetricHelp({title='指标说明',children}:{title?:string;children:ReactNode}) {
  const [open,setOpen]=useState(false),id=useId(),container=useRef<HTMLDivElement>(null);
  useEffect(()=>{
    if(!open)return;
    const closeOutside=(event:PointerEvent)=>{if(!container.current?.contains(event.target as Node))setOpen(false);};
    const closeEscape=(event:KeyboardEvent)=>{if(event.key==='Escape')setOpen(false);};
    document.addEventListener('pointerdown',closeOutside);document.addEventListener('keydown',closeEscape);
    return()=>{document.removeEventListener('pointerdown',closeOutside);document.removeEventListener('keydown',closeEscape);};
  },[open]);
  return <div className={styles.help} ref={container}><button type="button" className={styles.helpTrigger} aria-expanded={open} aria-controls={id} onClick={()=>setOpen(value=>!value)}><Info size={15} aria-hidden="true"/>{title}</button>
    {open&&<div id={id} className={styles.helpContent} role="note"><button type="button" className={styles.helpClose} aria-label="关闭指标说明" onClick={()=>setOpen(false)}><X size={14}/></button>{children}</div>}</div>;
}

export function QualityOutcomeRates({value,onSelect}:{value:QualityOutcomes;onSelect:(metric:string)=>void}) {
  return <div className={styles.outcomeGrid}>{([['firstPassed','一次通过率',value.firstPassed,value.firstPassRate],['qualityReturned','打回率',value.returned,value.returnRate],['discarded','废弃率',value.discarded,value.discardedRate]] as const).map(([metric,label,count,rate])=><button type="button" className={styles.outcomeCard} key={metric} onClick={()=>onSelect(metric)} disabled={!value.judged}><span>{label}</span><strong>{percent(rate)}</strong><small>{number(count)} / {number(value.judged)} 条</small></button>)}</div>;
}
function OverallPass({summary,scoped=false}:{summary:OperatorReport['summary']|undefined;scoped?:boolean}) {
  const {passed,decided,rate}=qaPass(summary?.qa??{passed:0,returned:0,batchImpactReturns:0});
  return <section className={styles.overallPanel} aria-label="质检操作通过率"><div className={styles.overallMain}>
    <div className={styles.overallTop}><span className={styles.eyebrow}>{scoped?'所选人员质检':'团队质检'}</span><MetricHelp title="通过率口径"><p>质检操作通过率 = 所选日期内逐项通过次数 /（逐项通过次数 + 逐项退回次数 + 整批打回波及退回项次）。首次抽检和返修后的强制复检都按操作时间、操作账号计入；同一内容多轮判定分别计数。</p><p>文案整批打回的触发项由逐项退回计入，其他波及项由整批记录计入；图片整批打回的全部波及项由整批记录计入。快捷直放、质检废弃和移交管理员不计入。没有判定时按 0.00% 展示。</p></MetricHelp></div>
    <h2>质检操作通过率</h2><strong className={styles.overallValue}>{percent(rate)}</strong>
    <span className={styles.overallCount}>{`通过 ${number(passed)} / 判定 ${number(decided)} 项次`}</span>
    {!!summary?.qa.batchImpactReturns&&<small>其中整批波及退回 {number(summary.qa.batchImpactReturns)} 项次</small>}
    {!!summary?.qa.unknownBatchCounts&&<small>{number(summary.qa.unknownBatchCounts)} 次整批打回缺少可恢复的波及数量，未计入</small>}
    {decided>0&&decided<20&&<small className={styles.sample}>判定少于 20 项次，仅供参考</small>}
  </div><div className={styles.overallStages}>{stages.map(([stage,label])=>{const value=summary?.qa[stage],stagePass=qaPass(value??{passed:0,returned:0,batchImpactReturns:0});return <div key={stage}>
    <span>{label}</span><strong>{percent(stagePass.rate)}</strong><small>{number(stagePass.passed)} / {number(stagePass.decided)} 项次</small></div>;})}</div></section>;
}
function OutcomeCell({value,count,decided,metric,person,onSelect,tone,unit='项次'}:{value:number|null;count:number;decided:number;metric:string;person:OperatorPerson;onSelect:()=>void;tone:string;unit?:'项次'|'条'}) {
  return <td className={styles.outcomeCell}><button type="button" className={`${styles.link} ${styles.outcomeValue} ${tone}`} disabled={!decided}
    aria-label={`${person.displayName}${metric} ${percent(value)}，${number(count)} / ${number(decided)} ${unit}，查看明细`} onClick={onSelect}>
    <span className={styles.mobileMetricLabel}>{metric}</span><strong>{percent(value)}</strong><small>{number(count)} / {number(decided)} {unit}</small></button></td>;
}
function AccountOverallPass({person,qa,stageLabel='',onSelect}:{person:OperatorPerson;qa:boolean;stageLabel?:string;onSelect:()=>void}) {
  const {passed,decided,rate}=qa?qaPass(person.qa):person.annotationOverallPass;
  const label=qa?'质检操作通过率':`${stageLabel}整体通过率`;
  return <td className={`${styles.outcomeCell} ${qa?styles.qaOverallCell:''}`}><button type="button" className={`${styles.link} ${styles.outcomeValue} ${styles.overallCell}`} onClick={onSelect}
    aria-label={qa?`${person.displayName}${label} ${percent(rate)}，通过 ${number(passed)} / 判定 ${number(decided)} 项次，其中整批波及退回 ${number(person.qa.batchImpactReturns)} 项次，查看明细`
      :`${person.displayName}${label} ${percent(rate)}，通过 ${number(passed)} / 判定 ${number(decided)} 项次，其中一次通过 ${number(person.annotationOverallPass.firstPassed)} 项次、返修通过 ${number(person.annotationOverallPass.reworkPassed)} 项次，查看明细`}>
    <span className={styles.mobileMetricLabel}>{label}</span><strong>{percent(rate)}</strong>
    <small>{number(passed)} / {number(decided)} 判定项次</small>
    {qa?person.qa.batchImpactReturns>0&&<small>整批波及退回 {number(person.qa.batchImpactReturns)} 项次</small>
      :<small>一次通过 {number(person.annotationOverallPass.firstPassed)} 项次 · 返修通过 {number(person.annotationOverallPass.reworkPassed)} 项次</small>}
    {qa&&person.qa.unknownBatchCounts>0&&<small>{number(person.qa.unknownBatchCounts)} 次整批打回缺少波及数量</small>}
    {decided>0&&decided<20&&<small className={styles.sample}>判定少于 20 项次</small>}</button></td>;
}
function Card({label,value,note,onClick}:{label:string;value:number|undefined;note:string;onClick:()=>void}) {
  return <article className={styles.card}><span>{label}</span><button className={`${styles.link} ${styles.cardValue}`} onClick={onClick}
    disabled={value==null} aria-label={`${label}：${number(value)} 条，查看明细`}><strong>{number(value)}</strong><span>条</span></button><small>{note}</small></article>;
}

export function OperatorPerformance({initialFilters={}}:{initialFilters?:Record<string,string>}) {
  const accountView=initialFilters.view ? initialFilters.view==='accounts'
    : !!initialFilters.accountId||!!initialFilters.query||!!initialFilters.stage||!!initialFilters.batchId||['PRODUCTION','QA'].includes(initialFilters.activity);
  const initialActivity=accountView&&['QA','PRODUCTION'].includes(initialFilters.activity)?initialFilters.activity:'ALL';
  const initialStage=accountView?(initialActivity==='QA'?['COPY','IMAGE'].includes(initialFilters.stage)?initialFilters.stage:'':initialFilters.stage==='IMAGE'?'IMAGE':'COPY'):'';
  const [view,setView]=useState(accountView?'accounts':'overview');
  const [filters,setFilters]=useState<Record<string,string>>(()=>({...defaults,...Object.fromEntries(Object.entries(initialFilters).filter(([key])=>key in defaults)),
    sort:initialFilters.sort??(accountView?(initialFilters.activity==='QA'?'qa':initialFilters.activity==='PRODUCTION'?'judged':'contributed'):'submitted'),
    stage:initialStage,activity:initialActivity}));
  const [dateError,setDateError]=useState('');
  const [showWorkload,setShowWorkload]=useState(false);
  const [selection,setSelection]=useState<{accountId:number;metric:string;stage:string;scopeStage:string;sampleSet:string;report:OperatorReport}|null>(null);
  const {report,error,busy,refresh}=useOperatorPerformance(filters);
  const [accounts,setAccounts]=useState<AccountOption[]>([]);
  const [exportError,setExportError]=useState(''),[exporting,setExporting]=useState(false);
  useEffect(()=>{let cancelled=false;void apiRequest<AccountOption[]|{items?:AccountOption[]}>('/api/control-plane/v1/users',{cache:'no-store'})
    .then(data=>{if(!cancelled)setAccounts(Array.isArray(data)?data:data.items??[]);}).catch(()=>{});
    return()=>{cancelled=true;};},[]);
  useEffect(()=>{const search=new URLSearchParams({...Object.fromEntries(Object.entries(filters).filter(([,v])=>v!=='')),view});
    window.history.replaceState(null,'',`${window.location.pathname}?${search}`);},[filters,view]);
  const show=(accountId:number,metric='all',stage='',sampleSet='all')=>{if(report)setSelection({accountId,metric,stage,scopeStage:view==='accounts'?filters.stage:'',sampleSet,report});};
  function changeView(next:string) {
    setView(next);setSelection(null);
    setFilters(previous=>({...previous,batchId:'',stage:next==='accounts'?'COPY':'',page:'1',sort:next==='overview'?'submitted':'contributed',order:'desc',activity:'ALL'}));
  }
  function apply(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields=new FormData(event.currentTarget),from=String(fields.get('from')||''),to=String(fields.get('to')||'');
    const selectedAccountId=String(fields.get('accountId')||'');
    const accountId=selectedAccountId==='__all__'?'':selectedAccountId;
    const selectedStage=String(fields.get('stage')||'');
    const days=(Date.parse(to)-Date.parse(from))/86400000+1;
    if((from||to)&&(!Number.isFinite(days)||days<1||days>366)){setDateError('请选择完整的日期，范围为 1–366 天');return;}
    setDateError('');setFilters(previous=>({...previous,from,to,period:from?'custom':previous.period==='custom'?'7d':previous.period,
      accountId,query:accountId?'':String(fields.get('query')||'').trim(),stage:view==='accounts'?(previous.activity==='QA'?['COPY','IMAGE'].includes(selectedStage)?selectedStage:'':selectedStage==='IMAGE'?'IMAGE':'COPY'):'',page:'1'}));
  }
  function preset(value:string) {
    const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10);
    const yesterday=new Date(Date.parse(`${today}T00:00:00Z`)-86400000).toISOString().slice(0,10);
    const custom=value==='yesterday'||value==='month';
    setDateError('');setFilters(previous=>({...previous,period:custom?'custom':value,
      from:value==='yesterday'?yesterday:value==='month'?`${today.slice(0,7)}-01`:'',to:value==='yesterday'?yesterday:value==='month'?today:'',page:'1'}));
  }
  const sort=(key:string)=>setFilters(previous=>({...previous,sort:key,order:previous.sort===key&&previous.order==='desc'?'asc':'desc',page:'1'}));
  const activePreset=(value:string)=>filters.period===value || filters.period==='custom' && (
    value==='yesterday' && filters.from===filters.to && filters.from===new Date(Date.now()+8*3600000-86400000).toISOString().slice(0,10)
    || value==='month' && filters.to===new Date(Date.now()+8*3600000).toISOString().slice(0,10) && filters.from===`${filters.to.slice(0,7)}-01`);
  async function exportReport() {
    if(!report||exporting)return;setExporting(true);setExportError('');
    try {
      const response=await fetch(`${OPERATOR_API}/export?snapshotToken=${encodeURIComponent(report.snapshotToken)}`,{cache:'no-store',signal:AbortSignal.timeout(30_000)});
      if(!response.ok){const body=await response.json().catch(()=>null);throw Error(body?.error?.message||'导出失败，请刷新统计后重试');}
      const blob=await response.blob(),url=URL.createObjectURL(blob),anchor=document.createElement('a');
      anchor.href=url;anchor.download=`标注与质检_${report.range.from}_${report.range.to}.csv`;anchor.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
    }catch(caught){setExportError(caught instanceof Error?caught.message:'导出失败');}finally{setExporting(false);}
  }
  const summary=report?.summary,activity=filters.activity,qa=activity==='QA',all=activity==='ALL';
  const accountOptions=new Map(accounts.map(account=>[account.id,account]));
  for(const person of report?.people.items??[]) if(!accountOptions.has(person.accountId)) accountOptions.set(person.accountId,{id:person.accountId,username:person.username,displayName:person.displayName,status:'HISTORICAL'});
  const selectedAccount=accountOptions.get(Number(filters.accountId));
  const selectedAccountLabel=selectedAccount
    ? `${selectedAccount.displayName||selectedAccount.username}（${selectedAccount.username}）`
    : filters.accountId ? `历史账号 #${filters.accountId}` : '';
  const summaryAccountId=Number(filters.accountId)||0;
  const visibleStages=stages.filter(([stage])=>!filters.stage||stage===filters.stage);
  const stageLabel=filters.stage==='IMAGE'?'图片':'文案';
  const columns: MetricColumn[]=qa?
    [...visibleStages.map(([stage,label]):MetricColumn=>({key:stage==='COPY'?'copyQa':'imageQa',label:`${label}质检`})),
      {key:'overallPassRate',label:'质检操作通过率'},
      {key:'qaReviews',label:'质检次数'},
      {key:'qaPassed',label:'通过次数'},
      {key:'qaReturned',label:'逐项退回'},
      {key:'qaRecheck',label:'复检次数'}]:
    [{key:'judged',label:`${stageLabel}判定项次`},
      {key:'firstPassRate',label:`${stageLabel}一次通过率`},
      {key:'overallPassRate',label:`${stageLabel}整体通过率`},
      {key:'returnRate',label:`${stageLabel}打回率`},
      {key:'discardedRate',label:`${stageLabel}首检废弃率`}];
  function cells(person:OperatorPerson) {
    if(qa)return <>{visibleStages.map(([stage,label])=><td className={styles.metricCell} data-label={`${label}质检`} aria-label={`${label}质检 ${number(person.qa[stage].tasks)} 项`} key={stage}><button className={styles.link} onClick={()=>show(person.accountId,'qa',stage)}>{number(person.qa[stage].tasks)}</button>
      </td>)}<AccountOverallPass person={person} qa onSelect={()=>show(person.accountId,'qaAll',filters.stage)}/>
      <td className={styles.metricCell} data-label="质检次数" aria-label={`质检次数 ${number(person.qa.reviews)} 次`}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage)}>{number(person.qa.reviews)}</button></td>
      <td className={styles.metricCell} data-label="通过次数" aria-label={`通过次数 ${number(person.qa.passed)} 次`}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage,'passed')}>{number(person.qa.passed)}</button></td>
      <td className={styles.metricCell} data-label="逐项退回" aria-label={`逐项退回 ${number(person.qa.returned)} 次`}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage,'failed')}>{number(person.qa.returned)}</button></td>
      <td className={styles.metricCell} data-label="复检次数" aria-label={`复检次数 ${number(person.qa.rechecks)} 次`}><button className={styles.link} onClick={()=>show(person.accountId,'qaRecheck',filters.stage)}>{number(person.qa.rechecks)}</button></td></>;
    const quality=person.qualityOutcomes,verdict=person.annotationOverallPass;
    return <><td className={styles.metricCell} data-label={`${stageLabel}判定项次`}><button className={`${styles.link} ${styles.judgedValue}`} aria-label={`${person.displayName}${stageLabel}判定 ${number(verdict.decided)} 项次，查看明细`} onClick={()=>show(person.accountId,'annotationOverall',filters.stage)}>{number(verdict.decided)}<small>{stageLabel}判定项次</small></button></td>
      <OutcomeCell value={verdict.firstPassRate} count={verdict.firstPassed} decided={verdict.decided} metric={`${stageLabel}一次通过率`} person={person} onSelect={()=>show(person.accountId,'annotationOverall',filters.stage,'first')} tone={styles.passValue}/>
      <AccountOverallPass person={person} qa={false} stageLabel={stageLabel} onSelect={()=>show(person.accountId,'annotationOverall',filters.stage)}/>
      <OutcomeCell value={verdict.returnRate} count={verdict.failed} decided={verdict.decided} metric={`${stageLabel}打回率`} person={person} onSelect={()=>show(person.accountId,'annotationOverall',filters.stage,'failed')} tone={styles.returnValue}/>
      <OutcomeCell value={quality.discardedRate??0} count={quality.discarded} decided={quality.judged} metric={`${stageLabel}首检废弃率`} person={person} onSelect={()=>show(person.accountId,'discarded',filters.stage)} tone={styles.discardValue} unit="条"/></>;
  }
  return <div className={styles.page}>
    <header className={styles.header}><div><h1>数据统计</h1><p className={styles.muted}>先看质量结果，再查看工作量与明细。</p></div><div className={styles.actions}>
      <Button variant="outline" size="sm" disabled={!report||busy||exporting} onClick={()=>void exportReport()}><Download size={14}/>{exporting?'导出中…':'导出报表'}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCw size={14}/>{busy?'更新中…':'刷新'}</Button></div></header>
    <nav className={styles.mainTabs} aria-label="统计视图">{[['overview','总数据'],['accounts','账号数据']].map(([value,label])=><button type="button" key={value} aria-current={view===value?'page':undefined} onClick={()=>changeView(value)}>{label}</button>)}</nav>
    <form className={`panel ${styles.filters}`} onSubmit={apply} key={`${view}:${filters.period}:${filters.from}:${filters.to}:${filters.accountId}:${filters.query}:${filters.stage}:${accounts.length}`}>
      <div className={styles.presets}>{[['today','今日'],['yesterday','昨日'],['7d','近 7 天'],['month','本月'],['30d','近 30 天']].map(([value,label])=><Button key={value} variant="outline" size="sm" type="button" aria-pressed={activePreset(value)} onClick={()=>preset(value)}>{label}</Button>)}</div>
      <DatePicker name="from" label="开始日期" defaultValue={filters.from}/><DatePicker name="to" label="结束日期" defaultValue={filters.to}/>
      <div className={styles.filterField}><label htmlFor="operator-account-filter">人员</label><Select name="accountId" defaultValue={filters.accountId||'__all__'}><SelectTrigger id="operator-account-filter" aria-label="人员"><SelectValue/></SelectTrigger><SelectContent><SelectItem value="__all__">全部人员</SelectItem>
        {[...accountOptions.values()].toSorted((a,b)=>(a.displayName||a.username).localeCompare(b.displayName||b.username,'zh-CN')).map(account=><SelectItem key={account.id} value={String(account.id)}>{account.displayName||account.username}（{account.username}）{account.status==='DISABLED'?' · 已停用':account.status==='HISTORICAL'?' · 历史':''}</SelectItem>)}</SelectContent></Select></div>
      {view==='accounts'&&<><label className={styles.search}>账号<input name="query" aria-label="账号" placeholder="搜索姓名或账号" maxLength={128} defaultValue={filters.query}/></label>
        <div className={styles.filterField}><label htmlFor="operator-stage-filter">内容类型</label><Select name="stage" defaultValue={filters.stage||'__all__'}><SelectTrigger id="operator-stage-filter" aria-label="内容类型"><SelectValue/></SelectTrigger><SelectContent>{qa&&<SelectItem value="__all__">文案和图片</SelectItem>}<SelectItem value="COPY">文案</SelectItem><SelectItem value="IMAGE">图片</SelectItem></SelectContent></Select></div></>}
      <Button type="submit" size="sm">应用筛选</Button></form>
    {(filters.accountId||filters.batchId)&&<div className={styles.attention}><span>{filters.accountId?`人员：${selectedAccountLabel}`:''} {filters.batchId?`指定批次 #${filters.batchId}`:''}</span><Button variant="ghost" size="sm" onClick={()=>setFilters(previous=>({...previous,accountId:'',batchId:'',page:'1'}))}>清除指定范围</Button></div>}
    {dateError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{dateError}</div>}
    {error&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{error}{report?'。以下保留上次成功的数据和范围，可能已过时。':'。尚未取得统计数据。'}</div>}
    {exportError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{exportError}</div>}
    {report&&<p role="status" className={styles.muted}>{report.range.from} 至 {report.range.to} · 北京时间 · 更新于 {new Date(report.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>}
    {!report&&busy&&<p role="status">正在汇总标注与质检记录…</p>}
    {view==='overview'?<>
      <OverallPass summary={summary} scoped={!!filters.accountId}/>
      <section className={`panel ${styles.section}`} aria-label="判定结果"><div className={styles.sectionHeading}><div><h2>{filters.accountId?'所选人员判定结果':'团队判定结果'}</h2><span className={styles.muted}>已判定 {number(summary?.qualityOutcomes.judged)} 条内容阶段</span></div>
        <MetricHelp><p>一次通过、打回、废弃是互斥的最终分类，共用“已判定”分母；没有判定时显示 —。</p><p>按各账号首次有效质检日归属。最终废弃会回写原日期；曾被打回后复检通过仍计打回。</p></MetricHelp></div>
        {summary&&<QualityOutcomeRates value={summary.qualityOutcomes} onSelect={metric=>show(summaryAccountId,metric,filters.stage)}/>}
      </section>
      <div className={styles.attention}><span>当前待处理</span><button className={styles.link} onClick={()=>show(summaryAccountId,'reassign')}>建议改派 {number(summary?.reassignSuggested)} 条</button><button className={styles.link} onClick={()=>show(summaryAccountId,'qaPending')}>待质检 {number(summary?.qa.pending)} 项</button></div>
      <details className={`panel ${styles.section} ${styles.workload}`} onToggle={event=>setShowWorkload(event.currentTarget.open)}><summary>工作量与趋势</summary>
        <div className={styles.headlineCards} aria-label="总数据">
          {stages.map(([stage,label])=><Card key={stage} label={`${label}标注`} value={summary?.[stage].submitted}
            note={`首次提交 ${number(summary?.[stage].firstSubmitted)} · 返修处理 ${number(summary?.[stage].reworked)}`} onClick={()=>show(summaryAccountId,'submitted',stage)}/>)}
          {stages.map(([stage,label])=><Card key={`qa-${stage}`} label={`${label}质检`} value={summary?.qa[stage].tasks}
            note={`${number(summary?.qa[stage].reviews)} 次质检 · 含复检 ${number(summary?.qa[stage].rechecks)} 次`} onClick={()=>show(summaryAccountId,'qa',stage)}/>)}
          <Card label="新增可交付内容" value={summary?.released} note="首次达到交付条件" onClick={()=>show(summaryAccountId,'released')}/>
        </div>
        {showWorkload&&report&&<div className={styles.trend}><h3>每日工作量</h3><Chart label="每日标注与质检条数" unit="条" labels={report.trend.map(day=>day.date.slice(5))} series={[
          {name:'文案标注',values:report.trend.map(day=>day.copySubmitted)},{name:'图片标注',values:report.trend.map(day=>day.imageSubmitted)},
          {name:'文案质检',values:report.trend.map(day=>day.copyQa)},{name:'图片质检',values:report.trend.map(day=>day.imageQa)}]}/></div>}
        <div className={styles.coverage}>{stages.map(([stage,label])=><span key={stage}>{label}抽检覆盖 {summary?.[stage].coverage.rate==null?'—':percent(summary[stage].coverage.rate)} · {number(summary?.[stage].coverage.sampled)} / {number(summary?.[stage].coverage.eligible)} 条</span>)}</div>
      </details>
    </>:<>
      {qa&&<OverallPass summary={summary} scoped={!!filters.accountId}/>}
      <section className={`panel ${styles.section}`} aria-label="账号数据">
        <div className={styles.sectionHeading}><div><h2>{qa?'质检工作量':all?'账号表现':'账号质量表现'}</h2><span className={styles.muted}>{number(report?.people.total)} 个账号{!qa?' · 一次通过、打回和废弃可点击查看明细':''}</span></div>
          <MetricHelp>{qa?<><p>质检操作通过率按所选日期内实际质检账号计算：逐项通过次数 /（逐项通过次数 + 逐项退回次数 + 整批打回波及退回项次）。初检和返修后的复检都计入，同一内容多轮判定分别计数。</p>
            <p>质检作业按内容去重；质检次数含复检及移交管理员。文案整批的触发项计入逐项退回，其余波及项计入整批；图片整批全部波及项计入整批。快捷直放、废弃和移交管理员不计入。</p></>
            :<><p>{stageLabel}整体通过率按实际标注账号归属：所选日期内给出“通过”的{stageLabel}判定项次 / 给出“通过或退回”的{stageLabel}判定总项次。通过包含一次通过和返修后通过；文案与图片分开统计。</p>
            <p>日期按北京时间每次有效质检结论的时间筛选。同一{stageLabel}同一天多次质检，每次有效通过或退回都计一项次；跨天复检计入实际结论日。整批打回的每条可识别受影响{stageLabel}各计一次退回，触发项不与逐项退回重复。判定项次、一次通过率、整体通过率和打回率共用结论项次分母；首检废弃率单独按首次质检日归属。没有判定时整体通过率显示 0.00%（0/0）。</p></>}</MetricHelp></div>
        {!qa&&!!report&&(report.dataQuality.unattributedAnnotationBatchReturns>0||report.dataQuality.unattributedAnnotationBatchScopes>0)&&<p className={styles.notice} role="note">
          {report.dataQuality.unattributedAnnotationBatchReturns>0&&<>另有 {number(report.dataQuality.unattributedAnnotationBatchReturns)} 项整批波及缺少成员归属，未分摊到账号。</>}
          {report.dataQuality.unattributedAnnotationBatchScopes>0&&<>另有 {number(report.dataQuality.unattributedAnnotationBatchScopes)} 次整批打回的总波及数量无法确认；已识别成员仍计入账号。</>}
        </p>}
        <div className={styles.workTabs} aria-label="工作类型">{[['ALL','全部'],['PRODUCTION','标注'],['QA','质检']].map(([value,label])=><Button key={value} type="button" variant="outline" size="sm" aria-pressed={filters.activity===value}
          onClick={()=>setFilters(previous=>({...previous,activity:value,stage:value==='QA'?'':'COPY',page:'1',sort:value==='QA'?'qa':value==='PRODUCTION'?'judged':'contributed',order:'desc'}))}>{label}</Button>)}</div>
        {!qa&&<div className={styles.mobileSort}><label htmlFor="operator-mobile-sort">排序</label><Select value={['judged','firstPassRate','overallPassRate','returnRate','discardedRate',...(all?['contributed']:[])].includes(filters.sort)?`${filters.sort}:${filters.order}`:all?'contributed:desc':'judged:desc'} onValueChange={value=>{const [sort,order]=value.split(':');setFilters(previous=>({...previous,sort,order,page:'1'}));}}><SelectTrigger id="operator-mobile-sort" aria-label="账号排序"><SelectValue/></SelectTrigger><SelectContent>
          {all&&<><SelectItem value="contributed:desc">参与处理最多</SelectItem><SelectItem value="contributed:asc">参与处理最少</SelectItem></>}
          <SelectItem value="judged:desc">{stageLabel}判定项次最多</SelectItem><SelectItem value="judged:asc">{stageLabel}判定项次最少</SelectItem>
          <SelectItem value="firstPassRate:desc">{stageLabel}一次通过率最高</SelectItem><SelectItem value="firstPassRate:asc">{stageLabel}一次通过率最低</SelectItem>
          <SelectItem value="overallPassRate:desc">{stageLabel}整体通过率最高</SelectItem><SelectItem value="overallPassRate:asc">{stageLabel}整体通过率最低</SelectItem>
          <SelectItem value="returnRate:desc">{stageLabel}打回率最高</SelectItem><SelectItem value="returnRate:asc">{stageLabel}打回率最低</SelectItem>
          <SelectItem value="discardedRate:desc">{stageLabel}首检废弃率最高</SelectItem><SelectItem value="discardedRate:asc">{stageLabel}首检废弃率最低</SelectItem>
        </SelectContent></Select></div>}
        {qa&&<div className={styles.mobileSort}><label htmlFor="operator-mobile-sort">排序</label><Select value={['qa','overallPassRate'].includes(filters.sort)?`${filters.sort}:${filters.order}`:'qa:desc'} onValueChange={value=>{const [sort,order]=value.split(':');setFilters(previous=>({...previous,sort,order,page:'1'}));}}><SelectTrigger id="operator-mobile-sort" aria-label="账号排序"><SelectValue/></SelectTrigger><SelectContent>
          <SelectItem value="qa:desc">质检作业最多</SelectItem><SelectItem value="qa:asc">质检作业最少</SelectItem>
          <SelectItem value="overallPassRate:desc">质检操作通过率最高</SelectItem><SelectItem value="overallPassRate:asc">质检操作通过率最低</SelectItem>
        </SelectContent></Select></div>}
        <div className={styles.tableScroll} role="region" aria-label="账号统计表" tabIndex={0}><table className={`${styles.table} ${qa?styles.qaTable:styles.qualityTable}`}><thead><tr><th scope="col">账号</th>{columns.map(({key,label})=><th scope="col" key={key} aria-sort={filters.sort===key?(filters.order==='asc'?'ascending':'descending'):'none'}><button type="button" className={styles.sortButton} onClick={()=>sort(key)}>{label} <ArrowUpDown size={13} aria-hidden="true"/></button></th>)}</tr></thead>
          <tbody>{report?.people.items.map(person=><tr key={person.accountId}><td><button type="button" className={`${styles.link} ${styles.name}`} onClick={()=>show(person.accountId,qa?'qaAll':'annotationOverall',filters.stage)}>{person.displayName}</button><small>@{person.username}</small></td>{cells(person)}</tr>)}
          {!report?.people.items.length&&<tr><td colSpan={columns.length+1} className={styles.empty}>{busy?'正在读取…':'当前范围暂无记录'}</td></tr>}</tbody></table></div>
        {report&&<div className={styles.pagination}><span>第 {report.people.page} / {Math.max(1,Math.ceil(report.people.total/report.people.pageSize))} 页</span><div className={styles.actions}><Button variant="outline" size="sm" disabled={busy||report.people.page<=1} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page-1)}))}>上一页</Button><Button variant="outline" size="sm" disabled={busy||report.people.page*report.people.pageSize>=report.people.total} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page+1)}))}>下一页</Button></div></div>}
      </section>
    </>}
    {selection&&<OperatorDetailDialog key={`${selection.report.snapshotToken}:${selection.accountId}:${selection.metric}:${selection.stage}`} report={selection.report} selection={selection} onClose={()=>setSelection(null)}/>}
  </div>;
}
