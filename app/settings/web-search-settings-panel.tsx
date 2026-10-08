'use client';

import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { ToastFeedback } from '@/components/ui/sonner';

import { Search, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '../components/api-client';
import { DEEPSEEK_MODEL_ID_PATTERN, DEFAULT_DEEPSEEK_SEARCH_MODEL, DEFAULT_WEB_SEARCH_PROVIDER, DEFAULT_WEB_SEARCH_TIMEOUT_MS, DEFAULT_WEB_SEARCH_RESULT_LIMIT } from '../../src/web-search-config.mjs';

type SearchProvider = 'DOUBAO' | 'DEEPSEEK' | 'CODEX';
type DoubaoSearchMode = 'GLOBAL' | 'CUSTOM';
type SearchSettings = {
  webSearchProvider: SearchProvider | null;
  webSearchProviderOrder: SearchProvider[] | null;
  deepseekSearchModel: string | null;
  webSearchTimeoutMs: number | null;
  webSearchResultLimit: number | null;
  doubaoSearchMode: DoubaoSearchMode | null;
  doubaoIcpHostOnly: boolean | null;
};
type SearchRecord = {
  settings: SearchSettings;
  scope: 'central' | 'local';
  effective: { provider: SearchProvider; providers?: SearchProvider[]; model?: string;
    timeoutMs?: number; resultLimit: number; doubaoSearchMode?: DoubaoSearchMode;
    doubaoIcpHostOnly?: boolean } | null;
  apiKeyConfigured: boolean | null;
  providerKeyConfigured?: { DEEPSEEK: boolean | null; DOUBAO: boolean | null };
  updatedAt: string | null;
};
const EMPTY_SETTINGS: SearchSettings = { webSearchProvider: null, webSearchProviderOrder: null,
  deepseekSearchModel: null, webSearchTimeoutMs: null, webSearchResultLimit: null,
  doubaoSearchMode: null, doubaoIcpHostOnly: null };
const INHERIT = 'INHERIT';
const SEARCH_PROVIDERS: SearchProvider[] = ['DOUBAO', 'DEEPSEEK', 'CODEX'];
const PROVIDER_LABELS: Record<SearchProvider, string> = {
  DOUBAO: '火山引擎豆包搜索', DEEPSEEK: 'DeepSeek 联网搜索', CODEX: 'Codex 联网搜索',
};

export function WebSearchSettingsPanel({
  onSaved,
  onDirtyChange,
}: {
  onSaved?: () => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
}) {
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
    if (!record) return;
    const changed = (Object.keys(settings) as Array<keyof SearchSettings>)
      .filter((key) => JSON.stringify(settings[key]) !== JSON.stringify(record.settings[key]));
    if (changed.length === 0) return;
    const patch = Object.fromEntries(changed.map((key) => [key, settings[key]]));
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const next = await apiRequest<SearchRecord>('/api/web-search-settings', {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
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
  const invalidResultLimit = settings.webSearchResultLimit !== null
    && (!Number.isInteger(settings.webSearchResultLimit) || settings.webSearchResultLimit < 1 || settings.webSearchResultLimit > 10);
  const invalidModel = settings.deepseekSearchModel !== null
    && !DEEPSEEK_MODEL_ID_PATTERN.test(settings.deepseekSearchModel.trim());
  const hasChanges = record !== null && JSON.stringify(settings) !== JSON.stringify(record.settings);
  useEffect(() => {
    onDirtyChange?.(hasChanges);
    return () => { onDirtyChange?.(false); };
  }, [hasChanges, onDirtyChange]);
  const configuredProviders = settings.webSearchProviderOrder
    ?? [settings.webSearchProvider ?? record?.effective?.provider ?? DEFAULT_WEB_SEARCH_PROVIDER];
  const usesDeepSeek = configuredProviders.includes('DEEPSEEK');
  const usesDoubao = configuredProviders.includes('DOUBAO');
  const usesApi = usesDeepSeek || usesDoubao;
  const doubaoMode = settings.doubaoSearchMode ?? 'CUSTOM';
  const savedProvider = record?.effective?.provider ?? record?.settings.webSearchProvider;
  const savedOrder = record?.settings.webSearchProviderOrder;
  const savedModel = record?.effective?.model ?? record?.settings.deepseekSearchModel;
  const savedDoubaoMode = record?.effective?.doubaoSearchMode ?? record?.settings.doubaoSearchMode ?? 'CUSTOM';
  const savedProviderLabel = (provider: SearchProvider) => provider === 'DOUBAO'
    ? `${PROVIDER_LABELS.DOUBAO}（${savedDoubaoMode === 'CUSTOM' ? 'Custom' : 'Global'}）`
    : PROVIDER_LABELS[provider];

  function changePrimary(value: string) {
    setMessage('');
    setSettings((current) => {
      if (value === INHERIT) return { ...current, webSearchProvider: null, webSearchProviderOrder: null };
      const provider = value as SearchProvider;
      return { ...current, webSearchProvider: provider,
        webSearchProviderOrder: current.webSearchProviderOrder
          ? [provider, ...current.webSearchProviderOrder.filter((item) => item !== provider)] : null };
    });
  }

  function addBackup() {
    setMessage('');
    setSettings((current) => {
      const first = current.webSearchProviderOrder?.[0] ?? current.webSearchProvider
        ?? record?.effective?.provider ?? DEFAULT_WEB_SEARCH_PROVIDER;
      const order = current.webSearchProviderOrder ?? [first];
      const next = SEARCH_PROVIDERS.find((provider) => !order.includes(provider));
      return next ? { ...current, webSearchProvider: first, webSearchProviderOrder: [...order, next] } : current;
    });
  }

  function changeBackup(index: number, provider: SearchProvider) {
    setMessage('');
    setSettings((current) => {
      if (!current.webSearchProviderOrder || current.webSearchProviderOrder.includes(provider)) return current;
      const order = [...current.webSearchProviderOrder];
      order[index] = provider;
      return { ...current, webSearchProviderOrder: order };
    });
  }

  return <section className="panel settings-section" aria-labelledby="web-search-heading" aria-busy={loading || busy}>
    <div className="panel-head">
      <div><span className="section-kicker">Web search</span><h2 id="web-search-heading">联网搜索服务</h2>
        <p className="subtle">设置搜索服务及备用顺序；主服务失败或证据不足时，按顺序尝试备用服务。修改后对后续任务生效。</p></div>
      <Search size={20} aria-hidden="true" />
    </div>
    {loading && <p className="subtle" role="status">正在读取搜索配置…</p>}
    {record && <p className="notice" role="status">
      {record.scope === 'local' ? '当前生效：' : '已保存的搜索服务：'}
      {savedOrder ? savedOrder.map(savedProviderLabel).join(' → ')
        : savedProvider === 'CODEX' ? '默认生成引擎'
          : savedProvider === 'DOUBAO' ? savedProviderLabel('DOUBAO')
            : savedProvider === 'DEEPSEEK' ? `DeepSeek · ${savedModel ?? `执行机模型（默认 ${DEFAULT_DEEPSEEK_SEARCH_MODEL}）`}`
              : `继承执行机环境（项目默认 ${DEFAULT_DEEPSEEK_SEARCH_MODEL}）`}
      {hasChanges && <span> · 有未保存的更改</span>}
    </p>}
    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="web-search-provider">搜索服务</label>
        <Select disabled={disabled} value={settings.webSearchProviderOrder?.[0] ?? settings.webSearchProvider ?? INHERIT}
          onValueChange={changePrimary}>
          <SelectTrigger id="web-search-provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>跟随执行机默认配置</SelectItem>
            <SelectItem value="DOUBAO">火山引擎豆包搜索</SelectItem>
            <SelectItem value="DEEPSEEK">DeepSeek 联网搜索</SelectItem>
            <SelectItem value="CODEX">Codex 联网搜索</SelectItem>
          </SelectContent>
        </Select>
        <small>第一项是首选搜索服务。跟随默认配置时，执行机环境设置优先。</small>
      </div>
      <div className="field">
        <label>备用搜索服务</label>
        {settings.webSearchProviderOrder?.slice(1).map((provider, offset) => {
          const index = offset + 1;
          return <div className="settings-actions" key={`${index}-${provider}`}>
            <Select disabled={disabled} value={provider} onValueChange={(value) => changeBackup(index, value as SearchProvider)}>
              <SelectTrigger aria-label={`第 ${index} 个备用搜索服务`}><SelectValue /></SelectTrigger>
              <SelectContent>{SEARCH_PROVIDERS.map((choice) => <SelectItem key={choice} value={choice}
                disabled={settings.webSearchProviderOrder?.includes(choice) && choice !== provider}>
                {PROVIDER_LABELS[choice]}</SelectItem>)}</SelectContent>
            </Select>
            <Button unstyled type="button" className="button" disabled={disabled || index === 1}
              onClick={() => setSettings((current) => {
                const order = [...(current.webSearchProviderOrder ?? [])];
                [order[index - 1], order[index]] = [order[index], order[index - 1]];
                return { ...current, webSearchProvider: order[0], webSearchProviderOrder: order };
              })}>上移</Button>
            <Button unstyled type="button" className="button" disabled={disabled}
              onClick={() => setSettings((current) => {
                const order = current.webSearchProviderOrder?.filter((_, position) => position !== index) ?? [];
                return { ...current, webSearchProviderOrder: order.length > 1 ? order : null };
              })}>移除</Button>
          </div>;
        })}
        <div className="settings-actions">
          <Button unstyled type="button" className="button" disabled={disabled || (settings.webSearchProviderOrder?.length ?? 1) >= SEARCH_PROVIDERS.length}
            onClick={addBackup}>添加备用服务</Button>
          {settings.webSearchProviderOrder && <Button unstyled type="button" className="button" disabled={disabled}
            onClick={() => setSettings((current) => ({ ...current, webSearchProviderOrder: null }))}>只用首选服务</Button>}
        </div>
        <small>最多配置 3 个不同的服务，依次尝试。启用多服务前，请先升级并重启所有执行机。</small>
      </div>
      <div className="field">
        <label htmlFor="deepseek-search-model">DeepSeek 搜索模型</label>
        <Input id="deepseek-search-model" className="input" type="text" maxLength={128}
          disabled={disabled || !usesDeepSeek} value={settings.deepseekSearchModel ?? ''}
          placeholder={`继承环境，默认 ${DEFAULT_DEEPSEEK_SEARCH_MODEL}`} autoComplete="off" spellCheck={false}
          aria-invalid={invalidModel} onChange={(event) => {
            setMessage('');
            setSettings((current) => ({ ...current, deepseekSearchModel: event.target.value === '' ? null : event.target.value }));
          }} />
        <small>{invalidModel
          ? '模型 ID 须以字母或数字开头，最多 128 个字符。'
          : '留空继承执行机环境；可直接填写 DeepSeek 后续发布的新模型 ID。'}</small>
      </div>
      <div className="field">
        <label htmlFor="web-search-timeout">API 搜索超时（毫秒）</label>
        <Input id="web-search-timeout" className="input" type="number" min={5000} max={120000} step={1000}
          disabled={disabled || !usesApi} value={settings.webSearchTimeoutMs ?? ''} placeholder="继承环境，默认 120000"
          aria-invalid={invalidTimeout} onChange={(event) => {
            setMessage('');
            setSettings((current) => ({ ...current, webSearchTimeoutMs: event.target.value === '' ? null : Number(event.target.value) }));
          }} />
        <small>{invalidTimeout ? '请输入 5,000–120,000 之间的整数。' : '留空沿用执行机环境；允许 5,000–120,000。'}</small>
      </div>
      <div className="field">
        <label htmlFor="web-search-result-limit">联网搜索来源数</label>
        <Input id="web-search-result-limit" className="input" type="number" min={1} max={10} step={1}
          disabled={disabled} value={settings.webSearchResultLimit ?? ''} placeholder={String(DEFAULT_WEB_SEARCH_RESULT_LIMIT)}
          aria-invalid={invalidResultLimit} onChange={(event) => {
            setMessage('');
            setSettings((current) => ({ ...current, webSearchResultLimit: event.target.value === '' ? null : Number(event.target.value) }));
          }} />
        <small>{invalidResultLimit
          ? '请输入 1–10 之间的整数。'
          : '请求并最多保留 1–10 条公开来源；留空使用默认 5 条。过滤和去重后，实际来源可能更少。'}</small>
      </div>
      <div className="field">
        <label htmlFor="doubao-search-mode">豆包搜索模式</label>
        <Select disabled={disabled || !usesDoubao}
          value={settings.doubaoSearchMode ?? INHERIT}
          onValueChange={(value) => {
            setMessage('');
            setSettings((current) => ({ ...current,
              doubaoSearchMode: value === INHERIT ? null : value as DoubaoSearchMode }));
          }}>
          <SelectTrigger id="doubao-search-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>默认：Custom</SelectItem>
            <SelectItem value="CUSTOM">Custom（订阅套餐）</SelectItem>
            <SelectItem value="GLOBAL">Global（按量后付费）</SelectItem>
          </SelectContent>
        </Select>
        <small>两种模式使用不同接口；请为执行机配置与所选模式匹配的豆包搜索 Key。</small>
      </div>
      <div className="field">
        <label htmlFor="doubao-icp-host-only">豆包搜索站点范围</label>
        <Select disabled={disabled || !usesDoubao || doubaoMode !== 'GLOBAL'}
          value={settings.doubaoIcpHostOnly === null ? INHERIT : settings.doubaoIcpHostOnly ? 'ICP' : 'ALL'}
          onValueChange={(value) => {
            setMessage('');
            setSettings((current) => ({ ...current,
              doubaoIcpHostOnly: value === INHERIT ? null : value === 'ICP' }));
          }}>
          <SelectTrigger id="doubao-icp-host-only"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>默认：仅 ICP 备案站点</SelectItem>
            <SelectItem value="ICP">仅 ICP 备案站点</SelectItem>
            <SelectItem value="ALL">不限站点备案</SelectItem>
          </SelectContent>
        </Select>
        <small>{doubaoMode === 'CUSTOM'
          ? 'Custom 接口不支持此过滤；切回 Global 后会沿用原有设置。'
          : '此选项控制 Global 的 IcpHostOnly 过滤；不能保证所有结果都来自境内。'}</small>
      </div>
    </div>
    <p className="notice">API Key 由各执行机环境提供：豆包使用 <span className="mono">DOUBAO_SEARCH_API_KEY</span>，
      DeepSeek 使用 <span className="mono">DEEPSEEK_API_KEY</span>。中心不保存密钥。
      {record?.scope === 'central' ? ' 启用多服务前请升级并重启所有执行机，且确认每台执行机都已配置要启用的服务。'
        : record ? ` 本机状态：豆包${record.providerKeyConfigured?.DOUBAO ? '已配置' : '未配置'}，DeepSeek${record.providerKeyConfigured?.DEEPSEEK ? '已配置' : '未配置'}。` : ''}
      {' '}“已配置”仅表示 Key 非空；Custom 接口权限需实际搜索验证。测试站浏览器中填写的 Key 不会进入执行机。
    </p>
    {error && <div className="notice error" role="alert">{error}</div>}
    <ToastFeedback id="web-search-settings-feedback" message={message} />
    <div className="settings-actions">
      <Button unstyled type="button" className="button" disabled={disabled} onClick={() => {
        setSettings((current) => ({ ...current, webSearchProvider: DEFAULT_WEB_SEARCH_PROVIDER, webSearchProviderOrder: null,
          deepseekSearchModel: DEFAULT_DEEPSEEK_SEARCH_MODEL, webSearchTimeoutMs: DEFAULT_WEB_SEARCH_TIMEOUT_MS }));
        setMessage(`已选择 DeepSeek ${DEFAULT_DEEPSEEK_SEARCH_MODEL}，点击“保存搜索配置”后生效。`);
      }}>使用 DeepSeek 默认模型</Button>
      <Button unstyled type="button" className="button" disabled={disabled} onClick={() => { setSettings({ ...EMPTY_SETTINGS }); setMessage(''); }}>
        <RotateCcw size={15} aria-hidden="true" />恢复环境配置
      </Button>
      {!record && !loading && <Button unstyled type="button" className="button" onClick={() => { void load(); }}>重新读取</Button>}
      <Button unstyled type="button" className="button primary" disabled={disabled || !hasChanges || invalidModel || invalidTimeout || invalidResultLimit} onClick={save}>{busy ? '保存中…' : '保存搜索配置'}</Button>
    </div>
  </section>;
}
