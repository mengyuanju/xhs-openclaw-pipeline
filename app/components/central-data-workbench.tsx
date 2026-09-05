'use client';

import { LoaderCircle, RefreshCw, Save, UploadCloud } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { useConfirmDialog } from '@/components/ui/confirm-dialog';

import { apiRequest } from './api-client';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { WebSearchSettingsPanel } from '../settings/web-search-settings-panel';

type Resource = 'prompts' | 'knowledge' | 'settings';

const endpoint = (path: string) => `/api/control-plane${path}`;

export function CentralDataWorkbench({ resource }: { resource: Resource }) {
  const confirm = useConfirmDialog();
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const path = resource === 'prompts'
    ? '/v1/prompts'
    : resource === 'knowledge'
      ? '/v1/knowledge'
      : '/v1/settings';

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest<any[]>(endpoint(path)));
      setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '中心数据读取失败');
    } finally {
      setLoading(false);
    }
  }, [path]);

  useEffect(() => { void refresh(); }, [refresh]);

  async function createPrompt(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    try {
      await apiRequest(endpoint('/v1/prompts/versions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: String(form.get('kind') ?? '').trim(),
          name: String(form.get('name') ?? '').trim(),
          content: String(form.get('content') ?? ''),
        }),
      });
      event.currentTarget.reset();
      setMessage('提示词草稿版本已保存到中心服务。');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '提示词保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function createKnowledge(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let content;
    try {
      content = JSON.parse(String(form.get('content') ?? '{}'));
    } catch {
      setError('知识内容必须是合法 JSON。');
      return;
    }
    setBusy(true);
    try {
      await apiRequest(endpoint('/v1/knowledge/versions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: String(form.get('kind') ?? 'COPY'),
          name: String(form.get('name') ?? '').trim(),
          content,
        }),
      });
      event.currentTarget.reset();
      setMessage('知识库草稿版本已保存到中心服务。');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '知识库保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function updateProduction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let value;
    try {
      value = JSON.parse(String(form.get('value') ?? '{}'));
      const selected = String(form.get('agentProvider') ?? 'INHERIT');
      value = { ...value, modelApi: { ...value.modelApi, agentProvider: selected === 'INHERIT' ? null : selected } };
    } catch {
      setError('生产配置必须是合法 JSON。');
      return;
    }
    setBusy(true);
    try {
      await apiRequest(endpoint('/v1/settings/production'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value }),
      });
      setMessage('生产配置已保存到中心服务，新的执行快照会使用该版本。');
      await refresh();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : '生产配置保存失败');
    } finally {
      setBusy(false);
    }
  }

  async function publish(kind: 'prompt' | 'knowledge', versionId: number) {
    if (!await confirm({
      title: '发布这个版本？',
      description: '发布只影响之后开始或选择“使用最新配置重试”的执行，不会改变正在运行的配置快照。',
      confirmLabel: '确认发布',
    })) return;
    setBusy(true);
    try {
      const path = kind === 'prompt'
        ? `/v1/prompt-versions/${versionId}/publish`
        : `/v1/knowledge-versions/${versionId}/publish`;
      await apiRequest(endpoint(path), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
      });
      setMessage('版本已发布。');
      await refresh();
    } catch (publishError) {
      setError(publishError instanceof Error ? publishError.message : '版本发布失败');
    } finally {
      setBusy(false);
    }
  }

  const production = data.find((item) => item.key === 'production');

  return <div className="central-data-stack">
    {resource === 'settings' && <WebSearchSettingsPanel onSaved={refresh} />}
    {resource === 'prompts' && <form className="panel" onSubmit={createPrompt}>
      <div className="panel-head"><div><span className="section-kicker">Remote prompt</span><h2>新建提示词草稿</h2></div><Save size={18} /></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="central-prompt-kind">类型</label><input className="input" id="central-prompt-kind" name="kind" required placeholder="TEXT_SYSTEM" /></div>
        <div className="field"><label htmlFor="central-prompt-name">名称</label><input className="input" id="central-prompt-name" name="name" required maxLength={160} /></div>
        <div className="field full"><label htmlFor="central-prompt-content">内容</label><textarea className="textarea" id="central-prompt-content" name="content" required /></div>
        <div className="field full"><button className="button primary" disabled={busy}>保存草稿</button></div>
      </div>
    </form>}

    {resource === 'knowledge' && <form className="panel" onSubmit={createKnowledge}>
      <div className="panel-head"><div><span className="section-kicker">Remote knowledge</span><h2>新建知识版本</h2></div><Save size={18} /></div>
      <div className="form-grid">
        <div className="field"><label htmlFor="central-knowledge-kind">类型</label><select className="input" id="central-knowledge-kind" name="kind"><option value="COPY">文案知识</option><option value="VISUAL">视觉知识</option></select></div>
        <div className="field"><label htmlFor="central-knowledge-name">名称</label><input className="input" id="central-knowledge-name" name="name" required maxLength={200} /></div>
        <div className="field full"><label htmlFor="central-knowledge-content">结构化内容 JSON</label><textarea className="textarea" id="central-knowledge-content" name="content" required defaultValue={'{\n  "text": ""\n}'} /></div>
        <div className="field full"><button className="button primary" disabled={busy}>保存草稿</button></div>
      </div>
    </form>}

    {resource === 'settings' && <form className="panel" onSubmit={updateProduction} key={production?.version ?? 0}>
      <div className="panel-head"><div><span className="section-kicker">Remote settings</span><h2>生产配置 JSON</h2></div><Save size={18} /></div>
      <div className="field">
        <label htmlFor="central-agent-provider">生成引擎</label>
        <Select name="agentProvider" disabled={busy || loading} defaultValue={production?.value?.modelApi?.agentProvider ?? 'INHERIT'}>
          <SelectTrigger id="central-agent-provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="INHERIT">沿用执行机环境（项目默认 Codex）</SelectItem>
            <SelectItem value="CODEX">Codex CLI（ChatGPT 订阅登录）</SelectItem>
            <SelectItem value="OPENCLAW">OpenClaw（兼容回退）</SelectItem>
          </SelectContent>
        </Select>
        <small>保存时以下 JSON 的 modelApi.agentProvider 以此选项为准。凭据仅在执行机管理；已有快照保持原配置，回切需选择“使用最新配置重新生成”。</small>
      </div>
      <div className="field"><label htmlFor="central-production-settings">当前配置</label><textarea className="textarea central-json-editor" id="central-production-settings" name="value" required defaultValue={JSON.stringify(production?.value ?? {}, null, 2)} /></div>
      <div className="inline"><button className="button primary" disabled={busy || loading}>保存新版本</button><small>模型 API 密钥仍只通过执行机环境变量提供，不要写入这里。</small></div>
    </form>}

    {resource !== 'settings' && <section className="panel">
      <div className="panel-head"><div><span className="section-kicker">Published data</span><h2>中心版本列表</h2></div><button className="button small" type="button" onClick={() => { void refresh(); }}><RefreshCw size={14} />刷新</button></div>
      {loading ? <div className="empty-state"><LoaderCircle className="animate-spin" size={18} />正在读取…</div>
        : data.length === 0 ? <div className="empty-state">暂无版本。</div>
          : <div className="central-version-list">{data.map((item) => <article key={`${resource}-${item.id}`}>
            <div><strong>{item.name}</strong><span className="pill">{item.kind}</span></div>
            {(item.versions ?? []).map((version: any) => <div className="central-version-row" key={version.id}>
              <span>v{version.version} · {version.status}</span>
              {version.status === 'DRAFT' && <button className="button small" type="button" disabled={busy} onClick={() => { void publish(resource === 'prompts' ? 'prompt' : 'knowledge', version.id); }}><UploadCloud size={13} />发布</button>}
            </div>)}
          </article>)}</div>}
    </section>}

    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
