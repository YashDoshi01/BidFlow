-- Phase 5: the transactional outbox and the per-auction event sequence.
--
-- Every durable auction event (today only bid.accepted) is written to outbox_events IN THE SAME
-- TRANSACTION as the change it describes, and carries the auction's next auction_event_sequence.
-- A separate worker claims rows (with a lease), publishes them, and marks them published.
-- The outbox is a DELIVERY QUEUE, not the event history (ADR-040): published rows may be pruned,
-- and the auctions and bids rows remain the source of truth.

-- ---------------------------------------------------------------------------
-- auctions.auction_event_sequence: orders EVERY durable event of an auction.
-- ---------------------------------------------------------------------------
ALTER TABLE auctions ADD COLUMN auction_event_sequence bigint NOT NULL DEFAULT 0;

-- Existing auctions: before this phase every durable event was an accepted bid, so the event
-- count equals the bid count. (Those events were delivered by the old direct publish and are not
-- in the outbox.) The guard trigger would reject this one-off change, so it is switched off for
-- the backfill only.
ALTER TABLE auctions DISABLE TRIGGER auctions_guard_update_trg;
UPDATE auctions SET auction_event_sequence = bid_sequence;
ALTER TABLE auctions ENABLE TRIGGER auctions_guard_update_trg;

ALTER TABLE auctions
  ADD CONSTRAINT auctions_event_sequence_nonneg CHECK (auction_event_sequence >= 0),
  -- Every accepted bid is an event, so there are at least as many events as bids.
  ADD CONSTRAINT auctions_event_sequence_covers_bids CHECK (auction_event_sequence >= bid_sequence);

-- ---------------------------------------------------------------------------
-- outbox_events
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_events (
  -- The stable event id: it is the envelope's eventId, so a re-publication carries the same id.
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id             uuid NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  event_type             text NOT NULL,
  schema_version         integer NOT NULL,
  auction_event_sequence bigint NOT NULL,
  -- The envelope's "data" object, built and validated when the event was written.
  payload                jsonb NOT NULL,
  occurred_at            timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  -- Delivery state (the only columns that change after the insert).
  status                 text NOT NULL DEFAULT 'pending',
  lease_owner            text,
  lease_until            timestamptz,
  published_at           timestamptz,
  attempt_count          integer NOT NULL DEFAULT 0,
  next_attempt_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  last_error             text,
  -- One event per position of an auction: this is what makes the order total.
  CONSTRAINT outbox_events_sequence_key UNIQUE (auction_id, auction_event_sequence),
  CONSTRAINT outbox_event_type_format CHECK (event_type ~ '^[a-z]+(\.[a-z]+)+$'),
  CONSTRAINT outbox_sequence_positive CHECK (auction_event_sequence >= 1),
  CONSTRAINT outbox_schema_version_positive CHECK (schema_version >= 1),
  CONSTRAINT outbox_status_valid CHECK (status IN ('pending', 'processing', 'published', 'failed')),
  -- A lease exists exactly while a worker holds the row.
  CONSTRAINT outbox_lease_when_processing
    CHECK (status <> 'processing' OR (lease_owner IS NOT NULL AND lease_until IS NOT NULL)),
  CONSTRAINT outbox_no_lease_otherwise
    CHECK (status = 'processing' OR (lease_owner IS NULL AND lease_until IS NULL)),
  CONSTRAINT outbox_published_consistent CHECK ((status = 'published') = (published_at IS NOT NULL)),
  CONSTRAINT outbox_attempts_nonneg CHECK (attempt_count >= 0),
  CONSTRAINT outbox_last_error_length CHECK (last_error IS NULL OR char_length(last_error) <= 500)
);

-- The claim query looks only at unpublished rows, in (auction, sequence) order.
CREATE INDEX outbox_events_unpublished_idx
  ON outbox_events (auction_id, auction_event_sequence) WHERE status <> 'published';
-- Pruning finds old published rows.
CREATE INDEX outbox_events_published_at_idx
  ON outbox_events (published_at) WHERE status = 'published';

-- An outbox row can only be written for the auction's CURRENT event sequence, as a fresh pending
-- row: the application advances auctions.auction_event_sequence first, then inserts the row.
CREATE FUNCTION outbox_guard_insert() RETURNS trigger AS $$
DECLARE
  current_sequence bigint;
