'use client';

import { useRouter } from 'next/navigation';
import { useEffect } from 'react';

export function TaskProgressRefresh({ active }: { active: boolean }) {
  const router = useRouter();

  useEffect(() => {
    if (!active) return undefined;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') router.refresh();
    };
    const timer = window.setInterval(refreshWhenVisible, 30_000);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [active, router]);

  return active
    ? <span className="progress-refresh subtle" role="status">执行状态每 30 秒自动更新</span>
    : null;
}
