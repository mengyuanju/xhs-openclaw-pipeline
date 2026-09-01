'use client';

import { Cable, RotateCcw } from 'lucide-react';

export type ModelApiSettings = {
  copyGenerationProvider: 'OPENCLAW' | 'DOTS' | null;
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
  copyGenerationProvider: 'OPENCLAW' | 'DOTS';
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
      后台不保存 API Key、Token 或 OAuth 授权码。OpenClaw 认证由主机管理；Dots Key 仅从 <span className="mono">XHS_DOTS_API_KEY</span> 读取。
    </div>

    <div className="form-grid compact-settings-grid">
      <div className="field">
        <label htmlFor="model-api-copy-provider">独立文案提供方</label>
        <select
          className="input"
          id="model-api-copy-provider"
          value={value.copyGenerationProvider ?? ''}
          onChange={(event) => onChange(
            'copyGenerationProvider',
            event.target.value === ''
              ? null
              : event.target.value as 'OPENCLAW' | 'DOTS',
          )}
        >
          <option value="">环境或默认值（{effective.copyGenerationProvider}）</option>
          <option value="OPENCLAW">OpenClaw</option>
          <option value="DOTS">Dots Chat Completions</option>
        </select>
        <small>只切换独立文案的正文生成；检索和独立审核仍由 OpenClaw 执行。</small>
      </div>

      <div className="field">
        <label htmlFor="model-api-dots-base-url">Dots API 基础地址</label>
        <input
          className="input mono"
          id="model-api-dots-base-url"
          type="url"
          value={value.dotsBaseUrl ?? ''}
          placeholder={effective.dotsBaseUrl}
          maxLength={500}
          autoComplete="off"
          onChange={(event) => onChange('dotsBaseUrl', optionalText(event.target.value))}
        />
        <small>固定为官方文档地址；请求端点自动追加 <span className="mono">/v1/chat/completions</span>。</small>
      </div>

      <div className="field">
        <label htmlFor="model-api-dots-model">Dots 模型</label>
        <input
          className="input mono"
          id="model-api-dots-model"
          value={value.dotsModel ?? ''}
          placeholder={effective.dotsModel}
          maxLength={200}
          pattern="[A-Za-z0-9][A-Za-z0-9._:-]*"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange('dotsModel', optionalText(event.target.value))}
        />
        <small>当前 Key 状态：{effective.dotsApiKeyConfigured ? '服务器已配置' : '尚未配置，请补充 XHS_DOTS_API_KEY'}。</small>
      </div>

      {MODEL_FIELDS.map((field) => <div className="field" key={field.key}>
        <label htmlFor={`model-api-${field.key}`}>{field.label}</label>
        <input
          className="input mono"
          id={`model-api-${field.key}`}
          value={value[field.key] ?? ''}
          maxLength={200}
          pattern="[^\s]+\/[^\s]+"
          placeholder={effective[field.key]}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => onChange(field.key, optionalText(event.target.value))}
        />
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
