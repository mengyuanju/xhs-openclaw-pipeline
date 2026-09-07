'use client';

import { Button } from '@/components/ui/button';

import { Component, useId, useState, type ReactNode } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { parseModelResponse } from './model-response-presentation.mjs';

function TextContent({ text }: { text: string }) {
  return <pre className="model-response-text">{text === '' ? '（空字符串）' : text}</pre>;
}

function ResponseValue({ value, depth = 0 }: { value: unknown; depth?: number }) {
  if (depth >= 8) return <TextContent text={typeof value === 'string' ? value : JSON.stringify(value, null, 2)} />;
  if (typeof value === 'string') {
    const parsed = parseModelResponse(value);
    if (parsed.format === 'json') return <ResponseValue value={parsed.value} depth={depth + 1} />;
    if (parsed.format === 'text') return <TextContent text={parsed.value} />;
    return <div className="model-response-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
      // Keep model HTML as escaped text. Images are explicit links, never automatic requests.
      img: ({ src, alt }) => <a href={typeof src === 'string' ? src : undefined} target="_blank" rel="noopener noreferrer">{alt || '图片链接'}（查看图片）</a>,
      a: ({ href, children }) => <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>,
      h1: ({ children }) => <h5>{children}</h5>,
      h2: ({ children }) => <h5>{children}</h5>,
      h3: ({ children }) => <h6>{children}</h6>,
      h4: ({ children }) => <h6>{children}</h6>,
      table: ({ children }) => <div className="model-response-table" tabIndex={0} role="region" aria-label="返回内容表格"><table>{children}</table></div>,
    }}>{parsed.value}</Markdown></div>;
  }
  if (value === null || typeof value !== 'object') return <code className="model-response-scalar">{String(value)}</code>;
  const entries = Object.entries(value);
  if (entries.length === 0) return <code className="model-response-scalar">{Array.isArray(value) ? '[]' : '{}'}</code>;
  if (entries.length > 100) return <TextContent text={JSON.stringify(value, null, 2)} />;
  if (Array.isArray(value)) return <ol className="model-response-list">{value.map((child, index) =>
    <li key={index}><ResponseValue value={child} depth={depth + 1} /></li>)}</ol>;
  return <dl className="model-response-fields">{entries.map(([key, child]) => <div key={key}>
    <dt>{key === '' ? '（空字段名）' : key}</dt><dd><ResponseValue value={child} depth={depth + 1} /></dd>
  </div>)}</dl>;
}

class ResponseBoundary extends Component<{ source: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() {
    return this.state.failed ? <><p className="model-call-note">此内容暂无法排版，已保留原文。</p><TextContent text={this.props.source} /></> : this.props.children;
  }
}

export function ModelResponseView({ text }: { text: string }) {
  const [raw, setRaw] = useState(false);
  const contentId = useId();
  return <div className="model-response-view">
    <div className="model-response-toolbar" role="group" aria-label="模型返回显示方式">
      <Button unstyled className="button" type="button" aria-pressed={!raw} aria-controls={contentId} onClick={() => setRaw(false)}>阅读视图</Button>
      <Button unstyled className="button" type="button" aria-pressed={raw} aria-controls={contentId} onClick={() => setRaw(true)}>原文</Button>
      <span>原文随时可查</span>
    </div>
    <div id={contentId} className="model-response-content" role="region" aria-label={raw ? '模型返回原文' : '模型返回阅读视图'} tabIndex={0}>
      {raw ? <pre className="model-response-raw">{text}</pre> : <ResponseBoundary key={text} source={text}><ResponseValue value={text} /></ResponseBoundary>}
    </div>
  </div>;
}
