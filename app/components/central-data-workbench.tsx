'use client';

import { Save } from 'lucide-react';
import { useCallback, useEffect, useState, type FormEvent } from 'react';

import { apiRequest } from './api-client';
import { WebSearchSettingsPanel } from '../settings/web-search-settings-panel';

const endpoint = (path: string) => `/api/control-plane${path}`;

export function CentralDataWorkbench() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setData(await apiRequest<any[]>(endpoint('/v1/settings')));
      setError('');
    } catch (refreshError) {
      setError(refreshError instanceof Error ? refreshError.message : '中心数据读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  async function updateProduction(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    let value;
    try {
      value = JSON.parse(String(form.get('value') ?? '{}'));
      value = { ...value, modelApi: { ...value.modelApi, agentProvider: 'CODEX' } };
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

  const production = data.find((item) => item.key === 'production');

  return <div className="central-data-stack">
    <WebSearchSettingsPanel onSaved={refresh} />
    <form className="panel" onSubmit={updateProduction} key={production?.version ?? 0}>
      <div className="panel-head"><div><span className="section-kicker">Remote settings</span><h2>生产配置 JSON</h2></div><Save size={18} /></div>
      <div className="field"><label htmlFor="central-production-settings">当前配置</label><textarea className="textarea central-json-editor" id="central-production-settings" name="value" required defaultValue={JSON.stringify(production?.value ?? {}, null, 2)} /></div>
      <div className="inline"><button className="button primary" disabled={busy || loading}>保存新版本</button><small>模型 API 密钥仍只通过执行机环境变量提供，不要写入这里。</small></div>
    </form>

    {message && <div className="notice success" role="status">{message}</div>}
    {error && <div className="notice error" role="alert">{error}</div>}
  </div>;
}
