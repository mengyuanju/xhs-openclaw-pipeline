import { withAdminStore } from '../../src/admin/runtime.mjs';
import { publicModelApiStatus } from '../../src/model-api-config.mjs';
import type { EffectiveModelApi } from './model-api-settings-section';
import { ProductionSettingsForm } from './production-settings-form';
import { CentralDataWorkbench } from '../components/central-data-workbench';
import { controlPlaneUrl } from '../../src/control-plane/next-runtime.mjs';

export const dynamic = 'force-dynamic';

export default function ProductionSettingsPage() {
  if (controlPlaneUrl()) return <>
    <header className="page-header settings-page-header"><div><span className="eyebrow">Central production policy</span><h1 className="sr-only">生产配置</h1><p className="subtle">按生成、质量、图片和高级设置分区维护；全局配置由远端中心统一保存。</p></div><span className="pill">中心模式</span></header>
    <CentralDataWorkbench />
  </>;
  const record = withAdminStore((store: any) => store.getProductionSettings()) as any;
  const effectiveModelApi = publicModelApiStatus(record.settings.modelApi) as EffectiveModelApi;
  return <>
    <header className="page-header settings-page-header">
      <div>
        <span className="eyebrow">Production policy</span>
        <h1 className="sr-only">生产配置</h1>
        <p className="subtle">按业务流程分区维护生成、评分、图片与兼容设置；切换分区不会丢失尚未保存的修改。</p>
      </div>
      <span className="pill">本机模式</span>
    </header>
    <ProductionSettingsForm initialRecord={record} effectiveModelApi={effectiveModelApi} />
  </>;
}
