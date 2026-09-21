export const API_KEY_SCOPES = [
  'preview:create',
  'preview:list',
  'preview:revoke',
] as const;

export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

export const API_KEY_SCOPE_OPTIONS: ReadonlyArray<{
  value: ApiKeyScope;
  label: string;
  description: string;
}> = [
  {
    value: 'preview:create',
    label: '创建预览',
    description: '允许单条及批量上传原图和文案。',
  },
  {
    value: 'preview:list',
    label: '读取记录',
    description: '允许读取后台预览记录列表。',
  },
  {
    value: 'preview:revoke',
    label: '撤销链接',
    description: '允许停止公开链接访问。',
  },
];

export interface ApiKeySummary {
  id: string;
  name: string;
  keyPrefix: string;
  scopes: ApiKeyScope[];
  createdAt: number;
  expiresAt: number | null;
  lastUsedAt: number | null;
  revokedAt: number | null;
}

export function isApiKeyScope(value: unknown): value is ApiKeyScope {
  return API_KEY_SCOPES.includes(value as ApiKeyScope);
}
