'use client';

import { Component, type ComponentProps, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import { Button } from '@/components/ui/button';
import styles from './workbench.module.css';

const Editor = dynamic(
  () => import('../components/standalone-image-editor').then(module => module.StandaloneImageEditor),
  {
    ssr: false,
    loading: () => <div className={styles.upload} role="status" aria-live="polite" aria-busy="true">正在加载图片编辑器…</div>,
  },
);

class EditorLoadBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return <div className={styles.upload}>
      <p role="alert">图片编辑器暂时无法打开，请重新加载。</p>
      <Button type="button" variant="outline" onClick={() => window.location.reload()}>重新加载编辑器</Button>
    </div>;
  }
}

export function LazyStandaloneImageEditor(props: ComponentProps<typeof Editor>) {
  return <EditorLoadBoundary><Editor {...props} /></EditorLoadBoundary>;
}
