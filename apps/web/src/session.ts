// The login session lives in sessionStorage: it survives a reload but not a closed
// tab. Trade-off (documented in docs/SECURITY notes of ADR-027): any script running
// on the page (XSS) could read it. There is no HttpOnly cookie because the same
// bearer token is used for REST and WebSocket (ADR-009).

export interface Session {
  token: string;
  userId: string;
  displayName: string;
}

const KEY = 'bidflow.session';

export function loadSession(): Session | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<Session>;
    if (
      typeof parsed.token === 'string' &&
      typeof parsed.userId === 'string' &&
      typeof parsed.displayName === 'string'
    ) {
      return { token: parsed.token, userId: parsed.userId, displayName: parsed.displayName };
    }
  } catch {
    // storage unavailable or corrupted: behave as logged out
  }
  return null;
}

export function saveSession(session: Session): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(session));
  } catch {
    // private mode: the session then lasts until the page is reloaded
  }
}

export function clearSession(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // nothing to clear
  }
}
