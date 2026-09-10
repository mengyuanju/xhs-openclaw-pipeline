import Link from 'next/link';

import { ArrowUpRight, Bot, UserRoundCheck } from 'lucide-react';

export function QualitySettingsOverview() {
  return <section className="quality-settings-overview" aria-labelledby="quality-systems-heading">
    <div className="settings-group-heading">
      <div>
        <span className="section-kicker">Scoring map</span>
        <h2 id="quality-systems-heading">先分清两套评分</h2>
      </div>
      <p>自动质检负责发现问题，人工评分记录审核判断；任务仍需完成适用的抽检或强制复检，两套分值不会互相覆盖。</p>
    </div>
    <div className="quality-system-grid">
      <article className="quality-system-card">
        <div className="quality-system-card-head"><Bot size={18} aria-hidden="true" /><span>系统自动质检</span><strong>0–3 分</strong></div>
        <p><b>production-v2</b> 按 10 个维度和最低阻碍分聚合。每次扣分原因来自该次检测的证据与问题标签，不使用人工原因选项。</p>
        <Link href="/prompts">在提示词中维护“质量评分”依据<ArrowUpRight size={14} aria-hidden="true" /></Link>
      </article>
      <article className="quality-system-card" data-human>
        <div className="quality-system-card-head"><UserRoundCheck size={18} aria-hidden="true" /><span>人工审核评分</span><strong>1 / 2 / 2.5 / 3</strong></div>
        <p>文案机器原稿只有 3 分可直接提交；2 分和 2.5 分须实际修改，人工确认达标后最终稿记录为 3 分。图片评分为 2.5 分或 3 分时可通过图文终审。</p>
      </article>
    </div>
  </section>;
}
