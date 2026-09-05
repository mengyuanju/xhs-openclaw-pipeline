'use client';

import { Search, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '../components/api-client';
import { DEFAULT_DEEPSEEK_SEARCH_MODEL, DEFAULT_WEB_SEARCH_PROVIDER, DEFAULT_WEB_SEARCH_TIMEOUT_MS } from '../../src/web-search-config.mjs';

type SearchSettings = {
  webSearchProvider: 'OPENCLAW' | 'DEEPSEEK' | null;
  deepseekSearchModel: 'deepseek-v4-pro' | 'deepseek-v4-flash' | null;
  webSearchTimeoutMs: number | null;
};
type SearchRecord = {
  settings: SearchSettings;
  scope: 'central' | 'local';
  effective: { provider: 'OPENCLAW' | 'DEEPSEEK'; model?: string; timeoutMs?: number } | null;
  apiKeyConfigured: boolean | null;
  updatedAt: string | null;
};
const EMPTY_SETTINGS: SearchSettings = { webSearchProvider: null, deepseekSearchModel: null, webSearchTimeoutMs: null };
const INHERIT = 'INHERIT';

export function WebSearchSettingsPanel({ onSaved }: { onSaved?: () => Promise<void> }) {
  const [record, setRecord] = useState<SearchRecord | null>(null);
  const [settings, setSettings] = useState<SearchSettings>(EMPTY_SETTINGS);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const next = await apiRequest<SearchRecord>('/api/web-search-settings');
      setRecord(next);
      setSettings(next.settings);
      setError('');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '搜索配置读取失败');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function save() {
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await apiRequest<SearchRecord>('/api/web-search-settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(settings),
      });
      setRecord(next);
      setSettings(next.settings);
      setMessage(next.scope === 'central'
        ? '搜索配置已保存到中心；新建执行快照会使用此配置，正在运行的任务保持原配置。'
        : '搜索配置已保存；后续任务将使用此配置。');
      await onSaved?.();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '搜索配置保存失败');
    } finally { setBusy(false); }
  }

  const disabled = loading || busy || !record;
  const invalidTimeout = settings.webSearchTimeoutMs !== null
    && (!Number.isInteger(settings.webSearchTimeoutMs) || settings.webSearchTimeoutMs < 5000 || settings.webSearchTimeoutMs > 120000);
  const hasChanges = record !== null && JSON.stringify(settings) !== JSON.stringify(record.settings);
  const usesOpenClaw = settings.webSearchProvider === 'OPENCLAW'
    || (settings.webSearchProvider === null && record?.effective?.provider === 'OPENCLAW');
  const savedProvider = record?.effective?.provider ?? record?.settings.webSearchProvider;
  const savedModel = record?.effective?.model ?? record?.settings.deepseekSearchModel;

  return <section className="panel settings-section" aria-labelledby="web-search-heading" aria-busy={loading || busy}>
    <div className="panel-head">
      <div><span className="section-kicker">Web search</span><h2 id="web-search-heading">联网搜索服务</h2>
        <p className="subtle">选择文案检索使用的服务，默认 DeepSeek Flash。修改后点击保存，对后续任务生效。</p></div>
      <Search size={20} aria-hidden="true" />
    </div>
    {loading && <p className="subtle" role="status">正在读取搜索配置…</p>}
    {record && <p className="notice" role="status">
      {record.scope === 'local' ? '当前生效：' : '已保存的搜索服务：'}
      {savedProvider === 'OPENCLAW' ? 'OpenClaw'
        : savedProvider === 'DEEPSEEK' ? `DeepSeek · ${savedModel ?? '继承执行机模型（默认 Flash）'}`
          : '继承执行机环境（项目默认 DeepSeek Flash）'}
      {hasChanges && <span> · 有未保存的更改</span>}
    </p>}
    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="web-search-provider">搜索服务</label>
        <Select disabled={disabled} value={settings.webSearchProvider ?? INHERIT} onValueChange={(value) => {
          setMessage('');
          setSettings((current) => ({ ...current, webSearchProvider: value === INHERIT ? null : value as SearchSettings['webSearchProvider'] }));
        }}>
          <SelectTrigger id="web-search-provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>跟随默认配置（DeepSeek）</SelectItem>
            <SelectItem value="DEEPSEEK">DeepSeek 联网搜索（推荐）</SelectItem>
            <SelectItem value="OPENCLAW">OpenClaw 联网搜索</SelectItem>
          </SelectContent>
        </Select>
        <small>可随时切换服务；跟随默认配置时，执行机环境设置优先。</small>
      </div>
      <div className="field">
        <label htmlFor="deepseek-search-model">DeepSeek 搜索模型</label>
        <Select disabled={disabled || usesOpenClaw} value={settings.deepseekSearchModel ?? INHERIT} onValueChange={(value) => {
          setMessage('');
          setSettings((current) => ({ ...current, deepseekSearchModel: value === INHERIT ? null : value as SearchSettings['deepseekSearchModel'] }));
        }}>
          <SelectTrigger id="deepseek-search-model"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>跟随默认配置（Flash）</SelectItem>
            <SelectItem value="deepseek-v4-flash">DeepSeek V4 Flash（推荐）</SelectItem>
            <SelectItem value="deepseek-v4-pro">DeepSeek V4 Pro</SelectItem>
          </SelectContent>
        </Select>
        <small>仅在使用 DeepSeek 搜索时生效。</small>
      </div>
      <div className="field">
        <label htmlFor="web-search-timeout">DeepSeek 搜索超时（毫秒）</label>
        <input id="web-search-timeout" className="input" type="number" min={5000} max={120000} step={1000}
          disabled={disabled || usesOpenClaw} value={settings.webSearchTimeoutMs ?? ''} placeholder="继承环境，默认 120000"
          aria-invalid={invalidTimeout} onChange={(event) => {
            setMessage('');
            setSettings((current) => ({ ...current, webSearchTimeoutMs: event.target.value === '' ? null : Number(event.target.value) }));
          }} />
        <small>{invalidTimeout ? '请输入 5,000–120,000 之间的整数。' : '留空沿用执行机环境；允许 5,000–120,000。'}</small>
      </div>
    </div>
    <p className="notice">DeepSeek Key 由你在实际执行机的 <span className="mono">DEEPSEEK_API_KEY</span> 中提供。
      {record?.scope === 'central' ? ' 中心不保存密钥，也无法判断各执行机是否已配置。'
        : record ? (record.apiKeyConfigured ? ' 本机已配置 Key。' : ' 本机尚未配置 Key。') : ''}
    </p>
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <div className="settings-actions">
      <button type="button" className="button" disabled={disabled} onClick={() => {
        setSettings({ webSearchProvider: DEFAULT_WEB_SEARCH_PROVIDER, deepseekSearchModel: DEFAULT_DEEPSEEK_SEARCH_MODEL, webSearchTimeoutMs: DEFAULT_WEB_SEARCH_TIMEOUT_MS });
        setMessage('已选择 DeepSeek Flash 推荐配置，点击“保存搜索配置”后生效。');
      }}>使用 DeepSeek Flash</button>
      <button type="button" className="button" disabled={disabled} onClick={() => { setSettings({ ...EMPTY_SETTINGS }); setMessage(''); }}>
        <RotateCcw size={15} aria-hidden="true" />恢复环境配置
      </button>
      {!record && !loading && <button type="button" className="button" onClick={() => { void load(); }}>重新读取</button>}
      <button type="button" className="button primary" disabled={disabled || invalidTimeout} onClick={save}>{busy ? '保存中…' : '保存搜索配置'}</button>
    </div>
  </section>;
}
