'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Disclosure, DisclosureContent, DisclosureTrigger } from '@/components/ui/disclosure';
import { Checkbox } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { CalendarRange, ChartNoAxesCombined, PackageCheck, RotateCcw, SlidersHorizontal } from 'lucide-react';
import { PERSONAL_WORK_FILTERS } from '../../src/personal-workspace.mjs';
import { chinaDay, normalizeRange } from '../../src/web-statistics/summary.mjs';
import type { PersonalTaskScope } from './list-state';
import { DEFAULT_PERSONAL_OPTIONS, type PersonalEvent, type PersonalOptions, type PersonalWork } from './personal-filters';
import styles from './personal-workspace.module.css';

const categoryLabels: Record<string,string> = {copyInitial:'待文案初审',imageInitial:'待图片初审',copyRework:'仅文案返修',imageRework:'仅图片返修',bothRework:'文案和图片返修',
  previews:'结果待确认',planRunning:'文案规划中',repairRunning:'图片修复中',backgroundFailed:'后台处理失败',recheck:'待复检',longWaiting:'等待超过 24 小时',completed:'已完成',cancelled:'已废弃'};

function CreatedDates({from,to,onChange}:{from:string;to:string;onChange:(from:string,to:string)=>void}) {
  const [start,setStart]=useState(from),[end,setEnd]=useState(to),[error,setError]=useState('');
  useEffect(()=>{setStart(from);setEnd(to);},[from,to]);
  return <form className={styles.dateForm} onSubmit={event=>{
    event.preventDefault();
    try { if(start||end){const range={period:'custom',from:start||end,to:end||start};normalizeRange(range);}setError('');onChange(start,end); }
    catch(caught){setError(caught instanceof Error?caught.message:'日期无效');}
  }}><DatePicker name="createdFrom" label="创建开始日期" aria-label="作业创建开始日期" value={start} onValueChange={setStart} />
    <DatePicker name="createdTo" label="创建结束日期" aria-label="作业创建结束日期" value={end} onValueChange={setEnd} />
    <Button variant="outline" type="submit">筛选创建日期</Button>
    {(from||to)&&<Button variant="ghost" type="button" onClick={()=>onChange('','')}>清除日期</Button>}
    {error&&<span role="alert">{error}</span>}
  </form>;
}

export function PersonalDateRange({ period, from, to, onChange }: {
  period: string; from: string; to: string; onChange: (value: { period: string; from: string; to: string }) => void;
}) {
  const [start, setStart] = useState(from || chinaDay(Date.now()));
  const [end, setEnd] = useState(to || chinaDay(Date.now()));
  const [error, setError] = useState('');
  useEffect(() => { if (from) setStart(from); if (to) setEnd(to); }, [from, to]);
  return <div className={styles.dateRange}>
    <div className={styles.periodTabs} aria-label="历史统计日期">
      {[['today','今天'],['yesterday','昨天'],['7d','近 7 天'],['30d','近 30 天']].map(([value,label]) => <Button unstyled
        className="button small" type="button" key={value} aria-pressed={period === value || value === 'yesterday' && period === 'custom' && from === to && from === chinaDay(Date.now()-86_400_000)}
        onClick={() => { setError(''); const yesterday = chinaDay(Date.now()-86_400_000); onChange(value === 'yesterday'
          ? {period:'custom',from:yesterday,to:yesterday} : {period:value,from:'',to:''}); }}>{label}</Button>)}
    </div>
    <form className={styles.dateForm} onSubmit={event => {
      event.preventDefault();
      try { const value = {period:'custom',from:start,to:end}; normalizeRange(value); setError(''); onChange(value); }
      catch (caught) { setError(caught instanceof Error ? caught.message : '日期无效'); }
    }}>
      <DatePicker name="from" label="开始日期" aria-label="历史开始日期" value={start} onValueChange={setStart} required />
      <DatePicker name="to" label="结束日期" aria-label="历史结束日期" value={end} onValueChange={setEnd} required />
      <Button variant="outline" type="submit">应用日期</Button>
    </form>
    {error && <span role="alert" className="notice error">{error}</span>}
  </div>;
}

