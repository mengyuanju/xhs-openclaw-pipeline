'use client';
import { useCallback,useEffect,useRef,useState } from 'react';
import { apiRequest,ApiRequestError } from '../components/api-client';
import { subscribeWorkspaceUpdates } from '../components/workspace-updates';
import type { OperatorReport } from './operator-types';

export const OPERATOR_API='/api/control-plane/v1/admin/operator-performance';
export function useOperatorPerformance(filters:Record<string,string>) {
  const [report,setReport]=useState<OperatorReport|null>(null);
  const [error,setError]=useState(''),[busy,setBusy]=useState(false),[revision,setRevision]=useState(0);
  const cache=useRef<{key:string;token:string;expires:string}|null>(null);
  const refresh=useCallback(()=>{cache.current=null;setRevision(value=>value+1);},[]);
  const query=new URLSearchParams(Object.entries(filters).filter(([,value])=>value!=='')).toString();
  const base=new URLSearchParams(Object.entries(filters).filter(([key,value])=>!['page','sort','order'].includes(key)&&value!=='')).toString();
  useEffect(()=>{
    const controller=new AbortController();let disposed=false;
    const timer=setTimeout(()=>controller.abort(),30_000);
    const search=new URLSearchParams(query);
    if(cache.current?.key===base && Date.parse(cache.current.expires)>Date.now()) search.set('snapshotToken',cache.current.token);
    if(cache.current && cache.current.key!==base) setReport(null);
    setBusy(true);setError('');
    void (async()=>{
      try{
        let next:OperatorReport;
        try{next=await apiRequest<OperatorReport>(`${OPERATOR_API}?${search}`,{signal:controller.signal,cache:'no-store'});}
        catch(caught){
          if(caught instanceof ApiRequestError && caught.code==='PERFORMANCE_SNAPSHOT_EXPIRED') {
            search.delete('snapshotToken');next=await apiRequest<OperatorReport>(`${OPERATOR_API}?${search}`,{signal:controller.signal,cache:'no-store'});
          }else throw caught;
        }
        if(!next?.snapshotToken || !next.summary || !Array.isArray(next.people?.items)) throw Error('统计数据格式不完整');
        if(next.metricVersion<9 || !next.summary.qa || !next.summary.annotationOverallPass || !next.summary.COPY?.overallPass || !next.summary.IMAGE?.overallPass) throw Error('中心尚未支持按质检结论日统计账号通过率，请先升级中心服务');
        if(!disposed){setReport(next);cache.current={key:base,token:next.snapshotToken,expires:next.expiresAt};}
      }catch(caught){
        if(!disposed){
          if(caught instanceof ApiRequestError && [401,403].includes(caught.status)){setReport(null);cache.current=null;}
          setError(controller.signal.aborted?'统计读取超时，请缩小范围或重试':caught instanceof ApiRequestError && caught.status===404
            ?'中心尚未支持人员统计，请先升级中心服务':caught instanceof Error?caught.message:'统计读取失败');
        }
      }finally{clearTimeout(timer);if(!disposed)setBusy(false);}
    })();
    return()=>{disposed=true;controller.abort();clearTimeout(timer);};
  },[query,base,revision]);
  useEffect(()=>{
    const unsubscribe=subscribeWorkspaceUpdates(()=>{if(document.visibilityState==='visible')refresh();});
    const interval=setInterval(()=>{if(document.visibilityState==='visible')refresh();},60_000);
    const visible=()=>{if(document.visibilityState==='visible')refresh();};
    document.addEventListener('visibilitychange',visible);
    return()=>{unsubscribe();clearInterval(interval);document.removeEventListener('visibilitychange',visible);};
  },[refresh]);
  return {report,error,busy,refresh};
}
