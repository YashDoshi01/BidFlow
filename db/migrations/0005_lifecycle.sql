-- Phase 6: the auction lifecycle (activation, anti-sniping, ending) and in-app notifications.
--
-- A worker moves auctions SCHEDULED -> LIVE at starts_at and LIVE -> ENDED at ends_at, with no
-- browser involved. Anti-sniping extends ends_at inside the bid transaction. Every one of these
-- changes writes its outbox event (auction.started / auction.extended / auction.ended) and its
-- notifications in the SAME transaction (ADR-039). The database re-states the rules as backstops.

-- ---------------------------------------------------------------------------
-- New auction columns
-- ---------------------------------------------------------------------------
ALTER TABLE auctions
  -- The end time the seller set; the anti-sniping cap (+1 hour) is measured from it.
  ADD COLUMN original_ends_at timestamptz,
  ADD COLUMN extension_count integer NOT NULL DEFAULT 0,
  -- Winner selection, recorded once and never changed: who won and when it ended.
  ADD COLUMN ended_at timestamptz,
  ADD COLUMN winning_bid_id uuid REFERENCES bids (id) ON DELETE RESTRICT,
  -- Set when the "ending soon" notifications were written, so they are written once.
  ADD COLUMN ending_soon_notified_at timestamptz;

UPDATE auctions SET original_ends_at = ends_at;
ALTER TABLE auctions ALTER COLUMN original_ends_at SET NOT NULL;

-- Auctions that already ended or were cancelled before this migration keep NULL ended_at only if
-- they are not ENDED; an ENDED row needs a time. Nothing could end before this phase (no worker),
-- so this is only a safety net for hand-edited data.
UPDATE auctions SET ended_at = updated_at WHERE status = 'ENDED' AND ended_at IS NULL;
UPDATE auctions SET winning_bid_id = highest_bid_id WHERE status = 'ENDED' AND highest_bid_id IS NOT NULL;

ALTER TABLE auctions
  ADD CONSTRAINT auctions_extension_count_range CHECK (extension_count BETWEEN 0 AND 10),
  -- Product rule 13: at most +1 hour in total, measured from the seller's end time.
  ADD CONSTRAINT auctions_extension_cap
    CHECK (ends_at >= original_ends_at AND ends_at <= original_ends_at + interval '1 hour'),
  ADD CONSTRAINT auctions_ended_has_time CHECK ((status = 'ENDED') = (ended_at IS NOT NULL)),
  ADD CONSTRAINT auctions_winner_only_when_ended CHECK (winning_bid_id IS NULL OR status = 'ENDED');

-- original_ends_at follows ends_at while the auction is a DRAFT (the seller may still edit it) and
-- is frozen from the moment it is published. A separate trigger: it must run after the guard.
CREATE FUNCTION auctions_set_original_end() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' OR OLD.status = 'DRAFT' THEN
    NEW.original_ends_at := NEW.ends_at;
  ELSIF NEW.original_ends_at IS DISTINCT FROM OLD.original_ends_at THEN
    RAISE EXCEPTION 'original_ends_at is frozen once the auction is no longer DRAFT'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auctions_original_end_trg
  BEFORE INSERT OR UPDATE ON auctions
  FOR EACH ROW EXECUTE FUNCTION auctions_set_original_end();