export function PersonalTaskControls({ options, onChange, category, onCategory, scope, onScope, counts, onDelivery }: {
  options: PersonalOptions; onChange: (value: PersonalOptions) => void;
  category: string; onCategory: (value: string) => void; scope: PersonalTaskScope; onScope: (value: PersonalTaskScope) => void;
  counts: Record<string, number> | null; onDelivery?: () => void;
}) {
  const update = (key: keyof PersonalOptions, value: string) => onChange({ ...options, [key]: value });
  const hasReworkFilters = Boolean(options.reworkType || options.reworkProgress || options.reworkSource || options.longWaiting || options.repeated);
  const hasCreatedDates = Boolean(options.createdFrom || options.createdTo);
  const [reworkOpen, setReworkOpen] = useState(category === 'rework' || hasReworkFilters);
  const [datesOpen, setDatesOpen] = useState(hasCreatedDates);
  useEffect(() => { if (category === 'rework' || hasReworkFilters) setReworkOpen(true); }, [category, hasReworkFilters]);
  useEffect(() => { if (hasCreatedDates) setDatesOpen(true); }, [hasCreatedDates]);
  return <section className={`panel ${styles.controls}`} aria-label="我的作业筛选">
    <div className={styles.heading}><div className={styles.modeTabs} aria-label="作业查询模式">
      {[['CURRENT','当前作业'],['COMPLETED','完成历史'],['RETURNS','退回记录'],['REWORK','返修提交'],['QUALITY','质检记录']].map(([value,label]) =>
        <Button unstyled type="button" className="button small" aria-pressed={options.mode === value} key={value} onClick={() => {
          onChange({ ...DEFAULT_PERSONAL_OPTIONS, period: options.period, from: options.from, to: options.to, mode:value }); onCategory('ALL');
        }}>{label}</Button>)}
    </div><div className={styles.inline}><Button asChild variant="outline" size="sm"><Link href="/workbench/personal-statistics"><ChartNoAxesCombined size={14} aria-hidden="true" />个人数据统计</Link></Button>
      {onDelivery && <Button variant="outline" size="sm" type="button" onClick={onDelivery}><PackageCheck size={14} aria-hidden="true" />我的交付记录</Button>}</div></div>
    {options.mode === 'CURRENT' ? <>
      <div className={styles.scopeRow}><label className={styles.field}>作业关系
        <Select value={scope} onValueChange={value => onScope(value as PersonalTaskScope)}>
          <SelectTrigger aria-label="作业关系"><SelectValue /></SelectTrigger>
          <SelectContent><SelectItem value="ASSIGNED">我负责的</SelectItem><SelectItem value="CREATED">我创建的</SelectItem><SelectItem value="ALL">与我相关</SelectItem></SelectContent>
        </Select>
      </label><span className={styles.muted}>当前待办按最新状态统计；同一作业在“我需处理”中只计算一次。</span></div>
      <div className={styles.tabs} aria-label="作业状态">
        {PERSONAL_WORK_FILTERS.map(([value,label]) => <Button unstyled type="button" className="button small" key={value} aria-pressed={category === value}
          onClick={() => onCategory(value)}>{label} <span>{counts?.[value] ?? '—'}</span></Button>)}
        {!PERSONAL_WORK_FILTERS.some(([value]) => value === category) && <span className="pill">当前筛选：{categoryLabels[category] ?? category}</span>}
      </div>
      <Disclosure className={styles.filterDisclosure} open={reworkOpen} onOpenChange={setReworkOpen}>
        <DisclosureTrigger><SlidersHorizontal size={15} aria-hidden="true" />返修与等待筛选{hasReworkFilters && <span className={styles.activeHint}>已筛选</span>}</DisclosureTrigger>
        <DisclosureContent><div className={styles.filterGrid}>
          <label className={styles.field}>返修类型<Select value={options.reworkType || 'ALL'} onValueChange={value => update('reworkType', value === 'ALL' ? '' : value)}>
            <SelectTrigger aria-label="返修类型"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部类型</SelectItem><SelectItem value="COPY">仅文案</SelectItem><SelectItem value="IMAGE">仅图片</SelectItem><SelectItem value="BOTH">文案和图片</SelectItem></SelectContent>
          </Select></label>
          <label className={styles.field}>返修进度<Select value={options.reworkProgress || 'ALL'} onValueChange={value => update('reworkProgress', value === 'ALL' ? '' : value)}>
            <SelectTrigger aria-label="返修进度"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部进度</SelectItem><SelectItem value="EDIT">待修改</SelectItem><SelectItem value="PROCESSING">后台处理中</SelectItem><SelectItem value="CONFIRM">待确认结果</SelectItem></SelectContent>
          </Select></label>
          <label className={styles.field}>退回来源<Select value={options.reworkSource || 'ALL'} onValueChange={value => update('reworkSource', value === 'ALL' ? '' : value)}>
            <SelectTrigger aria-label="退回来源"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部来源</SelectItem><SelectItem value="COPY_QA">文案质检</SelectItem><SelectItem value="IMAGE_QA">图片质检</SelectItem><SelectItem value="FINAL_REWORK">最终审核</SelectItem></SelectContent>
          </Select></label>
        </div><div className={styles.checks}>
          <label><Checkbox checked={options.longWaiting === '1'} onChange={event => update('longWaiting',event.target.checked ? '1' : '')} />等待超过 24 小时</label>
          <label><Checkbox checked={options.repeated === '1'} onChange={event => update('repeated',event.target.checked ? '1' : '')} />多次返修（≥ 2 次退回）</label>
        </div></DisclosureContent></Disclosure>
      <Disclosure className={styles.filterDisclosure} open={datesOpen} onOpenChange={setDatesOpen}><DisclosureTrigger><CalendarRange size={15} aria-hidden="true" />创建日期筛选{hasCreatedDates && <span className={styles.activeHint}>已筛选</span>}</DisclosureTrigger><DisclosureContent>
        <CreatedDates from={options.createdFrom} to={options.createdTo} onChange={(createdFrom,createdTo)=>onChange({...options,createdFrom,createdTo})}/>
      </DisclosureContent></Disclosure>
    </> : <><p className={styles.muted}>按本人实际操作的时间查询，任务改派后仍保留历史贡献；无当前详情权限的作业仅展示历史记录。</p>
      <PersonalDateRange {...options} onChange={value => onChange({ ...options,...value })} />
      <label className={styles.field}>阶段<Select value={options.stage || 'ALL'} onValueChange={value => update('stage', value === 'ALL' ? '' : value)}>
        <SelectTrigger aria-label="阶段"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ALL">全部阶段</SelectItem><SelectItem value="COPY">文案</SelectItem><SelectItem value="IMAGE">图片</SelectItem></SelectContent>
      </Select></label>
    </>}
    <div className={styles.filterFooter}><Button variant="ghost" size="sm" type="button" onClick={() => { onChange(DEFAULT_PERSONAL_OPTIONS); onCategory('ALL'); onScope('ASSIGNED'); setReworkOpen(false); setDatesOpen(false); }}><RotateCcw size={13} aria-hidden="true" />重置个人筛选</Button></div>
  </section>;
}

