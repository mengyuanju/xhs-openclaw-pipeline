'use client';

import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';

import { Chart, duration, Metric, number, percent } from './shared';
import type { Distribution, Efficiency } from './types';

function minutes(ms: number | null | undefined) {
  return ms == null ? null : Number((ms / 60_000).toFixed(1));
}

function hours(ms: number | null | undefined) {
  return ms == null ? null : Number((ms / 3_600_000).toFixed(1));
}

function EfficiencyStage({ label, data, note }: { label: string; data: Distribution | undefined; note: string }) {
  return <article className="job-stats-efficiency-card">
    <div><span>{label}</span><strong>{duration(data?.meanMs)}</strong><small>{note}</small></div>
    <dl>
      <div><dt>中位数</dt><dd>{duration(data?.medianMs)}</dd></div>
      <div><dt>90% 不超过</dt><dd>{duration(data?.p90Ms)}</dd></div>
      <div><dt>有效样本</dt><dd>{number(data?.samples)}</dd></div>
    </dl>
  </article>;
}

export function EfficiencyPanel({ data }: { data: Efficiency | null }) {
  const partial = data?.state === 'partial';
  const loading = !data || data.state === 'loading';
  const status = !data ? '等待作业数量汇总' : data.state === 'ready' ? `汇总完成 · ${number(data.loaded)} 项明细`
    : data.state === 'partial' ? `部分明细暂不可用 · 已汇总 ${number(data.loaded)} / ${number(data.total)} 项${data.failed ? `，${number(data.failed)} 项稍后重试` : ''}`
      : `正在汇总明细 · ${number(data.loaded)} / ${number(data.total)} 项`;
  const progress = data?.total ? Math.round(data.loaded / data.total * 100) : 0;
  const successRate = (failed: number | undefined, succeeded: number | undefined) => failed == null || succeeded == null || failed + succeeded === 0
    ? null : succeeded / (failed + succeeded);
  const firstPassRate = data?.repeatRate == null ? null : 1 - data.repeatRate;
  const hasGenerationSamples = Boolean(data && data.copy.samples + data.image.samples > 0);
  const hasDeliverySamples = Boolean(data?.delivery.samples);
  return <section className="panel job-stats-section" aria-label="生成与交付效率">
    <div className="job-stats-heading"><div><h2>生成与交付效率</h2><p className="job-stats-note">平均值、中位数和 P90 直接对照；图片耗时按整套统计。</p></div>
      <span className={partial ? 'job-stats-warning' : 'job-stats-note'} role="status">{status}</span>
    </div>
    {data && data.state !== 'ready' && data.total > 0 && <div className="job-stats-efficiency-progress">
      <progress max={data.total} value={data.loaded} aria-label={`效率明细汇总进度 ${progress}%`} />
      <span>{progress}%</span>
    </div>}
    <div className="job-stats-efficiency-grid">
      <EfficiencyStage label="文案生成" data={data?.copy} note="成功执行耗时" />
      <EfficiencyStage label="图片整套生成" data={data?.image} note="成功执行耗时" />
      <EfficiencyStage label="从创建到审核交付" data={data?.delivery} note="包含排队与人工审核" />
    </div>
    {data && <div className="job-stats-efficiency-chart-grid">
      <section className="job-stats-efficiency-chart"><div className="job-stats-chart-heading"><h3>自动生成耗时对比</h3><span>单位：分钟</span></div>
        {hasGenerationSamples ? <Chart label="文案生成和图片整套生成的平均值、中位数及 P90 耗时对比" bar horizontal unit="分钟"
          labels={['平均值', '中位数', 'P90']} series={[
            { name: '文案生成', values: [minutes(data.copy.meanMs), minutes(data.copy.medianMs), minutes(data.copy.p90Ms)] },
            { name: '图片整套', values: [minutes(data.image.meanMs), minutes(data.image.medianMs), minutes(data.image.p90Ms)] },
          ]} /> : <p className="job-stats-empty">当前范围暂无成功生成样本</p>}
      </section>
      <section className="job-stats-efficiency-chart"><div className="job-stats-chart-heading"><h3>总交付耗时分布</h3><span>单位：小时</span></div>
        {hasDeliverySamples ? <Chart label="从创建到审核交付的平均值、中位数及 P90 耗时" bar horizontal unit="小时"
          labels={['平均值', '中位数', 'P90']} series={[
            { name: '总交付', values: [hours(data.delivery.meanMs), hours(data.delivery.medianMs), hours(data.delivery.p90Ms)] },
          ]} /> : <p className="job-stats-empty">当前范围暂无有效交付样本</p>}
      </section>
    </div>}
    <div className="job-stats-metrics job-stats-secondary job-stats-efficiency-outcomes">
      <Metric label="期间有效产出图片" value={data?.loaded === 0 && data.total > 0 ? '—' : number(data?.effectiveImages)} note={loading || partial ? '已汇总明细中的当前有效图片' : '有效完成作业的当前图片资产'} />
      <Metric label="文案执行成功率" value={percent(successRate(data?.copy.failed, data?.copy.succeeded))} note={`${number(data?.copy.succeeded)} 次成功 / ${number(data ? data.copy.failed + data.copy.succeeded : null)} 次已结束`} />
      <Metric label="图片执行成功率" value={percent(successRate(data?.image.failed, data?.image.succeeded))} note={`${number(data?.image.succeeded)} 次成功 / ${number(data ? data.image.failed + data.image.succeeded : null)} 次已结束`} />
      <Metric label="一次完成率" value={percent(firstPassRate)} note={`${number(data ? data.executionTasks - data.repeatedTasks : null)} / ${number(data?.executionTasks)} 项未发生同阶段重做`} />
    </div>
    <Disclosure className="job-stats-methods"><DisclosureTrigger>查看样本质量与统计口径</DisclosureTrigger><DisclosureContent>
      <div className="job-stats-table-scroll"><table className="job-stats-table"><thead><tr><th>口径</th><th>中位数</th><th>P90</th><th>有效样本</th><th>无效耗时</th><th>已放弃执行</th></tr></thead>
        <tbody>{(['copy', 'image', 'delivery'] as const).map((key, i) => <tr key={key}><th>{['文案生成', '图片整套生成', '总交付'][i]}</th>
          <td>{duration(data?.[key].medianMs)}</td><td>{duration(data?.[key].p90Ms)}</td><td>{number(data?.[key].samples)}</td>
          <td>{key === 'delivery' ? '—' : number(data?.[key].invalid)}</td><td>{key === 'delivery' ? '不适用' : number(data?.[key].abandoned)}</td></tr>)}</tbody></table></div>
      <p className="job-stats-note">P90 表示 90% 的有效样本不超过该耗时。失败、已放弃、运行中和无效起止时间不计入成功耗时。</p>
    </DisclosureContent></Disclosure>
    {data && data.trend.length > 1 && <Disclosure className="job-stats-methods job-stats-trend-disclosure"><DisclosureTrigger>查看每日平均耗时趋势</DisclosureTrigger><DisclosureContent>
      <Chart label="每日文案和图片整套成功执行平均耗时（分钟），无样本日期留空" unit="分钟"
        labels={data.trend.map(day => day.date.slice(5))} series={[
          { name: '文案平均耗时', values: data.trend.map(day => minutes(day.copyMs)) },
          { name: '图片整套平均耗时', values: data.trend.map(day => minutes(day.imageMs)) },
        ]} />
    </DisclosureContent></Disclosure>}
    <p className="job-stats-note">以上指标均基于已汇总明细。明确标注为模拟的图片运行已排除{data ? `（期间 ${number(data.simulated)} 次执行）` : ''}；历史未标明来源的记录仍计入。一次完成率按未发生同阶段重做的作业计算，不代表模型内部重试。</p>
    {data?.updatedAt && <p className="job-stats-note">明细读取时间最早为 {new Date(data.updatedAt).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false })}；未变化的明细持续复用。</p>}
  </section>;
}
