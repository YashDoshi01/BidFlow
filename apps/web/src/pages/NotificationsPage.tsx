import { useEffect } from 'react';
import type { NotificationsHandle } from '../hooks/useNotifications.ts';
import { describeNotification } from '../lib/notificationText.ts';
import type { Session } from '../session.ts';

export function NotificationsPage({
  session,
  notifications: n,
}: {
  session: Session | null;
  notifications: NotificationsHandle;
}) {
  // Opening the page asks again: the list in memory may be up to 20 seconds old (found by the e2e test:
  // the seller opened it right after the auction ended and saw nothing).
  const refresh = n.refresh;
  const signedIn = session !== null;
  useEffect(() => {
    if (signedIn) refresh();
  }, [signedIn, refresh]);

  if (!session) {
    return (
      <section className="card">
        <h1>Notifications</h1>
        <p>
          <a href="#/login">Sign in</a> to see your notifications.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <div className="title-row">
        <h1>Notifications</h1>
        <div className="row-actions">
          <button type="button" onClick={n.refresh}>
            Refresh
          </button>
          <button
            type="button"
            onClick={() => {
              void n.markAllRead();
            }}
            disabled={n.unreadCount === 0}
            data-testid="read-all"
          >
            Mark all as read
          </button>
        </div>
      </div>
      <p className="hint">
        These are checked every 20 seconds while this tab is open; nothing is pushed to you.
      </p>
      {n.status === 'stale' && (
        <p role="status" className="warn-box" data-testid="notifications-stale">
          Could not refresh just now. Showing what was loaded earlier.
        </p>
      )}
      {n.error && n.status !== 'stale' && (
        <p role="alert" className="error">
          {n.error}
        </p>
      )}
      {n.status === 'loading' && <p aria-live="polite">Loading notifications…</p>}
      {n.status === 'ready' && n.items.length === 0 && (
        <p data-testid="notifications-empty">
          Nothing yet. You will be told here when you are outbid, when an auction you bid on is
          about to end, and when it ends.
        </p>
      )}
      <ul className="notifications" data-testid="notifications-list">
        {n.items.map((item) => {
          const text = describeNotification(item);
          const unread = item.readAt === null;
          return (
            <li key={item.id} className={unread ? 'unread' : ''} data-testid="notification">
              <a
                href={text.href}
                onClick={() => {
                  if (unread) void n.markRead(item.id);
                }}
              >
                <strong>{text.title}</strong>
              </a>
              {unread && <span className="dot">unread</span>}
              <p>{text.body}</p>
              <time dateTime={item.createdAt}>{new Date(item.createdAt).toLocaleString()}</time>
              {unread && (
                <button
                  type="button"
                  className="link"
                  onClick={() => {
                    void n.markRead(item.id);
                  }}
                >
                  Mark as read
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {n.hasMore && (
        <button type="button" onClick={n.loadMore}>
          Show older
        </button>
      )}
    </section>
  );
}
