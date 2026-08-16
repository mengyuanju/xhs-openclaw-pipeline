import type { Metadata } from 'next';

import { AppFrame } from './components/app-frame';
import './globals.css';

export const metadata: Metadata = {
  title: '内容工场 · OpenClaw',
  description: '小红书内容批量生成与审核后台',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        <AppFrame>{children}</AppFrame>
      </body>
    </html>
  );
}
