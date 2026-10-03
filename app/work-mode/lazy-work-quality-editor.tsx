'use client';

import dynamic from 'next/dynamic';

export const WorkQualityEditor = dynamic(() => import('./work-quality-editor').then(module => module.WorkQualityEditor), {
  ssr: false, loading: () => <p role="status">正在加载质检编辑器…</p>,
});
