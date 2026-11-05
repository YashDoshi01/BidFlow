import { useState, type SyntheticEvent } from 'react';
import { ApiError, api } from '../api.ts';
import type { Session } from '../session.ts';

interface LoginResponse {
  token: string;
  user: { id: string; displayName: string };
}

export function AuthPage({ onSignedIn }: { onSignedIn: (session: Session) => void }) {
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: SyntheticEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (mode === 'register') {
        await api('POST', '/auth/register', { body: { email, password, displayName } });
      }
      const login = await api<LoginResponse>('POST', '/auth/login', { body: { email, password } });
      onSignedIn({
        token: login.token,
        userId: login.user.id,
        displayName: login.user.displayName,
      });
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card narrow">
      <h1>{mode === 'login' ? 'Sign in' : 'Create an account'}</h1>
      <form
        onSubmit={(e) => {
          void submit(e);
        }}
      >
        <label>
          Email
          <input
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => {
              setEmail(e.target.value);
            }}
          />
        </label>
        {mode === 'register' && (
          <label>
            Display name <small>(shown next to your bids; it is public)</small>
            <input
              type="text"
              maxLength={50}
              required
              value={displayName}
              onChange={(e) => {
                setDisplayName(e.target.value);
              }}
            />
          </label>
        )}
        <label>
          Password <small>(at least 10 characters)</small>
          <input
            type="password"
            autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            minLength={10}
            required
            value={password}
            onChange={(e) => {
              setPassword(e.target.value);
            }}
          />
        </label>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {mode === 'login' ? 'Sign in' : 'Register and sign in'}
        </button>
      </form>
      <p>
        <button
          type="button"
          className="link"
          onClick={() => {
            setMode(mode === 'login' ? 'register' : 'login');
            setError(null);
          }}
        >
          {mode === 'login' ? 'Need an account? Register' : 'Have an account? Sign in'}
        </button>
      </p>
    </section>
  );
}
