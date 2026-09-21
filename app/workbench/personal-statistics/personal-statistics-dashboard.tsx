'use client';

import dynamic from 'next/dynamic';
import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { apiRequest } from '../../components/api-client';
import { subscribeWorkspaceUpdates } from '../../components/workspace-updates';
import { personalListHref } from '../../../src/personal-workspace.mjs';
import { PersonalDateRange } from '../personal-controls';
import { PersonalQualityActivity } from './personal-quality-activity';
import type { QaSummary } from '../../workbench-statistics/operator-types';
import { OperatorDeliveryHistory } from '../operator-delivery-history';
import type { PersonalTaskScope } from '../list-state';
import styles from '../personal-workspace.module.css';

const Chart = dynamic(() => import('../../workbench-statistics/statistics-chart'), { ssr:false });
type Report = {
  annotation?:Record<string,{firstSubmitted:number;reworked:number;submissions:number;firstRecheck:{passed:number;samples:number;rate:number|null}}>|null;
  qa?:QaSummary|null;contribution?:number|null;qaTrend?:({date:string}&QaSummary)[]|null;
  updatedAt:string; scope:string; range:{from:string;to:string}; counts:Record<string,number>;
  rework:{copy:number;image:number;both:number;edit:number;processing:number;confirm:number;longWaiting:number;longestHours:number};
  background:{plan:number;repair:number;previews:number;failed:number;imageRequests:number};
  period:Record<string,number|null>|null; pendingDeliveryBatches:number|null;
  trend:{date:string;copy:number;image:number;returned:number;reworked:number}[]|null;
  quality:Record<string,{samples:number;passed:number;rate:number|null}>|null;
  repeatReworkTasks:number|null; reasons:{code:string;count:number}[]|null;
  reworkDuration:{samples:number;medianMs:number|null}|null; missingDates:number;
  historyNotice:string; notices:string[];
};
const number = (value:number|null|undefined) => value == null ? '—' : value.toLocaleString('zh-CN');
const reasons: Record<string,string> = { OTHER:'其他',COPY_QUALITY:'文案质量',IMAGE_QUALITY:'图片质量',TEXT_ERROR:'文字错误',LAYOUT:'排版问题',FACT_ERROR:'事实错误',OFF_TOPIC:'偏离主题' };

