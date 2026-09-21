import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: '海默信息小红书编辑器',
  description: '将原图和文案整理成可分享的在线预览链接。',
  icons: {
    icon: [{ url: '/favicon.png', type: 'image/png', sizes: '512x512' }],
    shortcut: '/favicon.png',
    apple: [{ url: '/favicon.png', type: 'image/png', sizes: '512x512' }],
  },
  robots: {
    index: false,
    follow: false,
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
