'use client';

import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export type CopyAnalysisPrompt = {
  id: number;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export function copyAnalysisPromptLabel(prompt: CopyAnalysisPrompt, index: number) {
  const singleLine = prompt.content.replace(/\s+/gu, ' ').trim();
  const characters = [...singleLine];
  const preview = characters.length > 48
    ? `${characters.slice(0, 48).join('')}…`
    : singleLine;
  return `${index + 1}. ${preview}`;
}

export function CopyAnalysisPromptReplacementDialog({
  open,
  prompts,
  replacementId,
  busy,
  message,
  onOpenChange,
  onReplacementChange,
  onReplace,
}: {
  open: boolean;
  prompts: CopyAnalysisPrompt[];
  replacementId: string;
  busy: boolean;
  message: string;
  onOpenChange: (open: boolean) => void;
  onReplacementChange: (id: string) => void;
  onReplace: () => void;
}) {
  const replacementPrompt = prompts.find(({ id }) => String(id) === replacementId);
  const messageIsError = message.includes('失败');

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent className="copy-analysis-prompt-dialog">
      <div className="copy-analysis-prompt-dialog-head">
        <DialogTitle>选择要替换的 Prompt</DialogTitle>
        <DialogDescription>
          已保存 10 条。请选择一条旧 Prompt，确认后只替换该条记录。
        </DialogDescription>
      </div>
      <div className="field">
        <label htmlFor="copy-analysis-prompt-replacement">替换目标</label>
        <Select value={replacementId} disabled={busy} onValueChange={onReplacementChange}>
          <SelectTrigger id="copy-analysis-prompt-replacement">
            <SelectValue placeholder="请选择要替换的旧 Prompt" />
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
      {replacementPrompt && <div className="copy-analysis-prompt-preview">
        <strong>将被替换的内容</strong>
        <p>{replacementPrompt.content}</p>
      </div>}
      {message && <p
        className={messageIsError ? 'notice error copy-analysis-prompt-status' : 'notice success copy-analysis-prompt-status'}
        role={messageIsError ? 'alert' : 'status'}
        aria-live="polite"
      >{message}</p>}
      <div className="copy-analysis-prompt-dialog-actions">
        <DialogClose asChild>
          <button className="button" type="button" disabled={busy}>取消</button>
        </DialogClose>
        <button
          className="button primary"
          type="button"
          disabled={!replacementId || busy}
          onClick={onReplace}
        >
          {busy ? '替换中…' : '替换并保存'}
        </button>
      </div>
    </DialogContent>
  </Dialog>;
}
