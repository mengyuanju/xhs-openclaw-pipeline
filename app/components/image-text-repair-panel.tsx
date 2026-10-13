'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox, Input, Textarea } from '@/components/ui/input';
import { createRequestId } from './request-id';
import styles from './image-text-repair-panel.module.css';

export type TextRepairRegion = { x:number; y:number; width:number; height:number };
export type TextRepairItem = { id:string; correctText:string; contextText:string; region:TextRepairRegion|null };
type Check = { passed?:boolean; reason?:string; method?:string };
type Reference = { text:string; status:string; assetId?:number; url?:string; validation?:Check; error?:string; message?:string };
type Location = { id:string; correctText:string; status:string; rect?:TextRepairRegion; assetId?:number; url?:string; validation?:Check; error?:string; message?:string };
export type TextRepairState = { references?:Reference[]; locations?:Location[] };

export function newTextRepairItem():TextRepairItem {
  return { id:createRequestId(),correctText:'',contextText:'',region:null };
}

export function textRepairIssue(items:TextRepairItem[]) {
  if(!items.length||items.length>16)return '请添加 1～16 处错字修正。';
  for(const [index,item] of items.entries()) {
    const length=Array.from(item.correctText.trim()).length;
    if(!length||length>8)return `请填写第 ${index+1} 处正确文字，最多 8 个字。`;
    if(!item.region)return `请在原图框选第 ${index+1} 处错字所在的一句话或小段文字。`;
  }
  return '';
}

export function textRepairReady(state:TextRepairState|undefined,items:TextRepairItem[]) {
  if(!items.length)return false;
  const texts=[...new Set(items.map(item=>item.correctText.trim()))];
  return texts.every(text=>state?.references?.some(reference=>reference.text===text&&reference.status==='READY'&&reference.validation?.passed===true))
    &&items.every(item=>state?.locations?.some(location=>location.id===item.id&&location.status==='COMPLETED'&&location.validation?.passed===true));
}

export function TextRepairPanel({items,activeId,onChange,onSelect,disabled=false}:{
  items:TextRepairItem[]; activeId:string; onChange:(items:TextRepairItem[])=>void; onSelect:(id:string)=>void; disabled?:boolean;
}) {
  function update(id:string,patch:Partial<TextRepairItem>) {onChange(items.map(item=>item.id===id?{...item,...patch}:item));}
  return <section className={styles.planner} aria-label="错字修正项">
    <p className={styles.reminder}>先输入正确的字，再在原图框选错字所在的一句话或小段文字。周围文字有助于匹配字体、字号、颜色和位置。</p>
    <p className={styles.help}>一处位置建立一个修正项；同一段话有多个错字时可以使用相同的框。相同正确文字会共用一张标准字体参考图。</p>
    {items.map((item,index)=><section className={styles.item} key={item.id} data-active={item.id===activeId} aria-label={`第 ${index+1} 处错字`}>
      <div className={styles.heading}><strong>第 {index+1} 处</strong><Button size="sm" variant="outline" type="button" disabled={disabled} aria-pressed={item.id===activeId} onClick={()=>onSelect(item.id)}>{item.id===activeId?'正在框选此处':'框选此处'}</Button>{items.length>1&&<Button size="sm" variant="outline" type="button" disabled={disabled} onClick={()=>{const next=items.filter(value=>value.id!==item.id);onChange(next);if(activeId===item.id)onSelect(next[0].id);}}>移除</Button>}</div>
      <label>正确文字<Input aria-label={`第 ${index+1} 处正确文字`} value={item.correctText} maxLength={16} disabled={disabled} placeholder="例如：滩" onFocus={()=>onSelect(item.id)} onChange={event=>update(item.id,{correctText:event.target.value})}/><small>填写需要替换的正确字形，最多 8 个字。</small></label>
      <label>正确词句（可选）<Textarea aria-label={`第 ${index+1} 处正确词句`} value={item.contextText??''} maxLength={500} disabled={disabled} placeholder="例如：看当天的天气和海滩开放信息" onChange={event=>update(item.id,{contextText:event.target.value})}/><small>框内有重复的字时，填写所在词句帮助定位。</small></label>
      <div className={styles.selection} role="status"><span>{item.region?'已框选所在文字段落':'待框选：在原图上拖动，包含错字及周围文字'}</span>{item.region&&<Button size="sm" variant="outline" type="button" disabled={disabled} onClick={()=>{update(item.id,{region:null});onSelect(item.id);}}>重新框选</Button>}</div>
    </section>)}
    <Button size="sm" variant="outline" type="button" disabled={disabled||items.length>=16} onClick={()=>{const item=newTextRepairItem();onChange([...items,item]);onSelect(item.id);}}>添加另一处错字</Button>
    <p className={styles.help}>提交后由标准字体绘制参考图；模型负责定位、复杂背景清理和视觉检查，最终文字由程序排字合成。请检查修改预览后采用。</p>
  </section>;
}

