import type { PlanningMetadata } from '../settings/planning-catalog-types';
import '../settings/planning-catalog.css';

export function PlanningDetails({ page }: { page: PlanningMetadata }) {
  if (!page.pageType && !page.layoutPreset) return null;
  return <dl className="planning-description">
    {page.pageType && <div><dt>页面类型 · {page.pageType.name}</dt><dd>{page.pageType.description}</dd></div>}
    {page.layoutPreset && <div><dt>视觉布局 · {page.layoutPreset.name}</dt><dd>{page.layoutPreset.description}</dd></div>}
  </dl>;
}
