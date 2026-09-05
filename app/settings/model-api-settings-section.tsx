'use client';

import { Cable, RotateCcw } from 'lucide-react';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

import { DotsCopyProviderFields } from './dots-copy-provider-fields';

type CopyGenerationThinking = 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export type ModelApiSettings = {
  agentProvider: 'CODEX' | 'OPENCLAW' | null;
  copyGenerationProvider: 'OPENCLAW' | 'DOTS' | null;
  copyGenerationThinking: CopyGenerationThinking | null;
  dotsBaseUrl: string | null;
  dotsModel: string | null;
  textModel: string | null;
  screeningModel: string | null;
  reviewModel: string | null;
  visionModel: string | null;
  qualityModel: string | null;
  imageModel: string | null;
  modelProxyUrl: string | null;
  imageProxyUrl: string | null;
  imageTimeoutMs: number | null;
};

export type EffectiveModelApi = {
  agentProvider: 'CODEX' | 'OPENCLAW';
  copyGenerationProvider: 'OPENCLAW' | 'DOTS';
  copyGenerationThinking: CopyGenerationThinking;
  dotsBaseUrl: string;
  dotsModel: string;
  dotsApiKeyConfigured: boolean;
  textModel: string;
  screeningModel: string;
  reviewModel: string;
  visionModel: string;
  qualityModel: string;
  imageModel: string;
  modelProxyConfigured: boolean;
  imageProxyConfigured: boolean;
  imageTimeoutMs: number;
};

type ModelKey = 'textModel' | 'screeningModel' | 'reviewModel'
  | 'visionModel' | 'qualityModel' | 'imageModel';

const MODEL_FIELDS: Array<{
  key: ModelKey;
  label: string;
  description: string;
}> = [
  { key: 'textModel', label: '文本生成模型', description: '生成正文与视觉策划。' },
  { key: 'screeningModel', label: '需求检测模型', description: 'Excel 导入时判断需求强度。' },
  { key: 'reviewModel', label: '阶段审核模型', description: 'Query 与成稿的独立审核。' },
  { key: 'visionModel', label: '视觉验收模型', description: '逐页 OCR、图文对齐与视觉分析。' },
  { key: 'qualityModel', label: '独立终审模型', description: '整套交付的最终质量评分。' },
  { key: 'imageModel', label: '图片生成模型', description: '生成和编辑交付图片。' },
];

const INHERIT_VALUE = 'INHERIT';
const TEXT_MODEL_OPTIONS = [
  'openai/gpt-5.6-sol',
  'openai/gpt-5.6-terra',
  'openai/gpt-5.6-luna',
  'openai/gpt-5.5',
  'openai/gpt-5.4',
  'openai/gpt-5.4-mini',
  'openai/gpt-5.3-codex-spark',
] as const;
const IMAGE_MODEL_OPTIONS = ['openai/gpt-image-2'] as const;
const MODEL_OPTIONS: Record<ModelKey, readonly string[]> = {
  textModel: TEXT_MODEL_OPTIONS,
  screeningModel: TEXT_MODEL_OPTIONS,
  reviewModel: TEXT_MODEL_OPTIONS,
  visionModel: TEXT_MODEL_OPTIONS,
  qualityModel: TEXT_MODEL_OPTIONS,
  imageModel: IMAGE_MODEL_OPTIONS,
};
const THINKING_OPTIONS: Array<{ value: CopyGenerationThinking; label: string }> = [
  { value: 'minimal', label: '极简（minimal）' },
  { value: 'low', label: '低（low）' },
  { value: 'medium', label: '中（medium）' },
  { value: 'high', label: '高（high）' },
  { value: 'xhigh', label: '超高（xhigh）' },
  { value: 'max', label: '最高（max）' },
];

function availableModels(field: ModelKey, saved: string | null, effective: string) {
  return [...new Set([saved, effective, ...MODEL_OPTIONS[field]].filter((model): model is string => Boolean(model)))];
}

function optionalText(value: string) {
  return value === '' ? null : value;
}

