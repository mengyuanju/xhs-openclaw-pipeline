import { withAdminStore } from '../../src/admin/runtime.mjs';
import { publicModelApiStatus } from '../../src/model-api-config.mjs';
import type { EffectiveModelApi } from './model-api-settings-section';
import { ProductionSettingsForm } from './production-settings-form';
import { CentralDataWorkbench } from '../components/central-data-workbench';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';
import { WebSearchSettingsPanel } from './web-search-settings-panel';

export const dynamic = 'force-dynamic';

export default function ProductionSettingsPage() {
  if (controlPlaneUrl()) return <>
    <header className="page-header"><div><span className="eyebrow">Central production policy</span><h1 className="sr-only">生产配置</h1><p className="subtle">全局配置由远端中心统一维护；模型凭据仍只保留在执行机。</p></div></header>
    <CentralDataWorkbench resource="settings" />
  </>;
  const record = withAdminStore((store: any) => store.getProductionSettings()) as any;
  const effectiveModelApi = publicModelApiStatus(record.settings.modelApi) as EffectiveModelApi;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Production policy</span>
        <h1 className="sr-only">生产配置</h1>
        <p className="subtle">统一管理页面类型、视觉布局、模型 API、质量修复和图片合规标识。修改用于后续任务；已领取的任务沿用原配置。</p>
      </div>
    </header>
    <WebSearchSettingsPanel />
    <ProductionSettingsForm initialRecord={record} effectiveModelApi={effectiveModelApi} />
  </>;
}
