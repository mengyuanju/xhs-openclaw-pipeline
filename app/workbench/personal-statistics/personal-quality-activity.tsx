'use client';
import { useEffect,useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog,DialogContent,DialogTitle,DialogDescription } from '@/components/ui/dialog';
import { apiRequest } from '../../components/api-client';
import type { QaSummary } from '../../workbench-statistics/operator-types';
import styles from '../personal-workspace.module.css';

type Selection={metric:string;stage?:string;sampleSet?:string;label:string};
type Receipt={id:string;code:string;stage:string;kind:string;at:string;outcome?:string;sampleKind?:string;blocked?:boolean;passBlocked?:boolean;affectedCount?:number;exclusion?:string;roundKnown?:boolean;reviewRound?:number|null;returnRound?:number|null};
type Page={total:number;tasks:number;page:number;pageSize:number;items:Receipt[]};
const kinds:Record<string,string>={QA_REVIEW:'质检结论',QA_BATCH_RETURN:'批量退回',QA_DIRECT_PASS:'快捷直放',QA_DISCARD:'质检废弃',QA_PENDING:'当前质检待办',COMPLETE:'标注提交'};
const count=(value:number|null|undefined)=>value==null?'—':value.toLocaleString('zh-CN');

export function PersonalQualityActivity({qa,contribution,range}:{qa:QaSummary|null|undefined;contribution:number|null|undefined;range:{from:string;to:string}}) {
  const [selection,setSelection]=useState<Selection|null>(null),[page,setPage]=useState(1),[data,setData]=useState<Page|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!selection)return;
    const controller=new AbortController();let disposed=false;
    const timeout=setTimeout(()=>controller.abort(),25_000);
    setData(null);setError('');setBusy(true);
    const query=new URLSearchParams({period:'custom',...range,metric:selection.metric,stage:selection.stage??'',sampleSet:selection.sampleSet??'all',page:String(page),pageSize:'15'});
    void apiRequest<Page>(`/api/control-plane/v1/personal-workspace/qa-activities?${query}`,{signal:controller.signal,cache:'no-store'})
      .then(next=>{if(!Array.isArray(next.items))throw Error('明细数据不完整');if(!disposed)setData(next);})
      .catch(caught=>{if(!disposed)setError(controller.signal.aborted?'读取超时，请重试':caught instanceof Error?caught.message:'读取失败');})
      .finally(()=>{clearTimeout(timeout);if(!disposed)setBusy(false);});
    return()=>{disposed=true;controller.abort();clearTimeout(timeout);};
  },[selection,page,range.from,range.to,retry]);
  const card=(label:string,value:number|null|undefined,metric:string,note:string,stage='',sampleSet='all')=><Button unstyled key={label} type="button" className={styles.card} disabled={value==null}
    onClick={()=>{setPage(1);setSelection({label,metric,stage,sampleSet});}}><span>{label}</span><strong>{count(value)}</strong><small>{note}</small></Button>;
  return <>
    <h3>我的质检</h3><p className={styles.muted}>按本人实际操作统计；作业改派不转移历史贡献。通过、退回是结论数量，不代表质检准确率。</p>
    <div className={styles.cards}>
      {card('文案质检',qa?.COPY.tasks,'qa',`${count(qa?.COPY.reviews)} 次质检 · 含复检 ${count(qa?.COPY.rechecks)} 次`,'COPY')}
      {card('图片质检',qa?.IMAGE.tasks,'qa',`${count(qa?.IMAGE.reviews)} 次质检 · 含复检 ${count(qa?.IMAGE.rechecks)} 次`,'IMAGE')}
    </div>
    <details><summary>质检结论与当前待办</summary><div className={styles.cards}>
      {card('质检通过',qa?.passed,'qa','次结论','','passed')}
      {card('质检退回',qa?.returned,'qa','次结论','','failed')}
      {card('其中复检',qa?.rechecks,'qaRecheck','次 · 已包含在质检结论内')}
      {card('批量退回操作',qa?.batchActions,'qaBatch','次操作 · 影响作业另计')}
      {card('快捷直放与质检废弃',qa?.specialActions,'qaSpecial','次处置 · 不计逐项质检')}
    </div>
    {qa&&qa.batchActions>0&&<p className={styles.muted}>已知批量影响 {qa.affectedTasks} 项作业（去重）；{qa.unknownBatchScopes} 次旧操作缺少完整范围，已有记录合计 {qa.legacyAffectedCount} 影响项次。</p>}
    <h3>需要我质检</h3><p className={styles.muted}>当前指派给我的质检项，不受历史日期或标注作业范围影响；暂停或权限变化的项列为暂不可处理。图片修改期间仍可退回，通过需等待修改完成。</p>
    <div className={styles.cards}>
      {card('文案质检待办',qa?.COPY.pending,'qaPending',`项质检 · 含复检 ${count(qa?.COPY.pendingRechecks)} 项`,'COPY')}
      {card('图片质检待办',qa?.IMAGE.pending,'qaPending',`项质检 · 含复检 ${count(qa?.IMAGE.pendingRechecks)} 项`,'IMAGE')}
      {card('暂不可处理',qa?.blocked,'qaBlocked','项质检 · 暂停或权限变化')}
    </div>
    </details>
    {selection&&<Dialog open onOpenChange={open=>{if(!open)setSelection(null);}}><DialogContent className={styles.deliveryDialog}>
      <DialogTitle>{selection.label}</DialogTitle><DialogDescription>{['qaPending','qaBlocked'].includes(selection.metric)?'当前指派，与历史日期无关':`${range.from} 至 ${range.to}（北京时间）`} · 仅展示本人操作记录</DialogDescription>
      {busy&&<p role="status">正在读取记录…</p>}
      {error&&<div className="notice error" role="alert">{error}<Button onClick={()=>setRetry(value=>value+1)}>重试</Button></div>}
      {data&&<><p>共 {data.total} 条记录{selection.metric==='qaPending'?'':` · ${data.tasks} 项作业（去重）`}。同一作业可有多轮记录。</p>
        <div style={{overflowY:'auto',maxHeight:'55vh'}}>{data.items.map(item=><article key={item.id} className="panel" style={{padding:12,marginBottom:8}}>
          <strong>{item.code} · {item.stage==='COPY'?'文案':'图片'} · {kinds[item.kind]??item.kind}</strong>
          <p>{item.outcome==='PASS'?'通过':item.outcome==='RETURN'?'退回':item.kind==='QA_PENDING'?item.blocked?'暂不可处理':'待处理':''}{item.sampleKind==='MANDATORY_RECHECK'?' · 强制复检':''}</p>
          <small>{item.at?new Date(item.at).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'}):'分配时间未记录'}</small>
          {item.kind==='QA_REVIEW'&&<p>{item.roundKnown?`第 ${item.reviewRound} 轮质检 · 有效退回 ${item.returnRound} 次`:'历史轮次不明'}</p>}
          {item.passBlocked&&<p>图片修改待完成：仍可退回，暂不能通过。</p>}
          {item.kind==='QA_BATCH_RETURN'&&<p>记录的影响数量：{count(item.affectedCount)} 项</p>}
        </article>)}{!data.items.length&&<p>暂无记录</p>}</div>
        <div className={styles.inline}><Button disabled={busy||data.page<=1} onClick={()=>setPage(data.page-1)}>上一页</Button><span>第 {data.page} 页</span>
          <Button disabled={busy||data.page*data.pageSize>=data.total} onClick={()=>setPage(data.page+1)}>下一页</Button></div></>}
    </DialogContent></Dialog>}
  </>;
}