export function ModelApiSettingsSection({
  value,
  effective,
  busy,
  onChange,
  onReset,
}: {
  value: ModelApiSettings;
  effective: EffectiveModelApi;
  busy: boolean;
  onChange: <K extends keyof ModelApiSettings>(key: K, value: ModelApiSettings[K]) => void;
  onReset: () => void;
}) {
  return <section className="panel settings-section" aria-labelledby="model-api-heading">
    <div className="panel-head">
      <div>
        <span className="section-kicker">Model runtime</span>
        <h2 id="model-api-heading">模型 API 与网络</h2>
        <p className="subtle">数据库配置优先；留空时沿用主机环境变量或项目默认值。</p>
      </div>
      <Cable aria-hidden="true" size={20} />
    </div>

    <div className="notice">
      后台不保存 API Key、Token 或 OAuth 授权码。Codex / OpenClaw 认证由执行主机管理；Dots Key 仅从 <span className="mono">XHS_DOTS_API_KEY</span> 读取。
    </div>

    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="model-api-agent-provider">生成引擎</label>
        <Select
          disabled={busy}
          value={value.agentProvider ?? INHERIT_VALUE}
          onValueChange={(selected) => onChange('agentProvider', selected === INHERIT_VALUE ? null : selected as 'CODEX' | 'OPENCLAW')}
        >
          <SelectTrigger id="model-api-agent-provider"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>环境或默认值（{effective.agentProvider}）</SelectItem>
            <SelectItem value="CODEX">Codex CLI（ChatGPT 订阅登录）</SelectItem>
            <SelectItem value="OPENCLAW">OpenClaw（兼容回退）</SelectItem>
          </SelectContent>
        </Select>
        <small>控制文本、审核、视觉和图片调用。Codex 同一运行状态库最多并发 2 个调用、其中图片 1 个；额度不足会暂停，不保证订阅吞吐量。已有批次 Worker 需重启后切换。</small>
      </div>
      <DotsCopyProviderFields
        value={value}
        effective={effective}
        onProviderChange={(nextValue) => onChange('copyGenerationProvider', nextValue)}
        onBaseUrlChange={(nextValue) => onChange('dotsBaseUrl', nextValue)}
        onModelChange={(nextValue) => onChange('dotsModel', nextValue)}
      />

      <div className="field">
        <label htmlFor="model-api-copy-thinking">文案思考强度</label>
        <Select
          value={value.copyGenerationThinking ?? INHERIT_VALUE}
          onValueChange={(selected) => onChange(
            'copyGenerationThinking',
            selected === INHERIT_VALUE ? null : selected as CopyGenerationThinking,
          )}
        >
          <SelectTrigger id="model-api-copy-thinking"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>环境或默认值（{effective.copyGenerationThinking}）</SelectItem>
            {THINKING_OPTIONS.map((option) => (
              <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small>用于默认生成引擎的文案与独立审核；Dots 正文关闭思考时，审核仍使用此值。</small>
      </div>

      {MODEL_FIELDS.map((field) => <div className="field" key={field.key}>
        <label htmlFor={`model-api-${field.key}`}>{field.label}</label>
        <Select
          value={value[field.key] ?? INHERIT_VALUE}
          onValueChange={(selected) => onChange(
            field.key,
            selected === INHERIT_VALUE ? null : selected,
          )}
        >
          <SelectTrigger className="mono" id={`model-api-${field.key}`}><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT_VALUE}>环境或默认值（{effective[field.key]}）</SelectItem>
            {availableModels(field.key, value[field.key], effective[field.key]).map((model) => (
              <SelectItem key={model} value={model}>{model}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <small>{field.description} 当前生效：<span className="mono">{effective[field.key]}</span></small>
      </div>)}

      <div className="field">
        <label htmlFor="model-api-model-proxy">文本与视觉代理</label>
        <input
          className="input mono"
          id="model-api-model-proxy"
          type="url"
          value={value.modelProxyUrl ?? ''}
          maxLength={500}
          placeholder="http://127.0.0.1:7897"
          autoComplete="off"
          onChange={(event) => onChange('modelProxyUrl', optionalText(event.target.value))}
        />
        <small>{effective.modelProxyConfigured ? '当前已有代理配置；这里只显示后台覆盖值。' : '当前直连；仅支持无账号密码的 HTTP(S) 地址。'}</small>
      </div>

      <div className="field">
        <label htmlFor="model-api-image-proxy">图片生成代理</label>
        <input
          className="input mono"
          id="model-api-image-proxy"
          type="url"
          value={value.imageProxyUrl ?? ''}
          maxLength={500}
          placeholder="http://127.0.0.1:7897"
          autoComplete="off"
          onChange={(event) => onChange('imageProxyUrl', optionalText(event.target.value))}
        />
        <small>{effective.imageProxyConfigured ? '当前已有图片代理配置；这里只显示后台覆盖值。' : '当前直连；仅用于图片生成和编辑。'}</small>
      </div>

      <div className="field">
        <label htmlFor="model-api-image-timeout">图片调用超时</label>
        <input
          className="input"
          id="model-api-image-timeout"
          type="number"
          min={30_000}
          max={540_000}
          step={1_000}
          value={value.imageTimeoutMs ?? ''}
          placeholder={String(effective.imageTimeoutMs)}
          onChange={(event) => onChange(
            'imageTimeoutMs',
            event.target.value === '' ? null : Number(event.target.value),
          )}
        />
        <small>单位毫秒，允许 30,000–540,000；当前生效 {effective.imageTimeoutMs.toLocaleString('zh-CN')} ms。</small>
      </div>

      <div className="field full inline">
        <button className="button" type="button" disabled={busy} onClick={onReset}>
          <RotateCcw aria-hidden="true" size={15} />恢复环境配置
        </button>
        <span className="subtle">清空页面覆盖后仍需点击底部“保存生产配置”。</span>
      </div>
    </div>
  </section>;
}
