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
import { OperatorDeliveryHistory } from '../operator-delivery-history';
import type { PersonalTaskScope } from '../list-state';
import styles from '../personal-workspace.module.css';

const Chart = dynamic(() => import('../../workbench-statistics/statistics-chart'), { ssr:false });
type Report = {
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
    <header className={styles.heading}><div><h1>个人数据统计</h1><p className={styles.muted}>先处理当前待办，再查看完成记录与质量表现。</p></div>
      <div className={styles.inline}><Link href="/workbench/personal" className="button">我的作业</Link><Button unstyled className="button" type="button" disabled={loading} onClick={()=>void refresh()}><RefreshCw size={15} className={loading ? 'animate-spin' : ''} />{loading ? '更新中…' : '刷新'}</Button></div>
    </header>
    {error && <div className="notice error" role="alert">{error}{report ? '。以下保留上次成功的数据和统计范围，可能已过时。' : '。暂未取得统计数据，请重试。'}</div>}
    {report?.notices.map(notice=><div className="notice warning" role="status" key={notice}>{notice}</div>)}
    <section className={`panel ${styles.section}`} aria-busy={loading}>
      <div className={styles.heading}><div><h2>当前待办</h2><p className={styles.muted}>不受下方历史日期影响。“我需处理”按本人负责、可立即操作的作业去重，不包含纯机器处理和等待质检。</p></div>
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
        {card('待质检',report?.counts.qa,currentHref('qa'),'项作业 · 含复检')}
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
    <section className={`panel ${styles.section}`}><div><h2>历史完成与交付</h2><p className={styles.muted}>按本人实际提交事件统计；改派不改变历史贡献。文案、图片分别去重，“完成作业”合并去重。</p></div>
      <PersonalDateRange {...range} onChange={setRange} />
      {report && <p className={styles.muted}>当前展示：{report.range.from} 至 {report.range.to}（北京时间）</p>}
      <div className={styles.cards}>
        {card('完成作业',report?.period?.completed,historyHref('COMPLETED'),'项作业 · 去重')}
        {card('文案审核提交',report?.period?.copy,historyHref('COMPLETED','COPY'))}
        {card('图片初审提交',report?.period?.image,historyHref('COMPLETED','IMAGE'),'项作业 · 含返修复检提交')}
        {card('返修已提交',report?.period?.reworked,historyHref('REWORK'),`${number(report?.period?.reworkRounds)} 次提交 · 按阶段记录`)}
        {card('新增退回',report?.period?.returned,historyHref('RETURNS'),'项作业 · 去重')}
        {card('本人内容已交付',report?.period?.deliveredBatches,undefined,`${number(report?.period?.deliveredTasks)} 项作业 · 本人确认 ${number(report?.period?.confirmedByMeTasks)} 项 · 单位：批次`)}
      </div>
      {report?.trend ? <div className={styles.charts}>
        <Chart label="每日文案与图片完成作业" unit="项作业" labels={report.trend.map(item=>item.date)} series={[
          {name:'文案审核提交',values:report.trend.map(item=>item.copy)},{name:'图片初审提交',values:report.trend.map(item=>item.image)}]} />
        <Chart label="每日退回与返修提交" unit="项作业" labels={report.trend.map(item=>item.date)} series={[
          {name:'退回作业',values:report.trend.map(item=>item.returned)},{name:'返修提交',values:report.trend.map(item=>item.reworked)}]} />
      </div> : <p className={styles.muted}>{loading ? '正在读取历史趋势…' : '历史趋势暂不可用'}</p>}
      <details><summary>质量表现与统计口径</summary><div className={styles.quality}>
        <p className={styles.muted}>首轮质检通过率 = 首轮随机抽检通过样本 / 已出结论的首轮随机抽检样本。未抽中、免检、待结论和强制复检不计入分母。</p>
        <div className={styles.cards}>{['COPY','IMAGE'].map(stage=>{
          const item=report?.quality?.[stage];
          return <Link className={styles.card} href={historyHref('QUALITY',stage,{qualityFirst:'1'})} key={stage}><span>{stage === 'COPY' ? '文案' : '图片'}首轮质检通过率</span>
            <strong>{item?.rate == null ? '—' : `${(item.rate*100).toFixed(1)}%`}</strong><small>{item ? `${item.passed} / ${item.samples} 个样本${item.samples ? '' : ' · 暂无样本'}` : '数据暂不可用'}</small></Link>;
        })}{card('多次退回作业',report?.repeatReworkTasks,historyHref('RETURNS','',{repeated:'1'}),'期内发生第二次及以上退回的作业')}</div>
        <p>返修提交耗时中位数：{report?.reworkDuration?.medianMs == null ? '—' : `${(report.reworkDuration.medianMs/3_600_000).toFixed(1)} 小时`} <span className={styles.muted}>（{number(report?.reworkDuration?.samples)} 条可计算记录）</span></p>
        <div className={styles.reasons}>{report?.reasons?.length ? report.reasons.map(item=><span className="pill" key={item.code}>{reasons[item.code] ?? item.code} · {item.count} 次</span>) : <span className={styles.muted}>暂无可汇总的退回原因</span>}</div>
        <p className={styles.muted}>{report?.historyNotice ?? '历史数据读取后显示口径说明。'}</p>
      </div></details>
    </section>
    {canDeliver && <Dialog open={deliveryOpen} onOpenChange={setDeliveryOpen}><DialogContent className={styles.deliveryDialog}>
      <DialogTitle>我的交付记录</DialogTitle><DialogDescription>查看下载记录并确认交付。</DialogDescription>
      {deliveryOpen && <OperatorDeliveryHistory refreshKey={0} initialStatus="DOWNLOADED" />}
    </DialogContent></Dialog>}
  </div>;
}
