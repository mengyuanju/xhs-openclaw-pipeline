import { EyeOff } from 'lucide-react';
import type { CopyQaRevisionView } from './types';
import styles from './copy-qa.module.css';

const IMAGE_KIND_LABELS:Record<string,string>={
  hero:'封面',steps:'步骤',checklist:'清单',comparison:'对比',detail:'细节',summary:'总结',
};

export function CopyQaRevisionComparison({copy,blind}:{copy:CopyQaRevisionView;blind:boolean}){
  return <>
    {blind&&<div className="notice"><EyeOff size={15} aria-hidden="true" /> 当前为盲评，页面不显示任务身份或上游人员信息。</div>}
    <div className={styles.comparison} aria-label="最终文案与图片文案规划对照">
      <article className={styles.copy} aria-label="最终人工通过文案">
        <span className="pill">最终人工通过稿</span>
        {copy.title&&<h3>{copy.title}</h3>}
        <p className={styles.copyBody}>{copy.body||'最终稿正文为空'}</p>
        {copy.tags.length>0&&<div className={styles.tags}>{copy.tags.map((tag,index)=><span className="pill" key={`${tag}-${index}`}>#{tag}</span>)}</div>}
      </article>
      <section className={styles.plan} aria-labelledby="copy-qa-plan-title">
        <div className={styles.planHeader}><div><h3 id="copy-qa-plan-title">图片文案规划</h3><p>逐页核对最终稿中的画面文字与生成要求。</p></div><span className="pill">{copy.imagePlan.length} 页</span></div>
        {copy.imagePlan.length>0
          ?<div className={styles.planGrid}>{copy.imagePlan.map((page,index)=><article className={styles.planCard} key={`${index}-${page.kind}`}>
            <header><span className={styles.planIndex}>{String(index+1).padStart(2,'0')}</span><div><small>第 {index+1} 页 · {IMAGE_KIND_LABELS[page.kind]??(page.kind||'未设置类型')}</small><h4>{page.headline||'未填写页面标题'}</h4></div></header>
            <div className={styles.planField}><small>页面副标题</small><p>{page.subtitle||'未填写'}</p></div>
            <div className={styles.planField}><small>画面要点</small>{page.bullets.length>0?<ul>{page.bullets.map((bullet,bulletIndex)=><li key={bulletIndex}>{bullet}</li>)}</ul>:<p>未填写</p>}</div>
            <div className={`${styles.planField} ${styles.planPrompt}`}><small>画面生成指令</small><p>{page.prompt||'未填写'}</p></div>
          </article>)}</div>
          :<div className={styles.planEmpty}>当前最终稿未记录图片文案规划。</div>}
      </section>
    </div>
  </>;
}
