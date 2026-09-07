'use client';

import { Slider, Textarea } from '@/components/ui/input';
import { ColorPicker } from '@/components/ui/color-picker';

import { useId } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { DEFAULT_IMAGE_SETTINGS, IMAGE_FORMATS, normalizePageLayout } from '../../server/src/image-options.mjs';

export type ImageSettings = { version: number; format: string; quality: number; background: string; backgroundColor: string };
export type PageLayout = { mode: string; template?: string; titlePosition?: string; subjectPosition?: string; textPosition?: string; alignment?: string; imageShare?: number; spacing?: string; direction?: string };
export const defaultImageSettings: ImageSettings = { ...DEFAULT_IMAGE_SETTINGS };

function Choice({ label, value, choices, disabled, onChange }: { label: string; value: string; choices: string[][]; disabled?: boolean; onChange: (value: string) => void }) {
  const id = useId();
  return <div className="field"><label htmlFor={id}>{label}</label>
    <Select value={value} disabled={disabled} onValueChange={onChange}>
      <SelectTrigger id={id}><SelectValue /></SelectTrigger>
      <SelectContent>{choices.map(([key, title]) => <SelectItem value={key} key={key}>{title}</SelectItem>)}</SelectContent>
    </Select>
  </div>;
}

export function ImageSettingsEditor({ value, onChange, disabled = false }: { value: ImageSettings; onChange: (value: ImageSettings) => void; disabled?: boolean }) {
  const id = useId();
  const patch = (fields: Partial<ImageSettings>) => onChange({ ...value, ...fields });
  return <fieldset className="image-controls" disabled={disabled}>
    <legend>交付格式与背景</legend>
    <div className="image-controls-grid">
      <Choice disabled={disabled} label="文件格式" value={value.format} choices={Object.keys(IMAGE_FORMATS).map(format => [format, format === 'JPEG' ? 'JPEG / JPG' : format])} onChange={format => patch({ format, ...(format === 'JPEG' ? { background: 'SOLID' } : {}) })} />
      <Choice disabled={disabled} label="背景处理" value={value.background} choices={value.format === 'JPEG' ? [['SOLID', '实底（JPEG 不支持透明）']] : [['SOLID', '实底成品'], ['TRANSPARENT', '保留透明背景']]} onChange={background => patch({ background })} />
      <div className="field"><label htmlFor={`${id}-color`}>透明区域填充色</label><ColorPicker id={`${id}-color`} value={value.backgroundColor} disabled={disabled || value.background === 'TRANSPARENT'} onValueChange={backgroundColor => patch({ backgroundColor })} /></div>
      <div className="field"><label htmlFor={`${id}-quality`}>编码质量 · {value.quality}</label><Slider id={`${id}-quality`}  min={1} max={100} value={value.quality} disabled={['PNG', 'TIFF', 'GIF'].includes(value.format)} onChange={event => patch({ quality: Number(event.target.value) })} /><small>{['PNG', 'TIFF', 'GIF'].includes(value.format) ? '此格式不使用质量滑杆' : '较高质量通常产生较大的文件'}</small></div>
    </div>
    <p className="subtle">实底只填充透明像素，不会重绘已有背景；若棋盘格被画进图片，需重新生图。GIF 为静态图，半透明边缘会转为有限透明度；TIFF 使用 PNG 成品预览。尺寸沿用 1086 × 1448。</p>
  </fieldset>;
}

const positions = { titlePosition: [['top-left', '左上'], ['top-center', '上方居中'], ['top-right', '右上'], ['bottom', '底部']],
  subjectPosition: [['left', '左侧'], ['center', '中央'], ['right', '右侧'], ['top', '上方'], ['bottom', '下方'], ['full', '铺满画面']],
  textPosition: [['left', '左侧'], ['right', '右侧'], ['top', '上方'], ['bottom', '下方'], ['overlay', '融入主体画面']],
  alignment: [['left', '左对齐'], ['center', '居中'], ['right', '右对齐']], spacing: [['compact', '紧凑'], ['normal', '适中'], ['airy', '宽松']] };

export function PageLayoutEditor({ kind, value, onChange, disabled = false }: { kind: string; value?: PageLayout; onChange: (value: PageLayout) => void; disabled?: boolean }) {
  const id = useId();
  const custom = normalizePageLayout(value ?? { mode: 'CUSTOM' }, kind);
  const patch = (fields: Partial<PageLayout>) => onChange(normalizePageLayout({ ...custom, ...fields, mode: 'CUSTOM' }, kind));
  return <fieldset className="image-controls layout-controls" disabled={disabled}>
    <legend>布局格式</legend>
    {custom && <>
      <div className="image-controls-grid">
        {([['titlePosition', '标题位置'], ['subjectPosition', '主体位置'], ['textPosition', '文字区域'], ['alignment', '文字对齐'], ['spacing', '留白']] as const).map(([field, label]) => <Choice disabled={disabled} key={field} label={label} value={custom[field] ?? ''} choices={positions[field]} onChange={selected => patch({ [field]: selected })} />)}
        <div className="field"><label htmlFor={`${id}-share`}>主体占比 · {custom.imageShare}%</label><Slider id={`${id}-share`}  min={20} max={90} step={5} value={custom.imageShare} onChange={event => patch({ imageShare: Number(event.target.value) })} /></div>
      </div>
      <div className="layout-schematic" aria-label="布局意图示意，非成品预览" data-subject={custom.subjectPosition} data-text={custom.textPosition} data-title={custom.titlePosition}>
        <span className="layout-schematic-subject" style={{ opacity: 0.35 + (custom.imageShare ?? 60) / 200 }}>主体 · {custom.imageShare}%</span><span className="layout-schematic-text">文字区域</span><strong className="layout-schematic-title">标题</strong>
      </div>
      <p className="subtle">示意图表示区域意图，实际构图由模型生成，请以成品预览为准。</p>
      <div className="field"><label htmlFor={`${id}-direction`}>补充布局要求</label><Textarea id={`${id}-direction`} className="textarea compact" value={custom.direction} maxLength={1000} onChange={event => patch({ direction: event.target.value })} placeholder="例如：主体靠右，左侧文字按阅读顺序分三组；保留顶部留白。" /></div>
    </>}
  </fieldset>;
}
