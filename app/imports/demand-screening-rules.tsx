import { StatusPill } from '../components/status-pill';

export const DEMAND_LEVELS = ['STRONG', 'MEDIUM', 'WEAK', 'NONE'] as const;
export type DemandLevel = typeof DEMAND_LEVELS[number];

export const DEMAND_LEVEL_COPY: Record<DemandLevel, { label: string; reason: string; rule: string }> = {
  STRONG: {
    label: '强需',
    reason: '真实经验或攻略需求，优先保留。',
    rule: '评价、推荐、经验攻略等，需要真实 UGC 经历才能充分满足。',
  },
  MEDIUM: {
    label: '中需',
    reason: '专业回答为主，真实经验有补充价值。',
    rule: '通识问答、行业科普等有官方或专业答案，经验内容可作为补充。',
  },
  WEAK: {
    label: '弱需',
    reason: '固定事实或一两句话即可闭环，优先废弃。',
    rule: '客观唯一问答、强时效或纯文档需求，不适合承载为一篇笔记。',
  },
  NONE: {
    label: '无需',
    reason: '寻址、资源下载等明确非笔记需求，直接废弃。',
    rule: '寻址、观看、下载、成人或资讯等其他明确需求，触发即算错误。',
  },
};

export function DemandScreeningRules() {
  return <>
    <div className="screening-rules" aria-label="需求强度判定规则">
      {DEMAND_LEVELS.map((level) => <div className="screening-rule" key={level}>
        <StatusPill value={level} />
        <p>{DEMAND_LEVEL_COPY[level].rule}</p>
      </div>)}
    </div>
    <p className="notice screening-redlines">直接废弃红线：一句话可闭环、硬广、缺乏优质素材、开放性问题、医疗诊疗与用药、投资博彩建议、无出处古诗名言、低价值简单成语。</p>
  </>;
}
