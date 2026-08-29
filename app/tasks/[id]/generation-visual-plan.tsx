type VisualPlan = Record<string, unknown>;

export function VisualPlanTrace({ visualPlan }: { visualPlan?: VisualPlan | null }) {
  if (!visualPlan) {
    return <div className="batch-empty">历史批次未保存 VisualPlan；从下一次生成开始会按批次记录。</div>;
  }

  return <div className="prompt-content-list visual-plan-trace">
    <p className="subtle">显示本批次实际用于逐页图片生成的完整视觉计划。</p>
    <article className="prompt-content-card">
      <div className="prompt-content-meta">
        <h4>VisualPlan</h4>
        <span className="subtle">完整 JSON</span>
      </div>
      <pre className="prompt-content" tabIndex={0} aria-label="本批次 VisualPlan 完整内容">
        {JSON.stringify(visualPlan, null, 2)}
      </pre>
    </article>
  </div>;
}
