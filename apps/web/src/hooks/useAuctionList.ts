import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api.ts';
import type { AuctionView } from '../room/roomState.ts';

interface ListReply {
  items: AuctionView[];
  nextCursor: string | null;
}

export interface ListFilters {
  q: string;
  status: '' | AuctionView['status'];
  /** Seller dashboard: the signed-in user's own auctions, drafts included (needs a token). */
  mine: boolean;
  token?: string | undefined;
}

export interface AuctionListHandle {
  items: AuctionView[] | null;
  hasMore: boolean;
  loading: boolean;
  loadingMore: boolean;
  error: string | null;
  reload: () => void;
  loadMore: () => void;
}

const PAGE = 12;

function query(f: ListFilters, cursor?: string): string {
  const p = new URLSearchParams({ limit: String(PAGE) });
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  if (f.status !== '') p.set('status', f.status);
  if (f.mine) p.set('mine', 'true');
  if (cursor !== undefined) p.set('cursor', cursor);
  return `/auctions?${p.toString()}`;
}

/**
 * Server-side search, filter and cursor paging. The list is SERVER state: this hook owns a copy
 * of the last answer, never edits it locally, and refetches when the filters change. Each request
 * is numbered and only the newest request's answer is applied, so typing quickly cannot show the
 * results of an older search after a newer one.
 */
export function useAuctionList(filters: ListFilters): AuctionListHandle {
  const [items, setItems] = useState<AuctionView[] | null>(null);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const { q, status, mine, token } = filters;

  const fetchFirst = useCallback((): void => {
    const mineReq = ++latest.current;
    setLoading(true);
    setError(null);
    api<ListReply>('GET', query({ q, status, mine }), { token })
      .then((r) => {
        if (mineReq !== latest.current) return;
        setItems(r.items);
        setCursor(r.nextCursor);
        setLoading(false);
      })
      .catch((e: unknown) => {
        if (mineReq !== latest.current) return;
        setLoading(false);
        setItems((old) => old ?? null);
        setError(
          e instanceof ApiError && e.status !== 0
            ? e.message
            : 'Could not reach the server. Check your connection and try again.',
        );
      });
  }, [q, status, mine, token]);

  useEffect(() => {
    fetchFirst();
    return () => {
      latest.current += 1; // forget in-flight requests when filters change or the page closes
    };
  }, [fetchFirst]);

  const loadMore = useCallback((): void => {
    if (cursor === null) return;
    const mineReq = latest.current;
    setLoadingMore(true);
    api<ListReply>('GET', query({ q, status, mine }, cursor), { token })
      .then((r) => {
        if (mineReq !== latest.current) return;
        setItems((old) => {
          const seen = new Set((old ?? []).map((a) => a.id));
          return [...(old ?? []), ...r.items.filter((a) => !seen.has(a.id))];
        });
        setCursor(r.nextCursor);
      })
      .catch(() => {
        if (mineReq === latest.current) setError('Could not load more. Try again.');
      })
      .finally(() => {
        setLoadingMore(false);
      });
  }, [cursor, q, status, mine, token]);

  return {
    items,
    hasMore: cursor !== null,
    loading,
    loadingMore,
    error,
    reload: fetchFirst,
    loadMore,
  };
}

/** Delays a fast-changing value (a search box) so a request is not sent for every keystroke. */
export function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = window.setTimeout(() => {
      setDebounced(value);
    }, ms);
    return () => {
      window.clearTimeout(id);
    };
  }, [value, ms]);
  return debounced;
}
