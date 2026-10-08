'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Radio } from '@/components/ui/input';
import { AI_DISCLOSURE_DEFAULT_COLOR, normalizeAiDisclosureBadgeColor } from '../../src/ai-disclosure-badge.mjs';
import styles from './image-disclosure-color-control.module.css';

export type DisclosureColorMode = 'AUTO' | 'CUSTOM';
export const DISCLOSURE_COLOR_ERROR = `请输入有效的颜色值，例如 ${AI_DISCLOSURE_DEFAULT_COLOR}。`;

export function normalizeDisclosureBadgeColor(value:unknown):string|null {
  try{return normalizeAiDisclosureBadgeColor(value);}catch{return null;}
}

type EyeDropperInstance = { open:(options?:{signal:AbortSignal})=>Promise<{sRGBHex:string}> };
type EyeDropperWindow = Window & { EyeDropper?:new()=>EyeDropperInstance };

export function ImageDisclosureColorControl({mode,color,disabled,onModeChange,onColorChange}: {
  mode:DisclosureColorMode;color:string;disabled:boolean;
  onModeChange:(mode:DisclosureColorMode)=>void;onColorChange:(color:string)=>void;
}) {
  const id=useId();
  const [canPickScreen,setCanPickScreen]=useState(false);
  const [picking,setPicking]=useState(false),[pickerError,setPickerError]=useState('');
  const screenPickController=useRef<AbortController|null>(null);
  const normalizedColor=normalizeDisclosureBadgeColor(color);
  useEffect(()=>{
    setCanPickScreen(window.isSecureContext&&typeof (window as EyeDropperWindow).EyeDropper==='function');
    return ()=>screenPickController.current?.abort();
  },[]);
  useEffect(()=>{
    if(disabled)screenPickController.current?.abort();
  },[disabled]);
  async function pickScreenColor() {
    const EyeDropper=(window as EyeDropperWindow).EyeDropper;
    if(disabled||picking||!window.isSecureContext||!EyeDropper)return;
    const controller=new AbortController();
    screenPickController.current=controller;setPickerError('');setPicking(true);
    try {
      const selected=await new EyeDropper().open({signal:controller.signal});
      if(controller.signal.aborted)return;
      const nextColor=normalizeDisclosureBadgeColor(selected.sRGBHex);
      if(!nextColor)throw new TypeError('Invalid selected color');
      onColorChange(nextColor);
    } catch(error) {
      if(!controller.signal.aborted&&!(error instanceof Error&&error.name==='AbortError')) {
        setPickerError('屏幕取色未完成，请重试或使用取色器。');
      }
    } finally {
      if(screenPickController.current===controller) {
        screenPickController.current=null;setPicking(false);
      }
    }
  }
  function changeMode(nextMode:DisclosureColorMode) {
    setPickerError('');screenPickController.current?.abort();onModeChange(nextMode);
  }
  return <section className={styles.control} aria-label="程序标识颜色设置">
    <span className={styles.heading}>程序标识配色</span>
    <div className={styles.modes} role="radiogroup" aria-label="程序标识配色">
      <label><Radio className={styles.modeRadio} name={`${id}-color-mode`} aria-label="自动配色" checked={mode==='AUTO'} disabled={disabled||picking} onChange={()=>changeMode('AUTO')}/><span>自动配色</span></label>
      <label><Radio className={styles.modeRadio} name={`${id}-color-mode`} aria-label="自定义颜色" checked={mode==='CUSTOM'} disabled={disabled||picking} onChange={()=>changeMode('CUSTOM')}/><span>自定义颜色</span></label>
    </div>
    {mode==='CUSTOM'?<>
      <div className={styles.fields}>
        <label className={styles.pickerLabel}>取色器<Input type="color" className={styles.picker} aria-label="程序标识取色器" value={normalizedColor??AI_DISCLOSURE_DEFAULT_COLOR} disabled={disabled||picking} onChange={event=>{setPickerError('');onColorChange(event.target.value.toUpperCase());}}/></label>
        <label className={styles.hexLabel}>颜色值<Input aria-label="程序标识颜色值" aria-invalid={!normalizedColor} aria-describedby={!normalizedColor?`${id}-color-error`:undefined} value={color} maxLength={7} placeholder={AI_DISCLOSURE_DEFAULT_COLOR} spellCheck={false} autoComplete="off" disabled={disabled||picking} onChange={event=>{setPickerError('');onColorChange(event.target.value);}}/></label>
        {canPickScreen&&<Button className={styles.screenButton} variant="outline" size="sm" type="button" disabled={disabled||picking} onClick={()=>void pickScreenColor()}>{picking?'正在取色…':'屏幕取色'}</Button>}
      </div>
      {!normalizedColor&&<p id={`${id}-color-error`} className={styles.error} role="alert">{DISCLOSURE_COLOR_ERROR}</p>}
      {pickerError&&<p className={styles.error} role="alert">{pickerError}</p>}
      <small>描边徽章的文字与边框使用此色；实心徽章的底色与边框使用此色，文字自动选择黑色或白色。已选图片使用同一颜色。</small>
    </>:<small>生成时自动沿用每张图片的主题色。</small>}
  </section>;
}
