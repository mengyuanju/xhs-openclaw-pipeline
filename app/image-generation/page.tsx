import { ImageGenerationWorkbench } from './image-generation-workbench';

export default function ImageGenerationPage() {
  return <div className="stack">
    <div className="page-heading">
      <div>
        <span className="eyebrow">Standalone images</span>
        <h1>单独生成图片</h1>
        <p className="subtle">粘贴已完成文案和 3–5 页图片策划，独立验证视觉规划、图片生成、OCR 对齐与质量检查；不创建生产任务，也不进入正式审核。</p>
      </div>
    </div>
    <ImageGenerationWorkbench />
  </div>;
}
