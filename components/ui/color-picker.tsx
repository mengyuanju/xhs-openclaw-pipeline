'use client';

import { useEffect, useId, useState } from 'react';
import { Button } from './button';
import { Input } from './input';

const SWATCHES = ['#FFFFFF', '#F8F4EA', '#FCE7E9', '#DBEAFE', '#DCFCE7', '#18181B'];

export function ColorPicker({ id, value, disabled, onValueChange }: {
  id: string; value: string; disabled?: boolean; onValueChange: (value: string) => void;
}) {
  const errorId = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  const valid = /^#[\da-f]{6}$/i.test(draft);
  return <div className="ui-color-picker">
    <div className="ui-color-value"><span className="ui-color-preview" style={{ backgroundColor: value }} aria-hidden="true" />
      <Input id={id} value={draft} disabled={disabled} maxLength={7} spellCheck={false} placeholder="#FFFFFF"
        aria-invalid={!valid} aria-describedby={valid ? undefined : errorId}
        onChange={event => { setDraft(event.target.value); if (/^#[\da-f]{6}$/i.test(event.target.value)) onValueChange(event.target.value.toUpperCase()); }} />
    </div>
    <div className="ui-color-swatches" role="group" aria-label="常用填充色">{SWATCHES.map(color =>
      <Button unstyled type="button" key={color} disabled={disabled} className="ui-color-swatch" style={{ backgroundColor: color }}
        aria-label={`填充色 ${color}`} aria-pressed={value.toUpperCase() === color} onClick={() => { setDraft(color); onValueChange(color); }} />
    )}</div>
    {!valid && <small id={errorId} role="alert">请输入 # 和六位十六进制颜色值；当前仍使用 {value}。</small>}
  </div>;
}
