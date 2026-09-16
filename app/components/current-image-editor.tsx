'use client';

import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { Dialog, DialogClose, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { UploadCloud } from 'lucide-react';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';
import styles from './current-image-editor.module.css';

type Asset = { id: number; sha256: string; url: string };
type Ref = Asset & { purpose: string };
type TargetRegion = { x:number; y:number; width:number; height:number };
type Edit = { id: string; version: number; status: string; operation: string; source_asset_id?:number; target_page:number; created_by:string; validation?:unknown; events?:Array<{action:string;actor:string;reason:string}>; error: string | null; config: {instruction:string;confirmation?:string|null}; result?: {asset_id: number; image_run_id: string; validation: unknown} };
const labels: Record<string,string> = {DRAFT:'草稿',QUEUED:'排队中',RUNNING:'执行与校验中',PREVIEW_READY:'预览待确认',ACCEPTED:'已采用',REJECTED:'已拒绝',FAILED:'失败',CANCELLED:'已取消',TEXT:'人工生成标识',COMPOSITE:'实体合成（历史）',AI_FUSION:'真实产品替换',AI_LOCAL:'局部修改',AI_FULL:'整图修改（历史）',RESTORE:'恢复版本',REGENERATE:'重新生成',REPROCESS:'格式处理'};
const path=(url:string)=>`/api/control-plane${url}`;
const post=(url:string,body:unknown)=>apiRequest(path(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
export function CurrentImageEditor({taskId,runId,copyRevisionId,asset,page,runs,onChanged}: {
  taskId:number;runId:string;copyRevisionId:number;asset:Asset;page:number;
  runs:Array<{id:string;result:{processing?:{type:string}}|null}>;onChanged:()=>Promise<void>;
}) {
  const [open,setOpen]=useState(false),[tab,setTab]=useState('TEXT');
  const [text,setText]=useState('AI生成');
  const [instruction,setInstruction]=useState('');
  const [targetDescription,setTargetDescription]=useState('');
  const [targetRegion,setTargetRegion]=useState<TargetRegion|null>(null);
  const targetDragStart=useRef<{x:number;y:number}|null>(null);
  const [confirmed,setConfirmed]=useState(false),[refs,setRefs]=useState<Ref[]>([]),[edits,setEdits]=useState<Edit[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState(''),[compare,setCompare]=useState(50),[zoom,setZoom]=useState(1),[history,setHistory]=useState(''),[reason,setReason]=useState('');
  const [comparisonId,setComparisonId]=useState('');
  const refresh=useCallback(async()=>setEdits(await apiRequest<Edit[]>(path(`/v1/tasks/${taskId}/image-edits`))),[taskId]);
  useEffect(()=>{if(!open)return;let active=true;const poll=()=>{if(active)void refresh().catch(e=>setError(e.message));};poll();const timer=setInterval(poll,4000);return()=>{active=false;clearInterval(timer);};},[open,refresh]);
  const operation=tab==='TEXT'?'TEXT':tab==='ENTITY'?'AI_FUSION':'AI_LOCAL';
  const requestInstruction=tab==='TEXT'?`将人工生成标识显示为“${text.trim()}”并放在右下角`:
    tab==='ENTITY'?`使用上传的真实产品参考图，只替换目标“${targetDescription.trim()}”，保持场景、人物、构图和全部文字不变`:instruction.trim();
  const preserve=tab==='ENTITY'?'保留原图全部已批准文字、人物、背景、构图、色调和未被替换的物品':'除说明明确点名的目标外，保留原图全部已批准文字、所有未点名区域、人物、构图和色调';
  const negative=tab==='ENTITY'?'不得新增文字；不得改变参考产品的外形、颜色、标志和关键细节':'不得修改说明之外的区域；除明确要求修改或删除的目标外，不得新增、删除或改写已有文字';
  const base=()=>({requestId:createRequestId(),sourceImageRunId:runId,sourceAssetId:asset.id,copyRevisionId,sha256:asset.sha256,targetPage:page});
  async function act(action:()=>Promise<unknown>,pending='正在处理…',success='操作完成') {setBusy(true);setError('');setNotice(pending);try{await action();await refresh();await onChanged();setNotice(success);}catch(e){setNotice('');setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  function requestIssue(draft=false) {
    if(tab==='TEXT'&&!disclosureValid)return '人工生成标识需填写 1～12 个文字、数字、下划线或短横线。';
    if(tab==='ENTITY'&&refs.length!==1)return '请先上传 1 张真实产品图片。';
    if(tab==='ENTITY'&&!targetDescription.trim())return '请填写需要替换的目标物品说明。';
    if(tab==='ENTITY'&&!targetRegion)return '请在左侧原图上拖动框选需要替换的一个物品。';
    if(tab==='PROMPT'&&!instruction.trim())return '请先填写局部修改说明，并同时写清修改位置和内容。';
    if(!draft&&!confirmed)return '请先勾选费用确认，再生成修改预览。保存草稿不调用模型，无需勾选。';
    return '';
  }
  function submit(draft=false) {
    const issue=requestIssue(draft);
    if(issue){setNotice('');setError(issue);return;}
    return act(()=>post(`/v1/tasks/${taskId}/image-edits`,{...base(),operation,instruction:requestInstruction,preserve,negative,
    ...(operation==='TEXT'?{overlay:{text:text.trim(),textType:'AI_DISCLOSURE',size:32,margin:32,opacity:1,color:'#ffffff',background:'#111827',position:'bottom-right',disclosureType:'AI_GENERATED'}}:{}),
    references:tab==='ENTITY'?refs.map(r=>({assetId:r.id,purpose:r.purpose})):[],
    ...(tab==='ENTITY'?{target:{description:targetDescription.trim(),region:targetRegion}}:{}),
    confirmation:confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft}),draft?'正在保存草稿…':'已提交，正在排队生成修改预览…',draft?'草稿已保存。':'修改请求已提交，系统正在处理。');}
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
  const latest=edits.find(e=>e.id===comparisonId&&e.result)??edits.find(e=>e.status==='PREVIEW_READY'&&e.target_page===page);
  const textWidth=Array.from(text).length*32+24,textHeight=64;
  const tx=1086-32-textWidth,ty=1448-32-textHeight;
  const disclosureValid=/^[\p{L}\p{N}_-]{1,12}$/u.test(text.trim());
  function targetPoint(event:ReactPointerEvent<SVGSVGElement>) {
    const box=event.currentTarget.getBoundingClientRect();
    return {x:Math.max(0,Math.min(1085,Math.round((event.clientX-box.left)*1086/box.width))),
      y:Math.max(0,Math.min(1447,Math.round((event.clientY-box.top)*1448/box.height)))};
  }
  function startTargetSelection(event:ReactPointerEvent<SVGSVGElement>) {
    if(tab!=='ENTITY'||event.button!==0)return;
    const point=targetPoint(event);targetDragStart.current=point;setTargetRegion(null);setError('');
    event.currentTarget.setPointerCapture(event.pointerId);
  }
  function moveTargetSelection(event:ReactPointerEvent<SVGSVGElement>) {
    const start=targetDragStart.current;if(tab!=='ENTITY'||!start)return;
    const point=targetPoint(event),x=Math.min(start.x,point.x),y=Math.min(start.y,point.y);
    setTargetRegion({x,y,width:Math.max(1,Math.abs(point.x-start.x)),height:Math.max(1,Math.abs(point.y-start.y))});
  }
  function finishTargetSelection(event:ReactPointerEvent<SVGSVGElement>) {
    if(!targetDragStart.current)return;
    targetDragStart.current=null;
    if(event.currentTarget.hasPointerCapture(event.pointerId))event.currentTarget.releasePointerCapture(event.pointerId);
    setTargetRegion(region=>{if(region&&region.width>=24&&region.height>=24)return region;setError('目标框选区域过小，请完整框住一个物品并保留少量周边。');return null;});
  }
  function runHistoryAction(e:Edit,action:string) {
    const actionLabel=({accept:'采用此版本',reject:'拒绝',cancel:'取消',retry:'重试',queue:'提交草稿'} as Record<string,string>)[action]??'操作';
    if(!reason.trim()){setNotice('');setError(`请先填写“操作原因”，再${actionLabel}。`);return;}
    const needsConfirmation=['queue','retry'].includes(action)&&(e.operation==='TEXT'||e.operation.startsWith('AI_'))&&e.config.confirmation!=='LIVE_IMAGE_COST_ACCEPTED';
    if(needsConfirmation&&!confirmed){setNotice('');setError(`“${actionLabel}”会调用图片模型，请先勾选费用确认。`);return;}
    return act(()=>post(`/v1/image-edits/${e.id}/${action}`,{requestId:createRequestId(),version:e.version,reason,
      confirmation:confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined}),`正在${actionLabel}…`,`${actionLabel}操作已完成。`);
  }
  return <><Button className="current-image-editor-trigger" type="button" onClick={()=>setOpen(true)}>修改图片</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent className={styles.dialog} overlayClassName={styles.overlay}>
    <header className={styles.header}>
      <DialogTitle className={styles.title}>当前图片修改工作台 · 第 {page} 页</DialogTitle>
      <DialogDescription className={styles.description}>结果先生成预览。明确采用后需重新图片审核，原图和其他页面保留。</DialogDescription>
    </header>
    <div className={styles.tabs} role="tablist" aria-label="图片修改方式">{[['TEXT','添加文字'],['ENTITY','实体替换'],['PROMPT','局部修改']].map(([key,label])=><Button unstyled className={styles.tab} type="button" key={key} role="tab" aria-selected={tab===key} onClick={()=>{setTab(key);setConfirmed(false);setError('');setNotice('');}}>{label}</Button>)}</div>
    <div className={styles.body}>
    {(error||notice)&&<p className={`${styles.feedback} ${error?styles.feedbackError:''}`} role={error?'alert':'status'}>{error||notice}</p>}
    <div className={styles.workspace}>
      <section className={styles.previewPanel} aria-label="图片预览">
        <div className={styles.previewViewport}>
        <svg className={`${styles.previewCanvas} ${tab==='ENTITY'?styles.targetCanvas:''}`} role="img" aria-label="实时修改预览" viewBox="0 0 1086 1448" style={{width:`${zoom*100}%`}}
          onPointerDown={startTargetSelection} onPointerMove={moveTargetSelection} onPointerUp={finishTargetSelection} onPointerCancel={finishTargetSelection}>
          <image href={path(asset.url)} width="1086" height="1448"/>
          {tab==='TEXT'&&<g><rect x={tx} y={ty} width={textWidth} height={textHeight} rx="8" fill="#111827"/><text x={tx+12} y={ty+40} fill="#ffffff" fontSize="32" fontFamily="Noto Sans CJK SC,Microsoft YaHei,sans-serif">{text}</text></g>}
          {tab==='ENTITY'&&targetRegion&&<rect className={styles.targetSelection} x={targetRegion.x} y={targetRegion.y} width={targetRegion.width} height={targetRegion.height}/>}
        </svg>
        </div>
        <label className={styles.zoomControl}><span>预览缩放</span><input aria-label="预览缩放" type="range" min="1" max="3" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/><strong>{Math.round(zoom*100)}%</strong></label>
        <p className={styles.help}>{tab==='TEXT'?'标识固定放在右下角；左侧仅为位置示意，最终以 AI 改图预览为准。':tab==='ENTITY'?'在原图上拖动框住一个目标物品并保留少量周边；参考图只供模型重绘，不会直接贴到画面上。':'请在右侧说明中同时写清“改哪里”和“改什么”；系统会按文字描述定位。'}</p>
      </section><section className={styles.settings} aria-label="图片修改设置">
        {tab==='TEXT'&&<><label>人工生成标识文字<input aria-label="人工生成标识文字" value={text} maxLength={12} pattern="[\p{L}\p{N}_-]+" onChange={e=>setText(e.target.value)}/><small>最多 12 个字符，仅限文字、数字、下划线或短横线。</small></label><p>仍按人工生成标识处理，只改变最终显示文字；位置固定为右下角，样式由管理员的图片编辑提示词控制。</p></>}
        {tab==='ENTITY'&&<><div className={styles.referenceUpload}><div className={styles.referenceUploadHeading}><strong>上传真实产品图片</strong><p>系统会用这张图片中的真实产品替换你框选的一个物品，并自动保持原场景和文字。</p></div><label className={styles.filePicker} data-disabled={busy||undefined}><input className={styles.fileInput} aria-label="上传真实产品参考图" type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={e=>void upload(e.target.files)}/><span className={styles.filePickerIcon}><UploadCloud aria-hidden="true" size={26} strokeWidth={1.8}/></span><span className={styles.filePickerCopy}><strong>{refs.length?'更换产品图片':'点击选择产品图片'}</strong><small>也可以将图片拖放到这里</small></span><span className={styles.filePickerMeta}>PNG / JPG / WebP · 最大 5 MB</span></label>{refs.map(r=><div className={styles.referenceCard} key={r.id}><img src={path(r.url)} alt="已上传的真实产品参考图"/><span>真实产品参考图已就绪</span><Button variant="outline" size="sm" type="button" onClick={()=>setRefs([])}>移除</Button></div>)}</div><label>目标物品说明<textarea aria-label="目标物品说明" value={targetDescription} maxLength={500} placeholder="例如：画面右侧台面上、木托盘后方的米白色拿铁杯（不是咖啡机下方的红杯）" onChange={e=>setTargetDescription(e.target.value)}/><small>同时写清位置、颜色或相邻物体，避免多个同类物品时选错。</small></label><div className={styles.targetSelectionInfo} role="status"><span>{targetRegion?`已框选：x ${targetRegion.x}，y ${targetRegion.y}，宽 ${targetRegion.width}，高 ${targetRegion.height}`:'尚未框选目标。请在左侧原图上拖动。'}</span>{targetRegion&&<Button variant="outline" size="sm" type="button" onClick={()=>setTargetRegion(null)}>重新框选</Button>}</div><p>执行机会先用视觉模型确认框内只有一个符合描述的目标；不明确时不会调用图片编辑模型。确认后由 AI 在框选区域内完成真实融合，框外像素保持不变。</p></>}
        {tab==='PROMPT'&&<><label>局部修改说明<textarea aria-label="图片修改要求" value={instruction} maxLength={2000} placeholder="例如：把画面左下角人物手中的黑色书包替换成手提文件袋，保持人物动作、文字和其他区域不变" onChange={e=>setInstruction(e.target.value)}/><small>请同时描述位置和修改内容，例如“右上角的水杯”“人物左手旁的书包”。</small></label><p>不再画选区或填写坐标。系统根据这段说明定位修改区域；通用画面规则仍由管理员的图片编辑提示词统一控制。</p></>}
        <label className={styles.feeConfirmation}><input className={styles.feeCheckboxInput} type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/><span className={styles.feeCheckboxVisual} data-fee-checkbox aria-hidden="true"/><span>确认调用图片编辑与实体校验模型，会产生费用；自动修复和人工重试也可能收费。</span></label>
        <div className={styles.actions}><Button variant="outline" disabled={busy} onClick={()=>void submit(true)}>{busy?'处理中…':'保存草稿'}</Button><Button disabled={busy} onClick={()=>void submit()}>{busy?'处理中…':'生成修改预览'}</Button></div>
        <label>历史图片版本<select value={history} onChange={e=>setHistory(e.target.value)}><option value="">选择要恢复的图集</option>{runs.filter(r=>r.id!==runId).map(r=><option key={r.id} value={r.id}>{labels[r.result?.processing?.type??'']??'原始生成'} · {r.id.slice(0,8)}</option>)}</select></label>
        <Button variant="outline" disabled={!history||busy} onClick={()=>void act(()=>post(`/v1/tasks/${taskId}/image-versions/${history}/restore`,{...base(),instruction:'恢复历史图片版本'}),'正在创建恢复预览…','恢复预览请求已提交。')}>生成恢复预览</Button>
      </section></div>
    {latest?.result&&<section className={styles.comparison} aria-label="修改前后对比"><h3>修改前后滑动对比</h3><p>第 {latest.target_page} 页 · {labels[latest.operation]}</p><div className={styles.comparisonViewport}><div className={styles.comparisonImages} style={{width:320*zoom}}><img src={path(`/v1/assets/${latest.source_asset_id??asset.id}`)} alt="修改前"/><img src={path(`/v1/assets/${latest.result.asset_id}`)} alt="修改后" style={{clipPath:`inset(0 ${100-compare}% 0 0)`}}/></div></div><input aria-label="修改前后对比滑块" type="range" min="0" max="100" value={compare} onChange={e=>setCompare(Number(e.target.value))}/></section>}
    <label className={styles.reasonField}>操作原因（提交、采用、拒绝、重试或取消前必填）<input aria-label="采用拒绝重试原因" value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
    <ul className={styles.history} aria-label="图片修改记录">{edits.map(e=><li key={e.id}><strong>{labels[e.operation]} · {labels[e.status]}</strong><p>第 {e.target_page} 页 · {e.created_by} · {e.config.instruction}</p>{e.error&&<p role="alert">{e.error}</p>}
      {e.result&&<><Button onClick={()=>setComparisonId(e.id)}>对比此版本</Button><a href={path(`/v1/assets/${e.result.asset_id}`)} target="_blank" rel="noreferrer">打开此结果</a></>}
      {!!(e.result?.validation??e.validation)&&<details><summary>质量校验记录</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(e.result?.validation??e.validation,null,2)}</pre></details>}
      {!!e.events?.length&&<details><summary>操作审计</summary><ul>{e.events.map((event,index)=><li key={index}>{event.actor} · {event.action} · {event.reason}</li>)}</ul></details>}
      {(e.status==='PREVIEW_READY'?['accept','reject','cancel']:e.status==='FAILED'?['retry']:e.status==='DRAFT'?['queue','cancel']:['QUEUED','RUNNING'].includes(e.status)?['cancel']:[]).map(action=><Button key={action} disabled={busy} onClick={()=>void runHistoryAction(e,action)}>{({accept:'采用此版本',reject:'拒绝',cancel:'取消',retry:'重试（AI 可能再次收费）',queue:'提交草稿'})[action as 'accept']}</Button>)}
    </li>)}</ul>
    </div>
    <footer className={styles.footer}><DialogClose asChild><Button variant="outline" type="button">关闭工作台</Button></DialogClose></footer>
  </DialogContent></Dialog></>;
}
