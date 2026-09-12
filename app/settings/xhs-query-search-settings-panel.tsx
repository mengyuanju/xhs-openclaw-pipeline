'use client';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';

import { ListOrdered } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { apiRequest } from '../components/api-client';

const SETTINGS_ENDPOINT = '/api/control-plane/v1/settings';
const UPDATE_ENDPOINT = '/api/control-plane/v1/settings/xhs_query_search';
const DEFAULT_RESULT_LIMIT = 3;
const MIN_RESULT_LIMIT = 1;
const MAX_RESULT_LIMIT = 10;
const DEFAULT_SEARCH_MODE = 'FASTEST';
const DEFAULT_MINIMUM_INTERVAL_SECONDS = 60;
const MINIMUM_INTERVAL_SECONDS = 10;
const MAXIMUM_INTERVAL_SECONDS = 3600;
const DEFAULT_HOURLY_LIMIT = 30;
const MAX_HOURLY_LIMIT = 360;
const DEFAULT_DAILY_LIMIT = 150;
const MAX_DAILY_LIMIT = 8640;

type XiaohongshuSearchMode = 'FASTEST' | 'THOROUGH';

type XiaohongshuQuerySearchSettings = {
  resultLimit: number;
  searchMode: XiaohongshuSearchMode;
  minimumIntervalSeconds: number;
  hourlyLimit: number;
  dailyLimit: number;
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

function searchModeFrom(value: unknown): XiaohongshuSearchMode {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('中心返回的小红书搜索配置无效');
  }
  const searchMode = (value as Partial<XiaohongshuQuerySearchSettings>).searchMode ?? DEFAULT_SEARCH_MODE;
  if (!['FASTEST', 'THOROUGH'].includes(searchMode)) {
    throw new TypeError('中心返回的小红书搜索模式无效');
  }
  return searchMode;
}

function boundedSettingInteger(
  value: unknown,
  key: keyof Pick<XiaohongshuQuerySearchSettings,
  'minimumIntervalSeconds' | 'hourlyLimit' | 'dailyLimit'>,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('中心返回的小红书搜索配置无效');
  }
  const raw = (value as Partial<XiaohongshuQuerySearchSettings>)[key] ?? fallback;
  if (!Number.isInteger(raw) || Number(raw) < minimum || Number(raw) > maximum) {
    throw new RangeError(`中心返回的${label}无效`);
  }
  return Number(raw);
}

function pacingFrom(value: unknown) {
  const pacing = {
    minimumIntervalSeconds: boundedSettingInteger(
      value,
      'minimumIntervalSeconds',
      DEFAULT_MINIMUM_INTERVAL_SECONDS,
      MINIMUM_INTERVAL_SECONDS,
      MAXIMUM_INTERVAL_SECONDS,
      '搜索间隔',
    ),
    hourlyLimit: boundedSettingInteger(
      value, 'hourlyLimit', DEFAULT_HOURLY_LIMIT, 1, MAX_HOURLY_LIMIT, '每小时上限',
    ),
    dailyLimit: boundedSettingInteger(
      value, 'dailyLimit', DEFAULT_DAILY_LIMIT, 1, MAX_DAILY_LIMIT, '每日上限',
    ),
  };
  const maximumPerHour = Math.floor(3600 / pacing.minimumIntervalSeconds);
  const maximumPerDay = Math.min(
    Math.floor(86400 / pacing.minimumIntervalSeconds),
    pacing.hourlyLimit * 24,
  );
  if (pacing.hourlyLimit > maximumPerHour || pacing.dailyLimit > maximumPerDay) {
    throw new RangeError('中心返回的小红书账号保护节奏互相冲突');
  }
  return pacing;
}

