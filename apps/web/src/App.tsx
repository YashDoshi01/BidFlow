import { useCallback, useEffect, useRef, useState } from 'react';
import { api, syncServerClock } from './api.ts';
import { useNotifications } from './hooks/useNotifications.ts';
import { useOnline } from './hooks/useOnline.ts';
import { AccountPage } from './pages/AccountPage.tsx';
import { AuctionPage } from './pages/AuctionPage.tsx';
import { AuctionsPage } from './pages/AuctionsPage.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { NotificationsPage } from './pages/NotificationsPage.tsx';
import { SellerPage } from './pages/SellerPage.tsx';
import { clearSession, loadSession, saveSession, type Session } from './session.ts';

// A tiny hash router. Enough for this app without another dependency.
type Route =
  | { name: 'list' }
  | { name: 'login' }
  | { name: 'sell' }
  | { name: 'notifications' }
  | { name: 'account' }
  | { name: 'auction'; id: string };

export function parseRoute(hash: string): Route {
  const auction = /^#\/auction\/([0-9a-f-]{36})$/.exec(hash);
  if (auction?.[1]) return { name: 'auction', id: auction[1] };
  switch (hash) {
    case '#/login':
      return { name: 'login' };
    case '#/sell':
      return { name: 'sell' };
    case '#/notifications':
      return { name: 'notifications' };
    case '#/account':
      return { name: 'account' };
    default:
      return { name: 'list' };
  }
}

const TITLES: Record<Route['name'], string> = {
  list: 'Auctions',
  login: 'Sign in',
  sell: 'Your auctions',
  notifications: 'Notifications',
  account: 'Account',
  auction: 'Auction',
};

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [session, setSession] = useState<Session | null>(() => loadSession());
  const online = useOnline();
  const notifications = useNotifications(session?.token);
  const mainRef = useRef<HTMLElement>(null);
  const firstRender = useRef(true);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    syncServerClock();
    window.addEventListener('online', syncServerClock);
    return () => {
      window.removeEventListener('online', syncServerClock);
    };
  }, []);

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  // A hash change is not a page load, so a screen reader would hear nothing. Move focus to the
  // content and set the title on every navigation (not on the very first render).
  useEffect(() => {
    document.title = `${TITLES[route.name]} · BidFlow`;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    mainRef.current?.focus();
  }, [route]);

  const signIn = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
    window.location.hash = '#/';
  }, []);

  const signOut = useCallback(() => {
    // Revoke the token on the server too; forgetting it in the browser is not enough. The local
    // sign-out happens even if the request fails (offline, or the token is already invalid).
    const current = sessionRef.current;
    if (current) void api('POST', '/auth/logout', { token: current.token }).catch(() => undefined);
    clearSession();
    setSession(null);
  }, []);

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <a className="brand" href="#/">
          BidFlow
        </a>
        <span className="demo-note">Demo: simulated bids, no real money</span>
        <nav aria-label="Main">
          <a href="#/" aria-current={route.name === 'list' ? 'page' : undefined}>
            Auctions
          </a>
          {session && (
            <>
              <a href="#/sell" aria-current={route.name === 'sell' ? 'page' : undefined}>
                Sell
              </a>
              <a
                href="#/notifications"
                aria-current={route.name === 'notifications' ? 'page' : undefined}
                aria-label={
                  notifications.unreadCount > 0
                    ? `Notifications, ${String(notifications.unreadCount)} unread`
                    : 'Notifications'
                }
                data-testid="bell"
              >
                Notifications
                {notifications.unreadCount > 0 && (
                  <span className="count" data-testid="unread-count">
                    {notifications.unreadCount > 99 ? '99+' : notifications.unreadCount}
                  </span>
                )}
              </a>
              <a
                href="#/account"
                data-testid="whoami"
                aria-current={route.name === 'account' ? 'page' : undefined}
              >
                {session.displayName}
              </a>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          )}
          {!session && <a href="#/login">Sign in</a>}
        </nav>
      </header>
      {!online && (
        <p role="status" className="offline-banner" data-testid="offline">
          You are offline. What you see may be out of date, and bids cannot be sent until the
          connection is back.
        </p>
      )}
      <main id="main" ref={mainRef} tabIndex={-1}>
        {route.name === 'login' && <AuthPage onSignedIn={signIn} />}
        {route.name === 'list' && <AuctionsPage session={session} />}
        {route.name === 'sell' && <SellerPage session={session} onSignOut={signOut} />}
        {route.name === 'notifications' && (
          <NotificationsPage session={session} notifications={notifications} />
        )}
        {route.name === 'account' && <AccountPage session={session} onSignOut={signOut} />}
        {route.name === 'auction' && (
          <AuctionPage key={route.id} auctionId={route.id} session={session} onSignOut={signOut} />
        )}
      </main>
    </>
  );
}
