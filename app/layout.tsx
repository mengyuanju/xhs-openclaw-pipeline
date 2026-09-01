import type { Metadata } from 'next';

import { AppFrame } from './components/app-frame';
import { readServerSession } from './server-session';
import './globals.css';

export const metadata: Metadata = {
  title: '内容工场 · OpenClaw',
  description: '小红书内容批量生成与审核后台',
};

export default async function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const session = await readServerSession();
  return (
    <html lang="zh-CN">
      <body>
        <AppFrame session={session}>{children}</AppFrame>
      </body>
    </html>
  );
}