BEGIN
  SELECT auction_event_sequence INTO current_sequence FROM auctions WHERE id = NEW.auction_id;
  IF NEW.auction_event_sequence IS DISTINCT FROM current_sequence THEN
    RAISE EXCEPTION 'outbox event must carry the auction''s current auction_event_sequence'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.status <> 'pending' OR NEW.attempt_count <> 0 THEN
    RAISE EXCEPTION 'a new outbox event must be pending with no attempts'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_guard_insert_trg
  BEFORE INSERT ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_guard_insert();

-- What an event IS never changes; only its delivery state does, and only along the allowed
-- transitions:
--   pending    -> processing                       (claimed)
--   processing -> processing                       (lease expired: taken over by another worker)
--   processing -> published | pending | failed     (done / retry later / gave up)
--   failed     -> pending                          (manual retry, audited)
-- A published row never changes again.
CREATE FUNCTION outbox_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id
     OR NEW.auction_id <> OLD.auction_id
     OR NEW.event_type <> OLD.event_type
     OR NEW.schema_version <> OLD.schema_version
     OR NEW.auction_event_sequence <> OLD.auction_event_sequence
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.occurred_at <> OLD.occurred_at
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'outbox events are immutable except for their delivery state'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
       (OLD.status = 'pending'    AND NEW.status = 'processing')
    OR (OLD.status = 'processing' AND NEW.status IN ('processing', 'published', 'pending', 'failed'))
    OR (OLD.status = 'failed'     AND NEW.status = 'pending')
  ) THEN
    RAISE EXCEPTION 'illegal outbox status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_guard_update_trg
  BEFORE UPDATE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_guard_update();

-- Only delivered rows may be deleted (pruning). An unpublished event is never discarded.
CREATE FUNCTION outbox_guard_delete() RETURNS trigger AS $$
BEGIN
  IF OLD.status <> 'published' THEN
    RAISE EXCEPTION 'only published outbox events can be deleted' USING ERRCODE = 'check_violation';
  END IF;
  RETURN OLD;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_guard_delete_trg
  BEFORE DELETE ON outbox_events
  FOR EACH ROW EXECUTE FUNCTION outbox_guard_delete();

-- ---------------------------------------------------------------------------
-- The atomicity guarantee, enforced by the database: an auction's event sequence cannot move
-- unless an outbox row for the new position exists when the transaction COMMITS. Code that
-- advances the sequence and forgets (or fails) to write the event cannot commit.
-- ---------------------------------------------------------------------------
CREATE FUNCTION auctions_event_requires_outbox() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM outbox_events o
     WHERE o.auction_id = NEW.id AND o.auction_event_sequence = NEW.auction_event_sequence
  ) THEN
    RAISE EXCEPTION 'auction_event_sequence % of auction % has no outbox event',
      NEW.auction_event_sequence, NEW.id USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER auctions_event_requires_outbox_trg
  AFTER UPDATE OF auction_event_sequence ON auctions
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW.auction_event_sequence > OLD.auction_event_sequence)
  EXECUTE FUNCTION auctions_event_requires_outbox();

-- ---------------------------------------------------------------------------
-- auctions guard: keep every earlier rule (0002, 0003), add the event-sequence rules.
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------------------
-- Audit trail for manual retries of failed events. Append-only; no foreign key, so pruning
-- delivered events never touches it.
-- ---------------------------------------------------------------------------
CREATE TABLE outbox_retry_audit (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  outbox_event_id        uuid NOT NULL,
  auction_id             uuid NOT NULL,
  auction_event_sequence bigint NOT NULL,
  retried_at             timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor                  text NOT NULL,
  reason                 text NOT NULL,
  previous_attempt_count integer NOT NULL,
  previous_error         text,
  CONSTRAINT outbox_audit_actor_length CHECK (char_length(actor) BETWEEN 1 AND 100),
  CONSTRAINT outbox_audit_reason_length CHECK (char_length(btrim(reason)) BETWEEN 3 AND 300)
);

CREATE FUNCTION outbox_audit_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'the outbox audit trail is append-only' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER outbox_audit_append_only_trg
  BEFORE UPDATE OR DELETE ON outbox_retry_audit
  FOR EACH ROW EXECUTE FUNCTION outbox_audit_append_only();
