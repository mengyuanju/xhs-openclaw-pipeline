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
        value={value.copyGenerationProvider ?? 'INHERIT'}
        onValueChange={(selected) => onProviderChange(
          selected === 'INHERIT' ? null : selected as 'OPENCLAW' | 'DOTS',
        )}
      >
        <SelectTrigger id="model-api-copy-provider"><SelectValue /></SelectTrigger>
        <SelectContent>
          <SelectItem value="INHERIT">环境或默认值（{effective.copyGenerationProvider}）</SelectItem>
          <SelectItem value="OPENCLAW">OpenClaw</SelectItem>
          <SelectItem value="DOTS">Dots Chat Completions</SelectItem>
        </SelectContent>
      </Select>
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
        onChange={(event) => onBaseUrlChange(optionalText(event.target.value))}
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
        onChange={(event) => onModelChange(optionalText(event.target.value))}
      />
      <small>当前 Key 状态：{effective.dotsApiKeyConfigured ? '服务器已配置' : '尚未配置，请补充 XHS_DOTS_API_KEY'}。</small>
    </div>
  </>;
}
