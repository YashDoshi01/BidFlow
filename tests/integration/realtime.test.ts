import assert from 'node:assert/strict';
import { after, afterEach, before, describe, it } from 'node:test';
import {
  auctionRoom,
  auctionSnapshotEventSchema,
  bidAcceptedEventSchema,
  participantCountEventSchema,
} from '../../apps/api/src/events/events.ts';
import { createAuctionService } from '../../apps/api/src/modules/auctions/index.ts';
import { createBidService } from '../../apps/api/src/modules/bids/index.ts';
import { createLogger } from '../../apps/api/src/logging/logger.ts';
import {
  auctionBody,
  liveAuction,
  makeClient,
  newKey,
  newUser,
  placeBid,
  resetData,
  sleep,
  startApp,
  type Api,
  type TestApp,
} from './helpers.ts';
import { TestSocket } from './realtime-helpers.ts';

interface User {
  token: string;
  id: string;
}

describe('realtime auction rooms (real sockets, real PostgreSQL)', () => {
  let app: TestApp;
  let api: Api;
  let seller: User;
  let buyers: User[];
  const open: TestSocket[] = [];

  before(async () => {
    app = await startApp({ maxRoomsPerSocket: 3 });
    api = makeClient(app.base);
    await resetData(app.db);
    seller = await newUser(api, 'seller');
    buyers = [];
    for (let i = 0; i < 5; i += 1) buyers.push(await newUser(api, `buyer${String(i)}`));
  });
  afterEach(() => {
    open.splice(0).forEach((s) => {
      s.close();
    });
  });
  after(async () => {
    await app.close();
  });

  const buyer = (i = 0): User => buyers[i] as User;
  const connect = async (
    token?: string,
    options?: { reconnection?: boolean },
  ): Promise<TestSocket> => {
    const s = await TestSocket.connect(app.base, token, options);
    open.push(s);
    return s;
  };
  const roomSize = (auctionId: string): number =>
    app.io.sockets.adapter.rooms.get(auctionRoom(auctionId))?.size ?? 0;

  describe('connecting', () => {
    it('accepts an anonymous viewer and a valid token; rejects invalid, malformed and revoked tokens', async () => {
      await connect();
      await connect(buyer().token);
      for (const bad of [
        'x'.repeat(43),
        'short',
        'has spaces and !! symbols 123456',
        'a'.repeat(200),
      ]) {
        await assert.rejects(connect(bad), /UNAUTHENTICATED/, bad.slice(0, 12));
      }
      const u = await newUser(api, 'revoked');
      await api('POST', '/auth/logout', { token: u.token });
      await assert.rejects(connect(u.token), /UNAUTHENTICATED/);
    });

    it('refuses the HTTP long-polling transport (WebSocket only)', async () => {
      const res = await fetch(`${app.base}/socket.io/?EIO=4&transport=polling`);
      assert.ok(res.status >= 400, `polling answered ${String(res.status)}`);
    });
  });

  describe('joining', () => {
    it('joins a public auction, receives a valid snapshot, and is in the server-side room', async () => {
      const id = await liveAuction(api, seller.token);
      await placeBid(api, buyer().token, id, '10.00');
      await placeBid(api, buyer(1).token, id, '12.00');
      const s = await connect();
      const ack = await s.join(id);
      assert.deepEqual(ack, { ok: true });
      const snap = auctionSnapshotEventSchema.parse(await s.next('auction.snapshot'));
      assert.equal(snap.auctionId, id);
      assert.equal(snap.sequence, 2);
      assert.equal(snap.data.auction.currentPrice, '12.00');
      assert.equal(snap.data.auction.bidSequence, '2');
      assert.deepEqual(
        snap.data.recentBids.map((b) => b.bidSequence),
        ['2', '1'], // newest first
      );
      assert.equal(roomSize(id), 1);
    });

    it('a draft is invisible: anonymous and other users get NOT_FOUND, the seller may join', async () => {
      const created = await api('POST', '/auctions', { token: seller.token, body: auctionBody() });
      const id = created.body.auction.id as string;
      const anon = await connect();
      assert.equal((await anon.join(id)).error?.code, 'NOT_FOUND');
      const other = await connect(buyer().token);
      assert.equal((await other.join(id)).error?.code, 'NOT_FOUND');
      const owner = await connect(seller.token);
      assert.deepEqual(await owner.join(id), { ok: true });
      assert.equal(roomSize(id), 1); // only the owner
      assert.equal(
        (await anon.join('00000000-0000-4000-8000-000000000000')).error?.code,
        'NOT_FOUND',
      );
    });

    it('invalid payloads get a VALIDATION_FAILED ack and never crash the server', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      const bad: unknown[] = [
        undefined,
        null,
        'a string',
        42,
        [],
        {},
        { auctionId: 'nope' },
        { auctionId: id, extra: 1 },
        { auctionId: { $ne: null } },
        { auctionId: id.toUpperCase().slice(0, 10) },
      ];
      for (const payload of bad) {
        const ack = await s.ack('auction.join', payload);
        assert.equal(ack.ok, false, JSON.stringify(payload));
        assert.equal(ack.error?.code, 'VALIDATION_FAILED', JSON.stringify(payload));
        assert.equal((await s.ack('auction.leave', payload)).ok, false);
      }
      assert.equal(roomSize(id), 0);
      assert.deepEqual(await s.join(id), { ok: true }); // still healthy
    });

    it('a message without an acknowledgement callback does not crash the server', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      s.socket.emit('auction.join', { auctionId: id }); // no ack function
      s.socket.emit('auction.join', 'garbage');
      await s.next('auction.snapshot');
      assert.equal(roomSize(id), 1);
    });

    it('an oversized message disconnects the sender (8 KB limit) and nobody else', async () => {
      const id = await liveAuction(api, seller.token);
      const victim = await connect();
      await victim.join(id);
      const attacker = await connect();
      attacker.socket.emit('auction.join', { auctionId: 'x'.repeat(40_000) });
      await sleep(500);
      assert.equal(attacker.socket.connected, false);
      assert.equal(victim.socket.connected, true);
    });

    it('limits the number of rooms per connection; re-joining a room you are in is allowed', async () => {
      const ids = [
        await liveAuction(api, seller.token),
        await liveAuction(api, seller.token),
        await liveAuction(api, seller.token),
        await liveAuction(api, seller.token),
      ];
      const s = await connect();
      for (const id of ids.slice(0, 3)) assert.deepEqual(await s.join(id), { ok: true });
      assert.equal((await s.join(ids[3] as string)).error?.code, 'TOO_MANY_ROOMS');
      assert.deepEqual(await s.join(ids[0] as string), { ok: true }); // already a member
      assert.equal(roomSize(ids[3] as string), 0);
    });

    it('a session revoked after connecting cannot join, and the socket is dropped', async () => {
      const id = await liveAuction(api, seller.token);
      const u = await newUser(api, 'late-revoke');
      const s = await connect(u.token);
      await api('POST', '/auth/logout', { token: u.token });
      const ack = await s.join(id);
      assert.equal(ack.error?.code, 'UNAUTHENTICATED');
      await sleep(200);
      assert.equal(s.socket.connected, false);
      assert.equal(roomSize(id), 0);
    });

    it('joining twice leaves one membership and delivers each event once', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      await s.join(id);
      await s.join(id);
      assert.equal(roomSize(id), 1);
      await placeBid(api, buyer().token, id, '10.00');
      await s.next('bid.accepted');
      assert.equal((await s.quiet(300, 'bid.accepted')).length, 0, 'delivered more than once');
    });
  });

  describe('events', () => {
    it('every client in the room receives the same committed bid, after it is in the database', async () => {
      const id = await liveAuction(api, seller.token);
      const watchers = [
        await connect(),
        await connect(buyer(1).token),
        await connect(seller.token),
        await connect(),
      ];
      for (const w of watchers) await w.join(id);

      const res = await placeBid(api, buyer().token, id, '15.00');
      assert.equal(res.status, 201);

      const received = [];
      for (const w of watchers) {
        const event = bidAcceptedEventSchema.parse(await w.next('bid.accepted'));
        // Committed first: the row is visible to a different connection right now.
        const { rows } = await app.db.query<{ amount: string }>(
          'SELECT amount FROM bids WHERE id = $1',
          [event.data.bidId],
        );
        assert.equal(rows[0]?.amount, '15.00');
        received.push(event);
      }
      for (const e of received) {
        assert.equal(e.auctionId, id);
        assert.equal(e.sequence, 1);
        assert.equal(e.data.bidSequence, 1);
        assert.equal(e.data.amount, '15.00');
        assert.equal(e.data.currentPrice, '15.00');
        assert.equal(e.data.bidderDisplayName, 'buyer0');
        assert.equal(e.data.minimumNextBid, '16.00');
        assert.equal(e.data.bidId, res.body.bid.id);
        assert.equal(e.eventId, received[0]?.eventId); // one event, many recipients
      }
    });

    it('sequential bids arrive in order with contiguous sequence numbers', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      for (let i = 0; i < 5; i += 1)
        await placeBid(api, buyer(i % 5).token, id, `${String(10 + i)}.00`);
      const sequences: number[] = [];
      for (let i = 0; i < 5; i += 1) {
        sequences.push(bidAcceptedEventSchema.parse(await s.next('bid.accepted')).sequence);
      }
      assert.deepEqual(sequences, [1, 2, 3, 4, 5]);
    });

    it('concurrent bids: every accepted bid is announced exactly once (arrival order is NOT guaranteed yet)', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) =>
          placeBid(api, buyer(i % 5).token, id, `${String(11 + i)}.00`),
        ),
      );
      const accepted = results.filter((r) => r.status === 201).length;
      const seen = new Set<number>();
      for (let i = 0; i < accepted; i += 1) {
        seen.add(bidAcceptedEventSchema.parse(await s.next('bid.accepted')).sequence);
      }
      assert.equal(seen.size, accepted);
      assert.equal((await s.quiet(300, 'bid.accepted')).length, 0);
    });

    it("rooms are isolated: another auction's room and unjoined sockets hear nothing", async () => {
      const a = await liveAuction(api, seller.token);
      const b = await liveAuction(api, seller.token);
      const inA = await connect();
      const inB = await connect();
      const nowhere = await connect();
      await inA.join(a);
      await inB.join(b);
      await placeBid(api, buyer().token, a, '10.00');
      await inA.next('bid.accepted');
      assert.equal((await inB.quiet(300, 'bid.accepted')).length, 0);
      assert.equal((await nowhere.quiet(100, 'bid.accepted')).length, 0);
    });

    it('a rejected bid is never broadcast; neither is a replay of an accepted one', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      await placeBid(api, buyer().token, id, '10.00');
      await s.next('bid.accepted');

      assert.equal((await placeBid(api, buyer(1).token, id, '10.00')).status, 409); // too low
      assert.equal((await placeBid(api, seller.token, id, '99.00')).status, 403); // seller
      assert.equal((await placeBid(api, buyer(1).token, id, 'abc')).status, 400); // invalid
      const key = newKey();
      assert.equal((await placeBid(api, buyer(2).token, id, '20.00', key)).status, 201);
      await s.next('bid.accepted');
      const replay = await placeBid(api, buyer(2).token, id, '20.00', key);
      assert.equal(replay.headers.get('idempotent-replay'), 'true');
      assert.equal((await s.quiet(400, 'bid.accepted')).length, 0);
    });

    it('nothing is broadcast while the bid transaction is uncommitted', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      const holder = await app.db.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT id FROM auctions WHERE id = $1 FOR UPDATE', [id]);
        const pending = placeBid(api, buyer().token, id, '10.00');
        assert.equal((await s.quiet(500, 'bid.accepted')).length, 0, 'announced before commit');
        await holder.query('COMMIT');
        assert.equal((await pending).status, 201);
        await s.next('bid.accepted');
      } finally {
        await holder.query('ROLLBACK').catch(() => undefined);
        holder.release();
      }
    });

    // Deterministic "after commit" proof. The spy is called at the exact moment the service
    // publishes, and asks a DIFFERENT connection whether the bid is visible. An uncommitted
    // row is invisible to other connections, so publishing before COMMIT fails this test
    // every time (a client-side check would be a race).
    it('the publisher is called only once the bid is committed and visible to other connections', async () => {
      const id = await liveAuction(api, seller.token);
      const visibleAtPublish: boolean[] = [];
      const service = createBidService(app.db, createAuctionService(app.db), {
        publisher: {
          publish: async (event) => {
            if (event.eventType !== 'bid.accepted') return;
            const { rows } = await app.db.query(
              'SELECT 1 FROM bids b JOIN auctions a ON a.id = b.auction_id WHERE b.id = $1 AND a.highest_bid_id = b.id',
              [event.data.bidId],
            );
            visibleAtPublish.push(rows.length === 1);
          },
        },
      });
      const result = await service.place({
        auctionId: id,
        userId: buyer().id,
        idempotencyKey: newKey(),
        input: { amount: '10.00' },
      });
      assert.equal(result.status, 201);
      assert.deepEqual(visibleAtPublish, [true]);
    });

    it('a failing publisher does not fail the bid: it is committed, and the failure is logged', async () => {
      const id = await liveAuction(api, seller.token);
      const lines: Record<string, unknown>[] = [];
      const service = createBidService(app.db, createAuctionService(app.db), {
        publisher: {
          publish: () => {
            throw new Error('redis is down');
          },
        },
        logger: createLogger('debug', (l) => lines.push(JSON.parse(l) as Record<string, unknown>)),
      });
      const result = await service.place({
        auctionId: id,
        userId: buyer().id,
        idempotencyKey: newKey(),
        input: { amount: '10.00' },
      });
      assert.equal(result.status, 201);
      const { rows } = await app.db.query('SELECT 1 FROM bids WHERE auction_id = $1', [id]);
      assert.equal(rows.length, 1);
      assert.ok(lines.some((l) => l['msg'] === 'failed to publish bid.accepted'));
    });
  });

  describe('leaving, disconnecting, reconnecting', () => {
    it('after leaving, a client hears nothing more; leaving a room you are not in is fine', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      assert.deepEqual(await s.leave(id), { ok: true });
      assert.deepEqual(await s.leave(id), { ok: true });
      assert.equal(roomSize(id), 0);
      await placeBid(api, buyer().token, id, '10.00');
      assert.equal((await s.quiet(300, 'bid.accepted')).length, 0);
    });

    it('participant.count follows joins, leaves and disconnects, and every message validates', async () => {
      const id = await liveAuction(api, seller.token);
      const a = await connect();
      const b = await connect();
      await a.join(id);
      assert.equal(
        participantCountEventSchema.parse(await a.next('participant.count')).data.count,
        1,
      );
      await b.join(id);
      assert.equal((await a.next('participant.count', (p) => p.data.count === 2)).data.count, 2);
      await b.disconnectAndWait();
      assert.equal((await a.next('participant.count', (p) => p.data.count === 1)).data.count, 1);
      await sleep(100);
      assert.equal(roomSize(id), 1);
    });

    it('a disconnected socket leaves no room membership behind', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect();
      await s.join(id);
      assert.equal(roomSize(id), 1);
      await s.disconnectAndWait();
      await sleep(100);
      assert.equal(roomSize(id), 0);
      assert.equal(app.io.sockets.adapter.rooms.has(auctionRoom(id)), false);
    });

    it('after a dropped connection the client reconnects, re-joins, and is subscribed exactly once', async () => {
      const id = await liveAuction(api, seller.token);
      const s = await connect(undefined, { reconnection: true });
      await s.join(id);
      await s.next('auction.snapshot');
      const reconnected = new Promise<void>((resolve) =>
        s.socket.io.once('reconnect', () => {
          resolve();
        }),
      );
      // Kill the transport underneath Socket.IO, as a network drop would.
      s.socket.io.engine.close();
      await reconnected;
      assert.equal(await waitForRoomSize(id, 0), true, 'old connection must be cleaned up');
      assert.deepEqual(await s.join(id), { ok: true }); // rooms are NOT restored automatically
      assert.equal(roomSize(id), 1);
      const snap = auctionSnapshotEventSchema.parse(await s.next('auction.snapshot'));
      assert.equal(snap.sequence, 0);
      await placeBid(api, buyer().token, id, '10.00');
      await s.next('bid.accepted');
      assert.equal((await s.quiet(300, 'bid.accepted')).length, 0);
    });

    it('a bid committed while the client was away is visible in the snapshot taken on rejoin', async () => {
      const id = await liveAuction(api, seller.token);
      const first = await connect();
      await first.join(id);
      await first.disconnectAndWait();
      await placeBid(api, buyer().token, id, '10.00'); // nobody is listening
      await placeBid(api, buyer(1).token, id, '11.00');
      const again = await connect();
      await again.join(id);
      const snap = auctionSnapshotEventSchema.parse(await again.next('auction.snapshot'));
      assert.equal(snap.sequence, 2);
      assert.equal(snap.data.auction.currentPrice, '11.00');
    });
  });

  async function waitForRoomSize(id: string, expected: number): Promise<boolean> {
    for (let i = 0; i < 40; i += 1) {
      if (roomSize(id) === expected) return true;
      await sleep(50);
    }
    return false;
  }
});