export function PersonalStatisticsDashboard({ canDeliver = false }: {canDeliver?:boolean}) {
  const [activity,setActivity]=useState('PRODUCTION');
  const [scope,setScope] = useState<PersonalTaskScope>('ASSIGNED');
  const [range,setRange] = useState({period:'today',from:'',to:''});
  const [report,setReport] = useState<Report|null>(null);
  const [loading,setLoading] = useState(true);
  const [error,setError] = useState('');
  const [deliveryOpen,setDeliveryOpen] = useState(false);
  const active = useRef<AbortController|null>(null);
  const refresh = useCallback(async () => {
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const timer = setTimeout(()=>controller.abort(),25_000);
    setLoading(true);
    try {
      const search = new URLSearchParams({personalScope:scope,...range});
      const data = await apiRequest<Report>(`/api/control-plane/v1/personal-workspace/statistics?${search}`, {signal:controller.signal,cache:'no-store'});
      if (!data?.counts || !data.range || !data.updatedAt) throw new Error('统计数据格式不完整');
      if (active.current !== controller) return;
      setReport(data); setError('');
    } catch(caught) {
      if (active.current !== controller) return;
      setError(controller.signal.aborted ? '统计读取超时，请重试' : caught instanceof Error ? caught.message : '统计读取失败');
    } finally { clearTimeout(timer); if (active.current === controller) { active.current=null; setLoading(false); } }
  },[scope,range]);
  useEffect(() => {
    void refresh();
    const visible = () => { if (document.visibilityState === 'visible' && !active.current) void refresh(); };
    const timer = setInterval(visible,30_000);
    const unsubscribe = subscribeWorkspaceUpdates(()=>void refresh());
    document.addEventListener('visibilitychange',visible);
    return () => { active.current?.abort(); active.current=null; clearInterval(timer); unsubscribe(); document.removeEventListener('visibilitychange',visible); };
  },[refresh]);
  const currentHref = (category:string, extras:Record<string,string>={}) => personalListHref({personalScope:report?.scope ?? scope,category,...extras});
  const historyHref = (mode:string,stage='',extras:Record<string,string>={}) => personalListHref({mode,stage,period:'custom',from:report?.range.from,to:report?.range.to,...extras});
  const card = (label:string,value:number|null|undefined,href?:string,note='项作业',emphasis=false) => {
    const content = <><span>{label}</span><strong>{number(value)}</strong><small>{note}</small></>;
    return href && value != null ? <Link className={styles.card} data-emphasis={emphasis} href={href} key={label}>{content}</Link>
      : <div className={styles.card} data-emphasis={emphasis} key={label}>{content}</div>;
  };
  return <div className={styles.dashboard}>
    <header className={styles.heading}><div><h1>个人数据统计</h1><p className={styles.muted}>查看标注与质检贡献、当前待办及交付记录。</p></div>
      <div className={styles.inline}><Link href="/workbench/personal" className="button">我的作业</Link><Button unstyled className="button" type="button" disabled={loading} onClick={()=>void refresh()}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{loading ? '更新中…' : '刷新'}</Button></div>
    </header>
    {error && <div className="notice error" role="alert">{error}{report ? '。以下保留上次成功的数据和统计范围，可能已过时。' : '。暂未取得统计数据，请重试。'}</div>}
    {report?.notices.map(notice=><div className="notice warning" role="status" key={notice}>{notice}</div>)}
    <section className={`panel ${styles.section}`}><div><h2>我的数据</h2><p className={styles.muted}>按日期查看本人标注与质检记录。</p></div>
      <PersonalDateRange {...range} onChange={setRange} />
      <div className={styles.inline} aria-label="工作类型">{[['PRODUCTION','标注'],['QA','质检']].map(([value,label])=><Button key={value} variant="outline" size="sm" aria-pressed={activity===value} onClick={()=>setActivity(value)}>{label}</Button>)}</div>
      {report && <p className={styles.muted}>{report.range.from} 至 {report.range.to} · 北京时间 · 标注按提交日，质检按结论日</p>}
      {activity==='QA'?<>
        <PersonalQualityActivity qa={report?.qa} contribution={report?.contribution} range={report?.range??{from:range.from,to:range.to}}/>
        {report?.qaTrend&&<Chart label="每日质检条数" unit="条" labels={report.qaTrend.map(day=>day.date)} series={[
          {name:'文案质检',values:report.qaTrend.map(day=>day.COPY.tasks)},{name:'图片质检',values:report.qaTrend.map(day=>day.IMAGE.tasks)}]}/>}
      </>:<>
        <div className={styles.cards}>{['COPY','IMAGE'].map(stage=>card(stage==='COPY'?'文案标注':'图片标注',report?.period?.[stage==='COPY'?'copy':'image'],historyHref('COMPLETED',stage),
          '条 · 首次 '+number(report?.annotation?.[stage].firstSubmitted)+' · 返修 '+number(report?.annotation?.[stage].reworked)))}</div>
        <h3>一次通过率</h3><p className={styles.muted}>首次随机抽检的通过数 / 已检数；未抽中与待结论不计入。</p>
        <div className={styles.cards}>{['COPY','IMAGE'].map(stage=>{const item=report?.quality?.[stage];return <Link className={styles.card} href={historyHref('QUALITY',stage,{qualityFirst:'1'})} key={stage}>
          <span>{stage==='COPY'?'文案':'图片'}一次通过率</span><strong>{item?.rate==null?'—':(item.rate*100).toFixed(1)+'%'}</strong>
          <small>{item?item.passed+' / '+item.samples+' 已检'+(item.samples>0&&item.samples<20?' · 样本较少':''):'数据暂不可用'}</small></Link>;})}</div>
        {report?.trend&&<Chart label="每日标注条数" unit="条" labels={report.trend.map(day=>day.date)} series={[
          {name:'文案标注',values:report.trend.map(day=>day.copy)},{name:'图片标注',values:report.trend.map(day=>day.image)}]}/>}
        <details><summary>返修与交付明细</summary><div className={styles.cards}>
          {['COPY','IMAGE'].map(stage=>{const item=report?.annotation?.[stage].firstRecheck;return <Link className={styles.card} href={historyHref('QUALITY',stage,{qualityRecheck:'1'})} key={stage}>
            <span>{stage==='COPY'?'文案':'图片'}首次返修通过率</span><strong>{item?.rate==null?'—':(item.rate*100).toFixed(1)+'%'}</strong><small>{item?item.passed+' / '+item.samples+' 已检':'暂无有效样本'}</small></Link>;})}
          {card('返修处理',report?.period?.reworked,historyHref('REWORK'),number(report?.period?.reworkRounds)+' 次提交')}
          {card('被退回内容',report?.period?.returned,historyHref('RETURNS'),'条 · 去重')}
          {card('本人内容已交付',report?.period?.deliveredTasks,undefined,'条 · '+number(report?.period?.deliveredBatches)+' 批次')}
        </div><div className={styles.reasons}>{report?.reasons?.map(item=><span className="pill" key={item.code}>{reasons[item.code]??item.code} · {item.count} 次</span>)}</div>
        <p className={styles.muted}>标注条数按任务和阶段去重，一组图片计一条。首次提交和返修处理可能重叠，不能相加。改派保留历史贡献；通过率归实际提交该版本的标注。</p></details>
      </>}
    </section>
    <details className={styles.section}><summary>当前待办与返修跟进</summary>
    <section className={`panel ${styles.section}`} aria-busy={loading}>
      <div className={styles.heading}><div><h2>当前待办</h2><p className={styles.muted}>不受上方日期影响。“我需处理”按本人负责、可立即操作的作业去重，不包含纯机器处理和等待质检。</p></div>
        <label className={styles.field}>当前作业范围 <Select value={scope} onValueChange={value=>setScope(value as PersonalTaskScope)}>
          <SelectTrigger aria-label="当前作业范围"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="ASSIGNED">我负责的</SelectItem><SelectItem value="CREATED">我创建的</SelectItem><SelectItem value="ALL">与我相关</SelectItem></SelectContent>
        </Select></label></div>
      <div className={styles.cards}>
        {card('我需处理',report?.counts.actionable,currentHref('actionable'),'项作业 · 去重',true)}
        {card('待文案初审',report?.counts.copyInitial,currentHref('copyInitial'))}
        {card('待图片初审',report?.counts.imageInitial,currentHref('imageInitial'))}
        {card('待返修',report?.counts.rework,currentHref('rework'),'项作业 · 含返修处理/确认',true)}
        {card('执行异常',report?.counts.anomaly,currentHref('anomaly'))}
      </div>
      <div className={styles.cards}>
        {card('生产中',report?.counts.production,currentHref('production'),'项作业 · 排队或运行')}
        {card('我的内容等待质检',report?.counts.qa,currentHref('qa'),'项作业 · 含复检')}
        {card('待复检',report?.counts.recheck,currentHref('recheck'))}
        {card('可交付',report?.counts.ready,currentHref('ready'))}
        {canDeliver && <Button unstyled type="button" className={styles.card} onClick={()=>setDeliveryOpen(true)}><span>已下载待确认交付</span><strong>{number(report?.pendingDeliveryBatches)}</strong><small>批次 · 查看我的交付记录</small></Button>}
      </div>
      {report && <p className={styles.muted}>数据更新于 {new Date(report.updatedAt).toLocaleString('zh-CN')} · {({ASSIGNED:'我负责的',CREATED:'我创建的',ALL:'与我相关'} as Record<string,string>)[report.scope]}{report.missingDates ? ` · ${report.missingDates} 项缺少等待起始时间` : ''}</p>}
    </section>
    <section className={`panel ${styles.section}`}><h2>返修跟进</h2><p className={styles.muted}>仅文案、仅图片和两者返修互斥；提交后转入复检，再次退回后重新进入待返修。</p>
      <div className={styles.cards}>
        {card('仅文案返修',report?.rework.copy,currentHref('rework',{reworkType:'COPY'}))}
        {card('仅图片返修',report?.rework.image,currentHref('rework',{reworkType:'IMAGE'}))}
        {card('文案和图片返修',report?.rework.both,currentHref('rework',{reworkType:'BOTH'}))}
        {card('等待超过 24 小时',report?.rework.longWaiting,currentHref('rework',{longWaiting:'1'}),'项返修作业',true)}
      </div>
      <div className={styles.inline}>
        <Link className="button small" href={currentHref('rework',{reworkProgress:'EDIT'})}>待修改 {number(report?.rework.edit)}</Link>
        <Link className="button small" href={currentHref('rework',{reworkProgress:'PROCESSING'})}>处理中 {number(report?.rework.processing)}</Link>
        <Link className="button small" href={currentHref('rework',{reworkProgress:'CONFIRM'})}>待确认 {number(report?.rework.confirm)}</Link>
        <Link className="button small" href={currentHref('rework',{repeated:'1'})}>查看多次返修</Link>
        <span className={styles.muted}>最长待处理：{report ? `${report.rework.longestHours.toFixed(1)} 小时` : '—'}；按当前待处理阶段计时。</span>
      </div>
    </section>
    <section className={`panel ${styles.section}`}><h2>后台处理与结果</h2><p className={styles.muted}>文案规划、图片修复期间可关闭操作窗口；完成或失败后，顶部“后台任务”会保留提醒。</p>
      <div className={styles.cards}>
        {card('文案规划中',report?.background.plan,currentHref('planRunning'))}
        {card('图片修复中',report?.background.repair,currentHref('repairRunning'),report ? `${report.background.imageRequests} 项修复请求` : '项修复请求')}
        {card('结果待确认',report?.background.previews,currentHref('previews'),'项作业 · 文案规划或图片预览')}
        {card('后台处理失败',report?.background.failed,currentHref('backgroundFailed'))}
      </div>
    </section>
    </details>
    {canDeliver && <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}><DialogContent className={styles.deliveryDialog}>
      <DialogTitle>我的交付记录</DialogTitle><DialogDescription>查看下载记录并确认交付。</DialogDescription>
      {deliveryOpen && <OperatorDeliveryHistory refreshKey={0} initialStatus="DOWNLOADED" />}
    </DialogContent></Dialog>}
  </div>;
}
