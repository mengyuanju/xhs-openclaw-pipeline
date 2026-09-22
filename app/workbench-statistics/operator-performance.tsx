'use client';
import { useEffect,useState,type FormEvent } from 'react';
import { RefreshCw,Download,ArrowUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { apiRequest } from '../components/api-client';
import { Chart,number } from './shared';
import { useOperatorPerformance,OPERATOR_API } from './use-operator-performance';
import { OperatorDetailDialog,RATE_LABEL } from './operator-detail';
import type { OperatorPerson,OperatorReport,Rate,QualityOutcomes } from './operator-types';
import styles from './operator-performance.module.css';

const defaults={period:'7d',from:'',to:'',stage:'',query:'',accountId:'',batchId:'',page:'1',pageSize:'20',sort:'submitted',order:'desc',activity:'ALL'};
const stages=[['COPY','文案'],['IMAGE','图片']] as const;
type AccountOption={id:number;username:string;displayName?:string;status?:string};
type MetricColumn={key:string;label:string;help:string};
export function RateValue({value,onClick,detail}:{value:Rate;onClick:()=>void;detail?:string}) {
  return <button className={`${styles.link} ${styles.rate}`} onClick={onClick}><strong>{RATE_LABEL(value)}</strong>
    <small className={styles.metricDetail}>{detail??(value.decided
      ?`已出结论 ${value.decided} 条：通过 ${value.passed} 条、退回 ${value.failed} 条。`
      :'当前没有符合统计口径且已出结论的样本，暂时无法计算。')}</small>
    {value.decided>0&&value.decided<20&&<small className={styles.sample}>样本少于 20 条，结果仅供参考。</small>}</button>;
}
export function QualityOutcomeRates({value,onSelect}:{value:QualityOutcomes;onSelect:(metric:string)=>void}) {
  const percent=(rate:number|null)=>rate===null?'—':(rate*100).toFixed(2)+'%';
  return <div><button className={styles.link} onClick={()=>onSelect('judged')}>已判定 {value.judged} 条</button>
    {([['discarded','废弃率',value.discarded,value.discardedRate],['firstPassed','一次通过率',value.firstPassed,value.firstPassRate],['qualityReturned','打回率',value.returned,value.returnRate]] as const).map(([metric,label,count,rate])=><div key={metric}><button className={styles.link} onClick={()=>onSelect(metric)}>{label} {percent(rate)} · {count} 条</button></div>)}
    <small><button className={styles.link} onClick={()=>onSelect('reassigned')}>其中已二次分配 {value.reassigned} 条</button></small></div>;
}
function Card({label,value,note,onClick}:{label:string;value:number|undefined;note:string;onClick:()=>void}) {
  return <article className={styles.card}><span>{label}</span><button className={`${styles.link} ${styles.cardValue}`} onClick={onClick}
    disabled={value==null} aria-label={`${label}：${number(value)} 条，查看明细`}><strong>{number(value)}</strong><span>条</span></button><small>{note}</small></article>;
}

export function OperatorPerformance({initialFilters={}}:{initialFilters?:Record<string,string>}) {
  const accountView=initialFilters.view ? initialFilters.view==='accounts'
    : !!initialFilters.accountId||!!initialFilters.query||!!initialFilters.stage||!!initialFilters.batchId||['PRODUCTION','QA'].includes(initialFilters.activity);
  const [view,setView]=useState(accountView?'accounts':'overview');
  const [filters,setFilters]=useState<Record<string,string>>(()=>({...defaults,...Object.fromEntries(Object.entries(initialFilters).filter(([key])=>key in defaults)),
    activity:accountView?(initialFilters.activity==='QA'?'QA':'PRODUCTION'):'ALL'}));
  const [dateError,setDateError]=useState('');
  const [selection,setSelection]=useState<{accountId:number;metric:string;stage:string;sampleSet:string;report:OperatorReport}|null>(null);
  const {report,error,busy,refresh}=useOperatorPerformance(filters);
  const [accounts,setAccounts]=useState<AccountOption[]>([]);
  const [exportError,setExportError]=useState(''),[exporting,setExporting]=useState(false);
  useEffect(()=>{let cancelled=false;void apiRequest<AccountOption[]|{items?:AccountOption[]}>('/api/control-plane/v1/users',{cache:'no-store'})
    .then(data=>{if(!cancelled)setAccounts(Array.isArray(data)?data:data.items??[]);}).catch(()=>{});
    return()=>{cancelled=true;};},[]);
  useEffect(()=>{const search=new URLSearchParams({...Object.fromEntries(Object.entries(filters).filter(([,v])=>v!=='')),view});
    window.history.replaceState(null,'',`${window.location.pathname}?${search}`);},[filters,view]);
  const show=(accountId:number,metric='all',stage='',sampleSet='all')=>{if(report)setSelection({accountId,metric,stage,sampleSet,report});};
  function changeView(next:string) {
    setView(next);setSelection(null);
    setFilters(previous=>({...previous,batchId:'',stage:'',page:'1',sort:'submitted',activity:next==='overview'?'ALL':'PRODUCTION'}));
  }
  function apply(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();const fields=new FormData(event.currentTarget),from=String(fields.get('from')||''),to=String(fields.get('to')||'');
    const accountId=String(fields.get('accountId')||'');
    const days=(Date.parse(to)-Date.parse(from))/86400000+1;
    if((from||to)&&(!Number.isFinite(days)||days<1||days>366)){setDateError('请选择完整的日期，范围为 1–366 天');return;}
    setDateError('');setFilters(previous=>({...previous,from,to,period:from?'custom':previous.period==='custom'?'7d':previous.period,
      accountId,query:accountId?'':String(fields.get('query')||'').trim(),stage:String(fields.get('stage')||''),page:'1'}));
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
  const summary=report?.summary,qa=(report?.filters?.activity??filters.activity)==='QA';
  const accountOptions=new Map(accounts.map(account=>[account.id,account]));
  for(const person of report?.people.items??[]) if(!accountOptions.has(person.accountId)) accountOptions.set(person.accountId,{id:person.accountId,username:person.username,displayName:person.displayName,status:'HISTORICAL'});
  const selectedAccount=accountOptions.get(Number(filters.accountId));
  const selectedAccountLabel=selectedAccount
    ? `${selectedAccount.displayName||selectedAccount.username}（${selectedAccount.username}）`
    : filters.accountId ? `历史账号 #${filters.accountId}` : '';
  const summaryAccountId=Number(filters.accountId)||0;
  const visibleStages=stages.filter(([stage])=>!filters.stage||stage===filters.stage);
  const contentScope=filters.stage==='COPY'?'文案':filters.stage==='IMAGE'?'图片':'文案或图片';
  const columns: MetricColumn[]=qa?
    [...visibleStages.map(([stage,label]):MetricColumn=>({key:stage==='COPY'?'copyQa':'imageQa',label:`${label}质检条数`,help:`质检过的${label}内容数；同一内容被多次质检仍只算 1 条。`})),
      {key:'qaReviews',label:'质检次数',help:'实际完成的质检操作总数，包含首次质检和返修后的复检。'},
      {key:'qaPassed',label:'通过次数',help:'作出的“通过”结论次数，表示质检工作量，不代表质检准确率。'},
      {key:'qaReturned',label:'退回次数',help:'作出的“退回”结论次数；同一内容多次退回会分别计数。'},
      {key:'qaRecheck',label:'其中复检 / 移交管理员',help:'质检次数中，针对返修内容进行复检的次数。'}]:
    [...visibleStages.map(([stage,label]):MetricColumn=>({key:stage==='COPY'?'copySubmitted':'imageSubmitted',label:`${label}标注条数`,help:`实际提交过的${label}内容数；同一内容重复提交只算 1 条${stage==='IMAGE'?'，一组图片算 1 条':''}。`})),
      ...visibleStages.map(([stage,label]):MetricColumn=>({key:stage==='COPY'?'copyRate':'imageRate',label:`${label}判定结果`,help:'按该账号首次有效质检日计数；废弃、一次通过、打回三类互斥。二次分配不扣减原账号总量。'})),
      {key:'returned',label:'被退回条数',help:'收到有效退回结论的内容数；同一内容多次退回只算 1 条。'},
      {key:'reworked',label:'返修处理条数',help:'退回后实际提交过返修的内容数；同一内容只算 1 条，提交次数另行展示。'}];
  function cells(person:OperatorPerson) {
    if(qa)return <>{visibleStages.map(([stage,label])=><td className={styles.metricCell} key={stage}><button className={styles.link} onClick={()=>show(person.accountId,'qa',stage)}>{number(person.qa[stage].tasks)}</button>
      <small className={styles.metricDetail}>共质检 {number(person.qa[stage].tasks)} 条{label}内容；同一内容多次质检只计 1 条。</small></td>)}
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage)}>{number(person.qa.reviews)}</button><small className={styles.metricDetail}>共完成 {number(person.qa.reviews)} 次质检操作，包含首次质检和复检。</small></td>
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage,'passed')}>{number(person.qa.passed)}</button><small className={styles.metricDetail}>共作出 {number(person.qa.passed)} 次“通过”结论，仅表示质检工作量。</small></td>
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'qa',filters.stage,'failed')}>{number(person.qa.returned)}</button><small className={styles.metricDetail}>共作出 {number(person.qa.returned)} 次“退回”结论；重复退回会分别计数。</small></td>
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'qaRecheck',filters.stage)}>{number(person.qa.rechecks)}</button><small className={styles.metricDetail}>全部质检中有 {number(person.qa.rechecks)} 次是复检，提交管理员 {number(person.qa.escalated)} 次。</small></td></>;
    return <>{visibleStages.map(([stage,label])=><td className={styles.metricCell} key={stage}><button className={styles.link} onClick={()=>show(person.accountId,'submitted',stage)}>{number(person[stage].submitted)}</button>
      <small className={styles.metricDetail}>所选期间共处理 {number(person[stage].submitted)} 条{label}内容；首次提交 {number(person[stage].firstSubmitted)} 条，返修处理 {number(person[stage].reworked)} 条，两类可能重叠。</small></td>)}
      {visibleStages.map(([stage])=><td className={styles.metricCell} key={stage+'-rate'}><QualityOutcomeRates value={person[stage].qualityOutcomes} onSelect={metric=>show(person.accountId,metric,stage)}/></td>)}
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'returned',filters.stage)}>{number(person.returned)}</button><small className={styles.metricDetail}>所选期间有 {number(person.returned)} 条{contentScope}内容收到有效退回；同一内容多次退回只计 1 条。</small></td>
      <td className={styles.metricCell}><button className={styles.link} onClick={()=>show(person.accountId,'reworked',filters.stage)}>{number(person.reworked)}</button><small className={styles.metricDetail}>所选期间返修了 {number(person.reworked)} 条{contentScope}内容，累计提交返修 {number(person.reworkRounds)} 次。</small></td></>;
  }
  return <div className={styles.page}>
    <header className={styles.header}><div><h1>数据统计</h1><p className={styles.muted}>查看标注与质检工作量，以及废弃、一次通过和打回的占比。</p></div><div className={styles.actions}>
      <Button variant="outline" size="sm" disabled={!report||busy||exporting} onClick={()=>void exportReport()}><Download size={14}/>{exporting?'导出中…':'导出报表'}</Button>
      <Button variant="outline" size="sm" disabled={busy} onClick={refresh}><RefreshCw size={14}/>{busy?'更新中…':'刷新'}</Button></div></header>
    <nav className={styles.mainTabs} aria-label="统计视图">{[['overview','总数据'],['accounts','账号数据']].map(([value,label])=><button type="button" key={value} aria-current={view===value?'page':undefined} onClick={()=>changeView(value)}>{label}</button>)}</nav>
    <form className={`panel ${styles.filters}`} onSubmit={apply} key={`${view}:${filters.period}:${filters.from}:${filters.to}:${filters.accountId}:${filters.query}:${filters.stage}:${accounts.length}`}>
      <div className={styles.presets}>{[['today','今日'],['yesterday','昨日'],['7d','近 7 天'],['month','本月'],['30d','近 30 天']].map(([value,label])=><Button key={value} variant="outline" size="sm" type="button" aria-pressed={activePreset(value)} onClick={()=>preset(value)}>{label}</Button>)}</div>
      <DatePicker name="from" label="开始日期" defaultValue={filters.from}/><DatePicker name="to" label="结束日期" defaultValue={filters.to}/>
      <label>人员<select name="accountId" aria-label="人员" defaultValue={filters.accountId}><option value="">全部人员</option>
        {[...accountOptions.values()].toSorted((a,b)=>(a.displayName||a.username).localeCompare(b.displayName||b.username,'zh-CN')).map(account=><option key={account.id} value={account.id}>{account.displayName||account.username}（{account.username}）{account.status==='DISABLED'?' · 已停用':account.status==='HISTORICAL'?' · 历史':''}</option>)}</select></label>
      {view==='accounts'&&<><label className={styles.search}>账号<input name="query" aria-label="账号" placeholder="搜索姓名或账号" maxLength={128} defaultValue={filters.query}/></label>
        <label>内容类型<select name="stage" defaultValue={filters.stage}><option value="">文案和图片</option><option value="COPY">文案</option><option value="IMAGE">图片</option></select></label></>}
      <Button type="submit" size="sm">应用筛选</Button></form>
    {(filters.accountId||filters.batchId)&&<div className={styles.attention}><span>{filters.accountId?`人员：${selectedAccountLabel}`:''} {filters.batchId?`指定批次 #${filters.batchId}`:''}</span><Button variant="ghost" size="sm" onClick={()=>setFilters(previous=>({...previous,accountId:'',batchId:'',page:'1'}))}>清除指定范围</Button></div>}
    {dateError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{dateError}</div>}
    {error&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{error}{report?'。以下保留上次成功的数据和范围，可能已过时。':'。尚未取得统计数据。'}</div>}
    {exportError&&<div role="alert" className={`${styles.notice} ${styles.error}`}>{exportError}</div>}
    {report&&<p role="status" className={styles.muted}>{report.range.from} 至 {report.range.to} · 北京时间 · 更新于 {new Date(report.asOf).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false})}</p>}
    {!report&&busy&&<p role="status">正在汇总标注与质检记录…</p>}
    {view==='overview'?<>
      <section className={styles.headlineCards} aria-label="总数据">
        {stages.map(([stage,label])=><Card key={stage} label={`${label}标注`} value={summary?.[stage].submitted}
          note={`首次提交 ${number(summary?.[stage].firstSubmitted)} · 返修处理 ${number(summary?.[stage].reworked)}`} onClick={()=>show(summaryAccountId,'submitted',stage)}/>)}
        {stages.map(([stage,label])=><Card key={`qa-${stage}`} label={`${label}质检`} value={summary?.qa[stage].tasks}
          note={`${number(summary?.qa[stage].reviews)} 次质检 · 含复检 ${number(summary?.qa[stage].rechecks)} 次`} onClick={()=>show(summaryAccountId,'qa',stage)}/>)}
        <Card label="新增可交付内容" value={summary?.released} note="整条内容首次达到交付条件" onClick={()=>show(summaryAccountId,'released')}/>
      </section>
      <section className={`panel ${styles.section}`} aria-label="账号判定结果"><h2>账号判定结果</h2><p>按各账号首次有效质检日归属，最终废弃会回写原日期；三类之和为 100%，无判定时显示 —。团队任务去重 {summary?.qualityOutcomes.tasks ?? 0} 条，账号阶段判定 {summary?.qualityOutcomes.judged ?? 0} 条。</p><div className={styles.qualityGrid}>{stages.map(([stage,label])=><article key={stage}><h3>{label}</h3>{summary && <QualityOutcomeRates value={summary[stage].qualityOutcomes} onSelect={metric=>show(summaryAccountId,metric,stage)}/>}</article>)}</div></section>
      <section className={`panel ${styles.section}`} aria-label="内容质量"><h2>历史抽检辅助指标</h2><p className={styles.muted}>一次通过率只看首次随机抽检；整体通过率还包含打回后通过有效强制复检的内容，同一条内容只计一次。</p>
        <div className={styles.qualityGrid}>{stages.flatMap(([stage,label])=>[
          <article key={`${stage}-first`}><span>{label}一次通过率</span>{summary?<RateValue value={summary[stage].firstPass} onClick={()=>show(summaryAccountId,'firstPass',stage)} detail={summary[stage].firstPass.decided?`首次随机抽检已出结论 ${number(summary[stage].firstPass.decided)} 条：直接通过 ${number(summary[stage].firstPass.passed)} 条、退回 ${number(summary[stage].firstPass.failed)} 条。`:'当前没有完成首次随机抽检并得出结论的内容，暂时无法计算。'}/>:<strong>—</strong>}</article>,
          <article key={`${stage}-overall`}><span>{label}整体通过率</span>{summary?<RateValue value={summary[stage].overallPass} onClick={()=>show(summaryAccountId,'firstPass',stage)} detail={summary[stage].overallPass.decided?`首次随机抽检样本 ${number(summary[stage].overallPass.decided)} 条：首检或返修复检后通过 ${number(summary[stage].overallPass.passed)} 条、尚未通过 ${number(summary[stage].overallPass.failed)} 条。`:'当前没有首次随机抽检样本，暂时无法计算。'}/>:<strong>—</strong>}</article>,
        ])}</div>
        <details className={styles.methods}><summary>返修通过率与抽检覆盖</summary><div className={styles.qualityGrid}>{stages.map(([stage,label])=><article key={stage}><span>{label}首次返修通过率</span>{summary?<RateValue value={summary[stage].firstRecheck} onClick={()=>show(summaryAccountId,'firstRecheck',stage)} detail={summary[stage].firstRecheck.decided?`首检退回后完成第一次复检 ${number(summary[stage].firstRecheck.decided)} 条：通过 ${number(summary[stage].firstRecheck.passed)} 条、再次退回 ${number(summary[stage].firstRecheck.failed)} 条。`:'当前没有首检退回后完成第一次复检的内容，暂时无法计算。'}/>:<strong>—</strong>}
          <small className={styles.muted}>抽检覆盖：{summary?.[stage].coverage.rate==null?'—':`${(summary[stage].coverage.rate!*100).toFixed(1)}%`} · {number(summary?.[stage].coverage.sampled)} / {number(summary?.[stage].coverage.eligible)} 条已结批首次提交</small></article>)}</div>
          <p>首次返修通过率只统计首检实际退回后第一次复检的有效结论。</p></details>
      </section>
      <div className={styles.attention}><span>截至当前</span><button className={styles.link} onClick={()=>show(summaryAccountId,'reassign')}>建议改派 {number(summary?.reassignSuggested)} 条</button><button className={styles.link} onClick={()=>show(summaryAccountId,'qaPending')}>待质检 {number(summary?.qa.pending)} 项</button><small>强制复检不通过时进入管理员待二次分配。</small></div>
      {report&&<section className={`panel ${styles.section}`}><h2>每日工作量</h2><Chart label="每日标注与质检条数" unit="条" labels={report.trend.map(day=>day.date.slice(5))} series={[
        {name:'文案标注',values:report.trend.map(day=>day.copySubmitted)},{name:'图片标注',values:report.trend.map(day=>day.imageSubmitted)},
        {name:'文案质检',values:report.trend.map(day=>day.copyQa)},{name:'图片质检',values:report.trend.map(day=>day.imageQa)}]}/></section>}
    </>:<section className={`panel ${styles.section}`} aria-label="账号数据">
      <div className={styles.sectionHeading}><div className={styles.presets} aria-label="工作类型">{[['PRODUCTION','标注'],['QA','质检']].map(([value,label])=><Button key={value} type="button" variant="outline" size="sm" aria-pressed={filters.activity===value}
        onClick={()=>setFilters(previous=>({...previous,activity:value,page:'1',sort:value==='QA'?'qa':'submitted'}))}>{label}</Button>)}</div><span className={styles.muted}>{number(report?.people.total)} 个账号</span></div>
      <p className={styles.muted}>{qa?'质检条数按内容去重，次数包含复检。通过与退回次数表示工作量，不代表质检人员判断的准确率。':'标注条数按实际提交内容去重，首次提交与返修处理可能重叠。点击账号查看返修、质量和操作明细。'}</p>
      <div className={styles.tableScroll} role="region" aria-label="账号统计表" tabIndex={0}><table className={styles.table}><thead><tr><th scope="col">账号<small className={styles.columnHelp}>姓名和登录账号；点击姓名可查看该账号的操作明细。</small></th>{columns.map(({key,label,help})=><th scope="col" key={key} aria-sort={filters.sort===key?(filters.order==='asc'?'ascending':'descending'):'none'}><button className={styles.link} onClick={()=>sort(key)}>{label} <ArrowUpDown size={11} style={{display:'inline'}}/></button><small className={styles.columnHelp}>{help}</small></th>)}</tr></thead>
        <tbody>{report?.people.items.map(person=><tr key={person.accountId}><td><button className={`${styles.link} ${styles.name}`} onClick={()=>show(person.accountId,qa?'qaAll':'submitted',filters.stage)}>{person.displayName}</button><small>@{person.username}</small></td>{cells(person)}</tr>)}
        {!report?.people.items.length&&<tr><td colSpan={columns.length+1} className={styles.empty}>{busy?'正在读取…':'当前范围暂无记录'}</td></tr>}</tbody></table></div>
      {report&&<div className={styles.pagination}><span>第 {report.people.page} / {Math.max(1,Math.ceil(report.people.total/report.people.pageSize))} 页</span><div className={styles.actions}><Button variant="outline" size="sm" disabled={busy||report.people.page<=1} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page-1)}))}>上一页</Button><Button variant="outline" size="sm" disabled={busy||report.people.page*report.people.pageSize>=report.people.total} onClick={()=>setFilters(previous=>({...previous,page:String(report.people.page+1)}))}>下一页</Button></div></div>}
    </section>}
    <details className={`panel ${styles.section} ${styles.methods}`}><summary>统计口径</summary>
      <p>账号判定结果以“任务＋内容阶段＋实际操作者”为一条，日期固定为该账号首次有效质检日。历史打回后最终废弃会改计废弃；改派不扣减原账号已判定总量，新账号在自己的质检发生后新增判定。曾打回后复检通过仍计打回。标注工作量按提交日统计。条数按任务和内容阶段去重；图片的一组图计一条。文案和图片不能相加作为成品数。新增可交付不等于已实际交付。</p>
      <p>返修重复提交不增加同一期间的内容条数；首次提交与返修子项可能重叠。团队去重与个人贡献各自计算，多人接力或跨日处理时，个人或每日条数相加可能大于团队期间条数。</p>
      <p>整体通过率以首次随机抽检样本为分母，首检通过或打回后在所选期间通过有效强制复检均计为通过，同一内容只计一次。未抽中、免检、待结论、快捷直放、自检及模拟数据不计通过率；批量连带退回不等于逐条判错。团队通过率按样本加权，样本少于 20 条时仅供参考。</p>
      <p>历史贡献归实际操作账号，改派不转移。轮次沿文案、图片各自的质检链自动计算，历史链不完整则显示未知。改派提示按当前负责人和有效连续退回计算，不自动改派。</p>
    </details>
    {selection&&<OperatorDetailDialog key={`${selection.report.snapshotToken}:${selection.accountId}:${selection.metric}:${selection.stage}`} report={selection.report} selection={selection} onClose={()=>setSelection(null)}/>}
  </div>;
}
