'use client';

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

type DotsSettings = {
  copyGenerationProvider: 'OPENCLAW' | 'DOTS' | null;
  dotsBaseUrl: string | null;
  dotsModel: string | null;
};

type EffectiveDotsSettings = {
  copyGenerationProvider: 'OPENCLAW' | 'DOTS';
  dotsBaseUrl: string;
  dotsModel: string;
  dotsApiKeyConfigured: boolean;
};

const INHERIT_VALUE = 'INHERIT';
const DOTS_MODEL_OPTIONS = ['dots3-note-prev'] as const;

function optionalText(value: string) {
  return value === '' ? null : value;
}

export function DotsCopyProviderFields({
  value,
  effective,
  onProviderChange,
  onBaseUrlChange,
  onModelChange,
}: {
  value: DotsSettings;
  effective: EffectiveDotsSettings;
  onProviderChange: (value: DotsSettings['copyGenerationProvider']) => void;
  onBaseUrlChange: (value: string | null) => void;
  onModelChange: (value: string | null) => void;
}) {
  return <>
    <div className="field">
      <label htmlFor="model-api-copy-provider">独立文案提供方</label>
      <Select
        value={value.copyGenerationProvider ?? INHERIT_VALUE}
        onValueChange={(selected) => onProviderChange(
          selected === INHERIT_VALUE ? null : selected as 'OPENCLAW' | 'DOTS',
        )}
      >
        <SelectTrigger id="model-api-copy-provider"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>环境或默认值（{effective.copyGenerationProvider === 'DOTS' ? 'Dots' : '默认生成引擎'}）</SelectItem>
          <SelectItem value="OPENCLAW">默认生成引擎（Codex / OpenClaw）</SelectItem>
          <SelectItem value="DOTS">Dots Chat Completions</SelectItem>
        </SelectContent>
      </Select>
      <small>只切换独立文案的正文生成；检索使用联网搜索配置，独立审核仍由默认生成引擎执行。</small>
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
        onChange={(event) => onBaseUrlChange(optionalText(event.target.value))}
      />
      <small>固定为官方文档地址；请求端点自动追加 <span className="mono">/v1/chat/completions</span>。</small>
    </div>

    <div className="field">
      <label htmlFor="model-api-dots-model">Dots 模型</label>
      <Select
        value={value.dotsModel ?? INHERIT_VALUE}
        onValueChange={(selected) => onModelChange(selected === INHERIT_VALUE ? null : selected)}
      >
        <SelectTrigger className="mono" id="model-api-dots-model"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value={INHERIT_VALUE}>环境或默认值（{effective.dotsModel}）</SelectItem>
          {[...new Set([value.dotsModel, effective.dotsModel, ...DOTS_MODEL_OPTIONS]
            .filter((model): model is string => Boolean(model)))]
            .map((model) => <SelectItem key={model} value={model}>{model}</SelectItem>)}
        </SelectContent>
      </Select>
      <small>当前 Key 状态：{effective.dotsApiKeyConfigured ? '服务器已配置' : '尚未配置，请补充 XHS_DOTS_API_KEY'}。</small>
    </div>
  </>;
}