const statusLabels:Record<string,string>={PENDING:'等待处理',QUEUED:'排队中',GENERATING:'正在准备参考',RUNNING:'处理中',GENERATED:'参考已准备',VALIDATING:'校验中',READY:'已就绪',PASSED:'校验通过',COMPLETED:'已完成',FAILED:'失败',LOCATING:'定位中',LOCALIZING:'定位中',REPAIRING:'排字修正中'};
function statusLabel(status:string) {return statusLabels[status]??status;}
function RepairMessage({entry}:{entry:Reference|Location}) {
  const reason=typeof entry.validation?.reason==='string'?entry.validation.reason.trim():'';
  const message=entry.status==='FAILED'&&reason?reason:entry.error||entry.message||reason;
  return message?<small>{message}</small>:null;
}
function validRegion(region:TextRepairRegion|undefined):region is TextRepairRegion {
  return Boolean(region&&[region.x,region.y,region.width,region.height].every(Number.isFinite)&&region.x>=0&&region.y>=0&&region.width>0&&region.height>0&&region.x+region.width<=1086&&region.y+region.height<=1448);
}

export function TextRepairProgress({state,items,sourceUrl,assetUrl,status,attempts=0,disabled=false,onRegenerate}:{
  state?:TextRepairState; items:TextRepairItem[]; sourceUrl:string; assetUrl:(url:string)=>string; status:string; attempts?:number; disabled?:boolean; onRegenerate:(text:string)=>void;
}) {
  const [regenerateConfirmed,setRegenerateConfirmed]=useState(false);
  const references:Reference[]=[...new Set(items.map(item=>item.correctText.trim()).filter(Boolean))].map(text=>state?.references?.find(reference=>reference.text===text)??{text,status:'PENDING'});
  const locations:Location[]=items.map(item=>state?.locations?.find(location=>location.id===item.id)??{id:item.id,correctText:item.correctText,status:'PENDING'});
  const canRegenerate=['FAILED','PREVIEW_READY'].includes(status)&&attempts<3&&!disabled;
  return <section className={styles.progress} aria-label="文字参考与修正进度" data-status={status}>
    <strong>文字字形参考图</strong>
    <p className={styles.help}>新参考由标准字体直接绘制，无需 AI 生图；模型用于定位、复杂背景清理和视觉检查，最终文字由程序合成。历史参考保留其原来源。</p>
    <div className={styles.referenceGrid}>{references.map(reference=>{
      const standardFont=reference.validation?.method==='STANDARD_FONT';
      return <section className={styles.reference} key={reference.text} aria-label={`文字 ${reference.text} 的参考图`}>
      <div className={styles.heading}><strong>{reference.text}</strong><span>{statusLabel(reference.status)}</span></div>
      {reference.url?<><a href={assetUrl(reference.url)} target="_blank" rel="noreferrer" title={`放大查看 ${reference.text} 的参考图`}><img src={assetUrl(reference.url)} alt={`${standardFont?'标准字体绘制的':'已保存的'} ${reference.text} 字形参考图`}/></a><small>{standardFont?'标准字体排字':'历史参考图（未标记标准字体来源）'}</small></>:<div className={styles.placeholder}>参考图准备后显示</div>}
      <RepairMessage entry={reference}/>
      {canRegenerate&&<Button size="sm" variant="outline" type="button" disabled={!regenerateConfirmed} onClick={()=>{setRegenerateConfirmed(false);onRegenerate(reference.text);}}>重新排字并重做关联位置</Button>}
    </section>;})}</div>
    {canRegenerate&&<label className={styles.regenerateConfirmation}><Checkbox checked={regenerateConfirmed} onChange={event=>setRegenerateConfirmed(event.target.checked)}/><span>确认重新排字后，关联位置的定位、复杂背景清理和视觉校验可能再次调用模型并产生费用。</span></label>}
    <strong>逐处修正与对比</strong>
    {locations.map((location,index)=>{
      const rect=location.rect;
      return <section className={styles.location} key={location.id} aria-label={`第 ${index+1} 处修正结果`}><div className={styles.heading}><strong>第 {index+1} 处 · {location.correctText}</strong><span>{statusLabel(location.status)}</span></div>
        {location.url&&validRegion(rect)&&<div className={styles.comparison}><figure><svg viewBox={`${rect.x} ${rect.y} ${rect.width} ${rect.height}`} role="img" aria-label={`第 ${index+1} 处修改前`}><image href={sourceUrl} x="0" y="0" width="1086" height="1448"/></svg><figcaption>修改前</figcaption></figure><figure><a href={assetUrl(location.url)} target="_blank" rel="noreferrer"><img src={assetUrl(location.url)} alt={`第 ${index+1} 处修改后`}/></a><figcaption>修改后</figcaption></figure></div>}
        <RepairMessage entry={location}/>
      </section>;
    })}
    {status==='FAILED'&&<p className={styles.help}>本次自动校验未通过，请查看各项的具体原因。参考图和修正片段会保留供检查；有完整结果时，可以在编辑记录中自行决定采用。明确重试会复用本次已通过的标准字体参考与位置；重新排字会重做关联位置。系统不会自动重试，定位、复杂背景清理和视觉校验可能再次产生模型费用。</p>}
    {attempts>=3&&['FAILED','PREVIEW_READY'].includes(status)&&<p className={styles.help}>已达到本次请求的三次执行上限；需要继续修改时，可以复用错字位置创建新请求。</p>}
  </section>;
}
