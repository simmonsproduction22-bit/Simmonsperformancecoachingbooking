-- Small-group packages (priced per person), private custom offers, and quote requests.

-- kind 'group': price_cents is per person; the buyer picks a headcount between min_people and max_people.
-- offer_token set: a private offer, hidden from the public page and only buyable through its link.
ALTER TABLE packages
  ADD COLUMN kind        TEXT NOT NULL DEFAULT 'private' CHECK (kind IN ('private', 'group')),
  ADD COLUMN min_people  INTEGER NOT NULL DEFAULT 1 CHECK (min_people BETWEEN 1 AND 100),
  ADD COLUMN max_people  INTEGER NOT NULL DEFAULT 1 CHECK (max_people BETWEEN 1 AND 100),
  ADD COLUMN offer_token TEXT UNIQUE,
  ADD COLUMN offer_for   TEXT NOT NULL DEFAULT '';      -- who a private offer is for (shown to the coach)

ALTER TABLE purchases
  ADD COLUMN package_kind TEXT NOT NULL DEFAULT 'private' CHECK (package_kind IN ('private', 'group')),
  ADD COLUMN party_size   INTEGER NOT NULL DEFAULT 1 CHECK (party_size BETWEEN 1 AND 100);

CREATE TABLE inquiries (
  id          SERIAL PRIMARY KEY,
  coach_id    INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  kind        TEXT NOT NULL DEFAULT 'corporate',
  name        TEXT NOT NULL,
  email       TEXT NOT NULL,
  phone       TEXT NOT NULL DEFAULT '',
  company     TEXT NOT NULL DEFAULT '',
  group_size  TEXT NOT NULL DEFAULT '',
  message     TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'replied', 'closed')),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX inquiries_coach_idx ON inquiries (coach_id, status, created_at DESC);
