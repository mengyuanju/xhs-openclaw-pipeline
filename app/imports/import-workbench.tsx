'use client';

import { useRouter } from 'next/navigation';
import {
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from '../components/api-client';
import { DemandScreeningPanel } from './demand-screening-panel';
import {
  ImportBatchDetails,
  ImportFlowStage,
  type ImportFlowStep,
} from './import-flow-presentation';
import { QueueGenerationPanel } from './queue-generation-panel';

function initialFlowStep(batch: any): ImportFlowStep {
  if (!batch) return 1;
  return batch.status === 'COMMITTED' ? 4 : 2;
}

function commitButtonLabel(batch: any) {
  if (batch.status === 'COMMITTED') return '已写入队列';
  if (batch.pendingScreeningRows > 0) return '筛选未完成';
  if (batch.admittedRows === 0) return '完成批次（0 条入队）';
  return `确认入队 ${batch.admittedRows} 条`;
}

export function ImportWorkbench({ initialBatch = null, timingStats }: { initialBatch?: any; timingStats: any }) {
  const router = useRouter();
  const confirm = useConfirmDialog();
  const flowRef = useRef<HTMLDivElement>(null);
  const [batch, setBatch] = useState<any>(initialBatch);
  const [activeStep, setActiveStep] = useState<ImportFlowStep>(() => initialFlowStep(initialBatch));
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [messageIsError, setMessageIsError] = useState(false);

  useLayoutEffect(() => {
    const target = flowRef.current?.querySelector(`[data-import-step="${activeStep}"]`);
    target?.scrollIntoView({ behavior: 'auto', block: 'start' });
  }, [activeStep]);

  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true); setMessage(''); setMessageIsError(false);
    try {
      const data = new FormData(event.currentTarget);
      const result = await apiRequest<any>('/api/import-batches', { method: 'POST', body: data });
      setBatch(result);
      setActiveStep(2);
      const modelScreenedRows = result.rows.filter(
        (row: any) => ['CODEX', 'OPENCLAW'].includes(row.screeningSource),
      ).length;
      setMessage(modelScreenedRows > 0
        ? `结构预检完成；模型已自动判定 ${modelScreenedRows} 行，请复核后再入队。`
        : `已完成 ${result.totalRows} 行结构预检；现有 Excel 判定可继续人工复核。`);
      setMessageIsError(false);
      router.replace(`/imports?batchId=${result.id}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '上传失败');
      setMessageIsError(true);
    } finally { setBusy(false); }
  }

  async function commit() {
    if (!batch || batch.pendingScreeningRows > 0) {
      setMessage('筛选未完成：请先判定所有结构合格选题的需求强度。');
      setMessageIsError(true);
      return;
    }
    const commitMessage = batch.admittedRows > 0
      ? `确认将 ${batch.admittedRows} 条强需/中需选题写入生产队列？`
      : '当前没有强需/中需选题，确认完成该批次且不创建任务？';
    if (!await confirm({
      title: batch.admittedRows > 0 ? '写入生产队列？' : '完成空批次？',
      description: commitMessage,
      confirmLabel: batch.admittedRows > 0 ? `确认入队 ${batch.admittedRows} 条` : '确认完成批次',
    })) return;
    setBusy(true); setMessage(''); setMessageIsError(false);
    try {
      const result = await apiRequest<any>(`/api/import-batches/${batch.id}/commit`, { method: 'POST' });
      setBatch({ ...batch, ...result.batch });
      setActiveStep(4);
      setMessage(`已入队 ${result.createdTasks} 条任务。重复点击不会重复创建。`);
      setMessageIsError(false);
      router.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '提交失败');
      setMessageIsError(true);
    } finally { setBusy(false); }
  }

  const messageNotice = message && <div
    className={messageIsError ? 'notice error' : 'notice success'}
    role={messageIsError ? 'alert' : 'status'}
    aria-live="polite"
  >{message}</div>;
  const screeningComplete = Boolean(batch && batch.pendingScreeningRows === 0);
  const committed = batch?.status === 'COMMITTED';

  return (
    <div className="import-flow" aria-label="Excel 导入流程" ref={flowRef}>
      <ImportFlowStage
        step={1}
        title="准备并上传 Excel"
        summary={batch ? `${batch.name} · ${batch.sourceFileName}` : '下载模板，填写后上传并完成结构预检'}
        activeStep={activeStep}
        available
        completed={Boolean(batch)}
        onSelect={setActiveStep}
      >
        <form className="panel import-upload-panel" onSubmit={upload}>
          <div className="panel-head"><h2>准备并上传 Excel</h2><span className="subtle">最大 5 MiB · 最多 5,000 行</span></div>
          <div className="import-steps" aria-label="Excel 文件准备步骤">
            <div className="import-step">
              <span className="import-step-number" aria-hidden="true">1</span>
              <div className="import-step-copy">
                <strong>下载模板并粘贴选题</strong>
                <span className="subtle">保留首行表头，从第 2 行开始粘贴；只填「选题」列即可，其他列可选。</span>
              </div>
              <a
                className="button template-download"
                href="/templates/xhs-topic-import-template.xlsx"
                download="小红书选题导入模板.xlsx"
              >下载 Excel 模板</a>
            </div>
            <div className="import-step">
              <span className="import-step-number" aria-hidden="true">2</span>
              <div className="import-step-copy">
                <strong>上传填写好的文件</strong>
                <span className="subtle">保存为 .xlsx 后选择文件，系统会先校验格式，再进行模型检测。</span>
              </div>
            </div>
          </div>
          <div className="form-grid">
            <div className="field"><label htmlFor="batch-name">批次名称（可选）</label><input id="batch-name" className="input" name="name" maxLength={200} placeholder="如：8月收纳选题" /></div>
            <div className="field"><label htmlFor="excel-file">填写后的 Excel 文件</label><input id="excel-file" className="input file-input" name="file" type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" required /></div>
            <div className="field full inline"><button className="button primary" type="submit" disabled={busy}>{busy ? '模型检测中…' : '上传并调用模型检测'}</button><span className="subtle">未预筛选的有效行会调用文本模型，消耗相应额度并延长上传时间。</span></div>
          </div>
        </form>
        {activeStep === 1 && messageNotice}
      </ImportFlowStage>

      <ImportFlowStage
        step={2}
        title="需求强度筛选与复核"
        summary={!batch ? '上传完成后可开始复核' : screeningComplete ? `已判定 ${batch.totalRows} 行，等待确认复核` : `还有 ${batch.pendingScreeningRows} 行待判定`}
        activeStep={activeStep}
        available={Boolean(batch)}
        completed={Boolean(batch && (activeStep > 2 || committed))}
        onSelect={setActiveStep}
      >
        {activeStep === 2 && messageNotice}
        {batch && <>
          <ImportBatchDetails batch={batch} />
          <DemandScreeningPanel
            key={batch.id}
            batch={batch}
            onBatchChange={setBatch}
            onMessage={(nextMessage, isError = false) => {
              setMessage(nextMessage);
              setMessageIsError(isError);
            }}
            onComplete={() => {
              setMessage('需求强度复核已确认，可以执行入队。');
              setMessageIsError(false);
              setActiveStep(3);
            }}
          />
        </>}
      </ImportFlowStage>

      <ImportFlowStage
        step={3}
        title="确认写入生产队列"
        summary={!batch ? '完成复核后可执行' : !screeningComplete ? '先完成全部需求强度判定' : committed ? '该批次已写入生产队列' : `将 ${batch.admittedRows} 条强需/中需选题写入队列`}
        activeStep={activeStep}
        available={Boolean(committed || (batch && screeningComplete && activeStep >= 3))}
        completed={Boolean(committed)}
        onSelect={setActiveStep}
      >
        {activeStep === 3 && messageNotice}
        {batch && <>
          <ImportBatchDetails batch={batch} />
          <section className="panel commit-panel">
            <div><h2>确认入队</h2><p className="subtle">仅强需和中需进入生产；弱需、无需及结构错误行保留在批次记录中。</p></div>
            <button className="button primary" type="button" disabled={busy || committed || !screeningComplete} onClick={commit}>{commitButtonLabel(batch)}</button>
          </section>
        </>}
      </ImportFlowStage>

      <ImportFlowStage
        step={4}
        title="启动文案与图片生成"
        summary={committed ? `已入队 ${batch.admittedRows} 条，可按需启动生成` : '确认入队后开放'}
        activeStep={activeStep}
        available={Boolean(committed)}
        completed={false}
        onSelect={setActiveStep}
      >
        {activeStep === 4 && messageNotice}
        {committed && <>
          <ImportBatchDetails batch={batch} />
          <QueueGenerationPanel maxTasks={batch.admittedRows} timingStats={timingStats} />
        </>}
      </ImportFlowStage>
    </div>
  );
}
