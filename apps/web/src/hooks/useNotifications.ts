import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import { parseNotification, type NotificationView } from '../lib/notificationText.ts';

/** Other components say "your notifications may have changed" (for example after being outbid live). */
export const NOTIFICATIONS_STALE_EVENT = 'bidflow:notifications-stale';
export function markNotificationsStale(): void {
  window.dispatchEvent(new Event(NOTIFICATIONS_STALE_EVENT));
}

const POLL_MS = 20_000;
const PAGE = 20;

interface Reply {
  items: unknown[];
  nextCursor: string | null;
  unreadCount: number;
}

export interface NotificationsHandle {
  items: NotificationView[];
  unreadCount: number;
  hasMore: boolean;
  /** 'loading' only before the first answer; later failures keep the old data and set 'stale'. */
  status: 'idle' | 'loading' | 'ready' | 'stale';
  error: string | null;
  refresh: () => void;
  loadMore: () => void;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
}

/**
 * Notifications are rows on the server, read over REST. NOTHING is pushed to the browser, so
 * "new notifications" means "we asked again": on an interval while the tab is visible, when the
 * tab becomes visible, when the network comes back, and when another component reports a live
 * event that creates one. Every request carries a number; an answer that is not the newest
 * request's answer is dropped, so a slow old reply can never overwrite a newer list.
 */
export function useNotifications(token: string | undefined): NotificationsHandle {
  const [items, setItems] = useState<NotificationView[]>([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<NotificationsHandle['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);

  const fetchFirstPage = useCallback(async (): Promise<void> => {
    if (token === undefined) return;
    const mine = ++latest.current;
    try {
      const r = await api<Reply>('GET', `/notifications?limit=${String(PAGE)}`, { token });
      if (mine !== latest.current) return;
      setItems(r.items.map(parseNotification).filter((n): n is NotificationView => n !== null));
      setUnreadCount(r.unreadCount);
      setNextCursor(r.nextCursor);
      setStatus('ready');
      setError(null);
    } catch (e) {
      if (mine !== latest.current) return;
      setStatus((s) => (s === 'ready' || s === 'stale' ? 'stale' : 'idle'));
      setError(e instanceof ApiError && e.status !== 0 ? e.message : 'Could not reach the server');
    }
  }, [token]);

  useEffect(() => {
    // A different (or no) user: forget everything that belonged to the previous one.
    latest.current += 1;
    setItems([]);
    setUnreadCount(0);
    setNextCursor(null);
    setError(null);
    if (token === undefined) {
      setStatus('idle');
      return;
    }
    setStatus('loading');
    void fetchFirstPage();
    const tick = (): void => {
      if (document.visibilityState === 'visible') void fetchFirstPage();
    };
    const id = window.setInterval(tick, POLL_MS);
    const onStale = (): void => {
      void fetchFirstPage();
    };
    window.addEventListener('online', onStale);
    window.addEventListener(NOTIFICATIONS_STALE_EVENT, onStale);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('online', onStale);
      window.removeEventListener(NOTIFICATIONS_STALE_EVENT, onStale);
      document.removeEventListener('visibilitychange', tick);
      latest.current += 1; // a reply that arrives after unmount is ignored
    };
  }, [token, fetchFirstPage]);

  const loadMore = useCallback((): void => {
    if (token === undefined || nextCursor === null) return;
    const mine = latest.current;
    void api<Reply>('GET', `/notifications?limit=${String(PAGE)}&cursor=${nextCursor}`, { token })
      .then((r) => {
        if (mine !== latest.current) return;
        const more = r.items
          .map(parseNotification)
          .filter((n): n is NotificationView => n !== null);
        setItems((old) => {
          const seen = new Set(old.map((n) => n.id));
          return [...old, ...more.filter((n) => !seen.has(n.id))];
        });
        setNextCursor(r.nextCursor);
      })
      .catch(() => {
        setError('Could not load older notifications');
      });
  }, [token, nextCursor]);

  const markRead = useCallback(
    async (id: string): Promise<void> => {
      if (token === undefined) return;
      try {
        await api('POST', `/notifications/${id}/read`, { token });
        await fetchFirstPage();
      } catch {
        setError('Could not mark it as read');
      }
    },
    [token, fetchFirstPage],
  );

  const markAllRead = useCallback(async (): Promise<void> => {
    if (token === undefined) return;
    try {
      await api('POST', '/notifications/read-all', { token });
      await fetchFirstPage();
    } catch {
      setError('Could not mark all as read');
    }
  }, [token, fetchFirstPage]);

  // Stable identity: components may list it as an effect dependency.
  const refresh = useCallback((): void => {
    void fetchFirstPage();
  }, [fetchFirstPage]);

  return {
    items,
    unreadCount,
    hasMore: nextCursor !== null,
    status,
    error,
    refresh,
    loadMore,
    markRead,
    markAllRead,
  };
}
