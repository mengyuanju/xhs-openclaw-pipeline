'use client';

import { ChevronDown, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import type { ImageQaPreviousReturn, QaPreviousReturn } from '../components/qa-previous-return.mjs';
import styles from './work-mode.module.css';

const TARGET_LABELS: Record<NonNullable<ImageQaPreviousReturn['reworkTarget']>, string> = {
  IMAGE: '仅图片', COPY: '仅文案', BOTH: '文案和图片',
};
const COPY_FIELD_LABELS: Record<string, string> = {
  TITLE: '标题', BODY: '正文', TAGS: '标签', IMAGE_PLAN: '图文规划',
};

function imageReturn(value: QaPreviousReturn | ImageQaPreviousReturn | undefined): ImageQaPreviousReturn | null {
  return value && 'problemPages' in value ? value : null;
}

export function PreviousReturnNotice({ previousReturn, compact = false }: {
  previousReturn?: QaPreviousReturn | ImageQaPreviousReturn;
  compact?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);
  const image = imageReturn(previousReturn);
  const pages = image?.problemPages.map(page => `第 ${page} 页`).join('、');
  const fields = image?.copyFields.map(field => COPY_FIELD_LABELS[field] ?? field).join('、');

  useEffect(() => { setExpanded(!compact); }, [compact]);

  return <section className={styles.previousReturn} aria-label="上次打回原因">
    <div className={styles.previousReturnHeader}>
      <div><span className={styles.previousReturnIcon}><RotateCcw size={14} aria-hidden="true" /></span><strong>上次打回原因</strong><small>复检前重点核对</small></div>
      <Button unstyled type="button" className={styles.previousReturnToggle} aria-expanded={expanded}
        onClick={() => setExpanded(current => !current)}>{expanded ? '收起' : '展开'}<ChevronDown size={14} aria-hidden="true" data-expanded={expanded} /></Button>
    </div>
    {expanded && <div className={styles.previousReturnDetails}>
      {previousReturn ? <>
        {image && (image.reworkTarget || pages || fields) && <div className={styles.previousReturnMeta}>
          {image.reworkTarget && <span><b>返工范围</b>{TARGET_LABELS[image.reworkTarget]}</span>}
          {pages && <span><b>上次问题页</b>{pages}</span>}
          {fields && <span><b>文案字段</b>{fields}</span>}
        </div>}
        {previousReturn.reasonLabels.length > 0 && <div className={styles.previousReturnTags} aria-label="上次问题标签">
          {previousReturn.reasonLabels.map(label => <span key={label}>{label}</span>)}
        </div>}
        {previousReturn.note && <p><b>具体要求</b>{previousReturn.note}</p>}
        {!previousReturn.reasonLabels.length && !previousReturn.note && !image?.reworkTarget && !pages && !fields
          && <p>上次打回未填写具体原因。</p>}
      </> : <p>未找到上次打回原因记录，请核对当前返修内容。</p>}
    </div>}
  </section>;
}
