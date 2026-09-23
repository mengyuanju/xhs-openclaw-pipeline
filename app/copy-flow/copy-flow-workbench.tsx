'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { apiRequest } from '../components/api-client';
import { createRequestId } from '../components/request-id';
import styles from './copy-flow-workbench.module.css';

type User = { id:number;username:string;displayName:string;pendingCount:number;autoBatchEnabled:boolean;autoBatchSize:number;fullInspection:boolean;samplingRateBpsOverride:number|null };
type Task = {taskId:number;query:string;approverAccountId:number;approverUsername:string;approvedAt:string};
type Candidates = {users:User[];tasks:Task[];truncated:boolean};
type Choice = {member:boolean;sample:boolean};

export function CopyFlowWorkbench() {
  const confirm=useConfirmDialog();
  const [data,setData]=useState<Candidates|null>(null);
  const [tab,setTab]=useState<'PERSONAL'|'MIXED'>('PERSONAL');
  const [owner,setOwner]=useState<User|null>(null);
  const [tasks,setTasks]=useState<Task[]>([]);
  const [choices,setChoices]=useState<Record<number,Choice>>({});
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState('');
  const [message,setMessage]=useState('');
  const currentTasks=tab==='PERSONAL'?tasks:data?.tasks??[];
  const selectedCount=currentTasks.filter(task=>choices[task.taskId]?.member).length;
  const sampleCount=currentTasks.filter(task=>choices[task.taskId]?.sample).length;

  async function refresh(){
    try {setData(await apiRequest<Candidates>('/api/control-plane/v2/copy-qa/candidates'));setError('');}
    catch(e){setError(e instanceof Error?e.message:'加载失败');}
  }
  useEffect(()=>{void refresh();},[]);
  async function openUser(user:User){
    setBusy(true);
    try {
      const response=await apiRequest<Candidates>(`/api/control-plane/v2/copy-qa/candidates?accountId=${user.id}`);
      setOwner(user);setTasks(response.tasks);
      setChoices(Object.fromEntries(response.tasks.map(task=>[task.taskId,{member:true,sample:false}])));
      setError('');
    }catch(e){setError(e instanceof Error?e.message:'加载失败');}
    finally{setBusy(false);}
  }
  function switchTab(next:'PERSONAL'|'MIXED'){
    setTab(next);setOwner(null);setTasks([]);setChoices({});setError('');setMessage('');
  }
  function choose(id:number,field:keyof Choice,checked:boolean){
    setChoices(current=>{
      const previous=current[id]??{member:false,sample:false};
      return {...current,[id]:field==='member'
        ? {member:checked,sample:checked&&previous.sample}
        : {member:checked||previous.member,sample:checked}};
    });
  }
  function chooseAll(field:keyof Choice,checked:boolean){
    setChoices(current=>{
      const next={...current};
      for(const task of currentTasks){
        const previous=next[task.taskId]??{member:false,sample:false};
        next[task.taskId]=field==='member'
          ? {member:checked,sample:checked&&previous.sample}
          : {member:checked||previous.member,sample:checked};
      }
      return next;
    });
  }
  async function create(mode:'PERSONAL_MANUAL'|'PERSONAL_AUTO'|'MIXED_MANUAL'){
    const visibleTasks=mode==='MIXED_MANUAL' ? (data?.tasks??[]) : tasks;
    const memberIds=visibleTasks.filter(task=>choices[task.taskId]?.member).map(task=>task.taskId);
    const sampleTaskIds=visibleTasks.filter(task=>choices[task.taskId]?.sample).map(task=>task.taskId);
    if(!memberIds.length){setError('请先选择入批任务');return;}
    const approved=await confirm({
      title:'确认创建质检批次？',
      description:mode==='PERSONAL_AUTO'
        ? `将 ${memberIds.length} 条任务纳入新批次，并按 ${owner?.displayName??'该用户'} 的抽检比例随机选取质检项。`
        : `将 ${memberIds.length} 条任务纳入新批次，其中 ${sampleTaskIds.length} 条作为质检项。`,
      confirmLabel:'确认创建',
    });
    if(!approved)return;
    setBusy(true);
    try {
      const created=await apiRequest<{displayName:string}>('/api/control-plane/v2/copy-qa/batches',{
        method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({requestId:createRequestId(),mode,accountId:owner?.id,taskIds:memberIds,sampleTaskIds}),
      });
      setOwner(null);setTasks([]);setChoices({});await refresh();
      setMessage(`已创建 ${created.displayName}，可前往文案质检页查看。`);
    }catch(e){setError(e instanceof Error?e.message:'创建失败，请刷新任务后重试');}
    finally{setBusy(false);}
  }

  return <div className={`page-shell ${styles.page}`}>
    <header className="page-header"><div><span className="eyebrow">Copy workflow</span><h1>文案工作入口</h1>
      <p className="subtle">审核通过的任务在这里创建质检批次。入批任务会锁定，直到批次处理结束。</p></div>
      <button className="button" onClick={()=>void refresh()} disabled={busy}>刷新</button></header>
    <div className={styles.navigation}>
      <div className={styles.tabs} role="tablist" aria-label="批次创建模式">
        <button className={`${styles.tab} ${tab==='PERSONAL'?styles.active:''}`} role="tab" aria-selected={tab==='PERSONAL'} onClick={()=>switchTab('PERSONAL')} type="button">个人模式</button>
        <button className={`${styles.tab} ${tab==='MIXED'?styles.active:''}`} role="tab" aria-selected={tab==='MIXED'} onClick={()=>switchTab('MIXED')} type="button">混合模式</button>
      </div>
      <Link className="button" href="/copy-qa">进入文案质检</Link>
    </div>
    {error&&<div className="notice error" role="alert">{error}</div>}
    {message&&<div className="notice" role="status">{message}</div>}
    {tab==='PERSONAL'&&!owner&&<section className={`panel ${styles.panel}`}>
      <div className={styles.sectionHead}><div><h2>按用户创建批次</h2><p className="subtle">待入批数量仅统计尚未分配到质检批次的任务。</p></div></div>
      <div className="table-wrap"><table className={styles.table}><thead><tr><th>审核用户</th><th>待入批任务</th><th>自动成批</th><th>全量质检</th><th>操作</th></tr></thead><tbody>
        {data?.users.map(user=><tr key={user.id}><td><strong>{user.displayName}</strong><span className={styles.secondary}>@{user.username}</span></td><td>{user.pendingCount}</td>
          <td>{user.autoBatchEnabled?`开启 · ${user.autoBatchSize} 条`:'关闭'}</td><td>{user.fullInspection?'开启':'关闭'}</td>
          <td><button className="button small" type="button" disabled={busy||user.pendingCount===0} onClick={()=>void openUser(user)}>选择任务</button></td></tr>)}
      </tbody></table></div>
    </section>}
    {((tab==='PERSONAL'&&owner)||tab==='MIXED')&&<section className={`panel ${styles.panel}`}>
      <div className={styles.sectionHead}><div><h2>{owner?`${owner.displayName}的待入批任务`:'所有待入批任务'}</h2>
        <p className="subtle">入批决定本批成员；质检项决定需要逐条检查的任务。未抽中质检项的入批任务仍属于本批。</p></div>
        {owner&&<button type="button" className="button" onClick={()=>setOwner(null)}>返回用户列表</button>}</div>
      <div className={styles.toolbar}>
        <div className={styles.selectionSummary}><strong>已选入批 {selectedCount} 条</strong><span>质检项 {sampleCount} 条</span></div>
        <div className={styles.actions}>
          <button className="button primary" disabled={busy||!selectedCount} onClick={()=>void create(owner?'PERSONAL_MANUAL':'MIXED_MANUAL')}>手动创建批次</button>
          {owner&&<button className="button" disabled={busy||!selectedCount} onClick={()=>void create('PERSONAL_AUTO')}>按比例随机抽检并创建</button>}
        </div>
      </div>
      <div className="table-wrap"><table className={styles.table}><thead><tr>
        <th>任务</th><th>审核人</th>
        <th className={styles.checkColumn}><label className={styles.checkLabel}><input type="checkbox" aria-label="批量勾选入批任务" checked={currentTasks.length>0&&selectedCount===currentTasks.length} onChange={event=>chooseAll('member',event.target.checked)} />入批全选</label></th>
        <th className={styles.checkColumn}><label className={styles.checkLabel}><input type="checkbox" aria-label="批量勾选质检项" checked={currentTasks.length>0&&sampleCount===currentTasks.length} onChange={event=>chooseAll('sample',event.target.checked)} />质检项全选</label></th>
      </tr></thead><tbody>
        {currentTasks.map(task=><tr key={task.taskId}><td><strong>#{task.taskId}</strong><span className={styles.taskQuery}>{task.query}</span></td><td>{task.approverUsername}</td>
          <td className={styles.checkColumn}><input type="checkbox" aria-label={`任务 ${task.taskId} 入批`} checked={choices[task.taskId]?.member??false} onChange={event=>choose(task.taskId,'member',event.target.checked)} /></td>
          <td className={styles.checkColumn}><input type="checkbox" aria-label={`任务 ${task.taskId} 质检项`} checked={choices[task.taskId]?.sample??false} onChange={event=>choose(task.taskId,'sample',event.target.checked)} /></td></tr>)}
        {!currentTasks.length&&<tr><td colSpan={4} className={styles.empty}>暂无可入批任务</td></tr>}
      </tbody></table></div>
      {data?.truncated&&tab==='MIXED'&&<p className="subtle">仅显示前 5000 条候选任务。</p>}
    </section>}
  </div>;
}
