'use client';

import { useEffect,useRef,useState } from 'react';
import { Dialog,DialogContent,DialogDescription,DialogTitle } from '@/components/ui/dialog';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import { CopyQaReasonPicker } from './copy-qa-reason-picker';
import { CopyQaRevisionComparison } from './copy-qa-revision-view';
import legacyStyles from './copy-qa.module.css';
import { copyRevisionView } from './types';
import styles from './copy-qa-workbench.module.css';
import { COPY_QA_DISCARD_REASONS, copyQaDiscardReasonLabel } from '../../src/copy-qa-discard-reasons.mjs';

type Batch = {id:string;displayName:string;mode:string;status:string;memberCount:number;sampleCount:number;pendingCount:number;passedCount:number;returnedCount:number;discardedCount:number;affectedCount:number;fullInspection:boolean;returnTriggerCount:number;createdAt:string};
type Item = {id:string;taskId:number|null;query:string|null;content:unknown;status:string;approverUsername:string|null;revisionToken:string;discardReasonCode:string|null;dispositionNote:string|null};
type Detail = {batch:Batch;items:Item[]};
type View = 'PENDING'|'FINISHED';
const modeName:Record<string,string>={PERSONAL_AUTO:'个人自动',PERSONAL_MANUAL:'个人手动',MIXED_MANUAL:'混合手动',SYSTEM_MIGRATION:'系统迁移'};
const statusName:Record<string,string>={PENDING:'待质检',PASSED:'已通过',RETURNED:'已驳回',BATCH_AFFECTED:'批次驳回',RELEASED:'已放行',DISCARDED:'已废弃',COMPLETED:'已完成',AUTO_RETURNED:'整批驳回'};
const localTime=(value:string)=>new Date(value).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});

