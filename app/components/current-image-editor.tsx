'use client';

import { memo, useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Radio, Slider, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog';
import { UploadCloud, X } from 'lucide-react';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';
import { useBackgroundTasks } from './background-tasks';
import { isBackgroundTaskRunning } from './background-task-store';
import { localEditAlternatives } from '../../src/local-edit-alternatives.mjs';
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
type TargetMode = 'SINGLE' | 'ALL_MATCHES';
type ProductTarget = { description:string; region:TargetRegion|null; targetMode:TargetMode };
type ProductReplacement = { key:string; reference:Ref|null; referenceMode:ReferenceMode; targets:Record<number,ProductTarget> };
type TextScope = 'CURRENT' | 'ALL';
type DisclosureMethod = 'SVG' | 'MODEL';
type EditAction = 'accept' | 'reject' | 'cancel' | 'retry' | 'queue' | 'apply-suggestion';
type WorkspacePanel = 'EDIT' | 'HISTORY';
type MobileView = 'PREVIEW' | WorkspacePanel;
type PreviewMode = 'SOURCE' | 'RESULT' | 'COMPARE';
type PromptAction = '' | '改颜色' | '替换物体' | '删除物体' | '修复瑕疵';
type LocalSuggestion = { stage:'LOCAL_EDIT_SUGGESTION'; decision:'SUGGEST'; canEdit:true; suggestedInstruction:string; reason:string; operationType:string; touchesImageEdge:boolean; editRegions:TargetRegion[] };
type LocalRepairRecommendation = { repairableFromRejected:true; repairInstruction:string; failureCodes:string[]; repairRegions:TargetRegion[]; repairAttempt:number; repairMaxAttempts:number };
type Edit = { id: string; version: number; attempts:number; status: string; operation: string; source_asset_id?:number; target_page:number; created_by:string; validation?:unknown; events?:Array<{action:string;actor:string;reason:string}>; error: string | null; config: {instruction:string;confirmation?:string|null;batchId?:string|null;batchSize?:number|null}; result?: {asset_id: number; image_run_id: string; validation: unknown} };
const labels: Record<string,string> = {DRAFT:'草稿',QUEUED:'排队中',RUNNING:'执行与校验中',PREVIEW_READY:'预览待确认',ACCEPTED:'已采用',REJECTED:'已拒绝',FAILED:'失败',CANCELLED:'已取消',SVG_DISCLOSURE:'程序生成标识',TEXT:'模型生成标识',COMPOSITE:'实体合成（历史）',AI_FUSION:'真实产品替换',AI_LOCAL:'局部修改',AI_FULL:'整图修改（历史）',RESTORE:'恢复版本',REGENERATE:'重新生成',REPROCESS:'格式处理'};
const actionLabels: Record<EditAction,string> = {accept:'采用此版本',reject:'拒绝',cancel:'直接删除此修复',retry:'重试（AI 可能再次收费）',queue:'提交草稿','apply-suggestion':'采用建议并修改'};
const promptActions: PromptAction[] = ['改颜色','替换物体','删除物体','修复瑕疵'];
const quickRequirements = ['保持材质','保持光影','不改文字'];
const quickReasons = ['预览符合要求','定位或内容有误','调整说明后重试','不再需要此修复'];
const NOTICE_DURATION_MS=2_500;
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
    if(localEditAlternatives(edit).length)return ['apply-suggestion','cancel'];
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
function imageEditPreflightWarnings(edit:Edit) {
  const value=edit.result?.validation??edit.validation;
  if(!value||typeof value!=='object'||Array.isArray(value))return [];
  const root=value as Record<string,unknown>,warnings:string[]=[];
  const record=(item:unknown)=>item&&typeof item==='object'&&!Array.isArray(item)?item as Record<string,unknown>:null;
  const addList=(item:unknown)=>{if(Array.isArray(item))for(const warning of item)if(typeof warning==='string'&&warning.trim())warnings.push(warning.trim());};
  const collect=(item:unknown)=>{
    const check=record(item);if(!check)return;
    addList(check.warnings);addList(check.referenceWarnings);
    if((check.advisory===true||check.passed===false)&&typeof check.reason==='string'&&check.reason.trim())warnings.push(check.reason.trim());
  };
  const source=record(root.sourcePreflight);
  collect(source);
  const localization=record(root.localization);
  collect(localization);
  const replacements=localization?.replacements;
  if(Array.isArray(replacements))for(const replacement of replacements)collect(replacement);
  const stage=typeof root.stage==='string'?root.stage:'';
  if(['TARGET_LOCALIZATION','REFERENCE_QUALITY'].includes(stage))collect(root);
  if(stage==='SOURCE') {
    const checks=Array.isArray(root.checks)?root.checks:[];
    const last=record(checks.at(-1));
    addList(last?.contradictions);
    if(typeof last?.repairInstruction==='string'&&last.repairInstruction.trim())warnings.push(last.repairInstruction.trim());
    const missing=last?.missing,uncertain=last?.uncertain;
    if(Array.isArray(missing)&&missing.length)warnings.push(`源图必需内容未确认：${missing.join('、')}`);
    if(Array.isArray(uncertain)&&uncertain.length)warnings.push(`源图文字可读性仍不确定：${uncertain.join('、')}`);
    if(!warnings.length)warnings.push('源图视觉预检未能完全确认。');
  }
  if(!warnings.length&&edit.error?.includes('真实产品替换前置检查未通过'))warnings.push(edit.error.split('：').at(-1)??edit.error);
  return [...new Set(warnings)].slice(0,10);
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
const newReplacement=(index:number,page:number):ProductReplacement=>({key:`product-${index}`,reference:null,referenceMode:'APPEARANCE',targets:{[page]:{description:'',region:null,targetMode:'SINGLE'}}});
export function CurrentImageEditor({taskId,runId,copyRevisionId,asset,assets,page,runs,onChanged}: {
  taskId:number;runId:string;copyRevisionId:number;asset:Asset;assets?:Asset[];page:number;
  runs:Array<{id:string;result:{processing?:{type:string}}|null}>;onChanged:()=>Promise<void>;
}) {
  const confirm=useConfirmDialog();
  const {tasks:backgroundTasks,store:backgroundStore}=useBackgroundTasks();
  const [open,setOpen]=useState(false),[tab,setTab]=useState('TEXT');
  const [text,setText]=useState(DEFAULT_DISCLOSURE_TEXT);
  const [textScope,setTextScope]=useState<TextScope>('CURRENT');
  const [disclosureMethod,setDisclosureMethod]=useState<DisclosureMethod>('MODEL');
  const [activeBatchId,setActiveBatchId]=useState('');
  const [recentDisclosureTexts,setRecentDisclosureTexts]=useState<string[]>([]);
  const [instruction,setInstruction]=useState('');
  const [replacements,setReplacements]=useState<ProductReplacement[]>(()=>[newReplacement(1,page)]);
  const [activeReplacementKey,setActiveReplacementKey]=useState('product-1');
  const [entityPage,setEntityPage]=useState(page);
  const [panel,setPanel]=useState<WorkspacePanel>('EDIT');
  const [mobileView,setMobileView]=useState<MobileView>('PREVIEW');
  const [previewMode,setPreviewMode]=useState<PreviewMode>('SOURCE');
  const [promptAction,setPromptAction]=useState<PromptAction>('');
  const [promptTarget,setPromptTarget]=useState<{x:number;y:number}|null>(null);
  const [pendingHistoryAction,setPendingHistoryAction]=useState<{editId:string;action:EditAction}|null>(null);
  const [selectedAlternatives,setSelectedAlternatives]=useState<Record<string,string>>({});
  const [pendingBatchAccept,setPendingBatchAccept]=useState(false);
  const targetDragStart=useRef<{x:number;y:number}|null>(null);
  const pendingTargetRegion=useRef<TargetRegion|null>(null);
  const targetSelectionFrame=useRef<number|null>(null);
  const [confirmed,setConfirmed]=useState(false),[historyCostConfirmed,setHistoryCostConfirmed]=useState(false),[edits,setEdits]=useState<Edit[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[compare,setCompare]=useState(50),[zoom,setZoom]=useState(1),[history,setHistory]=useState(''),[reason,setReason]=useState('');
  const [comparisonId,setComparisonId]=useState('');
  const imageAssets=assets?.length?assets:[asset];
  const activeReplacement=replacements.find(item=>item.key===activeReplacementKey)??replacements[0];
  const activeTarget=activeReplacement?.targets[entityPage]??null;
  const targetDescription=activeTarget?.description??'';
  const targetRegion=activeTarget?.region??null;
  const targetMode=activeTarget?.targetMode??'SINGLE';
  const referenceMode=activeReplacement?.referenceMode??'APPEARANCE';
  const displayPage=tab==='ENTITY'?entityPage:page;
  const displayAsset=imageAssets[displayPage-1]??asset;
  const entityPages=[...new Set(replacements.flatMap(item=>Object.keys(item.targets).map(Number)))].sort((a,b)=>a-b);
  function updateReplacement(key:string,update:(current:ProductReplacement)=>ProductReplacement) {
    setReplacements(current=>current.map(item=>item.key===key?update(item):item));
  }
  function updateActiveTarget(update:(current:ProductTarget)=>ProductTarget) {
    if(!activeReplacement||!activeTarget)return;
    updateReplacement(activeReplacement.key,current=>({...current,targets:{...current.targets,[entityPage]:update(current.targets[entityPage])}}));
  }
  function setTargetDescription(value:string) {updateActiveTarget(current=>({...current,description:value}));}
  function setTargetRegion(value:TargetRegion|null) {updateActiveTarget(current=>({...current,region:value}));}
  function setTargetMode(value:TargetMode) {updateActiveTarget(current=>({...current,targetMode:value,region:null}));}
  function setReferenceMode(value:ReferenceMode) {if(activeReplacement)updateReplacement(activeReplacement.key,current=>({...current,referenceMode:value}));}
  const refresh=useCallback(async()=>{
    const items=await apiRequest<Edit[]>(path(`/v1/tasks/${taskId}/image-edits`));
    setEdits(items);
    for(const edit of items)if(isBackgroundTaskRunning(edit))backgroundStore?.track({id:edit.id,kind:'IMAGE_EDIT',taskId,page:edit.target_page,status:edit.status});
  },[backgroundStore,taskId]);
  useEffect(()=>{if(!open)return;let active=true;const poll=()=>{if(active)void refresh().catch(e=>setError(e.message));};poll();const timer=setInterval(poll,4000);return()=>{active=false;clearInterval(timer);};},[open,refresh]);
  useEffect(()=>{if(open)setRecentDisclosureTexts(loadRecentDisclosureTexts(window.localStorage));},[open]);
  useEffect(()=>{if(!notice||busy)return;const timer=window.setTimeout(()=>setNotice(''),NOTICE_DURATION_MS);return()=>window.clearTimeout(timer);},[notice,busy]);
  useEffect(()=>()=>{if(targetSelectionFrame.current!==null)window.cancelAnimationFrame(targetSelectionFrame.current);},[]);
  const operation=tab==='TEXT'?(disclosureMethod==='SVG'?'SVG_DISCLOSURE':'TEXT'):tab==='ENTITY'?'AI_FUSION':'AI_LOCAL';
  const usesBillableModel=operation==='TEXT'||operation.startsWith('AI_');
  const promptRequestInstruction=[pointLocation(promptTarget)&&`${pointLocation(promptTarget)}附近`,promptAction,instruction.trim()].filter(Boolean).join('，');
  const requestInstruction=tab==='TEXT'?`${disclosureMethod==='SVG'?'使用 SVG + Sharp 确定性叠加':'使用图片编辑模型融合'}人工生成标识“${text.trim()}”并放在右下角`:
    tab==='ENTITY'?`按每个替换项绑定的参考图和框选区域，替换第 ${displayPage} 页中的 ${replacements.filter(item=>item.targets[displayPage]).length} 个目标，保持场景、人物、构图和全部文字不变`:promptRequestInstruction;
  const preserve=tab==='ENTITY'?'保留原图全部已批准文字、人物、背景、构图、色调和未被替换的物品':'除说明明确点名的目标外，保留原图全部已批准文字、所有未点名区域、人物、构图和色调';
  const negative=tab==='ENTITY'
    ?replacements.some(item=>item.referenceMode==='APPEARANCE')
      ?'不得新增文字；不得把参考图中的手部、背景或次要产品带入结果；不得虚构参考图无法确认的标志、文字或功能结构'
      :'不得新增文字；不得改变参考产品的外形、颜色、标志和关键细节'
    :'不得修改说明之外的区域；除明确要求修改或删除的目标外，不得新增、删除或改写已有文字';
  const disclosureOverlay={text:text.trim(),textType:'AI_DISCLOSURE',size:32,margin:32,opacity:1,color:'#ffffff',background:'#111827',position:'bottom-right',disclosureType:'AI_GENERATED'};
  const base=()=>({requestId:createRequestId(),sourceImageRunId:runId,sourceAssetId:asset.id,copyRevisionId,sha256:asset.sha256,targetPage:page});
  const pageBase=(targetPage:number)=>{const item=imageAssets[targetPage-1];return {requestId:createRequestId(),sourceImageRunId:runId,sourceAssetId:item.id,copyRevisionId,sha256:item.sha256,targetPage};};
  async function trackedPost(url:string,body:unknown) {
    const edit=await post(url,body) as Edit;
    if(edit.status!=='DRAFT')backgroundStore?.track({id:edit.id,kind:'IMAGE_EDIT',taskId,page:edit.target_page,status:edit.status,error:edit.error},true);
    return edit;
  }
  async function act(action:()=>Promise<unknown>,pending='正在处理…',success='操作完成') {setBusy(true);setError('');setNotice(pending);try{await action();await refresh();await onChanged();setNotice(success);}catch(e){setNotice('');setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  function rememberDisclosureText() {
    const current=loadRecentDisclosureTexts(window.localStorage);
    const next=addRecentDisclosureText(current,text);
    setRecentDisclosureTexts(saveRecentDisclosureTexts(window.localStorage,next));
  }
  function requestIssue(draft=false) {
    if(tab==='TEXT'&&!disclosureValid)return '人工生成标识需填写 1～12 个文字、数字、下划线或短横线。';
    if(tab==='ENTITY')for(const [index,replacement] of replacements.entries()) {
      if(!replacement.reference)return `请先上传产品 ${index+1} 的真实参考图。`;
      const targets=Object.entries(replacement.targets);
      if(!targets.length)return `请至少为产品 ${index+1} 选择一张需要替换的图片。`;
      for(const [targetPage,target] of targets) {
        if(!target.description.trim())return `请填写产品 ${index+1} 在第 ${targetPage} 页的目标物品说明。`;
        if(!target.region)return `请在左侧第 ${targetPage} 页框选产品 ${index+1} 要替换的物品。`;
      }
    }
    if(tab==='PROMPT'&&!instruction.trim())return '请先填写局部修改说明，并同时写清修改位置和内容。';
    if(!draft&&usesBillableModel&&!confirmed)return '请先勾选费用确认，再生成修改预览。保存草稿不调用模型，无需勾选。';
    return '';
  }
  function submit(draft=false) {
    const issue=requestIssue(draft);
    if(issue){setNotice('');setError(issue);return;}
    if(tab==='ENTITY')return submitEntity(draft);
    return act(async()=>{
      await trackedPost(`/v1/tasks/${taskId}/image-edits`,{...base(),operation,instruction:requestInstruction,preserve,negative,
      ...(isDisclosureOperation(operation)?{overlay:disclosureOverlay}:{}),
      references:[],
      confirmation:usesBillableModel&&confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft});
      if(isDisclosureOperation(operation))rememberDisclosureText();
    },draft?'正在保存草稿…':'正在提交修改预览…',draft?'草稿已保存。':'修改请求已提交，可关闭窗口；完成或失败后会在“后台任务”中提醒。');}
  async function submitEntity(draft=false) {
    const pages=entityPages,batchId=pages.length>1?createRequestId():null,failedPages:number[]=[];
    if(batchId)setActiveBatchId(batchId);
    setBusy(true);setError('');setNotice(draft?'正在保存产品替换草稿…':`正在提交 ${pages.length} 张产品替换预览…`);
    let submitted=0;
    try {
      for(const targetPage of pages) {
        const pageReplacements=replacements.filter(item=>item.targets[targetPage]);
        const references=[...new Map(pageReplacements.map(item=>[item.reference!.id,item.reference!])).values()];
        try {
          await trackedPost(`/v1/tasks/${taskId}/image-edits`,{
            ...pageBase(targetPage),...(batchId?{batchId,batchSize:pages.length}:{}),operation:'AI_FUSION',
            instruction:`按 ${pageReplacements.length} 组参考图和框选区域，分别替换：${pageReplacements.map(item=>`${item.targets[targetPage].targetMode==='ALL_MATCHES'?'框内全部匹配的':'单个'}“${item.targets[targetPage].description.trim().slice(0,120)}”`).join('、')}；保持场景、人物、构图和全部文字不变`,
            preserve,negative,references:references.map(reference=>({assetId:reference.id,purpose:reference.purpose})),
            replacements:pageReplacements.map(item=>({referenceAssetId:item.reference!.id,referenceMode:item.referenceMode,targetMode:item.targets[targetPage].targetMode,
              target:{description:item.targets[targetPage].description.trim(),region:item.targets[targetPage].region}})),
            confirmation:!draft&&confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft,
          });
          submitted+=1;setNotice(`已提交 ${submitted} / ${pages.length} 张，正在继续…`);
        } catch { failedPages.push(targetPage); }
      }
      await refresh();if(submitted>0)await onChanged();
      if(failedPages.length){setNotice('');setError(`产品替换已提交 ${submitted} / ${pages.length} 张；第 ${failedPages.join('、')} 页提交失败，请重新发起批次。`);}
      else setNotice(draft?'产品替换草稿已保存。':pages.length>1?`共 ${pages.length} 张产品替换预览已提交；每张图会一次完成该图内的全部替换。`:'产品替换请求已提交，可关闭窗口等待后台完成。');
    } catch(e) {setNotice('');setError(e instanceof Error?e.message:'产品替换提交失败');}
    finally {setBusy(false);}
  }
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
          await trackedPost(`/v1/tasks/${taskId}/image-edits`,{requestId:createRequestId(),batchId,sourceImageRunId:runId,
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
  async function upload(replacementKey:string,files:FileList|null) {
    const file=files?.[0];
    if(!file)return;
    if(file.size>5*1024*1024){setError('实体图片不能超过 5 MB');return;}
    await act(async()=>{
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
      const saved=await apiRequest<Asset>(path(`/v1/tasks/${taskId}/image-edit-references`),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base64,mediaType:file.type,source:'标注上传的真实产品参考图',purpose:'真实产品替换'})});
      updateReplacement(replacementKey,current=>({...current,reference:{...saved,purpose:'真实产品替换'}}));
    },'正在上传真实产品图片…','真实产品图片已上传。');
  }
  function addReplacement() {
    if(replacements.length>=4)return;
    const key=`product-${createRequestId()}`,next={...newReplacement(replacements.length+1,entityPage),key};
    setReplacements(current=>[...current,next]);setActiveReplacementKey(key);setPreviewMode('SOURCE');setError('');
  }
  function removeActiveReplacement() {
    if(replacements.length<=1||!activeReplacement)return;
    const next=replacements.filter(item=>item.key!==activeReplacement.key);
    setReplacements(next);setActiveReplacementKey(next[0].key);setPreviewMode('SOURCE');setError('');
  }
  function selectEntityPage(nextPage:number) {
    setEntityPage(nextPage);setComparisonId('');setPreviewMode('SOURCE');setError('');
  }
  function toggleActivePage(checked:boolean) {
    if(!activeReplacement)return;
    updateReplacement(activeReplacement.key,current=>{
      const targets={...current.targets};
      if(checked) {
        const example=Object.values(targets)[0];
        targets[entityPage]={description:example?.description??'',region:null,targetMode:example?.targetMode??'SINGLE'};
      } else delete targets[entityPage];
      return {...current,targets};
    });
    setPreviewMode('SOURCE');setError('');
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
    ??edits.find(e=>e.target_page===displayPage&&e.result);
  const latestRejected=isRejectedPreview(latest);
  const pageEdits=edits.filter(e=>e.target_page===displayPage);
  const suggestedEdit=pageEdits.find(e=>localSuggestion(e)!==null);
  const suggestedPlan=suggestedEdit?localSuggestion(suggestedEdit):null;
  useEffect(()=>{if(latest?.result)setPreviewMode(current=>current==='SOURCE'?'COMPARE':current);},[latest?.id,latest?.result?.asset_id]);
  const disclosureBatchId=(activeBatchId&&edits.some(e=>isDisclosureOperation(e.operation)&&e.config.batchId===activeBatchId)?activeBatchId:null)
    ||edits.find(e=>isDisclosureOperation(e.operation)&&e.config.batchId)?.config.batchId||'';
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
  const entityBatchId=(activeBatchId&&edits.some(e=>e.operation==='AI_FUSION'&&e.config.batchId===activeBatchId)?activeBatchId:null)
    ||edits.find(e=>e.operation==='AI_FUSION'&&e.config.batchId)?.config.batchId||'';
  const entityBatchEdits=entityBatchId?edits.filter(e=>e.operation==='AI_FUSION'&&e.config.batchId===entityBatchId).sort((a,b)=>a.target_page-b.target_page):[];
  const entityBatchSize=Number(entityBatchEdits[0]?.config.batchSize??0);
  const entityBatchComplete=entityBatchSize>=2&&entityBatchEdits.length===entityBatchSize;
  const entityBatchReady=entityBatchComplete&&entityBatchEdits.every(e=>['PREVIEW_READY','ACCEPTED'].includes(e.status));
  const entityBatchAccepted=entityBatchComplete&&entityBatchEdits.every(e=>e.status==='ACCEPTED');
  const entityBatchCounts=entityBatchEdits.reduce<Record<string,number>>((counts,e)=>{counts[e.status]=(counts[e.status]??0)+1;return counts;},{});
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
    if(!activeTarget){setError(`请先勾选“在第 ${entityPage} 页替换这个产品”。`);return;}
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
    setTargetRegion(null);setError('目标框选区域过小，请框出物品的大致位置并保留少量周边。');
  }
  async function runHistoryAction(e:Edit,action:EditAction) {
    const choice=action==='apply-suggestion'?localEditAlternatives(e).find(option=>option.id===selectedAlternatives[`${e.id}:${e.version}`]):null;
    if(action==='apply-suggestion'&&!choice){setError('请先选择一种修改描述。');return;}
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
    const request=act(()=>trackedPost(`/v1/image-edits/${e.id}/${action}`,{requestId:createRequestId(),version:e.version,reason,
      confirmation:costConfirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,
      ...(choice?{suggestionId:choice.id}:{}),
      ...(targetedRepair?{useRejectedPreview:true}:{}),
      ...(action==='accept'&&isRejectedPreview(e)?{acceptRejectedResult:true}:{})}),`正在${actionLabel}…`,['queue','retry','apply-suggestion'].includes(action)?'修复已提交，可关闭窗口；完成或失败后会在“后台任务”中提醒。':`${actionLabel}操作已完成。`);
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
        await trackedPost(`/v1/image-edits/${edit.id}/accept`,{requestId:createRequestId(),version:edit.version,reason});
        accepted+=1;setNotice(`正在采用整套标识 ${accepted} / ${pending.length}…`);
      }
      await refresh();await onChanged();setNotice(`整套 ${imageAssets.length} 张标识已采用，请重新完成图片审核。`);
    } catch(e) {
      try {await refresh();await onChanged();} catch {}
      setNotice('');setError(`已采用 ${accepted} / ${pending.length} 张；${e instanceof Error?e.message:'剩余图片采用失败，可再次点击继续。'}`);
    } finally {setBusy(false);setPendingBatchAccept(false);setReason('');}
  }
  async function acceptEntityBatch() {
    if(!reason.trim()){setNotice('');setError('请先填写“操作原因”，再采用批量产品替换预览。');return;}
    if(!entityBatchReady||entityBatchAccepted){setNotice('');setError('请等待批量产品替换预览全部校验通过后再采用。');return;}
    const pending=entityBatchEdits.filter(e=>e.status==='PREVIEW_READY');
    setBusy(true);setError('');setNotice(`正在采用批量产品替换 0 / ${pending.length}…`);
    let accepted=0;
    try {
      for(const edit of pending) {
        await trackedPost(`/v1/image-edits/${edit.id}/accept`,{requestId:createRequestId(),version:edit.version,reason});
        accepted+=1;setNotice(`正在采用批量产品替换 ${accepted} / ${pending.length}…`);
      }
      await refresh();await onChanged();setNotice(`批量 ${entityBatchSize} 张产品替换已采用，请重新完成图片审核。`);
    } catch(e) {
      try {await refresh();await onChanged();} catch {}
      setNotice('');setError(`已采用 ${accepted} / ${pending.length} 张；${e instanceof Error?e.message:'剩余图片采用失败，可再次点击继续。'}`);
    } finally {setBusy(false);setPendingBatchAccept(false);setReason('');}
  }
  return <>
    <Button className="current-image-editor-trigger" type="button" onClick={()=>setOpen(true)}>修改图片</Button>
    <Dialog open={open} onOpenChange={next=>{if(!busy)setOpen(next);}}><DialogContent className={styles.dialog} overlayClassName={styles.overlay}>
      <header className={styles.header}>
        <div><DialogTitle className={styles.title}>当前图片修改工作台 · 第 {displayPage} 页</DialogTitle>
        <DialogDescription className={styles.description}>草稿和预览保留当前图片及交付状态，采用新图后需重新初审。提交后可关闭窗口，完成或失败会在“后台任务”中提醒。</DialogDescription>
        {backgroundTasks.some(item=>item.taskId===taskId&&item.kind==='IMAGE_EDIT'&&isBackgroundTaskRunning(item))&&<p className={styles.description} role="status">图片修复正在排队或处理中，可关闭窗口继续其他工作。</p>}</div>
        <span className={styles.pageCount}>{displayPage} / {imageAssets.length}</span>
      </header>
      <div className={styles.tabs} role="tablist" aria-label="图片修改方式">{[['TEXT','添加文字'],['ENTITY','实体替换'],['PROMPT','局部修改']].map(([key,label])=><Button unstyled className={styles.tab} type="button" key={key} role="tab" aria-selected={tab===key} onClick={()=>{setTab(key);setConfirmed(false);setError('');setNotice('');setPreviewMode('SOURCE');showPanel('EDIT');}}>{label}</Button>)}</div>
      <div className={styles.mobileViewTabs} role="tablist" aria-label="移动端工作区">
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='PREVIEW'} onClick={()=>setMobileView('PREVIEW')}>预览</Button>
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='EDIT'} onClick={()=>showPanel('EDIT')}>编辑</Button>
        <Button unstyled type="button" role="tab" aria-selected={mobileView==='HISTORY'} onClick={()=>showPanel('HISTORY')}>记录 {pageEdits.length||''}</Button>
      </div>
      <div className={styles.body}>
        {(error||notice)&&<div className={`${styles.feedback} ${error?styles.feedbackError:''}`} role={error?'alert':'status'}>
          <span>{error||notice}</span>
          <Button unstyled type="button" className={styles.feedbackClose} aria-label="关闭提示" title="关闭提示" onClick={()=>{setNotice('');setError('');}}><X size={16} aria-hidden="true"/></Button>
        </div>}
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
                <PreviewSourceImage src={path(displayAsset.url)}/>
                <svg className={styles.previewOverlay} aria-hidden="true" viewBox="0 0 1086 1448">
                   {tab==='TEXT'&&(disclosureMethod==='SVG'
                     ?<g><rect x={tx+0.75} y={ty+0.75} width={textWidth-1.5} height={textHeight-1.5} rx="18" fill="none" stroke="#68744A" strokeWidth="1.5"/><text x={tx+textWidth/2} y={ty+textHeight/2} textAnchor="middle" dominantBaseline="central" fill="#68744A" fontSize="20" fontWeight="600" fontFamily="Microsoft YaHei,Noto Sans CJK SC,sans-serif">{text}</text></g>
                     :<g><rect x={tx} y={ty} width={textWidth} height={textHeight} rx="8" fill="#111827"/><text x={tx+textWidth/2} y={ty+40} textAnchor="middle" fill="#ffffff" fontSize="32" fontWeight="500" fontFamily="Noto Sans CJK SC,Microsoft YaHei,sans-serif">{text}</text></g>)}
                   {tab==='ENTITY'&&replacements.map((item,index)=>item.targets[entityPage]?.region&&<g key={item.key}><rect className={item.key===activeReplacement?.key?styles.targetSelection:styles.secondaryTargetSelection} x={item.targets[entityPage].region!.x} y={item.targets[entityPage].region!.y} width={item.targets[entityPage].region!.width} height={item.targets[entityPage].region!.height}/><text className={styles.targetSelectionLabel} x={item.targets[entityPage].region!.x+12} y={item.targets[entityPage].region!.y+28}>{index+1}</text></g>)}
                   {tab==='PROMPT'&&panel==='HISTORY'&&suggestedPlan?.editRegions.map((region,index)=><rect key={index} className={styles.suggestionSelection} x={region.x} y={region.y} width={region.width} height={region.height}/>)}
                   {tab==='PROMPT'&&promptTarget&&<circle className={styles.promptTarget} cx={promptTarget.x} cy={promptTarget.y} r="54"/>}
                </svg>
              </div>}
              {previewMode==='RESULT'&&latest?.result&&<div className={styles.previewCanvas} role="img" aria-label="修改结果预览" style={{width:`${zoom*100}%`}}><img className={styles.previewImage} src={path(`/v1/assets/${latest.result.asset_id}`)} alt=""/></div>}
              {previewMode==='COMPARE'&&latest?.result&&<div className={styles.previewCanvas} role="img" aria-label="修改前后对比画面" style={{width:`${zoom*100}%`}}><img className={styles.previewImage} src={path(`/v1/assets/${latest.source_asset_id??displayAsset.id}`)} alt=""/><img className={styles.previewImage} src={path(`/v1/assets/${latest.result.asset_id}`)} alt="" style={{clipPath:`inset(0 ${100-compare}% 0 0)`}}/></div>}
            </div>
            {previewMode==='COMPARE'&&latest?.result?<section className={styles.inlineComparison} aria-label="修改前后对比"><div><h3>修改前后滑动对比</h3><span>第 {latest.target_page} 页 · {labels[latest.operation]}{latestRejected?' · 自动验收未通过':''}</span></div><Slider aria-label="修改前后对比滑块" min="0" max="100" value={compare} onChange={e=>setCompare(Number(e.target.value))}/></section>:<label className={styles.zoomControl}><span>预览缩放</span><Slider aria-label="预览缩放" min="1" max="3" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><strong>{Math.round(zoom*100)}%</strong></label>}
            <p className={styles.help}>{tab==='TEXT'?(disclosureMethod==='SVG'?'左侧预览程序标识的描边胶囊样式；提交后由 SVG + Sharp 确定性合成。':'左侧是模型标识的统一目标样式示意；提交后由图片编辑模型融合绘制。'):tab==='ENTITY'?`正在标注第 ${displayPage} 页、产品 ${Math.max(1,replacements.findIndex(item=>item.key===activeReplacement?.key)+1)}；${targetMode==='ALL_MATCHES'?'框选包含全部同款目标的搜索范围。':'框内只放一个目标。'}`:promptTarget?`已标记${pointLocation(promptTarget)}附近；右侧只需补充怎么修改。`:'可直接点击图片中的目标以自动补充位置，也可以完整输入自然语言说明。'}</p>
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
                  <label>人工生成标识文字<Input aria-label="人工生成标识文字" value={text} maxLength={12} pattern="[\p{L}\p{N}_-]+" onChange={e=>setText(e.target.value)}/><small>最多 12 个字符，仅限文字、数字、下划线或短横线。</small></label>
                  {imageAssets.length>1&&<div className={styles.scopeSelector} aria-label="标识应用范围"><span>应用范围</span><div role="group" aria-label="选择标识应用范围"><Button unstyled type="button" aria-pressed={textScope==='CURRENT'} onClick={()=>setTextScope('CURRENT')}>仅第 {page} 页</Button><Button unstyled type="button" aria-pressed={textScope==='ALL'} onClick={()=>setTextScope('ALL')}>整套 {imageAssets.length} 张</Button></div><small>{textScope==='ALL'?'同一标识会逐张生成并保持统一方式。':disclosureMethod==='SVG'?'只为当前页创建一张程序叠加标识预览。':'只为当前页创建一张模型绘制标识预览。'}</small></div>}
                  <div className={styles.recentDisclosureTexts} aria-label="最近常用标识文字"><span>最近常用</span>{recentDisclosureTexts.length?<div>{recentDisclosureTexts.map(item=><Button unstyled className={styles.recentDisclosureButton} type="button" key={item} aria-pressed={text===item} onClick={()=>setText(item)}>{item}</Button>)}</div>:<small>成功提交后会在这里保留最近使用的 5 条。</small>}</div>
                  <p>{disclosureMethod==='SVG'?'系统会固定标识位置、尺寸与转义后的文字，并逐像素确认标识区域外没有变化。':'系统会校验文字准确性、可读性和重复标识；失败时不会自动二次修改。'}</p>
                </>}
                {tab==='ENTITY'&&<>
                  <div className={styles.productPlanner} aria-label="产品替换项">
                    <div className={styles.productPlannerHeading}><div><strong>产品替换项</strong><small>一款产品建一个替换项；同一款产品可选择多张图片。</small></div><Button variant="outline" size="sm" type="button" disabled={busy||replacements.length>=4} onClick={addReplacement}>添加另一个产品</Button></div>
                    <div className={styles.productTabs} role="tablist" aria-label="选择产品替换项">{replacements.map((item,index)=><Button unstyled type="button" role="tab" key={item.key} aria-selected={item.key===activeReplacement?.key} onClick={()=>{setActiveReplacementKey(item.key);setPreviewMode('SOURCE');setError('');}}>产品 {index+1}<small>{item.reference?'参考图已上传':'待上传参考图'}</small></Button>)}</div>
                    {replacements.length>1&&<Button className={styles.removeProduct} variant="outline" size="sm" type="button" onClick={removeActiveReplacement}>移除当前产品</Button>}
                  </div>
                  <div className={styles.referenceUpload}><div className={styles.referenceUploadHeading}><strong>上传产品 {Math.max(1,replacements.findIndex(item=>item.key===activeReplacement?.key)+1)} 的真实图片</strong><p>每个替换项绑定自己的参考图，单张图内不会串用产品。</p></div><label className={styles.filePicker} data-disabled={busy||undefined}><input className={styles.fileInput} aria-label={replacements.findIndex(item=>item.key===activeReplacement?.key)===0?'上传真实产品参考图':`上传产品 ${replacements.findIndex(item=>item.key===activeReplacement?.key)+1} 参考图`} type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>activeReplacement&&void upload(activeReplacement.key,e.target.files)}/><span className={styles.filePickerIcon}><UploadCloud aria-hidden="true" size={26} strokeWidth={1.8}/></span><span className={styles.filePickerCopy}><strong>{activeReplacement?.reference?'更换产品图片':'点击选择产品图片'}</strong><small>也可以将图片拖放到这里</small></span><span className={styles.filePickerMeta}>PNG / JPG / WebP · 最大 5 MB</span></label>{activeReplacement?.reference&&<div className={styles.referenceCard}><img src={path(activeReplacement.reference.url)} alt="已上传的真实产品参考图"/><span>产品 {replacements.findIndex(item=>item.key===activeReplacement.key)+1} 参考图已就绪</span><Button variant="outline" size="sm" type="button" onClick={()=>updateReplacement(activeReplacement.key,current=>({...current,reference:null}))}>移除</Button></div>}</div>
                  <label>参考图使用方式<Select value={referenceMode} onValueChange={value=>setReferenceMode(value as ReferenceMode)}><SelectTrigger aria-label="参考图使用方式"><SelectValue /></SelectTrigger><SelectContent className={styles.selectContent}><SelectItem value="STRICT">完整产品（严格模式）</SelectItem><SelectItem value="APPEARANCE">外观参考（允许手部、裁切或次要产品）</SelectItem></SelectContent></Select><small>{referenceMode==='APPEARANCE'?'只迁移主产品可确认的外观，缺失部分沿用源图结构补全。':'要求参考图中只有一个清楚、完整、遮挡很少的产品。'}</small></label>
                  <div className={styles.entityPagePlanner} aria-label="产品应用图片"><span>选择正在标注的图片</span><div>{imageAssets.map((_,index)=>{const targetPage=index+1,target=activeReplacement?.targets[targetPage];return <Button unstyled type="button" key={targetPage} aria-pressed={entityPage===targetPage} onClick={()=>selectEntityPage(targetPage)}>第 {targetPage} 页<small>{target?.region?'已框选':target?'待框选':'未应用'}</small></Button>;})}</div><label><Checkbox checked={Boolean(activeTarget)} onChange={event=>toggleActivePage(event.target.checked)}/><span>在第 {entityPage} 页替换这个产品</span></label><small>跨图片使用同一参考产品时，逐页切换并分别框选目标；系统会按图片建立同一批次。</small></div>
                  {activeTarget?<><label>替换范围<Select value={targetMode} onValueChange={value=>setTargetMode(value as TargetMode)}><SelectTrigger aria-label="产品替换范围"><SelectValue /></SelectTrigger><SelectContent className={styles.selectContent}><SelectItem value="SINGLE">只替换一个产品</SelectItem><SelectItem value="ALL_MATCHES">替换框内全部同款产品或特写</SelectItem></SelectContent></Select><small>{targetMode==='ALL_MATCHES'?'框选搜索范围；系统会先定位每个匹配目标并生成紧框。紧框略超出搜索范围、目标未完整包含或含持握手部时会提醒，但不会阻止调用图片模型。':'框出目标的大致位置即可；框未完整覆盖或带有持握手部时，仍会直接交给模型完整替换该产品。'}</small></label><label>目标物品说明<Textarea aria-label={replacements.findIndex(item=>item.key===activeReplacement?.key)===0&&entityPage===page?'目标物品说明':`产品 ${replacements.findIndex(item=>item.key===activeReplacement?.key)+1} 第 ${entityPage} 页目标物品说明`} value={targetDescription} maxLength={500} placeholder={targetMode==='ALL_MATCHES'?'例如：框内全部蓝黑色儿童手表及旋钮特写':'例如：画面右侧人物手持的红色证件本'} onChange={e=>setTargetDescription(e.target.value)}/><small>{targetMode==='ALL_MATCHES'?'描述所有需要匹配的同款产品；定位蒙版只提供给模型参考，模型返回的完整画面会直接用于验收。':'同时写清颜色、持有者或相邻物体，帮助模型锁定唯一目标；框只用于定位。'}</small></label><div className={styles.targetSelectionInfo} role="status"><span>{targetRegion?`第 ${entityPage} 页已框选${targetMode==='ALL_MATCHES'?'搜索范围':'目标'}：x ${targetRegion.x}，y ${targetRegion.y}，宽 ${targetRegion.width}，高 ${targetRegion.height}`:`第 ${entityPage} 页尚未框选${targetMode==='ALL_MATCHES'?'搜索范围':'目标'}，请在左侧原图上拖动。`}</span>{targetRegion&&<Button variant="outline" size="sm" type="button" onClick={()=>setTargetRegion(null)}>重新框选</Button>}</div></>:<div className={styles.inactivePageNotice}>当前产品不应用到第 {entityPage} 页；勾选后可填写说明并框选目标。</div>}
                  <p>单目标模式会把说明和大致位置直接交给图片编辑模型；全部同款模式会先识别最多 4 个目标并生成紧框，再在一次模型编辑中完成。</p>
                </>}
                {tab==='PROMPT'&&<>
                  <div className={styles.promptStep}><div className={styles.stepHeading}><strong>1. 选择修改目标</strong><span>减少位置描述</span></div><div className={styles.targetSelectionInfo} role="status"><span>{promptTarget?`已定位：${pointLocation(promptTarget)}附近`:'可在左侧图片点击要修改的目标，也可跳过并在说明中写位置。'}</span>{promptTarget&&<Button variant="outline" size="sm" type="button" onClick={()=>setPromptTarget(null)}>清除定位</Button>}</div></div>
                  <div className={styles.promptStep}><div className={styles.stepHeading}><strong>2. 选择修改动作</strong><span>可选</span></div><div className={styles.promptActions} role="group" aria-label="局部修改动作">{promptActions.map(action=><Button unstyled type="button" key={action} aria-pressed={promptAction===action} onClick={()=>setPromptAction(current=>current===action?'':action)}>{action.replace('物体','')}</Button>)}</div></div>
                  <label>补充要求<Textarea aria-label="图片修改要求" value={instruction} maxLength={2000} placeholder={promptTarget?'例如：改成鼠尾草绿色，保持材质和光影不变':'例如：把画面左下角人物手中的黑色书包替换成手提文件袋'} onChange={e=>setInstruction(e.target.value)}/><small>{promptTarget?'位置已自动加入请求，只需描述修改结果。':'请同时描述位置和修改内容。'}</small></label>
                  <div className={styles.quickRequirements} aria-label="快捷补充要求">{quickRequirements.map(item=><Button unstyled type="button" key={item} onClick={()=>appendRequirement(item)}>＋ {item}</Button>)}</div>
                  <p>系统会将原图和修改说明直接交给图片编辑模型，生成后检查修改结果及文字。请查看预览后再采用。</p>
                 </>}
                {usesBillableModel?<label className={styles.feeConfirmation}><input className={styles.feeCheckboxInput} type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span className={styles.feeCheckboxVisual} data-fee-checkbox aria-hidden="true"/><span>确认调用图片编辑与视觉验收模型，会产生费用；生成结果需查看并采用后才会替换当前图片。</span></label>:<p>本次使用本地 SVG + Sharp 合成，不调用图片编辑或视觉模型，无需费用确认。</p>}
              </section></section>
              <footer className={styles.actionBar}><span>{usesBillableModel?'保存草稿不会调用模型':'程序标识不调用模型'}</span><div>{!(tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1)&&<Button variant="outline" disabled={busy} onClick={()=>void submit(true)}>{busy?'处理中…':'保存草稿'}</Button>}<Button disabled={busy} onClick={()=>void (tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1?submitDisclosureBatch():submit())}>{busy?'处理中…':tab==='TEXT'&&textScope==='ALL'&&imageAssets.length>1?`生成整套 ${imageAssets.length} 张${disclosureMethod==='SVG'?'程序':'模型'}标识预览`:tab==='TEXT'?`生成${disclosureMethod==='SVG'?'程序':'模型'}标识预览`:tab==='PROMPT'||(entityPages.length===1&&replacements.length===1)?'生成修改预览':entityPages.length>1?`生成 ${entityPages.length} 张批量替换预览`:`生成 ${replacements.length} 个产品替换预览`}</Button></div></footer>
            </>:<section className={styles.panelBody} aria-label="任务记录">
              <section className={styles.restorePanel} aria-label="历史图片版本"><div><strong>历史图片版本</strong><span>恢复入口与任务记录集中管理</span></div><Select value={history} onValueChange={setHistory} disabled={busy || !runs.some(r=>r.id!==runId)}><SelectTrigger aria-label="历史图片版本"><SelectValue placeholder="选择要恢复的图集" /></SelectTrigger><SelectContent className={styles.selectContent}>{runs.filter(r=>r.id!==runId).map(r=><SelectItem key={r.id} value={r.id}>{labels[r.result?.processing?.type??'']??'原始生成'} · {r.id.slice(0,8)}</SelectItem>)}</SelectContent></Select><Button variant="outline" disabled={!history||busy} onClick={()=>void act(()=>post(`/v1/tasks/${taskId}/image-versions/${history}/restore`,{...base(),instruction:'恢复历史图片版本'}),'正在创建恢复预览…','恢复预览请求已提交。')}>生成恢复预览</Button></section>
              {tab==='TEXT'&&!!disclosureBatchId&&disclosureBatchEdits.length>0&&<section className={styles.batchStatus} aria-label="整套标识批次状态"><div><h3>最近整套标识批次</h3><p>{disclosureBatchComplete?`共 ${imageAssets.length} 张，全部预览就绪后可一次采用。`:`已创建 ${disclosureBatchEdits.length} / ${imageAssets.length} 张请求，批次不完整。`}</p></div><div className={styles.batchCounts}>{Object.entries(disclosureBatchCounts).map(([status,count])=><span key={status}>{labels[status]??status} {count}</span>)}</div><Button disabled={busy||!disclosureBatchReady||disclosureBatchAccepted} onClick={()=>{setReason('');setPendingHistoryAction(null);setPendingBatchAccept(true);}}>{disclosureBatchAccepted?'整套标识已采用':disclosureBatchReady?'一次采用整套标识':'等待全部预览就绪'}</Button>{pendingBatchAccept&&<form className={styles.reasonEditor} onSubmit={event=>{event.preventDefault();void acceptDisclosureBatch();}}><label>采用整套标识的原因<Input aria-label="整套标识采用原因" value={reason} maxLength={1000} autoFocus onChange={e=>setReason(e.target.value)}/></label><div className={styles.quickReasons}>{quickReasons.slice(0,2).map(item=><Button variant="outline" size="sm" type="button" key={item} onClick={()=>setReason(item)}>{item}</Button>)}</div><div className={styles.reasonActions}><Button variant="outline" type="button" onClick={()=>{setPendingBatchAccept(false);setReason('');}}>取消</Button><Button type="submit" disabled={busy}>确认采用</Button></div></form>}</section>}
              {tab==='ENTITY'&&!!entityBatchId&&entityBatchEdits.length>0&&<section className={styles.batchStatus} aria-label="批量产品替换状态"><div><h3>最近批量产品替换</h3><p>{entityBatchComplete?`共 ${entityBatchSize} 张，每张图内的全部产品会一次完成。`:`已创建 ${entityBatchEdits.length} / ${entityBatchSize||'未知'} 张请求，批次不完整。`}</p></div><div className={styles.batchCounts}>{Object.entries(entityBatchCounts).map(([status,count])=><span key={status}>{labels[status]??status} {count}</span>)}</div><Button disabled={busy||!entityBatchReady||entityBatchAccepted} onClick={()=>{setReason('');setPendingHistoryAction(null);setPendingBatchAccept(true);}}>{entityBatchAccepted?'批量替换已采用':entityBatchReady?'一次采用全部替换':'等待全部预览就绪'}</Button>{pendingBatchAccept&&<form className={styles.reasonEditor} onSubmit={event=>{event.preventDefault();void acceptEntityBatch();}}><label>采用批量替换的原因<Input aria-label="批量替换采用原因" value={reason} maxLength={1000} autoFocus onChange={e=>setReason(e.target.value)}/></label><div className={styles.quickReasons}>{quickReasons.slice(0,2).map(item=><Button variant="outline" size="sm" type="button" key={item} onClick={()=>setReason(item)}>{item}</Button>)}</div><div className={styles.reasonActions}><Button variant="outline" type="button" onClick={()=>{setPendingBatchAccept(false);setReason('');}}>取消</Button><Button type="submit" disabled={busy}>确认采用</Button></div></form>}</section>}
              <div className={styles.historyHeading}><strong>当前页任务记录</strong><span>失败详情默认收起</span></div>
              {pageEdits.length?<ul className={styles.history} aria-label="图片修改记录">{pageEdits.map(e=>{
                const suggestion=localSuggestion(e);
                const alternatives=localEditAlternatives(e);
                const selectedAlternative=alternatives.find(option=>option.id===selectedAlternatives[`${e.id}:${e.version}`]);
                const rejectedPreview=isRejectedPreview(e),repairRecommendation=localRepairRecommendation(e),preflightWarnings=imageEditPreflightWarnings(e);
                return <li key={e.id}><div className={styles.historyTitle}><strong>{labels[e.operation]} · {alternatives.length?'待确认建议':rejectedPreview?(e.status==='ACCEPTED'?'已人工采用 · 自动验收未通过':'验收未通过 · 结果已保留'):labels[e.status]}</strong><span>第 {e.target_page} 页 · {e.created_by} · 已执行 {e.attempts??0} 次</span></div><p className={styles.historySummary}>{e.config.instruction}</p>
                  {alternatives.length>0&&<section className={styles.suggestionCard} aria-label="局部修改建议"><strong>选择一种修改描述</strong><span>3 个方向均保留原要求，只补充目标范围和处理约束。</span>
                    <div className={styles.suggestionOptions} role="radiogroup" aria-label="替代描述方案">{alternatives.map(option=><label key={option.id} data-selected={selectedAlternative?.id===option.id}>
                      <Radio name={`suggestion-${e.id}`} aria-label={option.title} checked={selectedAlternative?.id===option.id} disabled={busy} onChange={()=>{
                        setSelectedAlternatives(current=>({...current,[`${e.id}:${e.version}`]:option.id}));
                        if(pendingHistoryAction?.editId===e.id&&pendingHistoryAction.action==='apply-suggestion')setReason(`采用「${option.title}」方案`);
                      }}/><span><strong>{option.title}</strong><small>{option.description}</small></span>
                    </label>)}</div>
                    {selectedAlternative&&<blockquote aria-label="所选修改描述">{selectedAlternative.instruction}</blockquote>}
                    <span>{suggestion?'选择方案后点击下方“采用建议并修改”，结果仍需确认。':'选择方案后将直接生成修改预览，再进行结果验收。'}</span>
                  </section>}
                  {preflightWarnings.length>0&&<section className={styles.preflightWarningCard} aria-label="执行前提醒"><strong>执行前提醒（未阻止生成）</strong><ul>{preflightWarnings.map((warning,index)=><li key={index}>{warning}</li>)}</ul><span>系统已继续调用图片模型，是否采用仍以生成后的验收结果为准。</span></section>}
                  {rejectedPreview&&<section className={styles.rejectedResultCard} aria-label="自动验收未通过的结果"><strong>图片已生成，但没有完整完成任务</strong><p>{failedPreviewReason(e)}</p>{repairRecommendation?<><span>系统可以上一张失败图为起点，仅处理以下未完成部分：</span><blockquote>{repairRecommendation.repairInstruction}</blockquote><span>定向修复会再次调用图片模型并产生费用，只有确认后才会执行；修复结果仍由你决定是否采用。</span></>:<span>这是一张可查看的失败预览。当前问题不适合安全局部补救，你可以仍然采用，也可以调整说明后从原图重试；重试可能再次产生模型费用。</span>}</section>}
                  {e.error&&<details><summary>查看失败原因</summary><p role="alert">{e.error}</p></details>}
                  <div className={styles.historyActions}>{e.operation==='AI_LOCAL'&&<Button variant="outline" size="sm" onClick={()=>reuseInstruction(e)}>复用说明并修改</Button>}{e.result&&<><Button size="sm" onClick={()=>{setComparisonId(e.id);setPreviewMode('COMPARE');setMobileView('PREVIEW');}}>在左侧对比</Button><a href={path(`/v1/assets/${e.result.asset_id}`)} target="_blank" rel="noreferrer">打开结果</a></>}{historyActions(e).map(action=><Button key={action} size="sm" variant={action==='cancel'?'outline':undefined} className={action==='cancel'?styles.deleteAction:undefined} disabled={busy||action==='apply-suggestion'&&!selectedAlternative} onClick={()=>{setReason(action==='apply-suggestion'&&selectedAlternative?`采用「${selectedAlternative.title}」方案`:'');setHistoryCostConfirmed(false);setPendingBatchAccept(false);setPendingHistoryAction({editId:e.id,action});}}>{historyActionLabel(e,action)}</Button>)}</div>
                  {!!(e.result?.validation??e.validation)&&<details><summary>质量校验记录</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(e.result?.validation??e.validation,null,2)}</pre></details>}
                  {!!e.events?.length&&<details><summary>操作审计</summary><ul>{e.events.map((event,index)=><li key={index}>{event.actor} · {event.action} · {event.reason}</li>)}</ul></details>}
                  {pendingHistoryAction?.editId===e.id&&<form className={styles.reasonEditor} onSubmit={event=>{event.preventDefault();void runHistoryAction(e,pendingHistoryAction.action);}}><label>{historyActionLabel(e,pendingHistoryAction.action)}的操作原因<Input aria-label={`${historyActionLabel(e,pendingHistoryAction.action)}操作原因`} value={reason} maxLength={1000} autoFocus onChange={event=>setReason(event.target.value)}/></label>{pendingHistoryAction.action==='retry'&&repairRecommendation&&<label className={styles.feeConfirmation}><Checkbox checked={historyCostConfirmed} onChange={event=>setHistoryCostConfirmed(event.target.checked)}/><span>确认本次定向修复会再次调用图片模型并产生费用</span></label>}<div className={styles.quickReasons}>{quickReasons.map(item=><Button variant="outline" size="sm" type="button" key={item} onClick={()=>setReason(item)}>{item}</Button>)}</div><div className={styles.reasonActions}><Button variant="outline" type="button" onClick={()=>{setPendingHistoryAction(null);setHistoryCostConfirmed(false);setReason('');}}>取消</Button><Button type="submit" disabled={busy}>确认{historyActionLabel(e,pendingHistoryAction.action)}</Button></div></form>}
                </li>;
              })}</ul>:<p className={styles.emptyHistory}>当前还没有图片修改记录。</p>}
            </section>}
          </section>
        </div>
      </div>
    </DialogContent></Dialog>
  </>;
}
