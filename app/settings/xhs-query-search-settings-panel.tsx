'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

import { ListOrdered } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';

const SETTINGS_ENDPOINT = '/api/control-plane/v1/settings';
const UPDATE_ENDPOINT = '/api/control-plane/v1/settings/xhs_query_search';
const DEFAULT_RESULT_LIMIT = 3;
const MIN_RESULT_LIMIT = 1;
const MAX_RESULT_LIMIT = 10;

type XiaohongshuQuerySearchSettings = {
  resultLimit: number;
};

type GlobalSettingRecord = {
  key: string;
  value: unknown;
  version?: number;
  updatedAt?: string | null;
};

function resultLimitFrom(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('中心返回的小红书搜索配置无效');
  }
  const resultLimit = (value as Partial<XiaohongshuQuerySearchSettings>).resultLimit;
  if (!Number.isInteger(resultLimit)
    || Number(resultLimit) < MIN_RESULT_LIMIT
    || Number(resultLimit) > MAX_RESULT_LIMIT) {
    throw new RangeError('中心返回的小红书链接条数无效');
  }
  return Number(resultLimit);
}

function settingFromList(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError('中心返回的生产配置列表无效');
  const record = value.find((candidate) => candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && (candidate as Partial<GlobalSettingRecord>).key === 'xhs_query_search') as GlobalSettingRecord | undefined;
  if (!record) return { resultLimit: DEFAULT_RESULT_LIMIT, updatedAt: null };
  return {
    resultLimit: resultLimitFrom(record.value),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
}

function settingFromSave(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('中心没有返回已保存的小红书搜索配置');
  }
  const record = value as Partial<GlobalSettingRecord>;
  if (record.key !== 'xhs_query_search') {
    throw new TypeError('中心返回的小红书搜索配置不完整');
  }
  return {
    resultLimit: resultLimitFrom(record.value),
    updatedAt: typeof record.updatedAt === 'string' ? record.updatedAt : null,
  };
}

export function XhsQuerySearchSettingsPanel({
  onSaved,
}: {
  onSaved?: () => Promise<void>;
}) {
  const [savedResultLimit, setSavedResultLimit] = useState(DEFAULT_RESULT_LIMIT);
  const [draft, setDraft] = useState(String(DEFAULT_RESULT_LIMIT));
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const setting = settingFromList(await apiRequest<unknown>(SETTINGS_ENDPOINT, { cache: 'no-store' }));
      setSavedResultLimit(setting.resultLimit);
      setDraft(String(setting.resultLimit));
      setUpdatedAt(setting.updatedAt);
      setLoaded(true);
    } catch (failure) {
      setLoaded(false);
      setError(failure instanceof Error ? failure.message : '小红书搜索配置读取失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const parsedResultLimit = Number(draft);
  const invalid = !/^\d+$/u.test(draft)
    || !Number.isInteger(parsedResultLimit)
    || parsedResultLimit < MIN_RESULT_LIMIT
    || parsedResultLimit > MAX_RESULT_LIMIT;
  const changed = loaded && (invalid || parsedResultLimit !== savedResultLimit);
  const disabled = loading || busy || !loaded;

  async function save() {
    if (invalid) return;
    setBusy(true);
    setError('');
    setMessage('');
    try {
      const setting = settingFromSave(await apiRequest<unknown>(UPDATE_ENDPOINT, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value: { resultLimit: parsedResultLimit } }),
      }));
      setSavedResultLimit(setting.resultLimit);
      setDraft(String(setting.resultLimit));
      setUpdatedAt(setting.updatedAt);
      setMessage('小红书链接条数已保存；之后领取或重新领取的搜索使用新值，运行中和已完成的结果不变。');
      try {
        await onSaved?.();
      } catch {
        setError('配置已保存，但页面其他配置刷新失败，请稍后刷新页面。');
      }
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '小红书搜索配置保存失败');
    } finally {
      setBusy(false);
    }
  }

  return <section className="panel settings-section" aria-labelledby="xhs-query-search-heading" aria-busy={loading || busy}>
    <div className="panel-head">
      <div>
        <span className="section-kicker">Xiaohongshu search</span>
        <h2 id="xhs-query-search-heading">小红书 Query 查找</h2>
        <p className="subtle">控制每个 Query 按点赞量从高到低保留多少条可访问的小红书笔记链接。</p>
      </div>
      <ListOrdered size={20} aria-hidden="true" />
    </div>
    {loading && <p className="subtle" role="status">正在读取小红书搜索配置…</p>}
    {loaded && <p className="notice" role="status">
      当前保存：每个 Query 最多 {savedResultLimit} 条
      {changed && <span> · 有未保存的更改</span>}
    </p>}
    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="xhs-query-search-result-limit">每个 Query 保留链接数</label>
        <Input
          id="xhs-query-search-result-limit"
          className="input"
          type="number"
          min={MIN_RESULT_LIMIT}
          max={MAX_RESULT_LIMIT}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          value={draft}
          aria-invalid={invalid}
          onChange={(event) => {
            setMessage('');
            setDraft(event.target.value);
          }}
        />
        <small>{invalid ? '请输入 1–10 之间的整数。' : '允许设置 1–10 条，默认 3 条。'}</small>
      </div>
    </div>
    <p className="notice">系统会按点赞量排序后保留前几条；如果可访问的有效链接不足，实际保存数量可能少于设置值。</p>
    {updatedAt && <p className="subtle">最近保存：{new Date(updatedAt).toLocaleString('zh-CN')}</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <div className="settings-actions">
      {!loaded && !loading && <Button unstyled type="button" className="button" onClick={() => { void load(); }}>重新读取</Button>}
      <Button unstyled type="button" className="button primary" disabled={disabled || invalid || !changed} onClick={() => { void save(); }}>
        {busy ? '保存中…' : '保存小红书链接条数'}
      </Button>
    </div>
  </section>;
}
