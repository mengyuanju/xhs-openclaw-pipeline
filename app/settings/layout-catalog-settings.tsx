'use client';

import { ChevronLeft, ChevronRight, Pencil } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input, Switch } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { apiRequest } from '../components/api-client';
import { LAYOUT_FAMILIES } from '../../server/src/layout-catalog.mjs';
import { LayoutCatalogEditor } from './layout-catalog-editor';

export type CatalogTemplate = {
  layoutTemplate: string; templateVersion: number; layoutKind: string; name: string; description: string;
  suitableContent: string; applicablePageKinds: string[]; subjectRegion: string; textRegion: string; readingOrder: string;
  minItems: number; maxItems: number; rules: string[]; enabled: boolean; source: string;
};
type Catalog = { schemaVersion: number; selectionMode: string; templates: CatalogTemplate[] };
type CatalogRecord = { catalog: Catalog | null; revision: string; added?: number; unchanged?: number; model?: string; promptSource?: string };
const PAGE_SIZES = [10, 20, 50];

function filterCatalogTemplates(templates: CatalogTemplate[], family: string, status: string, search: string) {
  const query = search.trim().toLowerCase();
  return templates.filter(item =>
    (family === 'all' || item.layoutKind === family)
    && (status === 'all' || (status === 'enabled' ? item.enabled : !item.enabled))
    && `${item.name} ${item.layoutTemplate} ${item.description} ${item.suitableContent}`.toLowerCase().includes(query));
}

