'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { apiRequest } from './api-client';
import { createRequestId } from './request-id';

type Asset = { id: number; sha256: string; url: string };
type Ref = Asset & { purpose: string; x: number; y: number; width: number; height: number; opacity: number; z: number; removeBackground: boolean; crop?: {x:number;y:number;width:number;height:number} };
type Edit = { id: string; version: number; status: string; operation: string; source_asset_id?:number; target_page:number; created_by:string; validation?:unknown; events?:Array<{action:string;actor:string;reason:string}>; error: string | null; config: {instruction:string}; result?: {asset_id: number; image_run_id: string; validation: unknown} };
const labels: Record<string,string> = {DRAFT:'草稿',QUEUED:'排队中',RUNNING:'执行与校验中',PREVIEW_READY:'预览待确认',ACCEPTED:'已采用',REJECTED:'已拒绝',FAILED:'失败',CANCELLED:'已取消',TEXT:'AI 文字改图',COMPOSITE:'实体合成',AI_FUSION:'AI 融合',AI_LOCAL:'AI 局部修改',AI_FULL:'AI 整图修改',RESTORE:'恢复版本',REGENERATE:'重新生成',REPROCESS:'格式处理'};
const path=(url:string)=>`/api/control-plane${url}`;
const post=(url:string,body:unknown)=>apiRequest(path(url),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
export function CurrentImageEditor({taskId,runId,copyRevisionId,asset,page,runs,onChanged}: {
  taskId:number;runId:string;copyRevisionId:number;asset:Asset;page:number;
  runs:Array<{id:string;result:{processing?:{type:string}}|null}>;onChanged:()=>Promise<void>;
}) {
  const [open,setOpen]=useState(false),[tab,setTab]=useState('TEXT'),[fusion,setFusion]=useState(false),[local,setLocal]=useState(false);
  const [text,setText]=useState('AI生成'),[textType,setTextType]=useState('AI_DISCLOSURE'),[disclosure,setDisclosure]=useState(true),[position,setPosition]=useState('bottom-right');
  const [size,setSize]=useState(32),[margin,setMargin]=useState(32),[opacity,setOpacity]=useState(1),[color,setColor]=useState('#ffffff'),[background,setBackground]=useState('#111827');
  const [x,setX]=useState(100),[y,setY]=useState(500),[width,setWidth]=useState(300),[height,setHeight]=useState(300);
  const [instruction,setInstruction]=useState(''),[preserve,setPreserve]=useState('保留原有标题、正文要点、AI 标识'),[negative,setNegative]=useState('');
  const [confirmed,setConfirmed]=useState(false),[refs,setRefs]=useState<Ref[]>([]),[source,setSource]=useState(''),[edits,setEdits]=useState<Edit[]>([]);
  const [busy,setBusy]=useState(false),[error,setError]=useState(''),[compare,setCompare]=useState(50),[zoom,setZoom]=useState(1),[history,setHistory]=useState(''),[reason,setReason]=useState('');
  const [maskType,setMaskType]=useState('rect'),[points,setPoints]=useState<Array<{x:number;y:number}>>([]),[radius,setRadius]=useState(30);
  const [comparisonId,setComparisonId]=useState('');
  const drawing=useRef(false),origin=useRef({x:0,y:0});
  const refresh=useCallback(async()=>setEdits(await apiRequest<Edit[]>(path(`/v1/tasks/${taskId}/image-edits`))),[taskId]);
  useEffect(()=>{if(!open)return;let active=true;const poll=()=>{if(active)void refresh().catch(e=>setError(e.message));};poll();const timer=setInterval(poll,4000);return()=>{active=false;clearInterval(timer);};},[open,refresh]);
  const operation=tab==='TEXT'?'TEXT':tab==='ENTITY'?(fusion?'AI_FUSION':'COMPOSITE'):(local?'AI_LOCAL':'AI_FULL');
  const ai=operation==='TEXT'||operation.startsWith('AI_');
  const base=()=>({requestId:createRequestId(),sourceImageRunId:runId,sourceAssetId:asset.id,copyRevisionId,sha256:asset.sha256,targetPage:page});
  async function act(action:()=>Promise<unknown>) {setBusy(true);setError('');try{await action();await refresh();await onChanged();}catch(e){setError(e instanceof Error?e.message:'操作失败');}finally{setBusy(false);}}
  function submit(draft=false) {return act(()=>post(`/v1/tasks/${taskId}/image-edits`,{...base(),operation,instruction,preserve,negative,
    overlay:{text,textType,size,margin,opacity,color,background,position,x,y,disclosureType:disclosure?'AI_GENERATED':null},
    references:tab==='ENTITY'?refs.map(r=>({...r,assetId:r.id})):[],mask:maskType==='rect'?{type:'rect',x,y,width,height}:{type:'brush',points,radius},
    confirmation:confirmed?'LIVE_IMAGE_COST_ACCEPTED':undefined,draft}));}
  async function upload(files:FileList|null) {
    if(!files)return;
    const selected=Array.from(files);
    if(refs.length+selected.length>4||selected.some(f=>f.size>5*1024*1024)||!source.trim()){setError('请填写来源说明，最多 4 张，每张不超过 5 MB');return;}
    await act(async()=>{for(const file of selected){
      const base64=await new Promise<string>((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file);});
      const saved=await apiRequest<Asset>(path(`/v1/tasks/${taskId}/image-edit-references`),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({base64,mediaType:file.type,source,purpose:'实体参考'})});
      setRefs(current=>[...current,{...saved,purpose:'实体参考',x:100,y:500,width:300,height:300,opacity:1,z:current.length,removeBackground:false}]);
    }});
  }
  const latest=edits.find(e=>e.id===comparisonId&&e.result)??edits.find(e=>e.status==='PREVIEW_READY'&&e.target_page===page);
  const textWidth=Array.from(text).length*size+24,textHeight=Math.ceil(size*1.5)+16;
  const tx=position==='custom'?x:position.endsWith('left')?margin:['top','bottom'].includes(position)?(1086-textWidth)/2:1086-margin-textWidth;
  const ty=position==='custom'?y:position.startsWith('top')?margin:1448-margin-textHeight;
  const numberField=(label:string,value:number,change:(v:number)=>void,min:number,max:number,step=1)=><label style={{display:'inline-flex',gap:6,alignItems:'center',margin:4}}>{label}<input aria-label={label} type="number" value={value} min={min} max={max} step={step} onChange={e=>change(Number(e.target.value))} style={{width:80}}/></label>;
  return <><Button type="button" onClick={()=>setOpen(true)}>修改图片</Button><Dialog open={open} onOpenChange={setOpen}><DialogContent style={{maxWidth:1100,maxHeight:'92vh',overflow:'auto'}}>
    <DialogTitle>当前图片修改工作台 · 第 {page} 页</DialogTitle><DialogDescription>结果先生成预览。明确采用后需重新图片审核，原图和其他页面保留。</DialogDescription>
    <div role="tablist" aria-label="图片修改方式">{[['TEXT','添加文字'],['ENTITY','实体图片'],['PROMPT','提示词修改']].map(([key,label])=><Button key={key} role="tab" aria-selected={tab===key} onClick={()=>{setTab(key);setConfirmed(false);}}>{label}</Button>)}</div>
    <div style={{display:'grid',gridTemplateColumns:'minmax(240px,1fr) minmax(280px,1fr)',gap:20}}>
      <div style={{overflow:'auto'}}>
        <svg role="img" aria-label="实时修改预览与局部选区" viewBox="0 0 1086 1448" style={{width:`${zoom*100}%`,touchAction:'none',background:'#eee'}}
          onPointerDown={e=>{if(tab!=='PROMPT'||!local)return;const b=e.currentTarget.getBoundingClientRect();const p={x:Math.max(0,Math.min(1085,Math.round((e.clientX-b.left)*1086/b.width))),y:Math.max(0,Math.min(1447,Math.round((e.clientY-b.top)*1448/b.height)))};origin.current=p;drawing.current=true;e.currentTarget.setPointerCapture(e.pointerId);if(maskType==='brush')setPoints([p]);else{setX(p.x);setY(p.y);setWidth(1);setHeight(1);}}}
          onPointerMove={e=>{if(!drawing.current)return;const b=e.currentTarget.getBoundingClientRect();const p={x:Math.max(0,Math.min(1085,Math.round((e.clientX-b.left)*1086/b.width))),y:Math.max(0,Math.min(1447,Math.round((e.clientY-b.top)*1448/b.height)))};if(maskType==='brush')setPoints(ps=>ps.length<2000?[...ps,p]:ps);else{setX(Math.min(p.x,origin.current.x));setY(Math.min(p.y,origin.current.y));setWidth(Math.max(1,Math.abs(p.x-origin.current.x)));setHeight(Math.max(1,Math.abs(p.y-origin.current.y)));}}} onPointerUp={()=>{drawing.current=false;}} onPointerCancel={()=>{drawing.current=false;}}>
          <image href={path(asset.url)} width="1086" height="1448"/>
          {tab==='TEXT'&&<g opacity={opacity}><rect x={tx} y={ty} width={textWidth} height={textHeight} rx="8" fill={background}/><text x={tx+12} y={ty+8+size} fill={color} fontSize={size} fontFamily="Noto Sans CJK SC,Microsoft YaHei,sans-serif">{text}</text></g>}
          {tab==='ENTITY'&&!fusion&&[...refs].sort((a,b)=>a.z-b.z).map(r=><image key={r.id} href={path(r.url)} x={r.x} y={r.y} width={r.width} height={r.height} opacity={r.opacity} preserveAspectRatio="none"/>)}
          {tab==='PROMPT'&&local&&(maskType==='rect'?<rect x={x} y={y} width={width} height={height} fill="#22c55e66" stroke="#16a34a" strokeWidth="4"/>:<g fill="#22c55e88" stroke="#22c55e88" strokeWidth={radius*2} strokeLinecap="round"><polyline fill="none" points={points.map(p=>`${p.x},${p.y}`).join(' ')}/>{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={radius} stroke="none"/>)}</g>)}
        </svg>
        <label>缩放<input aria-label="预览缩放" type="range" min="1" max="3" step="0.1" value={zoom} onChange={e=>setZoom(Number(e.target.value))}/></label>
        <p>文字框仅用于向 AI 指定版式区域，不是程序叠字效果。最终结果以 AI 改图预览为准；错字、重复文字、位置偏离或遮挡原文都会被拒绝。</p>
      </div><div>
        {tab==='TEXT'&&<><label>指定短句<input aria-label="指定短句" maxLength={48} value={text} onChange={e=>{setText(e.target.value);setDisclosure(false);if(textType==='AI_DISCLOSURE')setTextType('CUSTOM');}}/></label><Button onClick={()=>{setText('AI生成');setTextType('AI_DISCLOSURE');setDisclosure(true);}}>AI生成预设</Button>
          <label>文本类型<select aria-label="文本类型" value={textType} onChange={e=>{setTextType(e.target.value);setDisclosure(e.target.value==='AI_DISCLOSURE');}}>{[['HEADLINE','标题'],['SUBTITLE','副标题'],['BULLET','正文要点'],['LABEL','标签'],['AI_DISCLOSURE','AI 生成标识'],['CUSTOM','自定义短句']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          <label><input type="checkbox" checked={disclosure} onChange={e=>{setDisclosure(e.target.checked);if(e.target.checked)setTextType('AI_DISCLOSURE');else if(textType==='AI_DISCLOSURE')setTextType('CUSTOM');}}/>记录为 AI 合规标识</label>
          <label>位置<select aria-label="文字位置" value={position} onChange={e=>setPosition(e.target.value)}>{[['top-left','左上'],['top-right','右上'],['bottom-left','左下'],['bottom-right','右下'],['top','顶部'],['bottom','底部'],['custom','自定义安全区域']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
          {numberField('字号',size,setSize,16,100)}{numberField('边距',margin,setMargin,16,160)}{numberField('透明度',opacity,setOpacity,.1,1,.05)}
          <label>文字颜色<input type="color" value={color} onChange={e=>setColor(e.target.value)}/></label><label>底色<input type="color" value={background} onChange={e=>setBackground(e.target.value)}/></label>
          {position==='custom'&&<>{numberField('横坐标',x,setX,16,1085)}{numberField('纵坐标',y,setY,16,1447)}</>}
          <p>系统将按指定图片、短句、文本类型和版式要求调用 AI 图片编辑；本地 OCR 最多驱动 3 次自动修复，不会用程序叠字兜底。</p></>}
        {tab==='ENTITY'&&<><label>合成模式<select value={fusion?'AI':'EXACT'} onChange={e=>{setFusion(e.target.value==='AI');setConfirmed(false);}}><option value="EXACT">精确合成（推荐保留真实细节）</option><option value="AI">AI 融合</option></select></label><p>AI 融合可能改变实体细节。</p>
          <label>用途及来源说明<input aria-label="参考图来源说明" value={source} maxLength={1000} onChange={e=>setSource(e.target.value)}/></label><input aria-label="上传实体参考图" type="file" accept="image/png,image/jpeg,image/webp" multiple disabled={busy} onChange={e=>void upload(e.target.files)}/>
          {refs.map((r,i)=><fieldset key={r.id}><legend>参考图 {i+1}</legend><img src={path(r.url)} alt={`参考图 ${i+1}`} width={70}/><Button onClick={()=>setRefs(rs=>rs.filter(a=>a.id!==r.id))}>移除</Button>
            {!fusion&&<>{(['x','y','width','height','z','opacity'] as const).map(key=>numberField(({x:'横坐标',y:'纵坐标',width:'宽度',height:'高度',z:'层级',opacity:'透明度'})[key]+` ${i+1}`,r[key],v=>setRefs(rs=>rs.map(a=>a.id===r.id?{...a,[key]:v}:a)),key==='opacity'?.01:0,key==='opacity'?1:1448,key==='opacity'?.05:1))}
              <label><input type="checkbox" checked={r.removeBackground} onChange={e=>setRefs(rs=>rs.map(a=>a.id===r.id?{...a,removeBackground:e.target.checked}:a))}/>移除纯白背景（确定性抠图）</label>
              <label><input type="checkbox" checked={!!r.crop} onChange={e=>setRefs(rs=>rs.map(a=>a.id===r.id?{...a,crop:e.target.checked?{x:0,y:0,width:100,height:100}:undefined}:a))}/>裁剪参考图</label>
              {r.crop&&(['x','y','width','height'] as const).map(key=>numberField(`裁剪 ${key} ${i+1}`,r.crop![key],v=>setRefs(rs=>rs.map(a=>a.id===r.id?{...a,crop:{...a.crop!,[key]:v}}:a)),0,16000))}</>}
          </fieldset>)}</>}
        {tab==='PROMPT'&&<><label><input type="checkbox" checked={local} onChange={e=>setLocal(e.target.checked)}/>局部修改（选区外像素不变）</label>{local&&<><label>选区方式<select value={maskType} onChange={e=>setMaskType(e.target.value)}><option value="rect">矩形</option><option value="brush">画笔</option></select></label><p>在左侧图片拖动绘制选区。</p>{maskType==='brush'?numberField('画笔半径',radius,setRadius,2,150):<>{numberField('选区横坐标',x,setX,0,1085)}{numberField('选区纵坐标',y,setY,0,1447)}{numberField('选区宽度',width,setWidth,1,1086)}{numberField('选区高度',height,setHeight,1,1448)}</>}</>}</>}
        {ai&&<><label>修改要求<textarea aria-label="图片修改要求" value={instruction} maxLength={2000} placeholder={tab==='TEXT'?'描述字体、排版、与画面融合方式；短句本身以上方输入为准':'替换背景、删除物体、改变颜色、增加物体、调整人物服装'} onChange={e=>setInstruction(e.target.value)}/></label><label>必须保留<textarea value={preserve} maxLength={2000} onChange={e=>setPreserve(e.target.value)}/></label><label>负面要求<textarea value={negative} maxLength={2000} onChange={e=>setNegative(e.target.value)}/></label><label><input type="checkbox" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)}/>确认调用图片编辑与实体校验模型，会产生费用；自动修复和人工重试也可能收费。</label></>}
        <div><Button disabled={busy||(ai&&!confirmed)} onClick={()=>void submit(true)}>保存草稿</Button><Button disabled={busy||(ai&&!confirmed)} onClick={()=>void submit()}>生成修改预览</Button></div>
        <label>历史图片版本<select value={history} onChange={e=>setHistory(e.target.value)}><option value="">选择要恢复的图集</option>{runs.filter(r=>r.id!==runId).map(r=><option key={r.id} value={r.id}>{labels[r.result?.processing?.type??'']??'原始生成'} · {r.id.slice(0,8)}</option>)}</select></label>
        <Button disabled={!history||busy} onClick={()=>void act(()=>post(`/v1/tasks/${taskId}/image-versions/${history}/restore`,{...base(),instruction:'恢复历史图片版本'}))}>生成恢复预览</Button>
      </div></div>
    {error&&<p role="alert">{error}</p>}
    {latest?.result&&<section aria-label="修改前后对比" style={{overflow:'auto'}}><h3>修改前后滑动对比</h3><p>第 {latest.target_page} 页 · {labels[latest.operation]}</p><div style={{position:'relative',width:320*zoom,aspectRatio:'3/4'}}><img src={path(`/v1/assets/${latest.source_asset_id??asset.id}`)} alt="修改前" style={{width:'100%',height:'100%',position:'absolute'}}/><img src={path(`/v1/assets/${latest.result.asset_id}`)} alt="修改后" style={{width:'100%',height:'100%',position:'absolute',clipPath:`inset(0 ${100-compare}% 0 0)`}}/></div><input aria-label="修改前后对比滑块" type="range" min="0" max="100" value={compare} onChange={e=>setCompare(Number(e.target.value))}/></section>}
    <label>操作原因<input aria-label="采用拒绝重试原因" value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)}/></label>
    <ul aria-label="图片修改记录">{edits.map(e=><li key={e.id}><strong>{labels[e.operation]} · {labels[e.status]}</strong><p>第 {e.target_page} 页 · {e.created_by} · {e.config.instruction}</p>{e.error&&<p role="alert">{e.error}</p>}
      {e.result&&<><Button onClick={()=>setComparisonId(e.id)}>对比此版本</Button><a href={path(`/v1/assets/${e.result.asset_id}`)} target="_blank" rel="noreferrer">打开此结果</a></>}
      {!!(e.result?.validation??e.validation)&&<details><summary>质量校验记录</summary><pre style={{whiteSpace:'pre-wrap'}}>{JSON.stringify(e.result?.validation??e.validation,null,2)}</pre></details>}
      {!!e.events?.length&&<details><summary>操作审计</summary><ul>{e.events.map((event,index)=><li key={index}>{event.actor} · {event.action} · {event.reason}</li>)}</ul></details>}
      {(e.status==='PREVIEW_READY'?['accept','reject','cancel']:e.status==='FAILED'?['retry']:e.status==='DRAFT'?['queue','cancel']:['QUEUED','RUNNING'].includes(e.status)?['cancel']:[]).map(action=><Button key={action} disabled={busy||!reason.trim()} onClick={()=>void act(()=>post(`/v1/image-edits/${e.id}/${action}`,{requestId:createRequestId(),version:e.version,reason}))}>{({accept:'采用此版本',reject:'拒绝',cancel:'取消',retry:'重试（AI 可能再次收费）',queue:'提交草稿'})[action as 'accept']}</Button>)}
    </li>)}</ul><Button onClick={()=>setOpen(false)}>关闭工作台</Button>
  </DialogContent></Dialog></>;
}
