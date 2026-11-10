-- Pay by Zelle or Cash App without an account: the client uploads a screenshot and the coach approves it.

ALTER TABLE coaches
  ADD COLUMN zelle_handle  TEXT NOT NULL DEFAULT '',   -- email or phone clients send Zelle payments to
  ADD COLUMN cashapp_tag   TEXT NOT NULL DEFAULT '',   -- $cashtag
  ADD COLUMN payment_note  TEXT NOT NULL DEFAULT '';   -- extra instructions shown at checkout

-- Accounts created automatically from a purchase have no password until the client sets one.
ALTER TABLE clients ALTER COLUMN password_hash DROP NOT NULL;

ALTER TABLE purchases DROP CONSTRAINT purchases_method_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_method_check CHECK (method IN ('card', 'offline', 'zelle', 'cashapp'));
ALTER TABLE purchases DROP CONSTRAINT purchases_status_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_status_check CHECK (status IN ('pending', 'paid', 'refunded', 'canceled', 'rejected'));
ALTER TABLE purchases
  ADD COLUMN submitted_at  TIMESTAMPTZ,
  ADD COLUMN reviewed_at   TIMESTAMPTZ,
  ADD COLUMN review_note   TEXT NOT NULL DEFAULT '';

-- Payment screenshots (downscaled in the browser before upload).
CREATE TABLE payment_proofs (
  purchase_id  INTEGER PRIMARY KEY REFERENCES purchases(id) ON DELETE CASCADE,
  mime         TEXT NOT NULL,
  data         BYTEA NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