export function CopyQaWorkbench(){
  const confirm=useConfirmDialog();
  const discardMutation=useRef<{fingerprint:string;requestId:string}|null>(null);
  const [view,setView]=useState<View>('PENDING');
  const [batches,setBatches]=useState<Batch[]>([]);
  const [detail,setDetail]=useState<Detail|null>(null);
  const [selectedItemId,setSelectedItemId]=useState<string|null>(null);
  const [note,setNote]=useState('');
  const [reasonCodes,setReasonCodes]=useState<string[]>([]);
  const [returnItem,setReturnItem]=useState<Item|null>(null);
  const [discardItem,setDiscardItem]=useState<Item|null>(null);
  const [discardReasonCode,setDiscardReasonCode]=useState('');
  const [discardNote,setDiscardNote]=useState('');
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const selectedItem=detail?.items.find(item=>item.id===selectedItemId)??null;
  const copy=selectedItem?copyRevisionView(selectedItem.content):null;

  async function refresh(target:View=view){
    try{setBatches(await apiRequest<Batch[]>(`/api/control-plane/v2/copy-qa/batches?view=${target}`));setError('');}
    catch(e){setError(e instanceof Error?e.message:'加载批次失败');}
  }
  useEffect(()=>{void refresh(view);},[view]);
  function switchView(next:View){setView(next);setDetail(null);setSelectedItemId(null);setError('');}
  async function open(id:string){
    try{setDetail(await apiRequest<Detail>(`/api/control-plane/v2/copy-qa/batches/${id}`));setError('');}
    catch(e){setError(e instanceof Error?e.message:'加载批次失败');}
  }
  function viewItem(id:string){setSelectedItemId(id);setReasonCodes([]);setNote('');setError('');}
  function openReturn(item:Item){setSelectedItemId(null);setReturnItem(item);setReasonCodes([]);setNote('');setError('');}
  function openDiscard(item:Item){setSelectedItemId(null);setDiscardItem(item);setDiscardReasonCode('');setDiscardNote('');discardMutation.current=null;setError('');}
  async function confirmDiscard(item:Item){
    if(!discardReasonCode||!discardNote.trim()){setError('请选择废弃理由并填写说明');return;}
    const approved=await confirm({title:'确认废弃这条任务？',description:'任务将进入已废弃状态，退出后续质检与返工；文案版本及质检记录仍会保留。',confirmLabel:'确认废弃',tone:'danger'});
    if(approved)await decide(item,'DISCARD');
  }
  async function confirmPass(item:Item){
    const approved=await confirm({title:'确认通过质检？',description:'通过后，该任务将进入下一环节。请确认当前文案已完成质检。',confirmLabel:'确认通过'});
    if(approved)await decide(item,'PASS');
  }
  async function decide(item:Item,decision:'PASS'|'RETURN'|'DISCARD'){
    if(decision==='RETURN'&&!note.trim()&&!reasonCodes.length){setError('驳回请填写原因或选择问题标签');return;}
    if(decision==='DISCARD'&&(!discardReasonCode||!discardNote.trim())){setError('请选择废弃理由并填写说明');return;}
    setBusy(true);setError('');
    try{
      const payload={decision,revisionToken:item.revisionToken,note:decision==='RETURN'?note.trim():decision==='DISCARD'?discardNote.trim():'',reasonCodes:decision==='RETURN'?reasonCodes:[],discardReasonCode:decision==='DISCARD'?discardReasonCode:undefined};
      let requestId=createRequestId();
      if(decision==='DISCARD'){
        const fingerprint=JSON.stringify({itemId:item.id,payload});
        if(discardMutation.current?.fingerprint!==fingerprint)discardMutation.current={fingerprint,requestId};
        requestId=discardMutation.current.requestId;
      }
      await apiRequest(`/api/control-plane/v2/copy-qa/items/${item.id}/decision`,{
        method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({requestId,...payload}),
      });
      discardMutation.current=null;
      setSelectedItemId(null);setReturnItem(null);setDiscardItem(null);setReasonCodes([]);setNote('');setDiscardReasonCode('');setDiscardNote('');
      await refresh();
      if(detail)await open(detail.batch.id);
    }catch(e){setError(e instanceof Error?e.message:'质检操作失败');}
    finally{setBusy(false);}
  }

  return <div className={styles.page}>
    {error&&<div className="notice error" role="alert">{error}</div>}
    {!detail?<section className={`panel ${styles.panel}`}>
      <div className={styles.topbar}>
        <div className={styles.tabs} role="tablist" aria-label="质检批次状态">
          <button type="button" role="tab" aria-selected={view==='PENDING'} className={`${styles.tab} ${view==='PENDING'?styles.active:''}`} onClick={()=>switchView('PENDING')}>待质检批次</button>
          <button type="button" role="tab" aria-selected={view==='FINISHED'} className={`${styles.tab} ${view==='FINISHED'?styles.active:''}`} onClick={()=>switchView('FINISHED')}>已完成批次</button>
        </div>
        <button className="button" type="button" onClick={()=>void refresh()}>刷新</button>
      </div>
      <div className={styles.heading}><h2>{view==='PENDING'?'待质检批次':'已完成批次'}</h2><span>{batches.length} 个批次</span></div>
      <div className="table-wrap"><table className={styles.table}><thead><tr><th>批次名称</th><th>任务数量</th><th>质检项</th><th>{view==='PENDING'?'待质检':'结果'}</th><th>模式</th><th>创建时间</th><th>操作</th></tr></thead><tbody>
        {batches.map(batch=><tr key={batch.id}><td><strong>{batch.displayName}</strong></td><td>{batch.memberCount}</td><td>{batch.sampleCount}</td>
          <td>{view==='PENDING'?`${batch.pendingCount} 条待检`:<span className={`pill ${batch.status==='COMPLETED'?'pill-completed':'pill-rejected'}`}>{statusName[batch.status]??batch.status}</span>}</td>
          <td>{modeName[batch.mode]??batch.mode}{batch.fullInspection?' · 全量质检':''}</td><td>{localTime(batch.createdAt)}</td>
          <td><button className="button small" type="button" onClick={()=>void open(batch.id)}>进入批次</button></td></tr>)}
        {!batches.length&&<tr><td colSpan={7} className={styles.empty}>暂无{view==='PENDING'?'待质检':'已完成'}批次</td></tr>}
      </tbody></table></div>
    </section>
    :<section className={`panel ${styles.panel}`}>
      <div className={styles.detailHead}>
        <div><button className={styles.back} type="button" onClick={()=>{setDetail(null);setSelectedItemId(null);void refresh();}}>← 返回批次列表</button>
          <h2>{detail.batch.displayName}</h2><p>{modeName[detail.batch.mode]??detail.batch.mode} · {statusName[detail.batch.status]??detail.batch.status}</p></div>
        <div className={styles.metrics}><span>任务数量 <strong>{detail.batch.memberCount}</strong></span><span>质检项 <strong>{detail.batch.sampleCount}</strong></span><span>已废弃 <strong>{detail.items.filter(item=>item.status==='DISCARDED').length}</strong></span><span>待质检 <strong>{detail.items.filter(item=>item.status==='PENDING').length}</strong></span></div>
      </div>
      <p className={styles.policy}>{detail.batch.fullInspection?'本批所有质检项需逐条完成质检。':`质检项驳回达到 ${detail.batch.returnTriggerCount} 条后，系统自动处理剩余成员。`}</p>
      <div className="table-wrap"><table className={styles.table}><thead><tr><th>序号</th><th>任务</th><th>文案标题</th><th>审核人</th><th>状态</th><th>操作</th></tr></thead><tbody>
        {detail.items.map((item,index)=>{
          const preview=copyRevisionView(item.content);
          return <tr key={item.id}><td>{index+1}</td><td className={styles.taskCell}>{item.taskId==null?`盲评项 ${index+1}`:`#${item.taskId}${item.query?` · ${item.query}`:''}`}</td>
            <td className={styles.titleCell}>{preview.title||preview.body.replace(/\s+/gu,' ').slice(0,60)||'未填写标题'}</td>
            <td>{item.approverUsername??'—'}</td><td><span className={`pill ${item.status==='PASSED'?'pill-completed':item.status==='PENDING'?'pill-waiting_review':'pill-rejected'}`}>{statusName[item.status]??item.status}</span></td>
            <td><button className="button small" type="button" onClick={()=>viewItem(item.id)}>{item.status==='PENDING'&&detail.batch.status==='INSPECTING'?'查看并质检':'查看文案'}</button></td>
          </tr>;
        })}
        {!detail.items.length&&<tr><td colSpan={6} className={styles.empty}>这个批次没有可查看的质检项</td></tr>}
      </tbody></table></div>
    </section>}
    <Dialog open={selectedItem!==null} onOpenChange={open=>{if(!open&&!busy){setSelectedItemId(null);setError('');}}}>
      <DialogContent className={`${legacyStyles.dialog} ${legacyStyles.detailDialog}`}>
        {selectedItem&&copy&&<>
          <header className={legacyStyles.detailHeader}>
            <div className={legacyStyles.dialogHeader}><div><DialogTitle>{detail?.batch.displayName} · 最终稿质检</DialogTitle>
              <DialogDescription>核对当前质检项绑定的最终人工通过稿 · {statusName[selectedItem.status]??selectedItem.status}</DialogDescription></div>
              <span className="pill">{selectedItem.taskId==null?'独立盲评':'非盲评'}</span>
            </div>
            <div className={legacyStyles.metadata}>
              {selectedItem.query&&<div><small>Query</small><strong>{selectedItem.query}</strong></div>}
              <div><small>质检批次</small><strong>{detail?.batch.displayName}</strong></div>
              <div><small>内容指纹</small><strong>{selectedItem.revisionToken?`${selectedItem.revisionToken.slice(0,12)}…`:'未提供'}</strong></div>
              {selectedItem.taskId!=null&&<div><small>正式任务</small><strong>#{selectedItem.taskId}</strong></div>}
              {selectedItem.approverUsername&&<div><small>文案审核人</small><strong>@{selectedItem.approverUsername}</strong></div>}
            </div>
          </header>
          <div className={legacyStyles.detailBody}>
            <CopyQaRevisionComparison copy={copy} blind={selectedItem.taskId==null} />
            {selectedItem.status==='DISCARDED'&&<p className="notice warning">废弃理由：{copyQaDiscardReasonLabel(selectedItem.discardReasonCode)}；说明：{selectedItem.dispositionNote??'—'}</p>}
            {error&&<div className="notice error" role="alert">{error}</div>}
          </div>
          <footer className={`${legacyStyles.footer} ${legacyStyles.detailFooter}`}>
            <span className="subtle">质检结论只绑定当前展示的最终修订版。</span>
            <div>
              <button className="button" disabled={busy} onClick={()=>setSelectedItemId(null)}>关闭</button>
              {selectedItem.status==='PENDING'&&detail?.batch.status==='INSPECTING'&&<>
                <button className="button danger" disabled={busy} onClick={()=>openReturn(selectedItem)}>仅打回此条</button>
                <button className="button danger" disabled={busy} onClick={()=>openDiscard(selectedItem)}>废弃任务</button>
                <button className="button primary" disabled={busy} onClick={()=>void confirmPass(selectedItem)}>通过质检</button>
              </>}
            </div>
          </footer>
        </>}
      </DialogContent>
    </Dialog>
    <Dialog open={discardItem!==null} onOpenChange={open=>{if(!open&&!busy){setDiscardItem(null);discardMutation.current=null;setError('');}}}>
      <DialogContent className={legacyStyles.dialog} showCloseButton={!busy}>
        <div className={legacyStyles.dialogHeader}><div>
          <DialogTitle>废弃文案任务</DialogTitle>
          <DialogDescription>请选择废弃理由并说明原因。该质检项废弃后不计入批次驳回率。</DialogDescription>
        </div></div>
        <section className={styles.returnPanel}>
          <label htmlFor="qa-discard-reason">废弃理由</label>
          <select id="qa-discard-reason" className="select" value={discardReasonCode} disabled={busy} onChange={event=>setDiscardReasonCode(event.target.value)}>
            <option value="">请选择废弃理由</option>
            {COPY_QA_DISCARD_REASONS.map(({code,label})=><option key={code} value={code}>{label}</option>)}
          </select>
          <label htmlFor="qa-discard-note">废弃说明（必填）</label>
          <textarea id="qa-discard-note" className="textarea" rows={3} maxLength={1000} value={discardNote} disabled={busy} onChange={event=>setDiscardNote(event.target.value)} />
        </section>
        {error&&<div className="notice error" role="alert">{error}</div>}
        <footer className={legacyStyles.footer}><span className="subtle">任务将退出后续流程，历史记录保留。</span><div>
          <button className="button" type="button" disabled={busy} onClick={()=>{setDiscardItem(null);discardMutation.current=null;setError('');}}>取消</button>
          <button className="button danger" type="button" disabled={busy} onClick={()=>{if(discardItem)void confirmDiscard(discardItem);}}>继续废弃</button>
        </div></footer>
      </DialogContent>
    </Dialog>
    <Dialog open={returnItem!==null} onOpenChange={open=>{if(!open&&!busy){setReturnItem(null);setError('');}}}>
      <DialogContent className={legacyStyles.dialog} showCloseButton={!busy}>
        <div className={legacyStyles.dialogHeader}><div>
          <DialogTitle>驳回质检项</DialogTitle>
          <DialogDescription>为任务 {returnItem?.taskId==null?'当前盲评项':`#${returnItem.taskId}`} 选择问题标签或填写原因，确认后提交驳回。</DialogDescription>
        </div></div>
        <section className={styles.returnPanel}>
          <CopyQaReasonPicker selected={reasonCodes} onChange={setReasonCodes} disabled={busy} />
          <label htmlFor="qa-return-note">补充说明</label>
          <textarea id="qa-return-note" className="textarea" rows={3} value={note} disabled={busy} onChange={event=>setNote(event.target.value)} />
        </section>
        {error&&<div className="notice error" role="alert">{error}</div>}
        <footer className={legacyStyles.footer}><span className="subtle">请选择问题标签或填写补充说明。</span><div>
          <button className="button" type="button" disabled={busy} onClick={()=>{setReturnItem(null);setError('');}}>取消</button>
          <button className="button danger" type="button" disabled={busy} onClick={()=>{if(returnItem)void decide(returnItem,'RETURN');}}>确认驳回</button>
        </div></footer>
      </DialogContent>
    </Dialog>
  </div>;
}
