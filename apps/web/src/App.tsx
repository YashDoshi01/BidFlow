import { useCallback, useEffect, useRef, useState } from 'react';
import { api, syncServerClock } from './api.ts';
import { IconBell, IconGrid, IconLogout, IconTag, LogoMark } from './components/Icons.tsx';
import { initial } from './components/ui.tsx';
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

  const current = (name: Route['name']): 'page' | undefined =>
    route.name === name ? 'page' : undefined;

  return (
    <>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a className="brand" href="#/" aria-label="BidFlow, home">
            <LogoMark />
            <span className="brand-name">BidFlow</span>
          </a>
          <span className="demo-pill" title="Bids are simulated. No real money changes hands.">
            Demo
          </span>
          <nav aria-label="Main" className="main-nav">
            <a href="#/" className="nav-link" aria-current={current('list')}>
              <IconGrid />
              <span className="nav-text">Auctions</span>
            </a>
            {session && (
              <>
                <a href="#/sell" className="nav-link" aria-current={current('sell')}>
                  <IconTag />
                  <span className="nav-text">Sell</span>
                </a>
                <a
                  href="#/notifications"
                  className="nav-link nav-bell"
                  aria-current={current('notifications')}
                  aria-label={
                    notifications.unreadCount > 0
                      ? `Notifications, ${String(notifications.unreadCount)} unread`
                      : 'Notifications'
                  }
                  data-testid="bell"
                >
                  <IconBell />
                  <span className="nav-text">Notifications</span>
                  {notifications.unreadCount > 0 && (
                    <span className="count" data-testid="unread-count">
                      {notifications.unreadCount > 99 ? '99+' : notifications.unreadCount}
                    </span>
                  )}
                </a>
                <a
                  href="#/account"
                  className="user-chip"
                  data-initial={initial(session.displayName)}
                  data-testid="whoami"
                  aria-current={current('account')}
                >
                  {session.displayName}
                </a>
                <button
                  type="button"
                  className="icon-button"
                  onClick={signOut}
                  aria-label="Sign out"
                  title="Sign out"
                >
                  <IconLogout />
                </button>
              </>
            )}
            {!session && (
              <a href="#/login" className="button primary small">
                Sign in
              </a>
            )}
          </nav>
        </div>
      </header>
      {!online && (
        <p role="status" className="offline-banner" data-testid="offline">
          You are offline. What you see may be out of date, and bids cannot be sent until the
          connection is back.
        </p>
      )}
      <main id="main" ref={mainRef} tabIndex={-1} className={`page page-${route.name}`}>
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
      <footer className="site-footer">
        <div className="footer-inner">
          <div className="footer-brand">
            <LogoMark />
            <div>
              <strong>BidFlow</strong>
              <p>Real-time auctions. A demo: bids are simulated and no real money changes hands.</p>
            </div>
          </div>
          <nav aria-label="Footer" className="footer-links">
            <a href="#/">Browse</a>
            <a href="#/sell">Sell</a>
            <a href="#/account">Account</a>
          </nav>
        </div>
      </footer>
    </>
  );
}