-- ---------------------------------------------------------------------------
-- auctions guard: keep every earlier rule (0002, 0003, 0004), add the lifecycle rules.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION auctions_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT'     AND NEW.status IN ('SCHEDULED', 'LIVE', 'CANCELLED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('LIVE', 'CANCELLED'))
    OR (OLD.status = 'LIVE'      AND NEW.status IN ('ENDED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'illegal auction status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  IF OLD.status <> 'DRAFT' AND (
       NEW.seller_id         IS DISTINCT FROM OLD.seller_id
    OR NEW.title             IS DISTINCT FROM OLD.title
    OR NEW.description       IS DISTINCT FROM OLD.description
    OR NEW.starting_price    IS DISTINCT FROM OLD.starting_price
    OR NEW.minimum_increment IS DISTINCT FROM OLD.minimum_increment
    OR NEW.currency          IS DISTINCT FROM OLD.currency
    OR NEW.starts_at         IS DISTINCT FROM OLD.starts_at
  ) THEN
    RAISE EXCEPTION 'auction terms are frozen once the auction is no longer DRAFT'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.bid_sequence <> OLD.bid_sequence AND NEW.bid_sequence <> OLD.bid_sequence + 1 THEN
    RAISE EXCEPTION 'bid_sequence can only increase by one' USING ERRCODE = 'check_violation';
  END IF;

  -- Each UPDATE statement advances the event sequence by at most one.
  IF NEW.auction_event_sequence <> OLD.auction_event_sequence
     AND NEW.auction_event_sequence <> OLD.auction_event_sequence + 1 THEN
    RAISE EXCEPTION 'auction_event_sequence can only increase by one per update'
      USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.highest_bid_id IS DISTINCT FROM OLD.highest_bid_id THEN
    IF NOT EXISTS (
      SELECT 1 FROM bids b
       WHERE b.id = NEW.highest_bid_id
         AND b.auction_id = NEW.id
         AND b.bid_sequence = NEW.bid_sequence
         AND b.amount = NEW.current_price
    ) THEN
      RAISE EXCEPTION 'highest_bid_id must reference the latest bid, with amount = current_price'
        USING ERRCODE = 'check_violation';
    END IF;
    -- A new highest bid is an event: the event sequence must advance together with it.
    IF NEW.auction_event_sequence <> OLD.auction_event_sequence + 1 THEN
      RAISE EXCEPTION 'an accepted bid is an event: auction_event_sequence must advance with it'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.bid_sequence <> OLD.bid_sequence THEN
    RAISE EXCEPTION 'bid_sequence cannot change without a new highest bid'
      USING ERRCODE = 'check_violation';
  ELSIF NEW.current_price <> OLD.current_price AND OLD.status <> 'DRAFT' THEN
    RAISE EXCEPTION 'current_price can only change together with highest_bid_id'
      USING ERRCODE = 'check_violation';
  END IF;

  -- ---- Phase 6 ----

  -- An auction cannot go LIVE before its start time (the worker's rule, and the publish rule).
  IF NEW.status = 'LIVE' AND OLD.status IN ('DRAFT', 'SCHEDULED')
     AND clock_timestamp() < NEW.starts_at THEN
    RAISE EXCEPTION 'an auction cannot become LIVE before starts_at'
      USING ERRCODE = 'check_violation';
  END IF;

  -- Ending: only at or after ends_at (the exact complement of the bid rule "clock < ends_at"),
  -- as an event, recording the winner = the highest accepted bid, once.
  IF NEW.status = 'ENDED' AND OLD.status <> 'ENDED' THEN
    IF clock_timestamp() < OLD.ends_at THEN
      RAISE EXCEPTION 'an auction cannot end before ends_at' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.auction_event_sequence <> OLD.auction_event_sequence + 1 THEN
      RAISE EXCEPTION 'ending an auction is an event: auction_event_sequence must advance with it'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.winning_bid_id IS DISTINCT FROM OLD.highest_bid_id THEN
      RAISE EXCEPTION 'the winner must be the highest accepted bid' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF OLD.ended_at IS NOT NULL AND (
       NEW.ended_at IS DISTINCT FROM OLD.ended_at
    OR NEW.winning_bid_id IS DISTINCT FROM OLD.winning_bid_id
    OR NEW.ends_at IS DISTINCT FROM OLD.ends_at
  ) THEN
    RAISE EXCEPTION 'the outcome of an ended auction never changes' USING ERRCODE = 'check_violation';
  END IF;

  -- Anti-sniping (product rule 13). After publishing, ends_at moves only forward, only while LIVE,
  -- only as an extension that is counted (at most 10) and that is an event, and never beyond
  -- original_ends_at + 1 hour (the table CHECK). Before publishing the seller edits freely.
  IF OLD.status <> 'DRAFT' AND NEW.ends_at IS DISTINCT FROM OLD.ends_at THEN
    IF OLD.status <> 'LIVE' OR NEW.status <> 'LIVE' THEN
      RAISE EXCEPTION 'ends_at can only change while the auction is LIVE'
        USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.ends_at <= OLD.ends_at THEN
      RAISE EXCEPTION 'ends_at can only move forward' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.extension_count <> OLD.extension_count + 1 THEN
      RAISE EXCEPTION 'every extension must be counted' USING ERRCODE = 'check_violation';
    END IF;
    IF clock_timestamp() >= OLD.ends_at THEN
      RAISE EXCEPTION 'a finished auction cannot be extended' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.auction_event_sequence <> OLD.auction_event_sequence + 1 THEN
      RAISE EXCEPTION 'an extension is an event: auction_event_sequence must advance with it'
        USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.extension_count IS DISTINCT FROM OLD.extension_count THEN
    RAISE EXCEPTION 'extension_count cannot change without an extension' USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- notifications: in-app, one row per (user, reason), written in the transaction of the change that
-- caused them (no queue, no broker). `read_at` is the only state that changes afterwards.
-- ---------------------------------------------------------------------------
CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Listing cursor, like auctions.seq (ADR-013): ids are random, a time is not unique.
  seq         bigint GENERATED ALWAYS AS IDENTITY UNIQUE,
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  auction_id  uuid NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  type        text NOT NULL,
  -- Makes writing idempotent: the same reason for the same user is stored once (ON CONFLICT DO NOTHING).
  dedupe_key  text NOT NULL,
  data        jsonb NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT clock_timestamp(),
  read_at     timestamptz,
  CONSTRAINT notifications_type_valid
    CHECK (type IN ('outbid', 'ending_soon', 'auction_won', 'auction_lost', 'auction_ended')),
  CONSTRAINT notifications_dedupe_key_length CHECK (char_length(dedupe_key) BETWEEN 1 AND 200),
  CONSTRAINT notifications_dedupe_key UNIQUE (user_id, dedupe_key)
);

CREATE INDEX notifications_user_idx ON notifications (user_id, seq DESC);
CREATE INDEX notifications_unread_idx ON notifications (user_id) WHERE read_at IS NULL;

-- A user is notified only about an auction they may see AND take part in: the auction is not a
-- DRAFT, and the user is its seller or has placed a bid on it. Whatever code writes a
-- notification, the database refuses one for anybody else (plan: no notifications for
-- unauthorized or private auctions).
CREATE FUNCTION notifications_guard_insert() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM auctions a
     WHERE a.id = NEW.auction_id
       AND a.status <> 'DRAFT'
       AND (a.seller_id = NEW.user_id
            OR EXISTS (SELECT 1 FROM bids b WHERE b.auction_id = a.id AND b.bidder_id = NEW.user_id))
  ) THEN
    RAISE EXCEPTION 'a notification needs a published auction the user sells or bid on'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.read_at IS NOT NULL THEN
    RAISE EXCEPTION 'a new notification is unread' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_guard_insert_trg
  BEFORE INSERT ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_guard_insert();

-- What a notification says never changes; it can only be marked read, once (read_at keeps its
-- first value). Deleting is allowed only through the user's own deletion (ON DELETE CASCADE).
CREATE FUNCTION notifications_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.seq <> OLD.seq
     OR NEW.user_id <> OLD.user_id
     OR NEW.auction_id <> OLD.auction_id
     OR NEW.type <> OLD.type
     OR NEW.dedupe_key <> OLD.dedupe_key
     OR NEW.data IS DISTINCT FROM OLD.data
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'a notification is immutable except for read_at' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD.read_at IS NOT NULL AND NEW.read_at IS DISTINCT FROM OLD.read_at THEN
    RAISE EXCEPTION 'read_at is set once' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER notifications_guard_update_trg
  BEFORE UPDATE ON notifications
  FOR EACH ROW EXECUTE FUNCTION notifications_guard_update();
