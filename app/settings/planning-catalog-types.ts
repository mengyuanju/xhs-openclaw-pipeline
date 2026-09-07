import type { PageLayout } from '../components/image-controls';

export type BaseKind = 'hero' | 'steps' | 'detail' | 'comparison' | 'checklist' | 'summary';
export type PlanningIdentity = { id: string; name: string; description: string };
export type PageTypeSnapshot = PlanningIdentity & { baseKind: BaseKind };
export type PlanningMetadata = { pageTypeId?: string; pageType?: PageTypeSnapshot; layoutPreset?: PlanningIdentity };
export type PageType = PageTypeSnapshot & { enabled: boolean };
export type CatalogLayout = PlanningIdentity & { kind: string; enabled: boolean; layout: PageLayout };
export type PlanningCatalog = { version: number; pageTypes: PageType[]; layouts: CatalogLayout[] };
