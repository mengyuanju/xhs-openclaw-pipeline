'use client';

import type { ReactNode } from 'react';
import { Input, Textarea } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ChevronLeft, ChevronRight, LoaderCircle, RefreshCw, Trash2 } from "lucide-react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Disclosure, DisclosureContent, DisclosureTrigger } from "@/components/ui/disclosure";
import { TaskReviewModelHistory } from './task-review-history';
import { PageLayoutEditor } from "../components/image-controls";
import { backgroundTaskMessage } from "../components/background-task-store";
import { imagePlanBlankBulletLines, imagePlanBulletLengthWarnings, imagePlanPageDeletionBlockReason } from "../../src/image-plan-editing.mjs";
import { type ImagePlanItem, type ReviewDraft, type TaskDetail, IMAGE_KINDS, IMAGE_KIND_LABELS, AutosizeTextarea, ReviewReferences } from './task-review-model';
import type { TaskReviewViewContext } from './task-review-dialog';

export function ImagePlanReviewPanel({ context, detail, draft, ratingPanel }: {
  context: Pick<TaskReviewViewContext, 'assets' | 'canEditApprovedImagePlan' | 'editable' | 'loading' | 'submitting' | 'regeneratingImagePlan' | 'regenerateImagePlan' | 'imagePlanComparison' | 'imagePlanChanged' | 'imagePlanGenerationNotice' | 'backgroundPlan' | 'completedPlan' | 'canLoadCompletedPlan' | 'appliedPlanIdRef' | 'draftSaveStatus' | 'confirm' | 'loadCompletedPlan' | 'activePlanIndex' | 'setActivePlanIndex' | 'planEditBlockMessage' | 'copyEditPointerAtRef' | 'revealCopyEditNotice' | 'deleteImagePlanPage' | 'planKindDisabled' | 'updateImagePlan' | 'planFieldsReadOnly' | 'expandedPrompts' | 'setExpandedPrompts' | 'research' | 'xiaohongshuLinks' | 'isAdmin' | 'imageSettingsPanel' | 'role' | 'revision'>;
  detail: TaskDetail; draft: ReviewDraft; ratingPanel?: ReactNode;
}) {
  const { assets, canEditApprovedImagePlan, editable, loading, submitting, regeneratingImagePlan, regenerateImagePlan, imagePlanComparison, imagePlanChanged, imagePlanGenerationNotice, backgroundPlan, completedPlan, canLoadCompletedPlan, appliedPlanIdRef, draftSaveStatus, confirm, loadCompletedPlan, activePlanIndex, setActivePlanIndex, planEditBlockMessage, copyEditPointerAtRef, revealCopyEditNotice, deleteImagePlanPage, planKindDisabled, updateImagePlan, planFieldsReadOnly, expandedPrompts, setExpandedPrompts, research, xiaohongshuLinks, isAdmin, imageSettingsPanel, role, revision } = context;
  return <div id="review-plan-pane" className="workbench-review-pane" data-review-pane="plan">
              {ratingPanel}
              <div className="workbench-review-plan-content">
              <section className="workbench-review-section workbench-image-plan-section">
                <div className="workbench-review-section-title"><span>{assets.length > 0 ? '03' : '02'}</span><div><h3>图片文案规划</h3><p>{canEditApprovedImagePlan
                  ? '可修正逐页文字与画面指令；页面类型保持锁定，评分后重试会创建新的人工批准版本。'
                    : editable ? '逐页核对画面文字与排版；修改后单独保存，不受文案评分档位影响。'
                    : '当前状态仅供核对已审核的图片文案规划。'}</p></div>
                  {editable && <Button unstyled className="button small workbench-image-plan-regenerate" type="button"
                    disabled={loading || submitting || regeneratingImagePlan}
                    title="调用文本模型，根据当前文案重新生成全部逐页规划"
                    onClick={(event) => { void regenerateImagePlan(event.currentTarget.form); }}>
                    {regeneratingImagePlan
                      ? <><LoaderCircle className="animate-spin" size={14} />执行机生成中…</>
                      : <><RefreshCw size={14} />按当前文案重新生成规划</>}
                  </Button>}
                </div>
                {editable && imagePlanComparison?.rawChanged && !imagePlanChanged
                  && <p className="notice" role="status">图片规划内容与当前正式版本一致，仅有空格或数据格式差异，无需单独保存。</p>}
                {imagePlanGenerationNotice && <div className="notice success" role="status">{imagePlanGenerationNotice}</div>}
                {backgroundPlan && !backgroundPlan.consumed && <div className="notice" role="status">
                  {backgroundTaskMessage(backgroundPlan)}
                  {completedPlan && !canLoadCompletedPlan && ' 当前文案或版本与生成时不同，请按当前文案重新生成规划。'}
                  {canLoadCompletedPlan && appliedPlanIdRef.current !== completedPlan?.id && <Button unstyled className="button small" type="button"
                    disabled={loading || submitting || draftSaveStatus === 'saving'} onClick={() => { void (async () => {
                      if (imagePlanChanged && !await confirm({ title: '载入已完成的新规划？', description: '载入后会替换当前逐页规划；文案内容保持不变。', confirmLabel: '载入新规划' })) return;
                      loadCompletedPlan();
                    })(); }}>载入新规划</Button>}
                </div>}
                <nav className="workbench-image-plan-nav" aria-label="图片规划页码">
                  <Button unstyled className="workbench-image-plan-nav-button" type="button" aria-label="上一页" disabled={activePlanIndex === 0}
                    onClick={() => setActivePlanIndex(index => Math.max(0, index - 1))}><ChevronLeft size={16} /><span>上一页</span></Button>
                  <div className="workbench-image-plan-current" aria-live="polite">
                    <div><strong>第 {activePlanIndex + 1} / {draft.imagePlan.length} 页</strong><span>{IMAGE_KIND_LABELS[draft.imagePlan[activePlanIndex]?.kind] ?? '未设置类型'}</span></div>
                    <p>{draft.imagePlan[activePlanIndex]?.headline || '未填写页面标题'}</p>
                  </div>
                  <Button unstyled className="workbench-image-plan-nav-button" type="button" aria-label="下一页" disabled={activePlanIndex >= draft.imagePlan.length - 1}
                    onClick={() => setActivePlanIndex(index => Math.min(draft.imagePlan.length - 1, index + 1))}><span>下一页</span><ChevronRight size={16} /></Button>
                </nav>
                <div className="workbench-image-plan-grid">
                  {draft.imagePlan.map((item, index) => {
                    const deletionBlockReason = imagePlanPageDeletionBlockReason(draft.imagePlan, index);
                    const blankBulletLines = imagePlanBlankBulletLines([item]);
                    const bulletLengthWarnings = imagePlanBulletLengthWarnings([item]);
                    return <article id={`review-plan-page-${index}`} className="workbench-image-plan-card" key={index} data-plan-index={index} tabIndex={-1} hidden={activePlanIndex !== index}>
                    <div className="workbench-image-plan-fields" data-edit-blocked={Boolean(planEditBlockMessage)}
                      onPointerDownCapture={(event) => {
                        if (!(event.target as Element).closest('[data-edit-reminder-exempt]')) copyEditPointerAtRef.current = Date.now();
                      }}
                      onClickCapture={(event) => {
                        if (!(event.target as Element).closest('[data-edit-reminder-exempt]')) revealCopyEditNotice('plan');
                      }}
                      onFocusCapture={(event) => {
                        if (Date.now() - copyEditPointerAtRef.current > 500 && !(event.target as Element).closest('[data-edit-reminder-exempt]')) revealCopyEditNotice('plan');
                      }}>
                      {editable && <div className="workbench-image-plan-page-actions full" data-edit-reminder-exempt>
                        <small>{deletionBlockReason ?? '删除后，后续页面会自动重新编号。'}</small>
                        <Button unstyled className="button small danger" type="button"
                          aria-label={`删除第 ${index + 1} 页规划`}
                          title={deletionBlockReason ?? `删除第 ${index + 1} 页“${item.headline}”`}
                          disabled={Boolean(deletionBlockReason) || loading || submitting || regeneratingImagePlan}
                          onClick={() => { void deleteImagePlanPage(index); }}>
                          <Trash2 size={13} />删除本页
                        </Button>
                      </div>}
                      <div className="field">
                        <label htmlFor={`review-plan-kind-${index}`}>页面类型 <small>{index === 0 ? '首图固定' : '影响页面版式'}</small></label>
                        <Select value={item.kind} disabled={planKindDisabled || index === 0} onValueChange={(kind: ImagePlanItem['kind']) => updateImagePlan(index, { kind, layout: { mode: 'AUTO' } })}>
                          <SelectTrigger id={`review-plan-kind-${index}`} aria-describedby={`review-plan-kind-help-${index}`}><SelectValue /></SelectTrigger>
                          <SelectContent>{IMAGE_KINDS.filter((kind) => index === 0 ? kind === 'hero' : kind !== 'hero').map((kind) => <SelectItem value={kind} key={kind}>{IMAGE_KIND_LABELS[kind]}</SelectItem>)}</SelectContent>
                        </Select>
                        <small id={`review-plan-kind-help-${index}`} className="workbench-image-plan-kind-help">{index === 0
                          ? '首图必须为封面。'
                          : '用于匹配可用版式；切换后将自动重新匹配布局。'}</small>
                      </div>
                      <div className="field">
                        <label htmlFor={`review-plan-headline-${index}`}>页面标题</label>
                        <Input id={`review-plan-headline-${index}`} className="input" value={item.headline} maxLength={18} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { headline: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-subtitle-${index}`}>页面副标题 <small>选填</small></label>
                        <Input id={`review-plan-subtitle-${index}`} className="input" value={item.subtitle} maxLength={30} readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { subtitle: event.target.value })} />
                      </div>
                      <div className="field full">
                        <label htmlFor={`review-plan-bullets-${index}`}>画面要点 <small id={`review-plan-bullets-help-${index}`}>每行一条，2–5 条；{item.kind === 'checklist' ? '建议每条不超过 40 字' : '建议每条不超过 30 字'}，连续英文算 1 字{blankBulletLines.length ? `，有 ${blankBulletLines.length} 个无效空行，请删除` : ''}{bulletLengthWarnings.length ? `，当前有 ${bulletLengthWarnings.length} 条超出，保存时需确认` : ''}</small></label>
                        <AutosizeTextarea id={`review-plan-bullets-${index}`} className="textarea workbench-plan-bullets-editor" value={item.bullets.join('\n')} required readOnly={planFieldsReadOnly}
                          aria-describedby={`review-plan-bullets-help-${index}`} aria-invalid={blankBulletLines.length > 0}
                          resizeToken={activePlanIndex === index} onChange={(event) => updateImagePlan(index, { bullets: event.target.value.split(/\r?\n/u) })} />
                      </div>
                      <Disclosure className="field full" open={expandedPrompts.includes(index)} onOpenChange={open => setExpandedPrompts(current => open ? [...current, index] : current.filter(value => value !== index))}>
                        <DisclosureTrigger data-edit-reminder-exempt>画面生成指令</DisclosureTrigger>
                        <DisclosureContent>
                        <label htmlFor={`review-plan-prompt-${index}`}>画面生成指令</label>
                        <Textarea id={`review-plan-prompt-${index}`} className="textarea" value={item.prompt} minLength={10} maxLength={1_000} required readOnly={planFieldsReadOnly}
                          onChange={(event) => updateImagePlan(index, { prompt: event.target.value })} />
                        </DisclosureContent>
                      </Disclosure>
                      <Disclosure className="field full workbench-page-layout-disclosure">
                         <DisclosureTrigger id={`review-plan-layout-trigger-${index}`} data-edit-reminder-exempt>
                          页面排版 <em>{item.layout?.mode === 'CUSTOM' ? '自定义' : '自动匹配'}</em>
                        </DisclosureTrigger>
                        <DisclosureContent>
                          <div className="field">
                            <label htmlFor={`review-plan-layout-mode-${index}`}>排版方式</label>
                            <Select value={item.layout?.mode === 'CUSTOM' ? 'CUSTOM' : 'AUTO'} disabled={planFieldsReadOnly}
                              onValueChange={(mode: 'AUTO' | 'CUSTOM') => updateImagePlan(index, { layout: { mode } })}>
                              <SelectTrigger id={`review-plan-layout-mode-${index}`}><SelectValue /></SelectTrigger>
                              <SelectContent>
                                <SelectItem value="AUTO">自动匹配版式</SelectItem>
                                <SelectItem value="CUSTOM">自定义排版</SelectItem>
                              </SelectContent>
                            </Select>
                          </div>
                          {item.layout?.mode === 'CUSTOM' && <PageLayoutEditor kind={item.kind} value={item.layout}
                            disabled={planFieldsReadOnly} onChange={(layout) => updateImagePlan(index, { layout })} />}
                        </DisclosureContent>
                      </Disclosure>
                    </div>
                  </article>})}
                </div>
              </section>
              {editable && <ReviewReferences detail={detail} research={research} xiaohongshuLinks={xiaohongshuLinks} isAdmin={isAdmin} />}
              {imageSettingsPanel}
              {role === 'ADMIN' && <TaskReviewModelHistory detail={detail} research={research} revision={revision} />}
              </div>
            </div>;
}
