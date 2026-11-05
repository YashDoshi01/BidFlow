/* eslint-disable @typescript-eslint/no-explicit-any -- test helper: payloads are validated by zod in the tests */
import { io as connectIo, type Socket } from 'socket.io-client';

export interface Received {
  name: string;
  payload: any;
}

export interface Ack {
  ok: boolean;
  error?: { code: string; message: string };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** A real Socket.IO client that records every event it receives. */
export class TestSocket {
  readonly socket: Socket;
  private readonly inbox: Received[] = [];
  private readonly listeners = new Set<() => void>();
  disconnectReason: string | undefined;

  private constructor(socket: Socket) {
    this.socket = socket;
    socket.onAny((name: string, payload: unknown) => {
      this.inbox.push({ name, payload });
      this.listeners.forEach((l) => {
        l();
      });
    });
    socket.on('disconnect', (reason: string) => {
      this.disconnectReason = reason;
      this.listeners.forEach((l) => {
        l();
      });
    });
  }

  /** Resolves when connected; rejects with the server's handshake error message. */
  static connect(
    base: string,
    token?: string,
    options: { reconnection?: boolean } = {},
  ): Promise<TestSocket> {
    return new Promise((resolve, reject) => {
      const socket = connectIo(base, {
        transports: ['websocket'],
        forceNew: true,
        reconnection: options.reconnection ?? false,
        reconnectionDelay: 50,
        reconnectionDelayMax: 100,
        ...(token === undefined ? {} : { auth: { token } }),
      });
      const wrapped = new TestSocket(socket);
      socket.once('connect', () => {
        resolve(wrapped);
      });
      socket.once('connect_error', (error: Error) => {
        socket.close();
        reject(error);
      });
    });
  }

  async join(auctionId: string): Promise<Ack> {
    return this.ack('auction.join', { auctionId });
  }

  async leave(auctionId: string): Promise<Ack> {
    return this.ack('auction.leave', { auctionId });
  }

  async ack(event: string, payload: unknown): Promise<Ack> {
    return (await this.socket.timeout(3000).emitWithAck(event, payload)) as Ack;
  }

  /** Consumes and returns the first received event with this name (and predicate). */
  async next(
    name: string,
    predicate: (payload: any) => boolean = () => true,
    timeoutMs = 3000,
  ): Promise<any> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const index = this.inbox.findIndex((e) => e.name === name && predicate(e.payload));
      if (index >= 0) return (this.inbox.splice(index, 1)[0] as Received).payload;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`timed out waiting for "${name}"`);
      await new Promise<void>((resolve) => {
        const done = (): void => {
          this.listeners.delete(done);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(done, remaining);
        this.listeners.add(done);
      });
    }
  }

  /** Events of this name received and not yet consumed. */
  pending(name: string): Received[] {
    return this.inbox.filter((e) => e.name === name);
  }

  /** Waits, then reports everything that arrived and was not consumed. */
  async quiet(ms: number, name?: string): Promise<Received[]> {
    await sleep(ms);
    return name === undefined ? [...this.inbox] : this.pending(name);
  }

  async disconnectAndWait(): Promise<void> {
    if (!this.socket.connected) return;
    const closed = new Promise<void>((resolve) =>
      this.socket.once('disconnect', () => {
        resolve();
      }),
    );
    this.socket.disconnect();
    await closed;
  }

  close(): void {
    this.socket.close();
  }
}
