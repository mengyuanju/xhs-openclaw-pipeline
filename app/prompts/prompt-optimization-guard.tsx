import { AlertTriangle, ShieldCheck } from 'lucide-react';

import { promptOptimizationGuardStatuses } from '../../src/prompt-optimization-guards.mjs';

type GuardStatus = {
  id: string;
  title: string;
  purpose: string;
  present: boolean;
  rule: string;
};

export function PromptOptimizationGuard({ kind, content }: { kind: string; content: string }) {
  const statuses = promptOptimizationGuardStatuses(kind, content) as GuardStatus[];
  if (statuses.length === 0) return null;

  return <aside className="prompt-optimization-guard" aria-label="关键提示词优化规则">
    <div className="prompt-optimization-guard-heading">
      <ShieldCheck size={17} aria-hidden="true" />
      <strong>关键优化规则 · 请勿误删</strong>
    </div>
    {statuses.map((status) => <section className={status.present ? '' : 'is-missing'} key={status.id}>
      <div className="prompt-optimization-guard-title">
        {status.present ? <ShieldCheck size={15} aria-hidden="true" /> : <AlertTriangle size={15} aria-hidden="true" />}
        <strong>{status.title}</strong>
        <span>{status.present ? '保护标识完整' : '保护标识或规则内容已缺失'}</span>
      </div>
      <p><b>主要优化：</b>{status.purpose}</p>
      {status.present && <pre>{status.rule}</pre>}
      <small>稳定标识：{status.id}。可以调整规则措辞，但请保留开始、结束标识和中间的有效内容。</small>
    </section>)}
  </aside>;
}
