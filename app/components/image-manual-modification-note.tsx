import styles from './image-manual-modification-note.module.css';

export const IMAGE_MANUAL_MODIFICATION_NOTE_GUIDANCE = '如需手动修改图片请备注具体点位，图片质检可先通过，后续自行修改后小豆芽替换';
export const IMAGE_MANUAL_MODIFICATION_NOTE_MAX_LENGTH = 1000;

export function ImageManualModificationNote({ note }: { note: string | null | undefined }) {
  if (!note?.trim()) return null;

  return <section className={styles.note} aria-label="图片审核备注">
    <h3>图片审核备注</h3>
    <p className={styles.content}>{note}</p>
    <p className={styles.guidance}>{IMAGE_MANUAL_MODIFICATION_NOTE_GUIDANCE}</p>
  </section>;
}
