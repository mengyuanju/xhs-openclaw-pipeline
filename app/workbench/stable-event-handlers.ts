'use client';

import { useLayoutEffect, useMemo, useRef } from 'react';

// Stable identities let memoized rows keep their render result. Only event
// handlers read the ref, after React commits the latest parent state.
export function useStableEventHandlers<T extends Record<string, (...args: any[]) => any>>(handlers: T): T {
  const current = useRef(handlers);
  useLayoutEffect(() => { current.current = handlers; });
  return useMemo(() => Object.fromEntries(Object.keys(handlers).map(key => [key,
    (...args: any[]) => current.current[key](...args),
  ])) as T, []);
}