const types: Record<string,string> = { COPY:'文案返修',IMAGE:'图片返修',BOTH:'文案和图片返修' };
const progress: Record<string,string> = { EDIT:'待修改',PROCESSING:'后台处理中',CONFIRM:'待确认结果' };
const sources: Record<string,string> = { COPY_QA:'文案质检',IMAGE_QA:'图片质检',FINAL_REWORK:'最终审核' };
export function PersonalWorkDetails({ work, events }: { work?: PersonalWork | null; events?: PersonalEvent[] }) {
  const history=events?.slice().sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)).map(event => <small key={event.id}>
    {event.stage === 'COPY' ? '文案' : '图片'}{event.kind === 'COMPLETE' ? event.rework ? '返修提交' : '审核提交' : event.kind === 'RETURN' ? '退回' : event.passed ? '质检通过' : '质检退回'}：{new Date(event.at).toLocaleString('zh-CN')}
  </small>);
  if (!work) return <div className={styles.rowDetails}>{history}</div>;
  return <div className={styles.rowDetails}>
    {work.reworkType && <><strong>{types[work.reworkType]} · {progress[work.reworkProgress || 'EDIT']}</strong>
      <small>{sources[work.reworkSource || ''] || '退回'} · 累计 {work.reworkCount} 次退回{work.returnedAt ? ` · ${new Date(work.returnedAt).toLocaleString('zh-CN')}` : ''}</small>
      {work.returnNote && <small title={work.returnNote} className="workbench-text-preview">退回原因：{work.returnNote}</small>}</>}
    {work.waitingHours !== null && <small className={work.waitingHours >= 24 ? styles.warning : ''}>当前待处理已等待 {work.waitingHours.toFixed(1)} 小时</small>}
    {work.categories.includes('planRunning') && <small>文案规划处理中，可关闭操作窗口</small>}
    {work.categories.includes('repairRunning') && <small>图片修复处理中 · {work.imageEdits.queued+work.imageEdits.running} 项</small>}
    {work.planStatus === 'SUCCEEDED' && <strong>文案规划已完成，待确认保存</strong>}
    {work.imageEdits.ready > 0 && work.categories.includes('previews') && <strong>图片修复已完成，{work.imageEdits.ready} 项待确认</strong>}
    {work.categories.includes('backgroundFailed') && <small className={styles.warning}>后台处理失败，请查看详情</small>}
    {history}
  </div>;
}
