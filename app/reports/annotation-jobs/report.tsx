'use client';

import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../../components/api-client';
import styles from './report.module.css';

type Person = {
  accountId:number;username:string;displayName:string;totalJobs:number;copyReview:number;copyReviewTasks:number;
  copyFirstPassRate:number;copyFirstPassed:number;copyDecided:number;copyFirstReturned:number;
  copyFirstQaDiscarded:number;copyFirstUnjudged:number;copyFirstDirectDiscarded:number;
  copyFirstPending:number;copyFirstBypassed:number;copyFirstUnjudgedOther:number;
  copyRework:number;copyReworkTasks:number;copyReworkOfFirstTasks:number;copyReworkOtherTasks:number;
  imageFirstReview:number;imageRework:number;
  imageReworkTasks:number;discarded:number;returned:number;
};
type Report = {
  range:{from:string;to:string};asOf:string;
  summary:{workers:number;totalJobs:number;returned:number};people:Person[];
  dataQuality:{unknownIdentity:number;unattributedAnnotationBatchReturns:number;unattributedAnnotationBatchScopes:number};
};
type Account = {id:number;username:string;displayName?:string;status?:string};
const day = (time:number) => new Date(time + 8 * 3_600_000).toISOString().slice(0,10);
const initialDates = () => { const today=day(Date.now()); return {from:today,to:today}; };
const number = (value:number|undefined) => value == null ? '—' : new Intl.NumberFormat('zh-CN').format(value);
export function AnnotationJobReport({initialFilters}:{initialFilters?:{from:string;to:string;accountId:string}}) {
  const [draft,setDraft] = useState(() => initialFilters ? {from:initialFilters.from,to:initialFilters.to} : initialDates());
  const [filters,setFilters] = useState(() => initialFilters ?? {...initialDates(),accountId:''});
  const [accounts,setAccounts] = useState<Account[]>([]);
  const [report,setReport] = useState<Report|null>(null);
  const [error,setError] = useState('');
  const [dateError,setDateError] = useState('');
  const [busy,setBusy] = useState(true);
  const [revision,setRevision] = useState(0);
  const [showQualityOnly,setShowQualityOnly] = useState(false);
  const query = new URLSearchParams({period:'custom',from:filters.from,to:filters.to,
    ...(filters.accountId?{accountId:filters.accountId}:{})}).toString();

  useEffect(() => {
    const controller=new AbortController();
    setShowQualityOnly(false);
    setBusy(true);setError('');setReport(null);
    void apiRequest<Report>(`/api/control-plane/v1/admin/annotation-job-report?${query}`,
      {signal:controller.signal,cache:'no-store'})
      .then(value=>setReport(value))
      .catch(caught=>{if(!controller.signal.aborted)setError(caught instanceof Error?caught.message:'报表读取失败');})
      .finally(()=>{if(!controller.signal.aborted)setBusy(false);});
    return ()=>controller.abort();
  },[query,revision]);
  useEffect(() => {
    let active=true;
    void apiRequest<Account[]|{items?:Account[]}>('/api/control-plane/v1/users',{cache:'no-store'})
      .then(value=>{if(active)setAccounts(Array.isArray(value)?value:value.items??[]);})
      .catch(()=>{});
    return ()=>{active=false;};
  },[]);
  const options=useMemo(()=>{
    const map=new Map(accounts.map(account=>[account.id,account]));
    for(const person of report?.people??[]) if(!map.has(person.accountId))
      map.set(person.accountId,{id:person.accountId,username:person.username,displayName:person.displayName,status:'HISTORICAL'});
    if(filters.accountId && !map.has(Number(filters.accountId)))
      map.set(Number(filters.accountId),{id:Number(filters.accountId),username:`#${filters.accountId}`,displayName:'历史账号',status:'HISTORICAL'});
    return [...map.values()].sort((a,b)=>(a.displayName||a.username).localeCompare(b.displayName||b.username,'zh-CN'));
  },[accounts,report,filters.accountId]);
  function apply(event:FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const length=(Date.parse(draft.to)-Date.parse(draft.from))/86_400_000+1;
    if(!Number.isFinite(length)||length<1||length>366){setDateError('请选择 1–366 天的有效日期范围');return;}
    setDateError('');setFilters(previous=>({...previous,...draft}));
  }
  const workingPeople=report?.people.filter(person=>person.totalJobs>0)??[];
  const qualityOnlyPeople=report?.people.filter(person=>person.totalJobs===0)??[];
  const visiblePeople=showQualityOnly?report?.people??[]:workingPeople;
  return <div className={styles.page}>
    <header className={styles.header}><div><span className={styles.kicker}>报表统计</span>
      <h1>标注作业统计报表</h1><p>按标注人汇总作业与质检打回，日期采用北京时间。</p></div>
      <Button variant="outline" size="sm" type="button" disabled={busy} onClick={()=>setRevision(value=>value+1)}><RefreshCw size={15}/>{busy?'读取中…':'刷新'}</Button>
    </header>
    <form className={`panel ${styles.filters}`} onSubmit={apply} aria-label="报表查询条件">
      <label>开始日期<input type="date" required value={draft.from} onChange={event=>setDraft(previous=>({...previous,from:event.target.value}))}/></label>
      <label>结束日期<input type="date" required value={draft.to} onChange={event=>setDraft(previous=>({...previous,to:event.target.value}))}/></label>
      <label>标注人<select value={filters.accountId} onChange={event=>setFilters(previous=>({...previous,accountId:event.target.value}))}>
        <option value="">全部标注人</option>{options.map(account=><option key={account.id} value={account.id}>{account.displayName||account.username}（{account.username}）{account.status==='DISABLED'?' · 已停用':''}</option>)}
      </select></label>
      <Button type="submit">查询</Button>
      {dateError&&<p className={styles.error} role="alert">{dateError}</p>}
    </form>
    {error&&<div className={styles.errorBox} role="alert">{error}</div>}
    <section className={styles.summary} aria-label="汇总数据">
      {[['作业人数',report?.summary.workers],['总作业',report?.summary.totalJobs],['打回次数',report?.summary.returned]].map(([label,value])=><article className={`panel ${styles.summaryCard}`} key={label}><span>{label}</span><strong>{number(value as number|undefined)}</strong>{label==='作业人数'&&<small>本期有审核提交或废弃操作的标注人</small>}</article>)}
    </section>
    <section className={`panel ${styles.results}`} aria-label="标注人作业列表">
      <div className={styles.resultHead}><div><h2>标注人作业明细</h2><p>{report?`${report.range.from} 至 ${report.range.to} · ${number(workingPeople.length)} 位有作业${qualityOnlyPeople.length?` · ${number(qualityOnlyPeople.length)} 位仅有质检记录`:''}`:busy?'正在读取…':'暂无数据'}</p><p>按操作日期统计；分配或改派后，本人每阶段第一次作业计首次，后续作业计返修。同一任务再次改派给本人会重新计首次。</p></div>{qualityOnlyPeople.length>0&&<Button type="button" variant="outline" size="sm" aria-expanded={showQualityOnly} onClick={()=>setShowQualityOnly(value=>!value)}>{showQualityOnly?'隐藏仅有质检记录':`查看仅有质检记录（${number(qualityOnlyPeople.length)}）`}</Button>}</div>
      <div className={styles.tableScroll} role="region" aria-label="标注作业统计表" tabIndex={0}><table><thead><tr>
        <th scope="col">标注人</th><th scope="col">总作业</th><th scope="col">首次文案审核</th><th scope="col">文案一次通过率</th><th scope="col">文案返修</th><th scope="col">首次图片审核</th><th scope="col">图片返修</th><th scope="col">废弃任务数量</th>
      </tr></thead><tbody>{visiblePeople.map(person=><tr key={person.accountId}>
        <td><strong>{person.displayName}</strong><small>@{person.username}</small>{person.totalJobs===0&&<small>本期无作业 · 仅质检记录</small>}</td><td>{number(person.totalJobs)}</td><td>{number(person.copyReview)}</td>
        <td>{person.copyDecided?(person.copyFirstPassRate*100).toFixed(2)+'%':'—'}<small title="按所选日期内首次文案作业对应的个人接手轮次统计，追踪该轮首次提交截至报表时点的结果；分母包含有效首检的通过、打回及质检废弃结论，绑定该首次提交的有效整批打回也计为未通过。">{number(person.copyFirstPassed)} / {number(person.copyDecided)} 有效首检轮次</small></td>
        <td>{number(person.copyRework)}<small>涉及 {number(person.copyReworkTasks)} 个任务</small></td><td>{number(person.imageFirstReview)}</td><td>{number(person.imageRework)}</td><td title="本人在所选日期内所有文案、图片阶段的废弃任务去重统计，包含首次审核及返修阶段。">{number(person.discarded)}</td>
      </tr>)}{!visiblePeople.length&&<tr><td colSpan={8} className={styles.empty}>{busy?'正在读取…':'所选日期暂无标注作业'}</td></tr>}</tbody></table></div>
      <details className={styles.methods}><summary>统计口径</summary>
        <p>作业人数只统计所选日期内有有效审核提交或本人废弃操作的标注人，主列表默认只显示这些标注人。仅有质检结论、没有本期作业的标注人可通过列表上方的按钮展开查看。总作业 = 首次文案审核 + 文案返修 + 首次图片审核 + 图片返修；每次有效提交或废弃操作计一次作业。废弃任务数量按本人在所选日期内执行的废弃操作涉及的任务去重，质检员后续废弃不会转记给原标注人，也不会在总作业之外再加一次。</p>
        <p>首次审核按个人接手口径计算：每次分配或改派产生一轮接手，该人员在本轮文案或图片阶段的第一次有效提交或本人直接废弃计为该阶段首次审核，后续作业计返修。接手时任务原本处于返修阶段，也计为本人的首次审核。同一任务再次改派给同一账号，可累计多个首次审核。操作按发生日期计入所选区间；首次作业发生在区间之前、本期继续处理的任务只计本期返修。</p>
        <p>首次审核和返修列的主数字是操作量，文案返修列下方“涉及任务”按任务去重。任务数与接手轮次不同，不能相减推算一次通过率。本人首检通过后，也可能因后续图片质检或整批打回再次返修。打回次数统计文案与图片质检对标注人的有效退回判定，同一内容多次打回分别计数。</p>
        <p>文案一次通过率按所选日期内首次文案作业对应的个人接手轮次统计，追踪该轮首次提交截至报表时点的首检结果：首检通过轮次 / 有有效首检结论的轮次。通过、打回和质检废弃均计入分母；绑定该首次提交的有效整批打回也计为首次未通过。本轮返修后的重复质检不重复计入，其他标注人或本人此前接手轮次的结果不计入本轮。待质检、管理员直接放行、未被抽中质检而正常释放，以及本人直接废弃但未提交质检的轮次，不进入分母。“放行/免检”展示管理员直接放行和未被抽中正常释放的轮次；本期首次废弃后恢复并提交的轮次，即使首次提交发生在所选日期之后，也追踪截至报表时点的首检结论或无首检记录。没有有效首检结论时显示“—”。</p>
      </details>
    </section>
  </div>;
}
