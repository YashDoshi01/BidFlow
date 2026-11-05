import { useCallback, useEffect, useState } from 'react';
import { AuctionPage } from './pages/AuctionPage.tsx';
import { AuctionsPage } from './pages/AuctionsPage.tsx';
import { AuthPage } from './pages/AuthPage.tsx';
import { clearSession, loadSession, saveSession, type Session } from './session.ts';

// A tiny hash router: `#/`, `#/login`, `#/auction/<id>`. Enough for this phase
// without another dependency; the full app (Phase 7) can swap it out.
type Route = { name: 'list' } | { name: 'login' } | { name: 'auction'; id: string };

function parseRoute(hash: string): Route {
  const auction = /^#\/auction\/([0-9a-f-]{36})$/.exec(hash);
  if (auction?.[1]) return { name: 'auction', id: auction[1] };
  if (hash === '#/login') return { name: 'login' };
  return { name: 'list' };
}

export function App() {
  const [route, setRoute] = useState<Route>(() => parseRoute(window.location.hash));
  const [session, setSession] = useState<Session | null>(() => loadSession());

  useEffect(() => {
    const onHashChange = (): void => {
      setRoute(parseRoute(window.location.hash));
    };
    window.addEventListener('hashchange', onHashChange);
    return () => {
      window.removeEventListener('hashchange', onHashChange);
    };
  }, []);

  const signIn = useCallback((next: Session) => {
    saveSession(next);
    setSession(next);
    window.location.hash = '#/';
  }, []);

  const signOut = useCallback(() => {
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
        <nav aria-label="Account">
          {session ? (
            <>
              <span data-testid="whoami">{session.displayName}</span>
              <button type="button" className="link" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <a href="#/login">Sign in</a>
          )}
        </nav>
      </header>
      <main id="main">
        {route.name === 'login' && <AuthPage onSignedIn={signIn} />}
        {route.name === 'list' && <AuctionsPage session={session} />}
        {route.name === 'auction' && (
          <AuctionPage key={route.id} auctionId={route.id} session={session} onSignOut={signOut} />
        )}
      </main>
    </>
  );
}
