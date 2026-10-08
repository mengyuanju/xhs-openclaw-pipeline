'use client';

import { ChevronDown, History } from 'lucide-react';
import { useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import styles from './secondary-assignment-feedback.module.css';

export type SecondaryAssignmentFeedback = {
  assignedAt: string | null;
  entries: Array<{
    stage: 'COPY' | 'IMAGE';
    reasonLabels: string[];
    note: string | null;
    reviewedAt: string | null;
  }>;
};

function feedbackDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toLocaleString('zh-CN', {
    timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

function FeedbackEntry({ entry, latest = false }: {
  entry: SecondaryAssignmentFeedback['entries'][number];
  latest?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const noteId = useId();
  const labels = Array.isArray(entry.reasonLabels)
    ? [...new Set(entry.reasonLabels.filter(label => typeof label === 'string' && label.trim()))] : [];
  const note = typeof entry.note === 'string' ? entry.note.trim() : '';
  const characters = Array.from(note);
  const longNote = characters.length > 180;
  const date = feedbackDate(entry.reviewedAt);
  return <div className={styles.entry}>
    <div className={styles.entryHeading}>
      <strong>{latest ? '最近一次' : '此前反馈'} · {entry.stage === 'IMAGE' ? '图片质检' : '文案质检'}</strong>
      {date && <time dateTime={entry.reviewedAt ?? undefined}>{date}</time>}
    </div>
    {labels.length > 0 && <ul className={styles.tags} aria-label="历史问题标签">
      {labels.map(label => <li key={label}>{label}</li>)}
    </ul>}
    {note && <div className={styles.noteBlock}>
      <p id={noteId} className={styles.note}>{longNote && !expanded ? `${characters.slice(0, 180).join('')}…` : note}</p>
      {longNote && <Button unstyled type="button" className={styles.toggle}
        aria-expanded={expanded} aria-controls={noteId} onClick={() => setExpanded(!expanded)}>
        {expanded ? '收起完整说明' : '展开完整说明'}
      </Button>}
    </div>}
  </div>;
}

export function SecondaryAssignmentFeedbackNotice({ feedback }: {
  feedback?: SecondaryAssignmentFeedback | null;
}) {
  const [historyOpen, setHistoryOpen] = useState(false);
  const historyId = useId();
  const entries = Array.isArray(feedback?.entries) ? feedback.entries.filter(entry => entry
    && ['COPY', 'IMAGE'].includes(entry.stage)
    && (typeof entry.note === 'string' && entry.note.trim()
      || Array.isArray(entry.reasonLabels) && entry.reasonLabels.some(label => typeof label === 'string' && label.trim()))) : [];
  if (!entries.length) return null;
  return <section className={styles.card} aria-label="二次分配历史质检反馈">
    <header className={styles.heading}>
      <History size={15} aria-hidden="true" />
      <h4>历史质检反馈</h4><span className={styles.badge}>二次分配参考</span>
    </header>
    <p className={styles.help}>本次从初稿重新审核，可参考上轮反馈检查文案和图片规划。</p>
    <FeedbackEntry entry={entries[0]} latest />
    {entries.length > 1 && <div className={styles.history}>
      <Button unstyled type="button" className={styles.historyToggle} aria-expanded={historyOpen}
        aria-controls={historyId} onClick={() => setHistoryOpen(!historyOpen)}>
        {historyOpen ? '收起此前反馈' : `查看此前 ${entries.length - 1} 次反馈`}
        <ChevronDown size={14} aria-hidden="true" className={historyOpen ? styles.expanded : undefined} />
      </Button>
      <div id={historyId} hidden={!historyOpen} className={styles.historyEntries}>
        {entries.slice(1).map((entry, index) => <FeedbackEntry key={`${entry.reviewedAt}-${index}`} entry={entry} />)}
      </div>
    </div>}
  </section>;
}
