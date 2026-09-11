import type { Metadata } from 'next';

import { LoginForm } from './login-form';

export const dynamic = 'force-dynamic';
export const metadata: Metadata = {
  title: '登录 | 海默内容工场',
};

function safeReturnPath(value: string | string[] | undefined) {
  return typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')
    && value !== '/' && value !== '/workbench'
    ? value
    : '/workbench/personal';
}

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <div className="login-page">
      <section className="login-story" aria-label="海默内容工场说明">
        <span className="login-brand">HAIMO CONTENT STUDIO</span>
        <div>
          <p className="eyebrow login-eyebrow">海默内容生产工作台</p>
          <h1>从选题到定稿，<br />让每一步都有据可查。</h1>
          <p>Excel 批量入队、提示词版本、图文生成与人工审核，集中在一套局域网内容工作台中。</p>
        </div>
        <p className="login-footnote">仅限可信私有网络 · 不包含自动发布</p>
      </section>
      <section className="login-panel" aria-labelledby="login-title">
        <div className="login-card">
          <span className="login-kicker">TEAM ACCESS</span>
          <h2 id="login-title">登录海默内容工场</h2>
          <p className="subtle">管理员和质检人员使用各自账号进入对应工作区。</p>
          <LoginForm
            nextPath={safeReturnPath(params.next)}
            passwordChanged={params.passwordChanged === '1'}
          />
        </div>
      </section>
    </div>
  );
}