export function LayoutCatalogSettings({ remote = false }: { remote?: boolean }) {
  const endpoint = remote ? '/api/control-plane/v1/layout-catalog' : '/api/layout-catalog';
  const [record, setRecord] = useState<CatalogRecord | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [family, setFamily] = useState('all');
  const [status, setStatus] = useState('all');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(PAGE_SIZES[0]);
  const [json, setJson] = useState('');
  const [brief, setBrief] = useState('');
  const [editing, setEditing] = useState<CatalogTemplate | null>(null);
  function applyRecord(next: CatalogRecord) {
    const nextTemplates = next.catalog?.templates ?? [];
    const nextTotalPages = Math.max(1, Math.ceil(filterCatalogTemplates(nextTemplates, family, status, search).length / pageSize));
    setRecord(next);
    setPage(current => Math.min(current, nextTotalPages));
  }
  async function load() {
    setError('');
    try { applyRecord(await apiRequest<CatalogRecord>(endpoint)); }
    catch (caught) { setError(caught instanceof Error ? caught.message : '加载布局目录失败'); }
  }
  useEffect(() => { void load(); }, [endpoint]); // eslint-disable-line react-hooks/exhaustive-deps
  async function mutate(input: object, success: string, generate = false) {
    if (!record) return false;
    setBusy(true); setError(''); setMessage('');
    try {
      const result = await apiRequest<CatalogRecord>(`${endpoint}${generate ? '/generate' : ''}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...input, expectedRevision: record.revision }) });
      applyRecord(result);
      setMessage(`${success}${result.added !== undefined ? `；新增 ${result.added} 项，重复 ${result.unchanged ?? 0} 项。` : ''}${result.promptSource ? ` 使用${result.promptSource === 'PUBLISHED' ? '已发布' : '内置'}布局设计规则。` : ''}`);
      return true;
    } catch (caught) { setError(caught instanceof Error ? caught.message : '保存失败'); return false; }
    finally { setBusy(false); }
  }
  const catalog = record?.catalog;
  const templates = catalog?.templates ?? [];
  const filteredRows = filterCatalogTemplates(templates, family, status, search);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const rows = filteredRows.slice(pageStart, pageStart + pageSize);
  async function importJson() {
    try {
      const parsed = JSON.parse(json);
      if (await mutate({ operation: 'IMPORT', templates: Array.isArray(parsed) ? parsed : parsed.templates }, '模板已导入')) setJson('');
    } catch { setError('请输入 JSON 数组，或包含 templates 数组的 JSON 对象。'); }
  }
  return <section className="panel settings-section layout-catalog-section" aria-labelledby="layout-catalog-title" aria-busy={busy}>
    <div className="panel-head"><div><h2 id="layout-catalog-title">布局模板库</h2><p className="subtle">按内容选择版式并自动保存视觉规划。当前 {templates.length} 个模板，{templates.filter(item => item.enabled).length} 个已启用。</p></div>
      <Button variant="outline" disabled={busy} onClick={() => void load()}>刷新目录</Button></div>
    {error && <p className="notice error" role="alert">{error}</p>}
    {message && <p className="notice success" role="status">{message}</p>}
    {!record && !error && <p role="status">正在读取布局模板…</p>}
    {record && <>
      <div className="form-grid">
        <label className="field">搜索模板<Input placeholder="编码、含义或适合内容" value={search} onChange={event => { setSearch(event.target.value); setPage(1); }} /></label>
        <div className="field"><label htmlFor="layout-family">版式分类</label><Select value={family} onValueChange={value => { setFamily(value); setPage(1); }}><SelectTrigger id="layout-family"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">所有分类</SelectItem>{Object.entries(LAYOUT_FAMILIES).map(([key, label]) => <SelectItem key={key} value={key}>{label}</SelectItem>)}</SelectContent></Select></div>
        <div className="field"><label htmlFor="layout-status">启用状态</label><Select value={status} onValueChange={value => { setStatus(value); setPage(1); }}><SelectTrigger id="layout-status"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="all">全部状态</SelectItem><SelectItem value="enabled">已启用</SelectItem><SelectItem value="disabled">未启用</SelectItem></SelectContent></Select></div>
        {catalog && <div className="field"><label htmlFor="layout-selection-mode">自动选择方式</label><Select value={catalog.selectionMode} disabled={busy} onValueChange={value => void mutate({ operation: 'REPLACE', catalog: { ...catalog, selectionMode: value } }, '选择方式已保存')}><SelectTrigger id="layout-selection-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="MODEL">模型按内容规划</SelectItem><SelectItem value="RANDOM">匹配后随机（跳过视觉规划模型）</SelectItem></SelectContent></Select></div>}
      </div>
      {templates.length === 0 ? <p className="notice">目录中还没有模板，可导入内置的 10 类、27 个模板。</p> : <>
        <div className="layout-catalog-result-bar">
          <span role="status">筛选到 {filteredRows.length} 个模板{filteredRows.length > 0 ? `，当前显示 ${pageStart + 1}–${pageStart + rows.length}` : ''}</span>
          <div className="layout-catalog-page-size"><label htmlFor="layout-page-size">每页显示</label><Select value={String(pageSize)} onValueChange={value => { setPageSize(Number(value)); setPage(1); }}><SelectTrigger id="layout-page-size"><SelectValue /></SelectTrigger><SelectContent>{PAGE_SIZES.map(size => <SelectItem key={size} value={String(size)}>{size} 条</SelectItem>)}</SelectContent></Select></div>
        </div>
        {filteredRows.length === 0 ? <p className="notice">没有匹配的模板，请调整搜索或筛选条件。</p> : <>
          <div className="layout-catalog-table" tabIndex={0} role="region" aria-label={`布局模板表格，可横向滚动，第 ${currentPage} 页`}>
            <table><thead><tr><th>分类 / 中文类型</th><th>模板编码</th><th>具体排版含义</th><th>适合内容</th><th>状态与操作</th></tr></thead><tbody>{rows.map(item => <tr key={`${item.layoutTemplate}-${item.templateVersion}`}>
              <td><code>{item.layoutKind}</code><br />{LAYOUT_FAMILIES[item.layoutKind as keyof typeof LAYOUT_FAMILIES]}</td>
              <td><code>{item.layoutTemplate}</code><small className="subtle">版本 {item.templateVersion} · {item.source === 'MODEL' ? '模型候选' : item.source === 'REFERENCE' ? '参考模板' : '人工维护'}</small></td>
              <td>{item.description}</td><td>{item.suitableContent}</td>
              <td><div className="layout-catalog-row-actions"><label className="switch-field"><Switch aria-label={`启用 ${item.layoutTemplate} 版本 ${item.templateVersion}`} disabled={busy} checked={item.enabled} onChange={event => void mutate({ operation: 'REPLACE', catalog: { ...catalog, templates: templates.map(candidate => candidate === item ? { ...candidate, enabled: event.target.checked } : candidate) } }, '启用状态已保存')} /><span>{item.enabled ? '已启用' : '未启用'}</span></label><Button className="layout-catalog-edit-action" variant="outline" size="sm" type="button" disabled={busy} onClick={() => setEditing(item)}><Pencil size={14} aria-hidden="true" />编辑新版本</Button></div></td>
            </tr>)}</tbody></table>
          </div>
          {totalPages > 1 && <nav className="layout-catalog-pagination" aria-label="布局模板分页">
            <span>共 {filteredRows.length} 条 · 第 {currentPage} / {totalPages} 页</span>
            <div><Button variant="outline" size="sm" type="button" disabled={currentPage <= 1} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={14} aria-hidden="true" />上一页</Button><Button variant="outline" size="sm" type="button" disabled={currentPage >= totalPages} onClick={() => setPage(currentPage + 1)}>下一页<ChevronRight size={14} aria-hidden="true" /></Button></div>
          </nav>}
        </>}
      </>}
      {editing && <LayoutCatalogEditor key={`${editing.layoutTemplate}-${editing.templateVersion}`} template={editing} nextVersion={Math.max(...templates.filter(item => item.layoutTemplate === editing.layoutTemplate).map(item => item.templateVersion)) + 1} busy={busy} onClose={() => setEditing(null)} onSave={async next => {
        if (await mutate({ operation: 'REPLACE', catalog: { ...catalog, templates: [...templates.map(item => item.layoutTemplate === editing.layoutTemplate ? { ...item, enabled: false } : item), next] } }, '新版本已保存')) setEditing(null);
      }} />}
      <details><summary>批量导入模板 JSON</summary><p className="subtle">支持模型返回的 templates 数组或完整目录 JSON。先校验整批数据，再自动入库；同编码的设计修改需增加版本号。</p>
        <label className="field">JSON 文件<Input type="file" accept=".json,application/json" disabled={busy} onChange={event => { const file = event.target.files?.[0]; if (!file) return; if (file.size > 1_000_000) { setError('文件不得超过 1 MB'); return; } void file.text().then(setJson).catch(() => setError('文件读取失败')); }} /></label>
        <div className="field"><label htmlFor="layout-import-json">模板 JSON</label><textarea id="layout-import-json" className="textarea" rows={8} value={json} onChange={event => setJson(event.target.value)} /></div>
        <div className="settings-actions"><Button disabled={busy || !json.trim()} onClick={() => void importJson()}>校验并导入</Button><Button variant="outline" disabled={busy} onClick={() => void mutate({ operation: 'BUILTIN' }, '内置模板已导入')}>导入内置 27 个模板</Button><Button variant="ghost" disabled={!catalog} onClick={() => setJson(JSON.stringify(catalog, null, 2))}>查看当前目录 JSON</Button></div>
      </details>
      <details><summary>用模型生成模板候选</summary><p className="subtle">使用已发布的“布局模板设计”规则；未发布时明确使用内置规则。生成会调用模型，结果自动入库为未启用候选，可在上表启用。</p>
        <label className="field">版式需求<textarea className="textarea" rows={3} maxLength={2000} placeholder="例如：适合四个食材知识点的杂志风卡片布局，清晰、留白充足。" value={brief} onChange={event => setBrief(event.target.value)} /></label>
        <Button disabled={busy || !brief.trim()} onClick={() => void mutate({ brief }, '模型候选已保存，请在表格中检查并启用', true)}>{busy ? '正在处理…' : '生成并自动入库'}</Button>
      </details>
    </>}
  </section>;
}
