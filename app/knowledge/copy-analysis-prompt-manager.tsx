'use client';

import { useState } from 'react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { apiRequest } from '../components/api-client';
import {
  CopyAnalysisPromptReplacementDialog,
  copyAnalysisPromptLabel,
  type CopyAnalysisPrompt,
} from './copy-analysis-prompt-replacement-dialog';

export type { CopyAnalysisPrompt } from './copy-analysis-prompt-replacement-dialog';

const PROMPT_LIMIT = 10;

export function CopyAnalysisPromptManager({
  initialPrompts,
  currentPrompt,
  onSelectPrompt,
  disabled = false,
}: {
  initialPrompts: CopyAnalysisPrompt[];
  currentPrompt: string;
  onSelectPrompt: (content: string) => void;
  disabled?: boolean;
}) {
  const [prompts, setPrompts] = useState(initialPrompts);
  const [replacementId, setReplacementId] = useState('');
  const [replacementOpen, setReplacementOpen] = useState(false);
  const [busy, setBusy] = useState<'SAVE' | 'REPLACE' | null>(null);
  const [message, setMessage] = useState('');

  const normalizedCurrentPrompt = currentPrompt.trim();
  const selectedPrompt = prompts.find(({ content }) => content === normalizedCurrentPrompt);

  function selectPrompt(id: string) {
    const prompt = prompts.find((item) => String(item.id) === id);
    if (!prompt) return;
    onSelectPrompt(prompt.content);
    setMessage('已载入保存的 Prompt。');
  }

  function openReplacementDialog() {
    setReplacementId('');
    setMessage('');
    setReplacementOpen(true);
  }

  function changeReplacementOpen(open: boolean) {
    if (busy === 'REPLACE') return;
    setReplacementOpen(open);
    if (!open) setReplacementId('');
  }

  async function saveCurrentPrompt() {
    if (!normalizedCurrentPrompt) return;
    if (selectedPrompt) {
      setMessage('当前 Prompt 已经保存。');
      return;
    }
    if (prompts.length >= PROMPT_LIMIT) {
      openReplacementDialog();
      return;
    }

    setBusy('SAVE');
    setMessage('');
    try {
      const saved = await apiRequest<CopyAnalysisPrompt>('/api/copy-analysis-prompts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: normalizedCurrentPrompt }),
      });
      setPrompts((current) => [saved, ...current.filter(({ id }) => id !== saved.id)]);
      setMessage(`Prompt 已保存（${prompts.length + 1}/${PROMPT_LIMIT}）。`);
    } catch (error) {
      setMessage(error instanceof Error ? `保存失败：${error.message}` : '保存失败');
      // Another page may have filled the last slot since this page loaded.
      try {
        const latest = await apiRequest<CopyAnalysisPrompt[]>('/api/copy-analysis-prompts');
        setPrompts(latest);
        if (latest.length >= PROMPT_LIMIT) setReplacementOpen(true);
      } catch { /* Preserve the original save error and the unsaved prompt. */ }
    } finally {
      setBusy(null);
    }
  }

  async function replacePrompt() {
    if (!replacementId || !normalizedCurrentPrompt) return;
    setBusy('REPLACE');
    setMessage('');
    try {
      const saved = await apiRequest<CopyAnalysisPrompt>(
        `/api/copy-analysis-prompts/${replacementId}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content: normalizedCurrentPrompt }),
        },
      );
      setPrompts((current) => [saved, ...current.filter(({ id }) => id !== saved.id)]);
      setReplacementOpen(false);
      setReplacementId('');
      setMessage('已替换所选 Prompt。');
    } catch (error) {
      setMessage(error instanceof Error ? `替换失败：${error.message}` : '替换失败');
    } finally {
      setBusy(null);
    }
  }

  const messageIsError = message.includes('失败');

  return <div className="copy-analysis-prompt-manager">
    <div className="copy-analysis-prompt-toolbar">
      <div className="copy-analysis-prompt-picker">
        <label className="subtle" htmlFor="saved-copy-analysis-prompt">
          已保存 Prompt（{prompts.length}/{PROMPT_LIMIT}）
        </label>
        <Select
          value={selectedPrompt ? String(selectedPrompt.id) : ''}
          disabled={disabled || prompts.length === 0 || busy !== null}
          onValueChange={selectPrompt}
        >
          <SelectTrigger id="saved-copy-analysis-prompt">
            <SelectValue placeholder={prompts.length === 0 ? '暂无已保存 Prompt' : '选择并载入之前的 Prompt'} />
          </SelectTrigger>
          <SelectContent>
            {prompts.map((prompt, index) => (
              <SelectItem key={prompt.id} value={String(prompt.id)}>
                {copyAnalysisPromptLabel(prompt, index)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <button
        className="button"
        type="button"
        disabled={disabled || busy !== null || !normalizedCurrentPrompt}
        onClick={saveCurrentPrompt}
      >
        {busy === 'SAVE' ? '保存中…' : '保存当前 Prompt'}
      </button>
    </div>
    <small id="copy-analysis-prompt-help">
      最多保存 10 条；达到上限后，系统会要求你选择一条旧 Prompt 进行替换，不会自动覆盖。
    </small>
    {message && !replacementOpen && <p
      className={messageIsError ? 'notice error copy-analysis-prompt-status' : 'notice success copy-analysis-prompt-status'}
      role={messageIsError ? 'alert' : 'status'}
      aria-live="polite"
    >{message}</p>}

    <CopyAnalysisPromptReplacementDialog
      open={replacementOpen}
      prompts={prompts}
      replacementId={replacementId}
      busy={busy === 'REPLACE'}
      message={message}
      onOpenChange={changeReplacementOpen}
      onReplacementChange={setReplacementId}
      onReplace={replacePrompt}
    />
  </div>;
}
