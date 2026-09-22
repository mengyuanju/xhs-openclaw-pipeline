'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '../components/api-client';
import { notifyWorkspaceUpdated } from '../components/workspace-updates';
import { createRequestId } from '../components/request-id';
import styles from '../workbench-statistics/operator-performance.module.css';
type Case = {id:number;taskId:number;stage:string;query:string;status:string;version:number;resetStatus:string;cleanupStatus:string;resetError:string|null;baselineSource:string|null;canAssign:boolean;operatorAccountId:number;operatorName:string|null;note:string;initialContent?:unknown;assignments?:Array<{id:number;assignee_username_snapshot:string;assigned_at:string;ended_at:string|null}>};
type Account = {id:number;username:string;displayName:string;status:string;role:string;copyReviewEnabled?:boolean};
const root='/api/control-plane/v1/admin/reassignment-cases';
const labels:Record<string,string>={PENDING:'待二次分配',REASSIGNED:'已重新分配',DISCARDED:'已废弃',READY:'已还原',BLOCKED:'还原受阻',REGENERATING:'初始数据生成中',FAILED:'清理失败',COMPLETE:'已清理'};
export function ReassignmentQueue() {
  const [items,setItems]=useState<Case[]>([]),[total,setTotal]=useState(0),[offset,setOffset]=useState(0),[status,setStatus]=useState('PENDING');
  const [selected,setSelected]=useState<Case|null>(null),[accounts,setAccounts]=useState<Account[]>([]),[target,setTarget]=useState(''),[note,setNote]=useState('');
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const pending=useRef(false),request=useRef<{key:string;id:string}|null>(null);
  const loadSequence=useRef(0),detailSequence=useRef(0);
  const load=useCallback(async()=>{
    const sequence=++loadSequence.current;
    const page=await apiRequest<{items:Case[];total:number}>(`${root}?status=${status}&offset=${offset}&limit=30`,{cache:'no-store'});
    if(sequence!==loadSequence.current)return;
    setItems(page.items);setTotal(page.total);
  },[status,offset]);
  useEffect(()=>{void load().catch(e=>setError(e.message));},[load]);
  useEffect(()=>{void apiRequest<Account[]|{items:Account[]}>('/api/control-plane/v1/users',{cache:'no-store'}).then(data=>setAccounts((Array.isArray(data)?data:data.items).filter(a=>a.status==='ACTIVE'&&(a.role==='ADMIN'||a.copyReviewEnabled)))).catch(e=>setError(e.message));},[]);
  async function open(item:Case) {const sequence=++detailSequence.current;setError('');setTarget('');setNote('');try{const detail=await apiRequest<Case>(`${root}/${item.id}`,{cache:'no-store'});if(sequence===detailSequence.current)setSelected(detail);}catch(e){if(sequence===detailSequence.current)setError(e instanceof Error?e.message:'读取失败');}}
  async function act(operation:string) {
    if(!selected||pending.current)return;
    if(['reassign','discard','restore'].includes(operation)&&!note.trim()){setError('请填写处理原因');return;}
    if(operation==='reassign'&&!target){setError('请选择接手账号');return;}
    pending.current=true;setBusy(true);setError('');setNotice('');
    const payload={expectedVersion:selected.version,note:note.trim(),...(operation==='reassign'?{targetAccountId:Number(target)}:{})};
    const key=JSON.stringify({id:selected.id,operation,payload});
    if(request.current?.key!==key)request.current={key,id:createRequestId()};
    try {
      await apiRequest(`${root}/${selected.id}/${operation}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...payload,requestId:request.current.id})});
      notifyWorkspaceUpdated();setSelected(null);setNotice(operation==='reassign'?'已分配初始数据，原账号统计保留。':operation==='discard'?'已最终废弃，原质检日期的统计已更新。':'处理已提交，请刷新查看结果。');await load();
    }catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{pending.current=false;setBusy(false);}
  }
  return <div className={styles.page}><header className={styles.header}><div><h1>待二次分配</h1><p>强制复检未通过的任务由管理员统一处理。还原初稿、清理旧标注内容完成后，才能分配给新的操作者。</p></div><Button onClick={()=>void load().catch(e=>setError(e.message))}>刷新</Button></header>
    {error&&<p role="alert" className="notice error">{error}</p>}{notice&&<p role="status" className="notice">{notice}</p>}
    <label>处置状态 <select value={status} onChange={e=>{setStatus(e.target.value);setOffset(0);}}>{['PENDING','REASSIGNED','DISCARDED','ALL'].map(value=><option key={value} value={value}>{labels[value]??'全部'}</option>)}</select></label>
    <div className={styles.tableScroll}><table className={styles.table}><thead><tr><th>任务</th><th>原操作者</th><th>移交原因</th><th>还原 / 清理</th><th>状态</th><th>操作</th></tr></thead><tbody>{items.map(item=><tr key={item.id}><td>#{item.taskId} · {item.stage==='COPY'?'文案':'图片'}<br/>{item.query}</td><td>{item.operatorName??`账号 #${item.operatorAccountId}`}</td><td>{item.note}</td><td>{labels[item.resetStatus]??item.resetStatus} / {labels[item.cleanupStatus]??'等待清理'}{item.resetError&&<small>{item.resetError}</small>}</td><td>{labels[item.status]}</td><td><Button onClick={()=>void open(item)}>查看处置</Button></td></tr>)}{!items.length&&<tr><td colSpan={6}>当前没有处置记录</td></tr>}</tbody></table></div>
    <div className={styles.actions}><span>共 {total} 条</span><Button disabled={!offset} onClick={()=>setOffset(Math.max(0,offset-30))}>上一页</Button><Button disabled={offset+30>=total} onClick={()=>setOffset(offset+30)}>下一页</Button></div>
    <Dialog open={!!selected} onOpenChange={open=>{if(!open&&!busy)setSelected(null);}}><DialogContent style={{maxWidth:760,maxHeight:'85vh',overflow:'auto'}}><DialogTitle>任务 #{selected?.taskId} · 管理员处置</DialogTitle><DialogDescription>原操作者的已判定总量包含该条。重新分配后，新账号须重新标注并接受完整质检。</DialogDescription>
      {selected&&<><p>移交原因：{selected.note}</p><p>{selected.resetError}</p><details><summary>查看初始数据</summary><pre style={{whiteSpace:'pre-wrap',maxHeight:240,overflow:'auto'}}>{selected.initialContent?JSON.stringify(selected.initialContent,null,2):'没有可信机器初稿，尚未清理旧内容。'}</pre></details><details><summary>分配记录</summary>{selected.assignments?.map(a=><p key={a.id}>{a.assignee_username_snapshot} · {new Date(a.assigned_at).toLocaleString('zh-CN')} · {a.ended_at?'已结束':'当前分配'}</p>)}</details>
      {selected.status==='DISCARDED'&&<><label>恢复原因<textarea value={note} maxLength={1000} onChange={e=>setNote(e.target.value)}/></label><Button disabled={busy} onClick={()=>void act('restore')}>撤销废弃，恢复待二次分配</Button></>}
      {selected.status==='PENDING'&&<><label>接手账号 <select value={target} disabled={busy||!selected.canAssign} onChange={e=>setTarget(e.target.value)}><option value="">请选择账号</option>{accounts.map(a=><option key={a.id} value={a.id}>{a.displayName||a.username}（{a.username}）</option>)}</select></label><label>处理原因<textarea maxLength={1000} rows={3} value={note} disabled={busy} onChange={e=>setNote(e.target.value)}/></label>
        <div className={styles.actions}><Button disabled={busy||!selected.canAssign||!target} onClick={()=>void act('reassign')}>确认二次分配</Button><Button variant="outline" disabled={busy||selected.resetStatus==='REGENERATING'} onClick={()=>void act('reset')}>重试还原 / 清理</Button>{selected.resetStatus==='BLOCKED'&&!selected.baselineSource&&<Button variant="outline" disabled={busy} onClick={()=>void act('regenerate')}>重新生成初始数据</Button>}<Button variant="outline" disabled={busy||selected.resetStatus==='REGENERATING'} onClick={()=>void act('discard')}>最终废弃</Button></div></>}{error&&<p role="alert">{error}</p>}</>}
    </DialogContent></Dialog>
  </div>;
}
