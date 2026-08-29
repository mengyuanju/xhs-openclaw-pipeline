import { withAdminStore } from '../../src/admin/runtime.mjs';
import { ProductionSettingsForm } from './production-settings-form';

export const dynamic = 'force-dynamic';

export default function ProductionSettingsPage() {
  const record = withAdminStore((store: any) => store.getProductionSettings()) as any;
  return <>
    <header className="page-header">
      <div>
        <span className="eyebrow">Production policy</span>
        <h1 className="sr-only">生产配置</h1>
        <p className="subtle">统一控制质量修复和图片合规标识。修改会用于之后领取的任务，并使不匹配的旧检查点失效。</p>
      </div>
    </header>
    <ProductionSettingsForm initialRecord={record} />
  </>;
}
