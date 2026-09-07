'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { apiRequest } from '../components/api-client';
import { normalizePlanningCatalog, resolvePlanningCatalog } from '../../server/src/planning-catalog.mjs';
import { PlanningCatalogEditor } from './planning-catalog-editor';
import type { PlanningCatalog } from './planning-catalog-types';

export function RemotePlanningCatalogSettings({ initialSettings, onSaved }: {
  initialSettings: Record<string, unknown>; onSaved: () => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<PlanningCatalog>(() => resolvePlanningCatalog(initialSettings) as PlanningCatalog);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save() {
    setBusy(true); setError('');
    try {
      const planningCatalog = normalizePlanningCatalog(catalog);
      const records = await apiRequest<Array<{ key: string; value: Record<string, unknown> }>>('/api/control-plane/v1/settings');
      const current = records.find(record => record.key === 'production')?.value ?? {};
      await apiRequest('/api/control-plane/v1/settings/production', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ value: { ...current, planningCatalog } }) });
      setCatalog(planningCatalog as PlanningCatalog);
      await onSaved();
    } catch (caught) { setError(caught instanceof Error ? caught.message : '图片规划配置保存失败'); }
    finally { setBusy(false); }
  }
  return <div className="settings-stack">
    <PlanningCatalogEditor value={catalog} onChange={setCatalog} disabled={busy} />
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="settings-actions"><Button unstyled className="button primary" type="button" disabled={busy} onClick={() => void save()}>{busy ? '保存中…' : '保存图片规划配置'}</Button></div>
  </div>;
}
