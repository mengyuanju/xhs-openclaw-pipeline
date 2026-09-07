import { Disclosure, DisclosureTrigger, DisclosureContent } from '@/components/ui/disclosure';
import { summarizeModelRequest } from './model-request-presentation.mjs';
import styles from './model-request-details.module.css';

type Section = { label: string; content?: string; value?: unknown };
type Version = { kind: string; versionId?: number | string | null; version?: number | null;
  source?: string; templateSha256?: string; renderedSha256?: string };
const print = (value: unknown) => typeof value === 'string' ? value : JSON.stringify(value, null, 2);
const SOURCES: Record<string, string> = { BUNDLED_DEFAULT: '程序内置模板', EXECUTION_SNAPSHOT: '本次执行快照',
  UNVERSIONED: '未关联发布版本', AMBIGUOUS: '多个模板内容相同，无法确认具体版本', CENTER: '中心发布版本', LOCAL: '本地发布版本' };

function Sections({ title, items, empty }: { title: string; items: Section[]; empty: string }) {
  return <section className={styles.section}>
    <h4>{title}</h4>
    {items.length ? items.map((item, index) => <Disclosure key={index} className={styles.part}>
      <DisclosureTrigger>{item.label}</DisclosureTrigger><DisclosureContent><pre tabIndex={0}>{item.content ?? print(item.value)}</pre>
    </DisclosureContent></Disclosure>) : <p className="model-call-note">{empty}</p>}
  </section>;
}

export function ModelRequestDetails({ detail }: { detail: { prompt?: string; request?: string; truncated: boolean } }) {
  const view = summarizeModelRequest(detail);
  const versions = view.versions as Version[];
  return <div className={styles.root} aria-label="实际模型请求明细">
    <div className={styles.intro}>
      <strong>本次实际请求</strong><span className={styles.badge}>仅管理员 · 只读记录</span>
      <p>按实际发送内容展示。业务提示词可在版本管理中修改；JSON 格式、字段限制和工具协议仍由程序校验。</p>
    </div>
    <section className={styles.section}>
      <h4>业务提示词版本</h4>
      {versions.length ? <div className={styles.versions}>{versions.map((version, index) => <Disclosure className={styles.part} key={index}>
        <DisclosureTrigger><strong>{version.kind}</strong> · {version.version != null ? `版本 ${version.version}` : '未关联发布版本'}</DisclosureTrigger><DisclosureContent>
        <dl className={styles.metadata}>
          <dt>来源</dt><dd>{version.source && Object.hasOwn(SOURCES, version.source) ? SOURCES[version.source] : version.source || '未记录'}</dd>
          <dt>版本编号</dt><dd>{version.versionId ?? '未记录'}</dd>
          <dt>模板 SHA-256</dt><dd>{version.templateSha256 || '未记录'}</dd>
          <dt>实际渲染 SHA-256</dt><dd>{version.renderedSha256 || '未记录'}</dd>
        </dl>
      </DisclosureContent></Disclosure>)}</div> : <p className="model-call-note">此记录未关联可核实的提示词版本；不会用当前版本代替历史版本。</p>}
      {view.runtime && <Disclosure className={styles.part}><DisclosureTrigger>本次冻结的提示词配置</DisclosureTrigger><DisclosureContent><pre tabIndex={0}>{print(view.runtime)}</pre></DisclosureContent></Disclosure>}
    </section>
    <Sections title="业务提示词内容" items={view.business} empty="未单独标注业务规则，请查看完整提示词原文。" />
    <Sections title="程序追加内容" items={view.program} empty="此记录未单独保存追加指令。" />
    <Sections title="任务数据" items={view.taskData} empty="未单独标注任务字段，请查看请求原文。" />
    <Sections title="参考案例与素材" items={view.references} empty="此请求未单独标注参考案例或附件；不会展示未发送的案例库内容。" />
    <Sections title="技术约束（只读）" items={view.constraints} empty="此记录未单独保存结构或工具约束，请查看请求原文。" />
    <Disclosure className={styles.part}>
      <DisclosureTrigger>{view.complete ? '完整脱敏请求' : '脱敏请求记录（完整性未确认）'}</DisclosureTrigger><DisclosureContent>
      <p className="model-call-note">{view.scope === 'HTTP_BODY' ? '记录本项目发送的 HTTP 请求体。' : view.scope === 'CLI_INPUT'
        ? '记录本项目交给模型客户端的完整调用输入；客户端内部未返回的子请求不可见。' : '旧记录或未知记录格式，可能缺少程序追加内容。'}密钥和图片二进制不展示。</p>
      {!view.complete && <p className="notice warning">该记录缺失、已截断或属于旧格式，不能当作完整请求。</p>}
      <pre tabIndex={0}>{view.payload ? print(view.payload) : view.rawRequest || '未保存请求内容。'}</pre>
    </DisclosureContent></Disclosure>
  </div>;
}
