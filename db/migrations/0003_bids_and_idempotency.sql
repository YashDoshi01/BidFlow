-- Phase 2: bids, per-auction bid ordering, highest-bid reference, idempotency records.
--
-- The application takes the auction row lock and makes the decision (see
-- docs/DECISIONS.md ADR-017). The database repeats the invariants so that a
-- bug, a script or a future service that skips the application still cannot
-- store an invalid bid.

ALTER TABLE auctions
  ADD COLUMN bid_sequence bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT auctions_bid_sequence_nonneg CHECK (bid_sequence >= 0);

CREATE TABLE bids (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auction_id   uuid NOT NULL REFERENCES auctions (id) ON DELETE RESTRICT,
  bidder_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  amount       numeric(12, 2) NOT NULL,
  -- 1, 2, 3 ... per auction: the authoritative order of accepted bids.
  bid_sequence bigint NOT NULL,
  -- The single boundary timestamp the decision was made with (clock_timestamp()
  -- read after the auction lock; plan section 3.4).
  accepted_at  timestamptz NOT NULL,
  CONSTRAINT bids_amount_positive CHECK (amount > 0),
  CONSTRAINT bids_sequence_positive CHECK (bid_sequence >= 1),
  -- Two bids can never both take the same position in an auction, even if the
  -- row lock were bypassed: the second insert waits, then fails.
  CONSTRAINT bids_auction_sequence_key UNIQUE (auction_id, bid_sequence)
);

CREATE INDEX bids_bidder_idx ON bids (bidder_id);

ALTER TABLE auctions
  ADD COLUMN highest_bid_id uuid REFERENCES bids (id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- A bid may only be inserted when it is valid right now.
-- ---------------------------------------------------------------------------
CREATE FUNCTION bids_guard_insert() RETURNS trigger AS $$
DECLARE
  a auctions%ROWTYPE;
BEGIN
  SELECT * INTO a FROM auctions WHERE id = NEW.auction_id;

  IF a.status <> 'LIVE' THEN
    RAISE EXCEPTION 'auction is not LIVE' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bidder_id = a.seller_id THEN
    RAISE EXCEPTION 'a seller cannot bid on their own auction' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.bid_sequence <> a.bid_sequence + 1 THEN
    RAISE EXCEPTION 'bid_sequence must be the next number for the auction'
      USING ERRCODE = 'check_violation';
  END IF;
  -- accepted_at must have been read inside this transaction (so it cannot be
  -- back-dated to slip under ends_at) and must lie inside the bidding window.
  IF NEW.accepted_at < transaction_timestamp() OR NEW.accepted_at > clock_timestamp() THEN
    RAISE EXCEPTION 'accepted_at must be taken inside the bid transaction'
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.accepted_at < a.starts_at OR NEW.accepted_at >= a.ends_at THEN
    RAISE EXCEPTION 'bid is outside the auction window' USING ERRCODE = 'check_violation';
  END IF;
  -- The first bid may equal the starting price; later bids must beat the
  -- current price by at least the increment (product rules 3 and 4).
  IF a.highest_bid_id IS NULL THEN
    IF NEW.amount < a.starting_price THEN
      RAISE EXCEPTION 'bid is below the starting price' USING ERRCODE = 'check_violation';
    END IF;
  ELSIF NEW.amount < a.current_price + a.minimum_increment THEN
    RAISE EXCEPTION 'bid is below the minimum acceptable amount' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bids_guard_insert_trg
  BEFORE INSERT ON bids
  FOR EACH ROW EXECUTE FUNCTION bids_guard_insert();

-- Bid history is immutable (plan section 1).
CREATE FUNCTION bids_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'bids are immutable' USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER bids_immutable_trg
  BEFORE UPDATE OR DELETE ON bids
  FOR EACH ROW EXECUTE FUNCTION bids_immutable();

-- ---------------------------------------------------------------------------
-- auctions guard: keep the 0002 rules, add the price/bid-agreement rules.
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

  -- The counter moves forward by exactly one, together with the highest bid.
  IF NEW.bid_sequence <> OLD.bid_sequence AND NEW.bid_sequence <> OLD.bid_sequence + 1 THEN
    RAISE EXCEPTION 'bid_sequence can only increase by one' USING ERRCODE = 'check_violation';
  END IF;

  IF NEW.highest_bid_id IS DISTINCT FROM OLD.highest_bid_id THEN
    -- The new highest bid must be this auction's latest bid and its amount must
    -- be the current price: price and highest bid cannot disagree.
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
-- Idempotency records. Only successful (2xx) results are stored (ADR-021); a
-- business rejection depends on current state and is simply evaluated again.
-- ---------------------------------------------------------------------------
CREATE TABLE idempotency_records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  operation       text NOT NULL,
  idempotency_key text NOT NULL,
  request_hash    text NOT NULL,
  response_status integer NOT NULL,
  response_body   jsonb NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  -- The final guard against two concurrent requests with the same key.
  CONSTRAINT idempotency_records_scope_key UNIQUE (user_id, operation, idempotency_key),
  CONSTRAINT idempotency_operation_length CHECK (char_length(operation) BETWEEN 1 AND 100),
  CONSTRAINT idempotency_key_format CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,128}$'),
  CONSTRAINT idempotency_hash_format CHECK (request_hash ~ '^[0-9a-f]{64}$'),
  CONSTRAINT idempotency_success_only CHECK (response_status BETWEEN 200 AND 299),
  CONSTRAINT idempotency_expiry CHECK (expires_at > created_at)
);

CREATE INDEX idempotency_records_expires_idx ON idempotency_records (expires_at);
