'use client';

import { Chart, duration, Metric, number, percent } from './shared';
import type { Efficiency } from './types';

export function EfficiencyPanel({ data }: { data: Efficiency | null }) {
  const partial = data?.state !== 'ready';
  return <section className="panel job-stats-section" aria-label="生成与交付效率">
    <div className="job-stats-heading"><div><h2>生成与交付效率</h2><p className="job-stats-note">生成耗时按成功执行结束日期统计，图片单位为整套。</p></div>
      <span className={partial ? 'job-stats-warning' : 'job-stats-note'} role="status">{!data ? '等待数量汇总'
        : partial ? `统计未完整 · 已读取 ${data.loaded} / ${data.total} 项${data.failed ? `，${data.failed} 项待重试` : ''}` : `明细已就绪 · ${data.loaded} 项`}</span>
    </div>
    <div className="job-stats-metrics job-stats-metrics-three">
      <Metric label="文案平均耗时" value={duration(data?.copy.meanMs)} note={`${number(data?.copy.samples)} 条成功执行样本${partial ? ' · 已读取部分' : ''}`} />
      <Metric label="图片整套平均耗时" value={duration(data?.image.meanMs)} note={`${number(data?.image.samples)} 条成功执行样本${partial ? ' · 已读取部分' : ''}`} />
      <Metric label="平均交付耗时" value={duration(data?.delivery.meanMs)} note={`${number(data?.delivery.samples)} 项有效完成作业 · 含排队和人工审核`} />
    </div>
    <details className="job-stats-methods"><summary>查看耗时分布与样本质量</summary>
      <div className="job-stats-table-scroll"><table className="job-stats-table"><thead><tr><th>口径</th><th>中位数</th><th>P90</th><th>有效样本</th><th>无效耗时</th><th>已放弃执行</th></tr></thead>
        <tbody>{(['copy', 'image', 'delivery'] as const).map((key, i) => <tr key={key}><th>{['文案生成', '图片整套生成', '总交付'][i]}</th>
          <td>{duration(data?.[key].medianMs)}</td><td>{duration(data?.[key].p90Ms)}</td><td>{number(data?.[key].samples)}</td>
          <td>{key === 'delivery' ? '—' : number(data?.[key].invalid)}</td><td>{key === 'delivery' ? '不适用' : number(data?.[key].abandoned)}</td></tr>)}</tbody></table></div>
      <p className="job-stats-note">P90 表示 90% 的有效样本不超过该耗时。失败、已放弃、运行中和无效起止时间不计入成功耗时。</p>
    </details>
    {data && <Chart label="每日文案和图片整套成功执行平均耗时（分钟），无样本日期留空" unit="分钟"
      labels={data.trend.map(day => day.date.slice(5))} series={[
        { name: '文案平均耗时', values: data.trend.map(day => day.copyMs === null ? null : Number((day.copyMs / 60_000).toFixed(2))) },
        { name: '图片整套平均耗时', values: data.trend.map(day => day.imageMs === null ? null : Number((day.imageMs / 60_000).toFixed(2))) },
      ]} />}
    <div className="job-stats-metrics job-stats-secondary">
      <Metric label="期间有效产出图片" value={data?.loaded === 0 && data.total > 0 ? '—' : number(data?.effectiveImages)} note={partial ? '当前已读取的图片资产，尚未汇总完整' : '当前有效完成作业 · 当前图片运行'} />
      <Metric label="文案失败执行占比" value={percent(data?.copy.failureRate)} note={`${number(data?.copy.failed)} 次失败 / ${number(data ? data.copy.failed + data.copy.succeeded : null)} 次已结束`} />
      <Metric label="图片失败执行占比" value={percent(data?.image.failureRate)} note={`${number(data?.image.failed)} 次失败 / ${number(data ? data.image.failed + data.image.succeeded : null)} 次已结束`} />
      <Metric label="多次执行任务占比" value={percent(data?.repeatRate)} note={`${number(data?.repeatedTasks)} / ${number(data?.executionTasks)} 项有期间执行的作业`} />
    </div>
    <p className="job-stats-note">以上执行指标均基于已读取明细。明确标注为模拟的图片运行已排除{data ? `（期间 ${data.simulated} 次执行）` : ''}；历史未标明来源的记录仍计入。多次执行包含同阶段重做，不代表模型内部重试。</p>
    {data?.updatedAt && <p className="job-stats-note">明细读取时间最早为 {new Date(data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}；未变化的明细持续复用。</p>}
  </section>;
}
