import { useEffect, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { Session } from '../session.ts';

interface Me {
  id: string;
  email: string;
  displayName: string;
  createdAt: string;
}

export function AccountPage({
  session,
  onSignOut,
}: {
  session: Session | null;
  onSignOut: () => void;
}) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  const token = session?.token;

  useEffect(() => {
    if (token === undefined) return;
    let cancelled = false;
    setMe(null);
    setError(null);
    api<{ user: Me }>('GET', '/users/me', { token })
      .then((r) => {
        if (!cancelled) setMe(r.user);
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ApiError && e.code === 'UNAUTHENTICATED') {
          onSignOut();
          return;
        }
        setError(
          e instanceof ApiError && e.status !== 0 ? e.message : 'Could not reach the server.',
        );
      });
    return () => {
      cancelled = true;
    };
  }, [token, onSignOut]);

  if (!session) {
    return (
      <section className="card">
        <h1>Account</h1>
        <p>
          <a href="#/login">Sign in</a> to see your account.
        </p>
      </section>
    );
  }
  return (
    <section className="card">
      <h1>Account</h1>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!me && !error && <p aria-live="polite">Loading…</p>}
      {me && (
        <dl className="facts" data-testid="account">
          <div>
            <dt>Display name</dt>
            <dd data-testid="account-name">{me.displayName}</dd>
          </div>
          <div>
            <dt>Email</dt>
            <dd data-testid="account-email">{me.email}</dd>
          </div>
          <div>
            <dt>Member since</dt>
            <dd>{new Date(me.createdAt).toLocaleDateString()}</dd>
          </div>
        </dl>
      )}
      <p className="hint">
        Your display name is public: it appears next to your bids. Your email is never shown to
        other people.
      </p>
      <p>
        <a href="#/sell">Your auctions</a> · <a href="#/notifications">Notifications</a>
      </p>
      <button type="button" onClick={onSignOut} data-testid="account-signout">
        Sign out
      </button>
    </section>
  );
}
