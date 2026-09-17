'use client';

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { UploadCloud } from 'lucide-react';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';
import {
  DEFAULT_DISCLOSURE_TEXT,
  addRecentDisclosureText,
  loadRecentDisclosureTexts,
  saveRecentDisclosureTexts,
} from '../../src/recent-disclosure-texts.mjs';
import styles from './current-image-editor.module.css';

type Asset = { id: number; sha256: string; url: string };
type Ref = Asset & { purpose: string };
type TargetRegion = { x:number; y:number; width:number; height:number };
type ReferenceMode = 'STRICT' | 'APPEARANCE';
type TextScope = 'CURRENT' | 'ALL';
type DisclosureMethod = 'SVG' | 'MODEL';
type EditAction = 'accept' | 'reject' | 'cancel' | 'retry' | 'queue' | 'apply-suggestion';
type WorkspacePanel = 'EDIT' | 'HISTORY';
type MobileView = 'PREVIEW' | WorkspacePanel;
type PreviewMode = 'SOURCE' | 'RESULT' | 'COMPARE';
type PromptAction = '' | '改颜色' | '替换物体' | '删除物体' | '修复瑕疵';
type LocalSuggestion = { stage:'LOCAL_EDIT_SUGGESTION'; decision:'SUGGEST'; canEdit:true; suggestedInstruction:string; reason:string; operationType:string; touchesImageEdge:boolean; editRegions:TargetRegion[] };
type LocalRepairRecommendation = { repairableFromRejected:true; repairInstruction:string; failureCodes:string[]; repairRegions:TargetRegion[]; repairAttempt:number; repairMaxAttempts:number };
type Edit = { id: string; version: number; attempts:number; status: string; operation: string; source_asset_id?:number; target_page:number; created_by:string; validation?:unknown; events?:Array<{action:string;actor:string;reason:string}>; error: string | null; config: {instruction:string;confirmation?:string|null;batchId?:string|null}; result?: {asset_id: number; image_run_id: string; validation: unknown} };
const labels: Record<string,string> = {DRAFT:'草稿',QUEUED:'排队中',RUNNING:'执行与校验中',PREVIEW_READY:'预览待确认',ACCEPTED:'已采用',REJECTED:'已拒绝',FAILED:'失败',CANCELLED:'已取消',SVG_DISCLOSURE:'程序生成标识',TEXT:'模型生成标识',COMPOSITE:'实体合成（历史）',AI_FUSION:'真实产品替换',AI_LOCAL:'局部修改',AI_FULL:'整图修改（历史）',RESTORE:'恢复版本',REGENERATE:'重新生成',REPROCESS:'格式处理'};
const actionLabels: Record<EditAction,string> = {accept:'采用此版本',reject:'拒绝',cancel:'直接删除此修复',retry:'重试（AI 可能再次收费）',queue:'提交草稿','apply-suggestion':'采用建议并修改'};
const promptActions: PromptAction[] = ['改颜色','替换物体','删除物体','修复瑕疵'];
const quickRequirements = ['保持材质','保持光影','不改文字'];
const quickReasons = ['预览符合要求','定位或内容有误','调整说明后重试','不再需要此修复'];
const NOTICE_DURATION_MS=6_000;
const isDisclosureOperation=(operation:string)=>['TEXT','SVG_DISCLOSURE'].includes(operation);
function localSuggestion(edit:Edit):LocalSuggestion|null {
  if(edit.status!=='FAILED')return null;
  const value=edit.validation;
  if(!value||typeof value!=='object'||Array.isArray(value))return null;
  const suggestion=value as Partial<LocalSuggestion>;
  const editRegions=Array.isArray(suggestion.editRegions)?suggestion.editRegions.filter(region=>region&&Number.isFinite(region.x)&&Number.isFinite(region.y)&&Number.isFinite(region.width)&&Number.isFinite(region.height)):[];
  if(suggestion.stage!=='LOCAL_EDIT_SUGGESTION'||suggestion.decision!=='SUGGEST'||suggestion.canEdit!==true
    ||typeof suggestion.suggestedInstruction!=='string'||!suggestion.suggestedInstruction.trim()||!editRegions.length)return null;
  return {...suggestion,reason:typeof suggestion.reason==='string'?suggestion.reason:'',operationType:typeof suggestion.operationType==='string'?suggestion.operationType:'ADJUST',
    touchesImageEdge:suggestion.touchesImageEdge===true,editRegions} as LocalSuggestion;
}
function historyActions(edit:Edit):EditAction[] {
  if(edit.status==='PREVIEW_READY')return ['accept','reject','cancel'];
  if(edit.status==='FAILED') {
    if(localSuggestion(edit))return ['apply-suggestion','cancel'];
    const canRetry=Boolean(localRepairRecommendation(edit))||Number(edit.attempts??0)<3;
    if(edit.result)return canRetry?['accept','retry','cancel']:['accept','cancel'];
    return canRetry?['retry','cancel']:['cancel'];
  }
  if(edit.status==='DRAFT')return ['queue','cancel'];
  return ['QUEUED','RUNNING'].includes(edit.status)?['cancel']:[];
}
function isRejectedPreview(edit:Edit|undefined) {
  if(!edit?.result)return false;
  const validation=edit.result.validation;
  return !validation||typeof validation!=='object'||Array.isArray(validation)||(validation as {passed?:boolean}).passed!==true;
}
function failedPreviewReason(edit:Edit) {
  const validation=edit.result?.validation;
  if(validation&&typeof validation==='object'&&!Array.isArray(validation)) {
    const local=(validation as {localConsistency?:{reason?:unknown}}).localConsistency;
    if(typeof local?.reason==='string'&&local.reason.trim())return local.reason;
  }
  return edit.error||'自动验收未通过，请对照原图检查修改结果。';
}
function localRepairRecommendation(edit:Edit):LocalRepairRecommendation|null {
  if(!isRejectedPreview(edit))return null;
  const validation=edit.result?.validation;
  if(!validation||typeof validation!=='object'||Array.isArray(validation))return null;
  const local=(validation as {localConsistency?:Partial<LocalRepairRecommendation>}).localConsistency;
  if(local?.repairableFromRejected!==true||typeof local.repairInstruction!=='string'||!local.repairInstruction.trim()
    ||!Array.isArray(local.failureCodes)||!Array.isArray(local.repairRegions)||!local.repairRegions.length)return null;
  return {repairableFromRejected:true,repairInstruction:local.repairInstruction,failureCodes:local.failureCodes.filter(code=>typeof code==='string'),
    repairRegions:local.repairRegions,repairAttempt:Number(local.repairAttempt??0),repairMaxAttempts:Number(local.repairMaxAttempts??0)};
}
function historyActionLabel(edit:Edit,action:EditAction) {
  if(action==='accept'&&isRejectedPreview(edit))return '仍采用此结果';
  if(action==='retry'&&edit.operation==='SVG_DISCLOSURE')return '重试程序标识';
  if(action==='retry'&&localRepairRecommendation(edit))return '基于失败图定向修复（再次收费）';
  if(action==='retry'&&isRejectedPreview(edit))return '从原图重新重试（可能再次收费）';
  return actionLabels[action];
}
const path=(url:string)=>`/api/control-plane${url}`;
const post=(url:string,body:unknown)=>apiRequest(path(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
const PreviewSourceImage=memo(function PreviewSourceImage({src}:{src:string}) {
  return <img className={styles.previewImage} src={src} alt="" draggable={false}/>;
});
function regionBetween(start:{x:number;y:number},point:{x:number;y:number}):TargetRegion {
  const x=Math.min(start.x,point.x),y=Math.min(start.y,point.y);
  return {x,y,width:Math.max(1,Math.abs(point.x-start.x)),height:Math.max(1,Math.abs(point.y-start.y))};
}
function pointLocation(point:{x:number;y:number}|null) {
  if(!point)return '';
  const horizontal=point.x<362?'左侧':point.x>724?'右侧':'中间';
  const vertical=point.y<483?'上方':point.y>965?'下方':'中部';
  if(horizontal==='中间'&&vertical==='中部')return '画面中央';
  if(horizontal==='中间')return `画面${vertical}`;
  if(vertical==='中部')return `画面${horizontal}`;
  return `画面${horizontal.replace('侧','')}${vertical.replace('方','')}`;
}
export function CurrentImageEditor({taskId,runId,copyRevisionId,asset,assets,page,runs,onChanged}: {
  taskId:number;runId:string;copyRevisionId:number;asset:Asset;assets?:Asset[];page:number;
  runs:Array<{id:string;result:{processing?:{type:string}}|null}>;onChanged:()=>Promise<void>;
}) {
  const confirm=useConfirmDialog();
  const [open,setOpen]=useState(false),[tab,setTab]=useState('TEXT');
  const [text,setText]=useState(DEFAULT_DISCLOSURE_TEXT);
  const [textScope,setTextScope]=useState<TextScope>('CURRENT');
  const [disclosureMethod,setDisclosureMethod]=useState<DisclosureMethod>('MODEL');
  const [activeBatchId,setActiveBatchId]=useState('');
  const [recentDisclosureTexts,setRecentDisclosureTexts]=useState<string[]>([]);
  const [instruction,setInstruction]=useState('');
  const [targetDescription,setTargetDescription]=useState('');
  const [targetRegion,setTargetRegion]=useState<TargetRegion|null>(null);
  const [referenceMode,setReferenceMode]=useState<ReferenceMode>('STRICT');
  const [panel,setPanel]=useState<WorkspacePanel>('EDIT');
  const [mobileView,setMobileView]=useState<MobileView>('PREVIEW');
  const [previewMode,setPreviewMode]=useState<PreviewMode>('SOURCE');
  const [promptAction,setPromptAction]=useState<PromptAction>('');
  const [promptTarget,setPromptTarget]=useState<{x:number;y:number}|null>(null);
  const [pendingHistoryAction,setPendingHistoryAction]=useState<{editId:string;action:EditAction}|null>(null);
  const [pendingBatchAccept,setPendingBatchAccept]=useState(false);
  const targetDragStart=useRef<{x:number;y:number}|null>(null);
  const pendingTargetRegion=useRef<TargetRegion|null>(null);
  const targetSelectionFrame=useRef<number|null>(null);
  const [confirmed,setConfirmed]=useState(false),[historyCostConfirmed,setHistoryCostConfirmed]=useState(false),[refs,setRefs]=useState<Ref[]>([]),[edits,setEdits]=useState<Edit[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[compare,setCompare]=useState(50),[zoom,setZoom]=useState(1),[history,setHistory]=useState(''),[reason,setReason]=useState('');
  const [comparisonId,setComparisonId]=useState('');
  const imageAssets=assets?.length?assets:[asset];
  const refresh=useCallback(async()=>setEdits(await apiRequest<Edit[]>(path(`/v1/tasks/${taskId}/image-edits`))),[taskId]);
  useEffect(()=>{if(!open)return;let active=true;const poll=()=>{if(active)void refresh().catch(e=>setError(e.message));};poll();const timer=setInterval(poll,4000);return()=>{active=false;clearInterval(timer);};},[open,refresh]);
  useEffect(()=>{if(open)setRecentDisclosureTexts(loadRecentDisclosureTexts(window.localStorage));},[open]);
  useEffect(()=>{if(!notice||busy)return;const timer=window.setTimeout(()=>setNotice(''),NOTICE_DURATION_MS);return()=>window.clearTimeout(timer);},[notice,busy]);
  useEffect(()=>()=>{if(targetSelectionFrame.current!==null)window.cancelAnimationFrame(targetSelectionFrame.current);},[]);
  const operation=tab==='TEXT'?(disclosureMethod==='SVG'?'SVG_DISCLOSURE':'TEXT'):tab==='ENTITY'?'AI_FUSION':'AI_LOCAL';
  const usesBillableModel=operation==='TEXT'||operation.startsWith('AI_');
  const promptRequestInstruction=[pointLocation(promptTarget)&&`${pointLocation(promptTarget)}附近`,promptAction,instruction.trim()].filter(Boolean).join('，');
  const requestInstruction=tab==='TEXT'?`${disclosureMethod==='SVG'?'使用 SVG + Sharp 确定性叠加':'使用图片编辑模型融合'}人工生成标识“${text.trim()}”并放在右下角`:
    tab==='ENTITY'?`${referenceMode==='APPEARANCE'?'使用上传参考图中主产品的可见外观':'使用上传的完整真实产品参考图'}，只替换目标“${targetDescription.trim()}”，保持场景、人物、构图和全部文字不变`:promptRequestInstruction;
  const preserve=tab==='ENTITY'?'保留原图全部已批准文字、人物、背景、构图、色调和未被替换的物品':'除说明明确点名的目标外，保留原图全部已批准文字、所有未点名区域、人物、构图和色调';
  const negative=tab==='ENTITY'
    ?referenceMode==='APPEARANCE'
      ?'不得新增文字；不得把参考图中的手部、背景或次要产品带入结果；不得虚构参考图无法确认的标志、文字或功能结构'
      :'不得新增文字；不得改变参考产品的外形、颜色、标志和关键细节'
    :'不得修改说明之外的区域；除明确要求修改或删除的目标外，不得新增、删除或改写已有文字';
  const disclosureOverlay={text:text.trim(),textType:'AI_DISCLOSURE',size:32,margin:32,opacity:1,color:'#ffffff',background:'#111827',position:'bottom-right',disclosureType:'AI_GENERATED'};
  const base=()=>({requestId:createRequestId(),sourceImageRunId:runId,sourceAssetId:asset.id,copyRevisionId,sha256:asset.sha256,targetPage:page});
  async function act(action:()=>Promise<unknown>,pending='正在处理…',success='操作完成') {setBusy(true);setError('');setNotice(pending);try{await action();await refresh();await onChanged();setNotice(success);}catch(e){setNotice('');setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  function rememberDisclosureText() {
    const current=loadRecentDisclosureTexts(window.localStorage);
    const next=addRecentDisclosureText(current,text);
    setRecentDisclosureTexts(saveRecentDisclosureTexts(window.localStorage,next));
  }
  function requestIssue(draft=false) {
    if(tab==='TEXT'&&!disclosureValid)return '人工生成标识需填写 1～12 个文字、数字、下划线或短横线。';
    if(tab==='ENTITY'&&refs.length!==1)return '请先上传 1 张真实产品图片。';
    if(tab==='ENTITY'&&!targetDescription.trim())return '请填写需要替换的目标物品说明。';
    if(tab==='ENTITY'&&!targetRegion)return '请在左侧原图上拖动框选需要替换的一个物品。';
    if(tab==='PROMPT'&&!instruction.trim())return '请先填写局部修改说明，并同时写清修改位置和内容。';
    if(!draft&&usesBillableModel&&!confirmed)return '请先勾选费用确认，再生成修改预览。保存草稿不调用模型，无需勾选。';
    return '';
  }
  function submit(draft=false) {
    const issue=requestIssue(draft);
    if(issue){setNotice('');setError(issue);return;}
    return act(async()=>{
      await post(`/v1/tasks/${taskId}/image-edits`,{...base(),operation,instruction:requestInstruction,preserve,negative,
      ...(isDisclosureOperation(operation)?{overlay:disclosureOverlay}:{}),
      references:tab==='ENTITY'?refs.map(r=>({assetId:r.id,purpose:r.purpose})):[],
      ...(tab==='ENTITY'?{referenceMode}:{}),
      ...(tab==='ENTITY'?{target:{description:targetDescription.trim(),region:targetRegion}}:{}),
      confirmation:usesBillableModel&&confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft});
      if(isDisclosureOperation(operation))rememberDisclosureText();
    },draft?'正在保存草稿…':'已提交，正在排队生成修改预览…',draft?'草稿已保存。':'修改请求已提交，系统正在处理。');}
  async function submitDisclosureBatch() {
    const issue=requestIssue(false);
    if(issue){setNotice('');setError(issue);return;}
    if(imageAssets.length<2){return submit();}
    const batchId=createRequestId(),failedPages:number[]=[];
    setActiveBatchId(batchId);setBusy(true);setError('');setNotice(`正在提交整套 ${imageAssets.length} 张标识预览…`);
    let submitted=0;
    try {
      for(const [index,item] of imageAssets.entries()) {
        try {
          await post(`/v1/tasks/${taskId}/image-edits`,{requestId:createRequestId(),batchId,sourceImageRunId:runId,
            sourceAssetId:item.id,copyRevisionId,sha256:item.sha256,targetPage:index+1,operation,
            instruction:requestInstruction,preserve,negative,overlay:disclosureOverlay,references:[],
            confirmation:usesBillableModel?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft:false});
          submitted+=1;setNotice(`已提交 ${submitted} / ${imageAssets.length} 张，正在继续…`);
        } catch { failedPages.push(index+1); }
      }
      if(submitted>0)rememberDisclosureText();
      await refresh();
      if(submitted>0)await onChanged();
      if(failedPages.length) {
        setNotice('');setError(`整套标识已提交 ${submitted} / ${imageAssets.length} 张；第 ${failedPages.join('、')} 页提交失败，请重新发起整套批次。`);
      } else {
        setNotice(disclosureMethod==='SVG'
          ?`整套 ${imageAssets.length} 张程序标识预览已提交；系统将逐页使用 SVG + Sharp 合成。`
          :`整套 ${imageAssets.length} 张模型标识预览已提交；系统将逐页调用图片编辑模型并校验文字。`);
      }
    } catch(e) {
      setNotice('');setError(e instanceof Error?e.message:'整套标识提交失败');
    } finally {setBusy(false);}
  }
  async function upload(files:FileList|null) {
    const file=files?.[0];
    if(!file)return;
    if(file.size>5*1024*1024){setError('实体图片不能超过 5 MB');return;}
    await act(async()=>{
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
      const saved=await apiRequest<Asset>(path(`/v1/tasks/${taskId}/image-edit-references`),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base64,mediaType:file.type,source:'作业员上传的真实产品参考图',purpose:'真实产品替换'})});
      setRefs([{...saved,purpose:'真实产品替换'}]);
    },'正在上传真实产品图片…','真实产品图片已上传。');
  }
  function showPanel(next:WorkspacePanel) {
    if(next==='EDIT'){setPendingHistoryAction(null);setPendingBatchAccept(false);setReason('');}
    setPanel(next);setMobileView(next);
  }
  function appendRequirement(requirement:string) {
    setInstruction(current=>current.includes(requirement)?current:`${current.replace(/[，。\s]+$/u,'')}${current.trim()?'，':''}${requirement}`);
  }
  function reuseInstruction(edit:Edit) {
    setTab('PROMPT');setInstruction(edit.config.instruction);setPromptAction('');setPromptTarget(null);
    setConfirmed(false);setError('');setNotice('');showPanel('EDIT');
  }
  const latest=edits.find(e=>e.id===comparisonId&&e.result)
    ??edits.find(e=>e.target_page===page&&e.result);
  const latestRejected=isRejectedPreview(latest);
  const pageEdits=edits.filter(e=>e.target_page===page);
  const suggestedEdit=pageEdits.find(e=>localSuggestion(e)!==null);
  const suggestedPlan=suggestedEdit?localSuggestion(suggestedEdit):null;
  useEffect(()=>{if(latest?.result)setPreviewMode(current=>current==='SOURCE'?'COMPARE':current);},[latest?.id,latest?.result?.asset_id]);
  const disclosureBatchId=activeBatchId||edits.find(e=>isDisclosureOperation(e.operation)&&e.config.batchId)?.config.batchId||'';
  const disclosureBatchEdits=disclosureBatchId
    ?edits.filter(e=>isDisclosureOperation(e.operation)&&e.config.batchId===disclosureBatchId).sort((a,b)=>a.target_page-b.target_page)
    :[];
  const disclosureBatchPages=new Set(disclosureBatchEdits.map(e=>e.target_page));
  const disclosureBatchComplete=disclosureBatchEdits.length===imageAssets.length
    && imageAssets.every((_,index)=>disclosureBatchPages.has(index+1));
  const disclosureBatchReady=disclosureBatchComplete
    && disclosureBatchEdits.every(e=>['PREVIEW_READY','ACCEPTED'].includes(e.status));
  const disclosureBatchAccepted=disclosureBatchComplete&&disclosureBatchEdits.every(e=>e.status==='ACCEPTED');
  const disclosureBatchCounts=disclosureBatchEdits.reduce<Record<string,number>>((counts,e)=>{
    counts[e.status]=(counts[e.status]??0)+1;return counts;
  },{});
  const textWidth=disclosureMethod==='SVG'
    ?Math.max(120,Math.min(300,Array.from(text.trim()).length*20+40))
    :Array.from(text).length*32+24;
  const textHeight=disclosureMethod==='SVG'?36:64;
  const textMargin=disclosureMethod==='SVG'?24:32;
  const tx=1086-textMargin-textWidth,ty=1448-textMargin-textHeight;
  const disclosureValid=/^[\p{L}\p{N}_-]{1,12}$/u.test(text.trim());
  function targetPoint(event:ReactPointerEvent<HTMLDivElement>) {
    const box=event.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1085,Math.round((event.clientX-box.left)*1086/box.width))),
      y:Math.max(0,Math.min(1447,Math.round((event.clientY-box.top)*1448/box.height)))};
  }
  function startTargetSelection(event:ReactPointerEvent<HTMLDivElement>) {
    if(event.button!==0)return;
    if(tab==='PROMPT'){
      setPromptTarget(targetPoint(event));setError('');setPreviewMode('SOURCE');
      return;
    }
    if(tab!=='ENTITY')return;
    if(targetSelectionFrame.current!==null){window.cancelAnimationFrame(targetSelectionFrame.current);targetSelectionFrame.current=null;}
    pendingTargetRegion.current=null;
    const point=targetPoint(event);targetDragStart.current=point;setTargetRegion(null);setError('');
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveTargetSelection(event:ReactPointerEvent<HTMLDivElement>) {
    const start=targetDragStart.current;if(tab!=='ENTITY'||!start)return;
    pendingTargetRegion.current=regionBetween(start,targetPoint(event));
    if(targetSelectionFrame.current!==null)return;
    targetSelectionFrame.current=window.requestAnimationFrame(()=>{
      targetSelectionFrame.current=null;
      if(pendingTargetRegion.current)setTargetRegion(pendingTargetRegion.current);
      pendingTargetRegion.current=null;
    });
  }
  function finishTargetSelection(event:ReactPointerEvent<HTMLDivElement>) {
    const start=targetDragStart.current;if(!start)return;
    const region=regionBetween(start,targetPoint(event));
    targetDragStart.current=null;
    pendingTargetRegion.current=null;
    if(targetSelectionFrame.current!==null){window.cancelAnimationFrame(targetSelectionFrame.current);targetSelectionFrame.current=null;}
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    if(region.width>=24&&region.height>=24){setTargetRegion(region);return;}
    setTargetRegion(null);setError('目标框选区域过小，请完整框住一个物品并保留少量周边。');
  }
  async function runHistoryAction(e:Edit,action:EditAction) {
    const actionLabel=historyActionLabel(e,action);
    if(!reason.trim()){setNotice('');setError(`请先填写“操作原因”，再${actionLabel}。`);return;}
    if(action==='cancel'&&!await confirm({
      title:'直接删除此修复？',
      description:`这条${labels[e.status]??e.status}的图片修复将被取消。${['QUEUED','RUNNING'].includes(e.status)?'正在排队或执行的重试会立即停止。':''}后台仍保留取消记录用于审计。`,
      confirmLabel:'确认直接删除',tone:'danger',
    }))return;
    if(action==='accept'&&isRejectedPreview(e)&&!await confirm({
      title:'仍采用未通过验收的结果？',
      description:'此结果未通过自动验收。采用后会进入正式图集，系统会保留本次人工决定和原因。',
      confirmLabel:'仍然采用',tone:'danger',
    }))return;
    const targetedRepair=action==='retry'?localRepairRecommendation(e):null;
    const needsConfirmation=['queue','retry','apply-suggestion'].includes(action)&&(e.operation==='TEXT'||e.operation.startsWith('AI_'))
      &&(e.config.confirmation!=='LIVE_IMAGE_COST_ACCEPTED'||Boolean(targetedRepair));
    const costConfirmed=targetedRepair?historyCostConfirmed:confirmed;
    if(needsConfirmation&&!costConfirmed){setNotice('');setError(`“${actionLabel}”会调用图片编辑或视觉校验模型，请先勾选费用确认。`);return;}
    const request=act(()=>post(`/v1/image-edits/${e.id}/${action}`,{requestId:createRequestId(),version:e.version,reason,
      confirmation:costConfirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,
      ...(targetedRepair?{useRejectedPreview:true}:{}),
      ...(action==='accept'&&isRejectedPreview(e)?{acceptRejectedResult:true}:{})}),`正在${actionLabel}…`,`${actionLabel}操作已完成。`);
    setPendingHistoryAction(null);setHistoryCostConfirmed(false);setReason('');return request;
  }
  async function acceptDisclosureBatch() {
    if(!reason.trim()){setNotice('');setError('请先填写“操作原因”，再采用整套标识预览。');return;}
    if(!disclosureBatchReady||disclosureBatchAccepted){setNotice('');setError('请等待整套标识预览全部校验通过后再采用。');return;}
    const pending=disclosureBatchEdits.filter(e=>e.status==='PREVIEW_READY');
    setBusy(true);setError('');setNotice(`正在采用整套标识 0 / ${pending.length}…`);
    let accepted=0;
    try {
      for(const edit of pending) {
        await post(`/v1/image-edits/${edit.id}/accept`,{requestId:createRequestId(),version:edit.version,reason});
        accepted+=1;setNotice(`正在采用整套标识 ${accepted} / ${pending.length}…`);
      }
      await refresh();await onChanged();setNotice(`整套 ${imageAssets.length} 张标识已采用，请重新完成图片审核。`);
    } catch(e) {
      try {await refresh();await onChanged();} catch {}
      setNotice('');setError(`已采用 ${accepted} / ${pending.length} 张；${e instanceof Error?e.message:'剩余图片采用失败，可再次点击继续。'}`);
    } finally {setBusy(false);setPendingBatchAccept(false);setReason('');}
  }
  return <>
    <Button className="current-image-editor-trigger" type="button" onClick={()=>setOpen(true)}>修改图片</Button>
    <Dialog open={open} onOpenChange={setOpen}><DialogContent className={styles.dialog} overlayClassName={styles.overlay}>
      <header className={styles.header}>
        <div><DialogTitle className={styles.title}>当前图片修改工作台 · 第 {page} 页</DialogTitle>
        <DialogDescription className={styles.description}>预览保持常驻；编辑、恢复和任务记录分区呈现。</DialogDescription></div>
        <span className={styles.pageCount}>{page} / {imageAssets.length}</span>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="图片修改方式">{[['TEXT','添加文字'],['ENTITY','实体替换'],['PROMPT','局部修改']].map(([key,label])=><Button unstyled className={styles.tab} type="button" key={key} role="tab" aria-selected={tab===key} onClick={()=>{setTab(key);setConfirmed(false);setError('');setNotice('');setPreviewMode('SOURCE');showPanel('EDIT');}}>{label}</Button>)}</div>
      <div className={styles.mobileViewTabs} role="tablist" aria-label="移动端工作区">
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='PREVIEW'} onClick={()=>setMobileView('PREVIEW')}>预览</Button>
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='EDIT'} onClick={()=>showPanel('EDIT')}>编辑</Button>
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='HISTORY'} onClick={()=>showPanel('HISTORY')}>记录 {pageEdits.length||''}</Button>
      </div>
      <div className={styles.body}>
        {(error||notice)&&<p className={`${styles.feedback} ${error?styles.feedbackError:''}`} role={error?'alert':'status'}>{error||notice}</p>}
        <div className={styles.workspace} data-mobile-view={mobileView.toLowerCase()}>
          <section className={styles.previewPanel} aria-label="图片预览">
            <div className={styles.previewHeader}>
              <div className={styles.previewToolbar} role="group" aria-label="预览模式">
                <Button unstyled type="button" aria-pressed={previewMode==='SOURCE'} onClick={()=>setPreviewMode('SOURCE')}>当前图</Button>
                <Button unstyled type="button" disabled={!latest?.result} aria-pressed={previewMode==='RESULT'} onClick={()=>setPreviewMode('RESULT')}>{latestRejected?'失败结果':'修改预览'}</Button>
                <Button unstyled type="button" disabled={!latest?.result} aria-pressed={previewMode==='COMPARE'} onClick={()=>setPreviewMode('COMPARE')}>前后对比</Button>
              </div>
              {latestRejected&&<div className={styles.rejectedPreviewNotice} role="alert"><strong>自动验收未通过</strong><span>{latest?.status==='ACCEPTED'?'该结果已由用户明确采用，审计记录已保留。':'结果已保留，可检查后自行决定采用或重试。'}</span></div>}
            </div>
            <div className={styles.previewViewport}>
              {(previewMode==='SOURCE'||!latest?.result)&&<div className={`${styles.previewCanvas} ${['ENTITY','PROMPT'].includes(tab)?styles.targetCanvas:''}`} role="img" aria-label="实时修改预览" style={{width:`${zoom*100}%`}}
                onPointerDown={startTargetSelection} onPointerMove={moveTargetSelection} onPointerUp={finishTargetSelection} onPointerCancel={finishTargetSelection}>
                <PreviewSourceImage src={path(asset.url)}/>
                <svg className={styles.previewOverlay} aria-hidden="true" viewBox="0 0 1086 1448">
                   {tab==='TEXT'&&(disclosureMethod==='SVG'
                     ?<g><rect x={tx+0.75} y={ty+0.75} width={textWidth-1.5} height={textHeight-1.5} rx="18" fill="none" stroke="#68744A" strokeWidth="1.5"/><text x={tx+textWidth/2} y={ty+textHeight/2} textAnchor="middle" dominantBaseline="central" fill="#68744A" fontSize="20" fontWeight="600" fontFamily="Microsoft YaHei,Noto Sans CJK SC,sans-serif">{text}</text></g>
                     :<g><rect x={tx} y={ty} width={textWidth} height={textHeight} rx="8" fill="#111827"/><text x={tx+textWidth/2} y={ty+40} textAnchor="middle" fill="#ffffff" fontSize="32" fontWeight="500" fontFamily="Noto Sans CJK SC,Microsoft YaHei,sans-serif">{text}</text></g>)}
                   {tab==='ENTITY'&&targetRegion&&<rect className={styles.targetSelection} x={targetRegion.x} y={targetRegion.y} width={targetRegion.width} height={targetRegion.height}/>}
                   {tab==='PROMPT'&&panel==='HISTORY'&&suggestedPlan?.editRegions.map((region,index)=><rect key={index} className={styles.suggestionSelection} x={region.x} y={region.y} width={region.width} height={region.height}/>)}
                   {tab==='PROMPT'&&promptTarget&&<circle className={styles.promptTarget} cx={promptTarget.x} cy={promptTarget.y} r="54"/>}
                </svg>
              </div>}
              {previewMode==='RESULT'&&latest?.result&&<div className={styles.previewCanvas} role="img" aria-label="修改结果预览" style={{width:`${zoom*100}%`}}><img className={styles.previewImage} src={path(`/v1/assets/${latest.result.asset_id}`)} alt=""/></div>}
              {previewMode==='COMPARE'&&latest?.result&&<div className={styles.previewCanvas} role="img" aria-label="修改前后对比画面" style={{width:`${zoom*100}%`}}><img className={styles.previewImage} src={path(`/v1/assets/${latest.source_asset_id??asset.id}`)} alt=""/><img className={styles.previewImage} src={path(`/v1/assets/${latest.result.asset_id}`)} alt="" style={{clipPath:`inset(0 ${100-compare}% 0 0)`}}/></div>}
            </div>
            {previewMode==='COMPARE'&&latest?.result?<section className={styles.inlineComparison} aria-label="修改前后对比"><div><h3>修改前后滑动对比</h3><span>第 {latest.target_page} 页 · {labels[latest.operation]}{latestRejected?' · 自动验收未通过':''}</span></div><input aria-label="修改前后对比滑块" type="range" min="0" max="100" value={compare} onChange={e=>setCompare(Number(e.target.value))}/></section>:<label className={styles.zoomControl}><span>预览缩放</span><input aria-label="预览缩放" type="range" min="1" max="3" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><strong>{Math.round(zoom*100)}%</strong></label>}
            <p className={styles.help}>{tab==='TEXT'?(disclosureMethod==='SVG'?'左侧预览程序标识的描边胶囊样式；提交后由 SVG + Sharp 确定性合成。':'左侧是模型标识的统一目标样式示意；提交后由图片编辑模型融合绘制。'):tab==='ENTITY'?'在原图上拖动框住一个目标物品并保留少量周边。':promptTarget?`已标记${pointLocation(promptTarget)}附近；右侧只需补充怎么修改。`:'可直接点击图片中的目标以自动补充位置，也可以完整输入自然语言说明。'}</p>
          </section>

          <section className={styles.controlPanel} aria-label="图片修改控制">
            <div className={styles.panelTabs} role="tablist" aria-label="编辑与任务记录">
              <Button unstyled type="button" role="tab" aria-selected={panel==='EDIT'} onClick={()=>showPanel('EDIT')}>本次编辑</Button>
              <Button unstyled type="button" role="tab" aria-selected={panel==='HISTORY'} onClick={()=>showPanel('HISTORY')}>任务记录{pageEdits.length?` · ${pageEdits.length}`:''}</Button>
            </div>
            {panel==='EDIT'?<>
              <section className={styles.panelBody} aria-label="本次编辑"><section className={styles.settings} aria-label="图片修改设置">
                {tab==='TEXT'&&<>
                  <div className={styles.scopeSelector} aria-label="标识生成方式"><span>生成方式</span><div role="group" aria-label="选择标识生成方式"><Button unstyled type="button" aria-pressed={disclosureMethod==='SVG'} onClick={()=>{setDisclosureMethod('SVG');setConfirmed(false);setError('');}}>程序叠加（SVG + Sharp）</Button><Button unstyled type="button" aria-pressed={disclosureMethod==='MODEL'} onClick={()=>{setDisclosureMethod('MODEL');setConfirmed(false);setError('');}}>图片模型融合</Button></div><small>{disclosureMethod==='SVG'?'使用现有规范的描边胶囊标识，程序确定性叠加，不调用图片编辑或视觉模型。':'保留现有方式，由图片编辑模型将深色底标识融合进画面，并使用视觉模型验收。'}</small></div>
                  <label>人工生成标识文字<input aria-label="人工生成标识文字" value={text} maxLength={12} pattern="[\p{L}\p{N}_-]+" onChange={e=>setText(e.target.value)}/><small>最多 12 个字符，仅限文字、数字、下划线或短横线。</small></label>
                  {imageAssets.length>1&&<div className={styles.scopeSelector} aria-label="标识应用范围"><span>应用范围</span><div role="group" aria-label="选择标识应用范围"><Button unstyled type="button" aria-pressed={textScope==='CURRENT'} onClick={()=>setTextScope('CURRENT')}>仅第 {page} 页</Button><Button unstyled type="button" aria-pressed={textScope==='ALL'} onClick={()=>setTextScope('ALL')}>整套 {imageAssets.length} 张</Button></div><small>{textScope==='ALL'?'同一标识会逐张生成并保持统一方式。':disclosureMethod==='SVG'?'只为当前页创建一张程序叠加标识预览。':'只为当前页创建一张模型绘制标识预览。'}</small></div>}
                  <div className={styles.recentDisclosureTexts} aria-label="最近常用标识文字"><span>最近常用</span>{recentDisclosureTexts.length?<div>{recentDisclosureTexts.map(item=><Button unstyled className={styles.recentDisclosureButton} type="button" key={item} aria-pressed={text===item} onClick={()=>setText(item)}>{item}</Button>)}</div>:<small>成功提交后会在这里保留最近使用的 5 条。</small>}</div>
                  <p>{disclosureMethod==='SVG'?'系统会固定标识位置、尺寸与转义后的文字，并逐像素确认标识区域外没有变化。':'系统会校验文字准确性、可读性和重复标识；失败时不会自动二次修改。'}</p>
                </>}
                {tab==='ENTITY'&&<><div className={styles.referenceUpload}><div className={styles.referenceUploadHeading}><strong>上传真实产品图片</strong><p>使用参考图中的真实产品替换左侧框选的一个物品。</p></div><label className={styles.filePicker} data-disabled={busy||undefined}><input className={styles.fileInput} aria-label="上传真实产品参考图" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>void upload(e.target.files)}/><span className={styles.filePickerIcon}><UploadCloud aria-hidden="true" size={26} strokeWidth={1.8}/></span><span className={styles.filePickerCopy}><strong>{refs.length?'更换产品图片':'点击选择产品图片'}</strong><small>也可以将图片拖放到这里</small></span><span className={styles.filePickerMeta}>PNG / JPG / WebP · 最大 5 MB</span></label>{refs.map(r=><div className={styles.referenceCard} key={r.id}><img src={path(r.url)} alt="已上传的真实产品参考图"/><span>真实产品参考图已就绪</span><Button variant="outline" size="sm" type="button" onClick={()=>setRefs([])}>移除</Button></div>)}</div><label>参考图使用方式<select aria-label="参考图使用方式" value={referenceMode} onChange={e=>setReferenceMode(e.target.value as ReferenceMode)}><option value="STRICT">完整产品（严格模式）</option><option value="APPEARANCE">外观参考（允许手部、裁切或次要产品）</option></select><small>{referenceMode==='APPEARANCE'?'只迁移主产品可确认的外观，缺失部分沿用源图结构补全。':'要求参考图中只有一个清楚、完整、遮挡很少的产品。'}</small></label><label>目标物品说明<textarea aria-label="目标物品说明" value={targetDescription} maxLength={500} placeholder="例如：画面右侧台面上、木托盘后方的米白色拿铁杯" onChange={e=>setTargetDescription(e.target.value)}/><small>同时写清颜色或相邻物体，避免多个同类物品时选错。</small></label><div className={styles.targetSelectionInfo} role="status"><span>{targetRegion?`已框选：x ${targetRegion.x}，y ${targetRegion.y}，宽 ${targetRegion.width}，高 ${targetRegion.height}`:'尚未框选目标。请在左侧原图上拖动。'}</span>{targetRegion&&<Button variant="outline" size="sm" type="button" onClick={()=>setTargetRegion(null)}>重新框选</Button>}</div><p>视觉预检会先确认框内目标唯一；不明确时不会调用图片编辑模型。</p></>}
                {tab==='PROMPT'&&<>
                  <div className={styles.promptStep}><div className={styles.stepHeading}><strong>1. 选择修改目标</strong><span>减少位置描述</span></div><div className={styles.targetSelectionInfo} role="status"><span>{promptTarget?`已定位：${pointLocation(promptTarget)}附近`:'可在左侧图片点击要修改的目标，也可跳过并在说明中写位置。'}</span>{promptTarget&&<Button variant="outline" size="sm" type="button" onClick={()=>setPromptTarget(null)}>清除定位</Button>}</div></div>
                  <div className={styles.promptStep}><div className={styles.stepHeading}><strong>2. 选择修改动作</strong><span>可选</span></div><div className={styles.promptActions} role="group" aria-label="局部修改动作">{promptActions.map(action=><Button unstyled type="button" key={action} aria-pressed={promptAction===action} onClick={()=>setPromptAction(current=>current===action?'':action)}>{action.replace('物体','')}</Button>)}</div></div>
                  <label>补充要求<textarea aria-label="图片修改要求" value={instruction} maxLength={2000} placeholder={promptTarget?'例如：改成鼠尾草绿色，保持材质和光影不变':'例如：把画面左下角人物手中的黑色书包替换成手提文件袋'} onChange={e=>setInstruction(e.target.value)}/><small>{promptTarget?'位置已自动加入请求，只需描述修改结果。':'请同时描述位置和修改内容。'}</small></label>
                  <div className={styles.quickRequirements} aria-label="快捷补充要求">{quickRequirements.map(item=><Button unstyled type="button" key={item} onClick={()=>appendRequirement(item)}>＋ {item}</Button>)}</div>
                  <p>系统会先结合原图规划源位置、目标位置和安全编辑区域。原说明需要补强时，会先给出可采用的描述，不会提前调用图片编辑模型。</p>
                 </>}
                {usesBillableModel?<label className={styles.feeConfirmation}><input className={styles.feeCheckboxInput} type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span className={styles.feeCheckboxVisual} data-fee-checkbox aria-hidden="true"/><span>确认调用视觉规划、图片编辑与结果验收模型，会产生费用；规划需要改写时会先返回建议，采用后才调用图片编辑模型。</span></label>:<p>本次使用本地 SVG + Sharp 合成，不调用图片编辑或视觉模型，无需费用确认。</p>}
              </section></section>
              <footer className={styles.actionBar}><span>{usesBillableModel?'保存草稿不会调用模型':'程序标识不调用模型'}</span><div>{!(tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1)&&<Button variant="outline" disabled={busy} onClick={()=>void submit(true)}>{busy?'处理中…':'保存草稿'}</Button>}<Button disabled={busy} onClick={()=>void (tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1?submitDisclosureBatch():submit())}>{busy?'处理中…':tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1?`生成整套 ${imageAssets.length} 张${disclosureMethod==='SVG'?'程序':'模型'}标识预览`:tab==='TEXT'?`生成${disclosureMethod==='SVG'?'程序':'模型'}标识预览`:tab==='PROMPT'?'分析并生成修改预览':'生成修改预览'}</Button></div></footer>
            </>:<section className={styles.panelBody} aria-label="任务记录">
              <section className={styles.restorePanel} aria-label="历史图片版本"><div><strong>历史图片版本</strong><span>恢复入口与任务记录集中管理</span></div><select aria-label="历史图片版本" value={history} onChange={e=>setHistory(e.target.value)}><option value="">选择要恢复的图集</option>{runs.filter(r=>r.id!==runId).map(r=><option key={r.id} value={r.id}>{labels[r.result?.processing?.type??'']??'原始生成'} · {r.id.slice(0,8)}</option>)}</select><Button variant="outline" disabled={!history||busy} onClick={()=>void act(()=>post(`/v1/tasks/${taskId}/image-versions/${history}/restore`,{...base(),instruction:'恢复历史图片版本'}),'正在创建恢复预览…','恢复预览请求已提交。')}>生成恢复预览</Button></section>
              {!!disclosureBatchId&&disclosureBatchEdits.length>0&&<section className={styles.batchStatus} aria-label="整套标识批次状态"><div><h3>最近整套标识批次</h3><p>{disclosureBatchComplete?`共 ${imageAssets.length} 张，全部预览就绪后可一次采用。`:`已创建 ${disclosureBatchEdits.length} / ${imageAssets.length} 张请求，批次不完整。`}</p></div><div className={styles.batchCounts}>{Object.entries(disclosureBatchCounts).map(([status,count])=><span key={status}>{labels[status]??status} {count}</span>)}</div><Button disabled={busy||!disclosureBatchReady||disclosureBatchAccepted} onClick={()=>{setReason('');setPendingHistoryAction(null);setPendingBatchAccept(true);}}>{disclosureBatchAccepted?'整套标识已采用':disclosureBatchReady?'一次采用整套标识':'等待全部预览就绪'}</Button>{pendingBatchAccept&&<form className={styles.reasonEditor} onSubmit={event=>{event.preventDefault();void acceptDisclosureBatch();}}><label>采用整套标识的原因<input aria-label="整套标识采用原因" value={reason} maxLength={1000} autoFocus onChange={e=>setReason(e.target.value)}/></label><div className={styles.quickReasons}>{quickReasons.slice(0,2).map(item=><Button variant="outline" size="sm" type="button" key={item} onClick={()=>setReason(item)}>{item}</Button>)}</div><div className={styles.reasonActions}><Button variant="outline" type="button" onClick={()=>{setPendingBatchAccept(false);setReason('');}}>取消</Button><Button type="submit" disabled={busy}>确认采用</Button></div></form>}</section>}
              <div className={styles.historyHeading}><strong>当前页任务记录</strong><span>失败详情默认收起</span></div>
              {pageEdits.length?<ul className={styles.history} aria-label="图片修改记录">{pageEdits.map(e=>{
                const suggestion=localSuggestion(e);
                const rejectedPreview=isRejectedPreview(e),repairRecommendation=localRepairRecommendation(e);
                return <li key={e.id}><div className={styles.historyTitle}><strong>{labels[e.operation]} · {suggestion?'待确认建议':rejectedPreview?(e.status==='ACCEPTED'?'已人工采用 · 自动验收未通过':'验收未通过 · 结果已保留'):labels[e.status]}</strong><span>第 {e.target_page} 页 · {e.created_by} · 已执行 {e.attempts??0} 次</span></div><p className={styles.historySummary}>{e.config.instruction}</p>
                  {suggestion&&<section className={styles.suggestionCard} aria-label="局部修改建议"><strong>系统已生成可执行描述</strong>{suggestion.reason&&<p>{suggestion.reason}</p>}<blockquote>{suggestion.suggestedInstruction}</blockquote><span>{suggestion.editRegions.length} 个安全编辑区域 · {suggestion.touchesImageEdge?'目标贴近画面边缘，可按可见部分处理':'目标完整位于画面内'}</span></section>}
                  {rejectedPreview&&<section className={styles.rejectedResultCard} aria-label="自动验收未通过的结果"><strong>图片已生成，但没有完整完成任务</strong><p>{failedPreviewReason(e)}</p>{repairRecommendation?<><span>系统可以上一张失败图为起点，仅处理以下未完成部分：</span><blockquote>{repairRecommendation.repairInstruction}</blockquote><span>定向修复会再次调用图片模型并产生费用，只有确认后才会执行；修复结果仍由你决定是否采用。</span></>:<span>这是一张可查看的失败预览。当前问题不适合安全局部补救，你可以仍然采用，也可以调整说明后从原图重试；重试可能再次产生模型费用。</span>}</section>}
                  {e.error&&<details><summary>查看失败原因</summary><p role="alert">{e.error}</p></details>}
                  <div className={styles.historyActions}>{e.operation==='AI_LOCAL'&&<Button variant="outline" size="sm" onClick={()=>reuseInstruction(e)}>复用说明并修改</Button>}{e.result&&<><Button size="sm" onClick={()=>{setComparisonId(e.id);setPreviewMode('COMPARE');setMobileView('PREVIEW');}}>在左侧对比</Button><a href={path(`/v1/assets/${e.result.asset_id}`)} target="_blank" rel="noreferrer">打开结果</a></>}{historyActions(e).map(action=><Button key={action} size="sm" variant={action==='cancel'?'outline':undefined} className={action==='cancel'?styles.deleteAction:undefined} disabled={busy} onClick={()=>{setReason('');setHistoryCostConfirmed(false);setPendingBatchAccept(false);setPendingHistoryAction({editId:e.id,action});}}>{historyActionLabel(e,action)}</Button>)}</div>
                  {!!(e.result?.validation??e.validation)&&<details><summary>质量校验记录</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(e.result?.validation??e.validation,null,2)}</pre></details>}
                  {!!e.events?.length&&<details><summary>操作审计</summary><ul>{e.events.map((event,index)=><li key={index}>{event.actor} · {event.action} · {event.reason}</li>)}</ul></details>}
                  {pendingHistoryAction?.editId===e.id&&<form className={styles.reasonEditor} onSubmit={event=>{event.preventDefault();void runHistoryAction(e,pendingHistoryAction.action);}}><label>{historyActionLabel(e,pendingHistoryAction.action)}的操作原因<input aria-label={`${historyActionLabel(e,pendingHistoryAction.action)}操作原因`} value={reason} maxLength={1000} autoFocus onChange={event=>setReason(event.target.value)}/></label>{pendingHistoryAction.action==='retry'&&repairRecommendation&&<label className={styles.feeConfirmation}><input type="checkbox" checked={historyCostConfirmed} onChange={event=>setHistoryCostConfirmed(event.target.checked)}/><span>确认本次定向修复会再次调用图片模型并产生费用</span></label>}<div className={styles.quickReasons}>{quickReasons.map(item=><Button variant="outline" size="sm" type="button" key={item} onClick={()=>setReason(item)}>{item}</Button>)}</div><div className={styles.reasonActions}><Button variant="outline" type="button" onClick={()=>{setPendingHistoryAction(null);setHistoryCostConfirmed(false);setReason('');}}>取消</Button><Button type="submit" disabled={busy}>确认{historyActionLabel(e,pendingHistoryAction.action)}</Button></div></form>}
                </li>;
              })}</ul>:<p className={styles.emptyHistory}>当前还没有图片修改记录。</p>}
            </section>}
          </section>
        </div>
      </div>
    </DialogContent></Dialog>
  </>;
}
