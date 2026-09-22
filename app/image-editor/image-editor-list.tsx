'use client';
import { useEffect, useState } from 'react';
import { apiRequest } from '../components/api-client';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/input';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { createRequestId } from '../components/request-id';
import { useBackgroundTasks } from '../components/background-tasks';
import styles from './workbench.module.css';

type Item = { id:number; title:string; owner:string; status:string; nodeId:string|null; error:string|null; createdAt?:string };
const outcomes:Record<string,string> = { FAILED:'生成失败，可打开记录重试', CANCELLED:'已取消', REJECTED:'结果未采用' };
function statusOf(status:string) {
  if(status === 'RUNNING')return {label:'生图中',tone:'running'};
  if(['UPLOADED','DRAFT','QUEUED'].includes(status))return {label:'待生图',tone:'queued'};
  return {label:'已完成',tone:'completed'};
}
export function ImageEditorList({refreshKey=0,onSelect}:{refreshKey?:number;onSelect:(id:number)=>void}) {
  const confirm=useConfirmDialog();
  const {store:backgroundStore}=useBackgroundTasks();
  const [selected,setSelected]=useState<number[]>([]),[deleting,setDeleting]=useState(false),[actionError,setActionError]=useState('');
  const [offset,setOffset] = useState(0), [revision,setRevision] = useState(0);
  const [data,setData] = useState<{items:Item[];total:number}>({items:[],total:0}), [error,setError] = useState('');
  const [loading,setLoading] = useState(true);
  useEffect(() => {setOffset(0);},[refreshKey]);
  useEffect(() => {
    const controller = new AbortController();
    let active = true, pending = false;
    setLoading(true);
    const refresh = async () => {
      if(pending)return;
      pending = true;
      try {
        const value = await apiRequest<{items:Item[];total:number}>(`/api/control-plane/v1/image-editor/workspaces?offset=${offset}&limit=20&queue=true`,{signal:controller.signal});
        if(!active)return;
        if(offset > 0 && !value.items.length && value.total <= offset) {setOffset(Math.max(0,Math.ceil(value.total/20)-1)*20);return;}
        setData(value);setSelected(current=>current.filter(id=>value.items.some(item=>item.id===id&&item.status!=='RUNNING')));setError('');
      } catch(e) {if(active)setError(e instanceof Error ? e.message : '读取图片列表失败');}
      finally {pending=false;if(active)setLoading(false);}
    };
    void refresh();
    const timer = setInterval(() => void refresh(),5000);
    return () => {active=false;controller.abort();clearInterval(timer);};
  },[offset,refreshKey,revision]);
  const selectable=data.items.filter(item=>item.status!=='RUNNING').map(item=>item.id);
  async function remove(ids:number[]) {
    if(deleting||!ids.length)return;
    const approved=await confirm({title:ids.length>1?'删除所选图片？':'删除这条图片？',description:`将删除 ${ids.length} 条图片编辑记录，尚未开始的生图请求也会取消。`,confirmLabel:'确认删除',tone:'danger'});
    if(!approved)return;
    setDeleting(true);setActionError('');
    try {
      const result=await apiRequest<{deletedIds:number[]}>('/api/control-plane/v1/image-editor/workspaces/delete',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({workspaceIds:ids,requestId:createRequestId()})});
      backgroundStore?.dismissStandaloneWorkspaces(result.deletedIds);
      setSelected([]);setRevision(value=>value+1);
    } catch(e) {setActionError(e instanceof Error?e.message:'删除失败');setRevision(value=>value+1);}
    finally {setDeleting(false);}
  }
  return <section className={`panel ${styles.list}`} aria-label="图片编辑列表" aria-busy={loading}>
    <div className={styles.heading}><span>共 {data.total} 条图片编辑</span><Button variant="outline" size="sm" disabled={deleting||loading||!selected.length} onClick={()=>void remove(selected)}>{deleting?'正在删除…':`批量删除${selected.length?`（${selected.length}）`:''}`}</Button><Button variant="outline" size="sm" disabled={loading} onClick={() => setRevision(value => value+1)}>刷新</Button></div>
    {(error||actionError) && <p role="alert">{actionError||error}</p>}
    {data.items.length ? <div className={styles.tableScroll}><table><thead><tr><th><Checkbox aria-label="全选本页可删除图片" checked={selectable.length>0&&selectable.every(id=>selected.includes(id))} disabled={deleting||!selectable.length} onChange={event=>setSelected(event.target.checked?selectable:[])}/></th><th>图片名称</th><th>提交人</th><th>状态</th><th>执行机</th><th>创建时间</th><th>操作</th></tr></thead><tbody>{data.items.map(item => {
      const status = statusOf(item.status);
      return <tr key={item.id}>
        <td><Checkbox aria-label={`选择图片 ${item.title}`} checked={selected.includes(item.id)} disabled={deleting||item.status==='RUNNING'} onChange={event=>setSelected(current=>event.target.checked?[...current,item.id]:current.filter(id=>id!==item.id))}/></td>
        <td><strong>{item.title}</strong><small className={styles.meta}>#{item.id}</small></td><td>{item.owner}</td>
        <td><span className={styles.status} data-tone={status.tone}>{status.label}</span>{outcomes[item.status] && <small className={styles.outcome}>{outcomes[item.status]}</small>}{item.error && <details><summary>查看原因</summary>{item.error}</details>}</td>
        <td>{item.nodeId ?? '—'}</td><td className={styles.date}>{item.createdAt ? new Date(item.createdAt).toLocaleString('zh-CN',{hour12:false}) : '—'}</td>
        <td><div className={styles.rowActions}><Button variant="outline" size="sm" disabled={deleting} onClick={() => onSelect(item.id)}>{item.status === 'RUNNING' ? '查看' : '查看 / 编辑'}</Button><Button variant="outline" size="sm" disabled={deleting||item.status==='RUNNING'} onClick={()=>void remove([item.id])}>删除</Button></div></td>
      </tr>;
    })}</tbody></table></div> : <div className={styles.empty}>{loading ? '正在加载图片…' : error ? '图片列表暂时无法加载' : '暂无图片，点击右上角“新增图片”开始编辑。'}</div>}
    <div className={styles.pagination}><span>第 {Math.floor(offset/20)+1} / {Math.max(1,Math.ceil(data.total/20))} 页</span><Button variant="outline" size="sm" disabled={loading || offset === 0} onClick={() => setOffset(Math.max(0,offset-20))}>上一页</Button><Button variant="outline" size="sm" disabled={loading || offset+20 >= data.total} onClick={() => setOffset(offset+20)}>下一页</Button></div>
  </section>;
}
