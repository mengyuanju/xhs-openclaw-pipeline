'use client';

import { useEffect, useRef, useState, type ComponentProps, type ComponentType } from 'react';
import { Button } from '@/components/ui/button';

type EditorProps = ComponentProps<typeof import('../components/current-image-editor').CurrentImageEditor>;
type EditorComponent = ComponentType<EditorProps>;

export function LazyCurrentImageEditor(props: Omit<EditorProps, 'initialOpen' | 'openSignal' | 'hideTrigger' | 'returnFocusRef'>) {
  const [Editor, setEditor] = useState<EditorComponent | null>(null);
  const [opened, setOpened] = useState(0);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const loadingRef = useRef(false);
  const mounted = useRef(true);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  async function openEditor() {
    if (Editor) { setOpened(value => value + 1); return; }
    if (loadingRef.current) return;
    loadingRef.current = true;
    setLoading(true); setFailed(false);
    try {
      const module = await import('../components/current-image-editor');
      if (!mounted.current) return;
      setEditor(() => module.CurrentImageEditor);
      setOpened(value => value + 1);
    } catch {
      if (mounted.current) setFailed(true);
    } finally {
      loadingRef.current = false;
      if (mounted.current) setLoading(false);
    }
  }
  return <>
    <Button ref={trigger} className="current-image-editor-trigger" type="button" disabled={loading} aria-busy={loading || undefined}
      onClick={() => { void openEditor(); }}>{loading ? '正在加载图片编辑器…' : '修改图片'}</Button>
    {failed && <div role="alert">图片编辑器加载失败。<Button type="button" variant="outline" onClick={() => { void openEditor(); }}>重新加载编辑器</Button></div>}
    {Editor && <Editor {...props} initialOpen openSignal={opened} hideTrigger returnFocusRef={trigger} />}
  </>;
}
