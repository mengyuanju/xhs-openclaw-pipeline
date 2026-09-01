import { withAdminStore } from '../../src/admin/runtime.mjs';
import { publicModelApiStatus } from '../../src/model-api-config.mjs';
import type { EffectiveModelApi } from './model-api-settings-section';
import { ProductionSettingsForm } from './production-settings-form';

export const dynamic = 'force-dynamic';

export default function ProductionSettingsPage() {
  const record = withAdminStore((store: any) => store.getProductionSettings()) as any;
  const effectiveModelApi = publicModelApiStatus(record.settings.modelApi) as EffectiveModelApi;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Production policy</span>
        <h1 className="sr-only">生产配置</h1>
        <p className="subtle">统一控制模型 API、质量修复和图片合规标识。修改会用于后续模型请求，并使不匹配的旧检查点失效。</p>
      </div>
    </header>
    <ProductionSettingsForm initialRecord={record} effectiveModelApi={effectiveModelApi} />
  </>;
}
