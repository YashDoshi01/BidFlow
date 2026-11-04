-- Auctions. Money is NUMERIC(12,2), never floating point.
-- bids, bid_sequence and highest_bid_id arrive with Phase 2 (they need the bids table).

CREATE TABLE auctions (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Monotonic listing cursor. A timestamp cannot be a keyset cursor: JS Date
  -- has millisecond precision, PostgreSQL has microseconds, so rows would be
  -- skipped or repeated at page boundaries.
  seq               bigint GENERATED ALWAYS AS IDENTITY,
  seller_id         uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  title             text NOT NULL,
  description       text NOT NULL DEFAULT '',
  starting_price    numeric(12, 2) NOT NULL,
  current_price     numeric(12, 2) NOT NULL,
  minimum_increment numeric(12, 2) NOT NULL DEFAULT 1.00,
  currency          text NOT NULL DEFAULT 'USD',
  status            text NOT NULL DEFAULT 'DRAFT',
  starts_at         timestamptz NOT NULL,
  ends_at           timestamptz NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT auctions_seq_key UNIQUE (seq),
  CONSTRAINT auctions_title_length CHECK (char_length(btrim(title)) BETWEEN 1 AND 120),
  CONSTRAINT auctions_description_length CHECK (char_length(description) <= 5000),
  CONSTRAINT auctions_starting_price_positive CHECK (starting_price > 0),
  CONSTRAINT auctions_increment_positive CHECK (minimum_increment > 0),
  CONSTRAINT auctions_current_price_floor CHECK (current_price >= starting_price),
  CONSTRAINT auctions_currency_format CHECK (currency ~ '^[A-Z]{3}$'),
  CONSTRAINT auctions_status_valid
    CHECK (status IN ('DRAFT', 'SCHEDULED', 'LIVE', 'ENDED', 'CANCELLED')),
  -- Product rule 14: duration between 1 minute and 30 days (measured from the start).
  CONSTRAINT auctions_duration_bounds
    CHECK (ends_at >= starts_at + interval '1 minute' AND ends_at <= starts_at + interval '30 days')
);

-- Access patterns (each index names the query it serves):
-- seller's own auctions, newest first
CREATE INDEX auctions_seller_seq_idx ON auctions (seller_id, seq DESC);
-- public listing, newest first, drafts excluded
CREATE INDEX auctions_public_seq_idx ON auctions (seq DESC) WHERE status <> 'DRAFT';
-- lifecycle worker (Phase 6): live auctions by end time, scheduled by start time
CREATE INDEX auctions_live_ends_at_idx ON auctions (ends_at) WHERE status = 'LIVE';
CREATE INDEX auctions_scheduled_starts_at_idx ON auctions (starts_at) WHERE status = 'SCHEDULED';

-- State machine enforced by the database (product rule 9). The application
-- checks first for a friendly error; this trigger is the backstop.
CREATE FUNCTION auctions_guard_update() RETURNS trigger AS $$
BEGIN
  IF NEW.status <> OLD.status AND NOT (
       (OLD.status = 'DRAFT'     AND NEW.status IN ('SCHEDULED', 'LIVE', 'CANCELLED'))
    OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('LIVE', 'CANCELLED'))
    OR (OLD.status = 'LIVE'      AND NEW.status IN ('ENDED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION 'illegal auction status transition % -> %', OLD.status, NEW.status
      USING ERRCODE = 'check_violation';
  END IF;

  -- After publication the sale terms are frozen (product rule 10).
  -- current_price, ends_at (anti-sniping) and status stay writable for later phases.
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

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER auctions_guard_update_trg
  BEFORE UPDATE ON auctions
  FOR EACH ROW EXECUTE FUNCTION auctions_guard_update();