function settingFromList(value: unknown) {
  if (!Array.isArray(value)) throw new TypeError('中心返回的生产配置列表无效');
  const record = value.find((candidate) => candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && (candidate as Partial<GlobalSettingRecord>).key === 'xhs_query_search') as GlobalSettingRecord | undefined;
  if (!record) return {
    resultLimit: DEFAULT_RESULT_LIMIT,
    searchMode: DEFAULT_SEARCH_MODE as XiaohongshuSearchMode,
    minimumIntervalSeconds: DEFAULT_MINIMUM_INTERVAL_SECONDS,
    hourlyLimit: DEFAULT_HOURLY_LIMIT,
    dailyLimit: DEFAULT_DAILY_LIMIT,
    updatedAt: null,
  };
  return {
    resultLimit: resultLimitFrom(record.value),
    searchMode: searchModeFrom(record.value),
    ...pacingFrom(record.value),
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
    searchMode: searchModeFrom(record.value),
    ...pacingFrom(record.value),
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
  const [savedSearchMode, setSavedSearchMode] = useState<XiaohongshuSearchMode>(DEFAULT_SEARCH_MODE);
  const [draftSearchMode, setDraftSearchMode] = useState<XiaohongshuSearchMode>(DEFAULT_SEARCH_MODE);
  const [savedMinimumIntervalSeconds, setSavedMinimumIntervalSeconds] = useState(DEFAULT_MINIMUM_INTERVAL_SECONDS);
  const [minimumIntervalDraft, setMinimumIntervalDraft] = useState(String(DEFAULT_MINIMUM_INTERVAL_SECONDS));
  const [savedHourlyLimit, setSavedHourlyLimit] = useState(DEFAULT_HOURLY_LIMIT);
  const [hourlyLimitDraft, setHourlyLimitDraft] = useState(String(DEFAULT_HOURLY_LIMIT));
  const [savedDailyLimit, setSavedDailyLimit] = useState(DEFAULT_DAILY_LIMIT);
  const [dailyLimitDraft, setDailyLimitDraft] = useState(String(DEFAULT_DAILY_LIMIT));
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
      setSavedSearchMode(setting.searchMode);
      setDraftSearchMode(setting.searchMode);
      setSavedMinimumIntervalSeconds(setting.minimumIntervalSeconds);
      setMinimumIntervalDraft(String(setting.minimumIntervalSeconds));
      setSavedHourlyLimit(setting.hourlyLimit);
      setHourlyLimitDraft(String(setting.hourlyLimit));
      setSavedDailyLimit(setting.dailyLimit);
      setDailyLimitDraft(String(setting.dailyLimit));
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
  const resultLimitInvalid = !/^\d+$/u.test(draft)
    || !Number.isInteger(parsedResultLimit)
    || parsedResultLimit < MIN_RESULT_LIMIT
    || parsedResultLimit > MAX_RESULT_LIMIT;
  const parsedMinimumIntervalSeconds = Number(minimumIntervalDraft);
  const parsedHourlyLimit = Number(hourlyLimitDraft);
  const parsedDailyLimit = Number(dailyLimitDraft);
  const minimumIntervalInvalid = !/^\d+$/u.test(minimumIntervalDraft)
    || !Number.isInteger(parsedMinimumIntervalSeconds)
    || parsedMinimumIntervalSeconds < MINIMUM_INTERVAL_SECONDS
    || parsedMinimumIntervalSeconds > MAXIMUM_INTERVAL_SECONDS;
  const hourlyLimitInvalid = !/^\d+$/u.test(hourlyLimitDraft)
    || !Number.isInteger(parsedHourlyLimit)
    || parsedHourlyLimit < 1
    || parsedHourlyLimit > MAX_HOURLY_LIMIT;
  const dailyLimitInvalid = !/^\d+$/u.test(dailyLimitDraft)
    || !Number.isInteger(parsedDailyLimit)
    || parsedDailyLimit < 1
    || parsedDailyLimit > MAX_DAILY_LIMIT;
  const maximumPerHour = minimumIntervalInvalid ? 0 : Math.floor(3600 / parsedMinimumIntervalSeconds);
  const maximumPerDay = minimumIntervalInvalid || hourlyLimitInvalid
    ? 0
    : Math.min(Math.floor(86400 / parsedMinimumIntervalSeconds), parsedHourlyLimit * 24);
  const pacingError = minimumIntervalInvalid
    ? '最短间隔请输入 10–3600 秒之间的整数。'
    : hourlyLimitInvalid
      ? '每小时上限请输入 1–360 之间的整数。'
      : parsedHourlyLimit > maximumPerHour
        ? `${parsedMinimumIntervalSeconds} 秒间隔下，每小时最多只能设置 ${maximumPerHour} 次。`
        : dailyLimitInvalid
          ? '每日上限请输入 1–8640 之间的整数。'
          : parsedDailyLimit > maximumPerDay
            ? `按当前间隔和每小时上限，每 24 小时最多只能设置 ${maximumPerDay} 次。`
            : '';
  const invalid = resultLimitInvalid || Boolean(pacingError);
  const changed = loaded && (invalid
    || parsedResultLimit !== savedResultLimit
    || draftSearchMode !== savedSearchMode
    || parsedMinimumIntervalSeconds !== savedMinimumIntervalSeconds
    || parsedHourlyLimit !== savedHourlyLimit
    || parsedDailyLimit !== savedDailyLimit);
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
        body: JSON.stringify({ value: {
          resultLimit: parsedResultLimit,
          searchMode: draftSearchMode,
          minimumIntervalSeconds: parsedMinimumIntervalSeconds,
          hourlyLimit: parsedHourlyLimit,
          dailyLimit: parsedDailyLimit,
        } }),
      }));
      setSavedResultLimit(setting.resultLimit);
      setDraft(String(setting.resultLimit));
      setSavedSearchMode(setting.searchMode);
      setDraftSearchMode(setting.searchMode);
      setSavedMinimumIntervalSeconds(setting.minimumIntervalSeconds);
      setMinimumIntervalDraft(String(setting.minimumIntervalSeconds));
      setSavedHourlyLimit(setting.hourlyLimit);
      setHourlyLimitDraft(String(setting.hourlyLimit));
      setSavedDailyLimit(setting.dailyLimit);
      setDailyLimitDraft(String(setting.dailyLimit));
      setUpdatedAt(setting.updatedAt);
      setMessage('小红书搜索模式、链接条数和账号保护节奏已保存；新节奏从下一次任务领取开始生效。');
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
        <p className="subtle">控制每个 Query 使用首屏极速选择，或滚动多轮后再按点赞量排序。</p>
      </div>
      <ListOrdered size={20} aria-hidden="true" />
    </div>
    {loading && <p className="subtle" role="status">正在读取小红书搜索配置…</p>}
    {loaded && <p className="notice" role="status">
      当前保存：{savedSearchMode === 'FASTEST'
        ? '极速模式 · 首屏点赞最高 1 条'
        : `深度排序 · 最多 ${savedResultLimit} 条`}
      {` · 最短 ${savedMinimumIntervalSeconds} 秒 · ${savedHourlyLimit} 次/60 分钟 · ${savedDailyLimit} 次/24 小时`}
      {changed && <span> · 有未保存的更改</span>}
    </p>}
    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="xhs-query-search-mode">搜索模式</label>
        <Select disabled={disabled} value={draftSearchMode} onValueChange={(value) => {
          setMessage('');
          setDraftSearchMode(value as XiaohongshuSearchMode);
        }}>
          <SelectTrigger id="xhs-query-search-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="FASTEST">极速模式（默认）</SelectItem>
            <SelectItem value="THOROUGH">深度排序模式</SelectItem>
          </SelectContent>
        </Select>
        <small>{draftSearchMode === 'FASTEST'
          ? '只读取首屏，在首屏有效候选中保留点赞最高的 1 条；不向下滚动。'
          : '读取首屏并向下滚动 3 次，再按点赞量保留指定条数。'}</small>
      </div>
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
          disabled={disabled || draftSearchMode === 'FASTEST'}
          value={draft}
          aria-invalid={resultLimitInvalid}
          onChange={(event) => {
            setMessage('');
            setDraft(event.target.value);
          }}
        />
        <small>{draftSearchMode === 'FASTEST'
          ? '极速模式固定保留 1 条；该数值仅在深度排序模式下生效。'
          : resultLimitInvalid ? '请输入 1–10 之间的整数。' : '深度排序允许设置 1–10 条，默认 3 条。'}</small>
      </div>
      <div className="field">
        <label htmlFor="xhs-query-search-minimum-interval">两次搜索最短间隔（秒）</label>
        <Input
          id="xhs-query-search-minimum-interval"
          className="input"
          type="number"
          min={MINIMUM_INTERVAL_SECONDS}
          max={MAXIMUM_INTERVAL_SECONDS}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          value={minimumIntervalDraft}
          aria-invalid={minimumIntervalInvalid}
          onChange={(event) => {
            setMessage('');
            setMinimumIntervalDraft(event.target.value);
          }}
        />
        <small>默认 60 秒；允许管理员在 10–3600 秒之间调整。</small>
      </div>
      <div className="field">
        <label htmlFor="xhs-query-search-hourly-limit">滚动 60 分钟最多搜索（次）</label>
        <Input
          id="xhs-query-search-hourly-limit"
          className="input"
          type="number"
          min={1}
          max={minimumIntervalInvalid ? MAX_HOURLY_LIMIT : maximumPerHour}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          value={hourlyLimitDraft}
          aria-invalid={hourlyLimitInvalid || (!minimumIntervalInvalid && parsedHourlyLimit > maximumPerHour)}
          onChange={(event) => {
            setMessage('');
            setHourlyLimitDraft(event.target.value);
          }}
        />
        <small>{minimumIntervalInvalid
          ? '先填写有效的最短间隔。'
          : `按当前间隔，每 60 分钟理论上最多 ${maximumPerHour} 次。`}</small>
      </div>
      <div className="field">
        <label htmlFor="xhs-query-search-daily-limit">滚动 24 小时最多搜索（次）</label>
        <Input
          id="xhs-query-search-daily-limit"
          className="input"
          type="number"
          min={1}
          max={maximumPerDay || MAX_DAILY_LIMIT}
          step={1}
          inputMode="numeric"
          disabled={disabled}
          value={dailyLimitDraft}
          aria-invalid={dailyLimitInvalid || (maximumPerDay > 0 && parsedDailyLimit > maximumPerDay)}
          onChange={(event) => {
            setMessage('');
            setDailyLimitDraft(event.target.value);
          }}
        />
        <small>{maximumPerDay > 0
          ? `结合当前间隔和每小时上限，每 24 小时最多可设置 ${maximumPerDay} 次。`
          : '先填写有效的最短间隔和每小时上限。'}</small>
      </div>
    </div>
    <p className="notice">两种模式都会按可确认的点赞量排序；区别是极速模式只比较首屏，深度模式会滚动收集更多候选。如果可访问的有效链接不足，实际保存数量可能少于设置值。</p>
    <p className="notice">账号保护按中心每次发放的搜索任务计数，随后搜索失败、出现验证码或登录失效也占用额度。三个限制同时生效，以最先达到的限制为准。</p>
    {pacingError && <div className="notice error" role="alert">{pacingError}</div>}
    {updatedAt && <p className="subtle">最近保存：{new Date(updatedAt).toLocaleString('zh-CN')}</p>}
    {error && <div className="notice error" role="alert">{error}</div>}
    {message && <div className="notice success" role="status">{message}</div>}
    <div className="settings-actions">
      {!loaded && !loading && <Button unstyled type="button" className="button" onClick={() => { void load(); }}>重新读取</Button>}
      <Button unstyled type="button" className="button primary" disabled={disabled || invalid || !changed} onClick={() => { void save(); }}>
        {busy ? '保存中…' : '保存小红书搜索配置'}
      </Button>
    </div>
  </section>;
}
