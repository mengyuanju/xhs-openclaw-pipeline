'use client';

import {
  Check,
  Clock3,
  Globe2,
  LoaderCircle,
  LockKeyhole,
  Plus,
  Settings2,
  Tags,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { Checkbox, Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import {
  COPY_QA_REASON_GROUPS,
  COPY_QA_SYSTEM_REASONS,
  MAX_COPY_QA_REASON_CODES,
} from '../../src/copy-qa-reasons.mjs';
import { apiRequest } from '../components/api-client';
import styles from './copy-qa-reason-picker.module.css';

type ReasonGroup = 'TITLE' | 'BODY' | 'PLAN';
type CustomReasonTag = {
  code: string;
  publicId: string;
  group: ReasonGroup;
  label: string;
  visibility: 'PRIVATE' | 'PUBLIC';
  status: 'ACTIVE' | 'PENDING' | 'DISABLED';
  ownedByActor: boolean;
  ownerUsername?: string;
  canRequestPublic: boolean;
  canPublish: boolean;
  canDisable: boolean;
};
type ReasonTagPayload = {
  version: number;
  canPublish: boolean;
  selectable: CustomReasonTag[];
  managed: CustomReasonTag[];
};

const EMPTY_PAYLOAD: ReasonTagPayload = {
  version: 1,
  canPublish: false,
  selectable: [],
  managed: [],
};
const apiPath = (path: string) => `/api/control-plane${path}`;

function statusIcon(tag: CustomReasonTag) {
  if (tag.visibility === 'PUBLIC') return <Globe2 size={12} aria-hidden="true" />;
  if (tag.status === 'PENDING') return <Clock3 size={12} aria-hidden="true" />;
  return <LockKeyhole size={12} aria-hidden="true" />;
}

function statusLabel(tag: CustomReasonTag) {
  if (tag.visibility === 'PUBLIC') return '公共标签';
  if (tag.status === 'PENDING') return '公开申请待审核';
  return '我的标签';
}

export function CopyQaReasonPicker({ selected, onChange, disabled = false }: {
  selected: string[];
  onChange: (reasonCodes: string[]) => void;
  disabled?: boolean;
}) {
  const [payload, setPayload] = useState<ReasonTagPayload>(EMPTY_PAYLOAD);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [manageOpen, setManageOpen] = useState(false);
  const [createGroup, setCreateGroup] = useState<ReasonGroup>('TITLE');
  const [createLabel, setCreateLabel] = useState('');
  const [requestPublic, setRequestPublic] = useState(false);
  const [createError, setCreateError] = useState('');
  const [creating, setCreating] = useState(false);
  const [tagAction, setTagAction] = useState('');
  const [manageError, setManageError] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await apiRequest<ReasonTagPayload>(apiPath('/v1/copy-qa/reason-tags'));
      setPayload({
        version: Number(result.version) || 1,
        canPublish: result.canPublish === true,
        selectable: Array.isArray(result.selectable) ? result.selectable : [],
        managed: Array.isArray(result.managed) ? result.managed : [],
      });
      setLoadError('');
    } catch (caught) {
      setLoadError(caught instanceof Error ? caught.message : '自定义标签读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const selectableByGroup = useMemo(() => new Map(COPY_QA_REASON_GROUPS.map((group) => [
    group.code,
    payload.selectable.filter((tag) => tag.group === group.code),
  ])), [payload.selectable]);

  function toggle(code: string) {
    if (disabled) return;
    if (selected.includes(code)) {
      onChange(selected.filter((item) => item !== code));
      return;
    }
    if (selected.length >= MAX_COPY_QA_REASON_CODES) {
      setLoadError(`一次最多选择 ${MAX_COPY_QA_REASON_CODES} 个问题标签`);
      return;
    }
    onChange([...selected, code]);
    setLoadError('');
  }

  function beginCreate() {
    setCreateGroup('TITLE');
    setCreateLabel('');
    setRequestPublic(false);
    setCreateError('');
    setCreateOpen(true);
  }

  async function createTag() {
    if (creating) return;
    if (selected.length >= MAX_COPY_QA_REASON_CODES) {
      setCreateError(`已选满 ${MAX_COPY_QA_REASON_CODES} 项，请先取消一个标签再添加`);
      return;
    }
    const label = createLabel.replace(/\s+/gu, ' ').trim();
    if ([...label].length < 2 || [...label].length > 20) {
      setCreateError('问题标签需要包含 2–20 个字');
      return;
    }
    setCreating(true);
    setCreateError('');
    try {
      const created = await apiRequest<CustomReasonTag>(apiPath('/v1/copy-qa/reason-tags'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ group: createGroup, label, requestPublic }),
      });
      setPayload((current) => ({
        ...current,
        selectable: [...current.selectable.filter((tag) => tag.code !== created.code), created],
        managed: [...current.managed.filter((tag) => tag.code !== created.code), created],
      }));
      if (!selected.includes(created.code)) onChange([...selected, created.code]);
      setCreateOpen(false);
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : '添加问题标签失败');
    } finally {
      setCreating(false);
    }
  }

  async function updateTag(tag: CustomReasonTag, action: 'REQUEST_PUBLIC' | 'PUBLISH' | 'REJECT' | 'DISABLE') {
    if (tagAction) return;
    setTagAction(`${tag.publicId}:${action}`);
    setManageError('');
    try {
      await apiRequest(apiPath(`/v1/copy-qa/reason-tags/${encodeURIComponent(tag.publicId)}`), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (action === 'DISABLE' && selected.includes(tag.code)) {
        onChange(selected.filter((code) => code !== tag.code));
      }
      await load();
    } catch (caught) {
      setManageError(caught instanceof Error ? caught.message : '标签操作失败');
    } finally {
      setTagAction('');
    }
  }

  return <>
    <section className={styles.picker} aria-label="问题标签">
      <header className={styles.pickerHeader}>
        <div><strong>问题标签</strong><span>已选 {selected.length} 项</span></div>
        <div className={styles.headerActions}>
          {selected.length > 0 && <Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={() => onChange([])}>清空</Button>}
          <Button variant="outline" size="sm" type="button" disabled={disabled} onClick={beginCreate}><Plus size={14} />添加我的标签</Button>
          {payload.managed.length > 0 && <Button variant="ghost" size="sm" type="button" disabled={disabled} onClick={() => { setManageError(''); setManageOpen(true); }}><Settings2 size={14} />管理</Button>}
        </div>
      </header>
      <p className={styles.hint}>选中常见问题后可直接打回；只有需要指出句子、页码或修改方式时才填写详细说明。</p>
      <div className={styles.groups}>
        {COPY_QA_REASON_GROUPS.map((group) => {
          const systemTags = COPY_QA_SYSTEM_REASONS.filter((reason) => reason.group === group.code);
          const customTags = selectableByGroup.get(group.code) ?? [];
          return <section className={styles.group} key={group.code} aria-labelledby={`copy-qa-reason-${group.code}`}>
            <header><strong id={`copy-qa-reason-${group.code}`}>{group.label}</strong>{customTags.length > 0 && <small>{customTags.length} 个自定义标签</small>}</header>
            <div className={styles.chips}>
              {systemTags.map((reason) => <Button unstyled className={styles.chip} type="button" key={reason.code}
                aria-pressed={selected.includes(reason.code)} data-selected={selected.includes(reason.code)} disabled={disabled}
                onClick={() => toggle(reason.code)}>{selected.includes(reason.code) && <Check size={13} aria-hidden="true" />}<span>{reason.label}</span></Button>)}
              {customTags.map((tag) => <Button unstyled className={styles.chip} type="button" key={tag.code}
                aria-pressed={selected.includes(tag.code)} data-selected={selected.includes(tag.code)} data-custom="true"
                disabled={disabled} title={statusLabel(tag)} onClick={() => toggle(tag.code)}>
                {selected.includes(tag.code) ? <Check size={13} aria-hidden="true" /> : statusIcon(tag)}<span>{tag.label}</span>
              </Button>)}
            </div>
          </section>;
        })}
      </div>
      {loading && <p className={styles.status}><LoaderCircle className={styles.spin} size={14} />正在读取我的标签…</p>}
      {loadError && <p className={styles.error} role="alert">{loadError}<Button variant="ghost" size="sm" type="button" onClick={() => void load()}>重试</Button></p>}
    </section>

    <Dialog open={createOpen} onOpenChange={(open) => { if (!creating) setCreateOpen(open); }}>
      <DialogContent className={styles.dialog}>
        <div className={styles.dialogHeading}><div><DialogTitle>添加我的问题标签</DialogTitle><DialogDescription>新标签默认只在你的选择器中显示，提交后当前任务的返工人员仍能看到。</DialogDescription></div><Tags size={20} aria-hidden="true" /></div>
        <div className={styles.createFields}>
          <label>所属分类<Select value={createGroup} onValueChange={(value) => setCreateGroup(value as ReasonGroup)} disabled={creating}><SelectTrigger aria-label="自定义问题标签分类"><SelectValue /></SelectTrigger><SelectContent>{COPY_QA_REASON_GROUPS.map((group) => <SelectItem key={group.code} value={group.code}>{group.label}</SelectItem>)}</SelectContent></Select></label>
          <label>标签名称<Input value={createLabel} maxLength={20} disabled={creating} autoFocus placeholder="例如：开头铺垫过长" onChange={(event) => { setCreateLabel(event.target.value); setCreateError(''); }} /><small>{[...createLabel].length}/20</small></label>
          <label className={styles.publicOption}><Checkbox checked={requestPublic} disabled={creating} onChange={(event) => setRequestPublic(event.target.checked)} /><span><strong>{payload.canPublish ? '直接发布为公共标签' : '同时申请加入公共标签库'}</strong><small>{payload.canPublish ? '发布后所有质检员都可选择。' : '管理员通过前，仍作为你的个人标签使用。'}</small></span></label>
        </div>
        {createError && <div className={styles.errorBox} role="alert">{createError}</div>}
        <footer className={styles.dialogFooter}><DialogClose asChild><Button variant="outline" type="button" disabled={creating}>取消</Button></DialogClose><Button type="button" disabled={creating || !createLabel.trim()} onClick={() => void createTag()}>{creating ? <LoaderCircle className={styles.spin} size={15} /> : <Plus size={15} />}添加并选中</Button></footer>
      </DialogContent>
    </Dialog>

    <Dialog open={manageOpen} onOpenChange={(open) => { if (!tagAction) setManageOpen(open); }}>
      <DialogContent className={`${styles.dialog} ${styles.manageDialog}`}>
        <div className={styles.dialogHeading}><div><DialogTitle>{payload.canPublish ? '管理自定义问题标签' : '管理我的问题标签'}</DialogTitle><DialogDescription>停用只会从以后的选择器移除标签，已提交的历史记录仍保留原始中文快照。</DialogDescription></div><Settings2 size={20} aria-hidden="true" /></div>
        <div className={styles.manageList}>
          {payload.managed.map((tag) => <article key={tag.code}>
            <div className={styles.tagIdentity}>{statusIcon(tag)}<div><strong>{tag.label}</strong><small>{COPY_QA_REASON_GROUPS.find((group) => group.code === tag.group)?.label} · {statusLabel(tag)}{tag.ownerUsername ? ` · @${tag.ownerUsername}` : ''}</small></div></div>
            <div className={styles.tagActions}>
              {tag.canRequestPublic && <Button variant="outline" size="sm" type="button" disabled={Boolean(tagAction)} onClick={() => void updateTag(tag, 'REQUEST_PUBLIC')}><Globe2 size={13} />申请公开</Button>}
              {tag.canPublish && tag.status === 'PENDING' && <><Button variant="outline" size="sm" type="button" disabled={Boolean(tagAction)} onClick={() => void updateTag(tag, 'REJECT')}>驳回</Button><Button size="sm" type="button" disabled={Boolean(tagAction)} onClick={() => void updateTag(tag, 'PUBLISH')}><Globe2 size={13} />发布</Button></>}
              {tag.canPublish && tag.status !== 'PENDING' && tag.visibility === 'PRIVATE' && <Button variant="outline" size="sm" type="button" disabled={Boolean(tagAction)} onClick={() => void updateTag(tag, 'PUBLISH')}><Globe2 size={13} />设为公共</Button>}
              {tag.canDisable && <Button variant="ghost" size="sm" type="button" disabled={Boolean(tagAction)} onClick={() => void updateTag(tag, 'DISABLE')}>停用</Button>}
            </div>
          </article>)}
        </div>
        {manageError && <div className={styles.errorBox} role="alert">{manageError}</div>}
        <footer className={styles.dialogFooter}><DialogClose asChild><Button variant="outline" type="button" disabled={Boolean(tagAction)}>完成</Button></DialogClose></footer>
      </DialogContent>
    </Dialog>
  </>;
}
