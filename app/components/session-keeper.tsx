'use client';

import { useEffect } from 'react';
import { createSessionActivity } from '../../src/admin/session-activity.mjs';
import { SESSION_CHECK_SECONDS } from '../../src/admin/session-policy.mjs';
import {
  invalidateBrowserSession, redirectToSessionLogin, renewBrowserSession,
  subscribeSession, type SessionMetadata,
} from './session-client';

const ACTIVITY_EVENTS = ['pointerdown', 'keydown', 'input', 'wheel', 'touchmove'];

export function SessionKeeper({ session }: { session: SessionMetadata }) {
  useEffect(() => {
    const activity = createSessionActivity({
      initialSession: session,
      renew: renewBrowserSession,
      isVisible: () => document.visibilityState === 'visible',
      onUnauthorized: invalidateBrowserSession,
      onChanged: () => window.location.reload(),
    });
    const unsubscribe = subscribeSession(session, event => {
      if (event.type === 'updated') activity.update(event.session);
      else if (event.sessionId === session.sessionId) {
        activity.stop();
        if (event.remote) redirectToSessionLogin();
      }
    });
    const interact = (event: Event) => { void activity.recordActivity(event.isTrusted); };
    const check = () => { void activity.check(); };
    ACTIVITY_EVENTS.forEach(name => document.addEventListener(name, interact, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    const timer = window.setInterval(check, SESSION_CHECK_SECONDS * 1000);
    return () => {
      activity.stop(); unsubscribe(); window.clearInterval(timer);
      ACTIVITY_EVENTS.forEach(name => document.removeEventListener(name, interact, true));
      document.removeEventListener('visibilitychange', check);
      window.removeEventListener('focus', check);
    };
  }, [session.sessionId]);
  return null;
}
