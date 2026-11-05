import { useEffect, useReducer, useRef } from 'react';
import { io, type Socket } from 'socket.io-client';
import { parseBidAccepted, parseParticipantCount, parseSnapshot } from './parseEvents.ts';
import { initialRoomState, roomReducer, type RoomAction, type RoomState } from './roomState.ts';

export interface RoomHandle {
  state: RoomState;
  /** Feed a server-confirmed result (our own 201 reply) into the same rules as live events. */
  dispatch: (action: RoomAction) => void;
  /** Set if the server refused the connection because the token is no longer valid. */
  authFailed: boolean;
  /** Set if the server refused to let us into this room (for example, an unknown auction). */
  joinError: string | null;
}

/**
 * One socket per (auction, token). The effect is the only place that creates and
 * destroys it, so the subscription is created once and removed on unmount, and a
 * dropped connection cannot leave a second subscription behind: Socket.IO
 * reconnects with the SAME client object (listeners are registered once), the
 * server sees a brand-new connection with no rooms, and we join again on every
 * `connect`.
 */
export function useAuctionRoom(auctionId: string, token: string | undefined): RoomHandle {
  const [state, dispatch] = useReducer(roomReducer, initialRoomState);
  const [flags, setFlags] = useReducer(
    (s: { authFailed: boolean; joinError: string | null }, patch: Partial<typeof s>) => ({
      ...s,
      ...patch,
    }),
    { authFailed: false, joinError: null },
  );
  const socketRef = useRef<Socket | null>(null);
  const resyncInFlight = useRef(false);

  useEffect(() => {
    const socket = io({
      path: '/socket.io',
      transports: ['websocket'],
      ...(token === undefined ? {} : { auth: { token } }),
    });
    socketRef.current = socket;

    const join = (): void => {
      void socket
        .timeout(5000)
        .emitWithAck('auction.join', { auctionId })
        .then(
          (ack: { ok: boolean; error?: { code: string } }) => {
            resyncInFlight.current = false;
            if (ack.ok) setFlags({ joinError: null });
            else setFlags({ joinError: ack.error?.code ?? 'JOIN_FAILED' });
          },
          () => {
            resyncInFlight.current = false;
            setFlags({ joinError: 'JOIN_TIMEOUT' });
          },
        );
    };

    socket.on('connect', () => {
      dispatch({ type: 'connection', status: 'connected' });
      join(); // on EVERY connect, including reconnects: rooms are not restored
    });
    socket.on('disconnect', () => {
      dispatch({ type: 'connection', status: 'disconnected' });
    });
    socket.on('connect_error', (error: Error) => {
      dispatch({ type: 'connection', status: 'disconnected' });
      if (error.message === 'UNAUTHENTICATED') setFlags({ authFailed: true });
    });
    socket.on('auction.snapshot', (payload: unknown) => {
      const snapshot = parseSnapshot(payload);
      if (snapshot) dispatch({ type: 'snapshot', ...snapshot });
    });
    socket.on('bid.accepted', (payload: unknown) => {
      const accepted = parseBidAccepted(payload);
      if (accepted) dispatch({ type: 'bid', accepted });
    });
    socket.on('participant.count', (payload: unknown) => {
      const count = parseParticipantCount(payload);
      if (count !== null) dispatch({ type: 'participants', count });
    });

    return () => {
      // Unmount (or the auction/token changed): leave, close, forget.
      socket.off();
      if (socket.connected) socket.emit('auction.leave', { auctionId });
      socket.disconnect();
      socketRef.current = null;
    };
  }, [auctionId, token]);

  // A gap in the sequence means we missed or mis-ordered an event: join again, which
  // makes the server send a fresh authoritative snapshot (joining is idempotent).
  useEffect(() => {
    const socket = socketRef.current;
    if (state.resyncRequests === 0 || !socket?.connected || resyncInFlight.current) return;
    resyncInFlight.current = true;
    void socket
      .timeout(5000)
      .emitWithAck('auction.join', { auctionId })
      .then(
        () => {
          resyncInFlight.current = false;
        },
        () => {
          resyncInFlight.current = false;
        },
      );
  }, [state.resyncRequests, auctionId]);

  return { state, dispatch, authFailed: flags.authFailed, joinError: flags.joinError };
}
