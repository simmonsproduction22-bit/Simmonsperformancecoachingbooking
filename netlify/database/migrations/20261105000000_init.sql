-- Coach platform: coaches, their clients, packages, purchases, lessons, and per-lesson payouts.
-- Money is in cents. Times are UTC (TIMESTAMPTZ); availability is stored in the coach's local time.

CREATE TABLE coaches (
  id                    SERIAL PRIMARY KEY,
  slug                  TEXT NOT NULL UNIQUE,            -- public URL: /<slug>
  email                 TEXT NOT NULL UNIQUE,            -- lowercased
  password_hash         TEXT NOT NULL,
  name                  TEXT NOT NULL,
  headline              TEXT NOT NULL DEFAULT '',
  bio                   TEXT NOT NULL DEFAULT '',
  location              TEXT NOT NULL DEFAULT '',
  timezone              TEXT NOT NULL DEFAULT 'America/Chicago',
  lesson_minutes        INTEGER NOT NULL DEFAULT 60,
  slot_step_minutes     INTEGER NOT NULL DEFAULT 30,     -- start times offered every N minutes
  buffer_minutes        INTEGER NOT NULL DEFAULT 0,      -- gap kept between lessons
  min_notice_hours      INTEGER NOT NULL DEFAULT 12,     -- earliest a client can book ahead
  max_days_ahead        INTEGER NOT NULL DEFAULT 45,
  cancel_window_hours   INTEGER NOT NULL DEFAULT 24,     -- clients may cancel/reschedule until this many hours before
  stripe_account_id     TEXT,                            -- Stripe Connect account that receives released funds
  stripe_payouts_ready  BOOLEAN NOT NULL DEFAULT FALSE,
  platform_fee_bps      INTEGER NOT NULL DEFAULT 0,      -- platform cut per released lesson (basis points); 0 for the owner
  failed_logins         INTEGER NOT NULL DEFAULT 0,
  locked_until          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE clients (
  id             SERIAL PRIMARY KEY,
  coach_id       INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  email          TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  name           TEXT NOT NULL,
  phone          TEXT NOT NULL DEFAULT '',
  notes          TEXT NOT NULL DEFAULT '',                -- private coach notes
  failed_logins  INTEGER NOT NULL DEFAULT 0,
  locked_until   TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (coach_id, email)
);

CREATE TABLE sessions (
  token_hash  TEXT PRIMARY KEY,
  role        TEXT NOT NULL CHECK (role IN ('coach', 'client')),
  user_id     INTEGER NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions (role, user_id);

CREATE TABLE packages (
  id            SERIAL PRIMARY KEY,
  coach_id      INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL DEFAULT '',
  lesson_count  INTEGER NOT NULL CHECK (lesson_count BETWEEN 1 AND 100),
  price_cents   INTEGER NOT NULL CHECK (price_cents >= 100),
  expires_days  INTEGER NOT NULL DEFAULT 90,             -- lessons must be used within this many days
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One row per package a client buys. Card purchases hold funds on the platform until lessons are delivered.
CREATE TABLE purchases (
  id                  SERIAL PRIMARY KEY,
  coach_id            INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  client_id           INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  package_id          INTEGER REFERENCES packages(id) ON DELETE SET NULL,
  package_name        TEXT NOT NULL,
  lessons_total       INTEGER NOT NULL,
  amount_cents        INTEGER NOT NULL,
  method              TEXT NOT NULL CHECK (method IN ('card', 'offline')),  -- offline = paid outside the site, nothing held
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'refunded', 'canceled')),
  released_cents      INTEGER NOT NULL DEFAULT 0,        -- sent on to the coach so far
  refunded_cents      INTEGER NOT NULL DEFAULT 0,
  stripe_session_id   TEXT UNIQUE,
  stripe_payment_intent TEXT,
  stripe_charge_id    TEXT,
  paid_at             TIMESTAMPTZ,
  expires_at          TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX purchases_client_idx ON purchases (client_id, status);
CREATE INDEX purchases_coach_idx ON purchases (coach_id, status);

-- availability: weekly recurring windows in the coach's local time (minutes after midnight).
CREATE TABLE availability (
  id         SERIAL PRIMARY KEY,
  coach_id   INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  weekday    INTEGER NOT NULL CHECK (weekday BETWEEN 0 AND 6),  -- 0 = Sunday
  start_min  INTEGER NOT NULL CHECK (start_min BETWEEN 0 AND 1440),
  end_min    INTEGER NOT NULL CHECK (end_min BETWEEN 0 AND 1440),
  CHECK (end_min > start_min)
);
CREATE INDEX availability_coach_idx ON availability (coach_id);

CREATE TABLE time_off (
  id         SERIAL PRIMARY KEY,
  coach_id   INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  starts_at  TIMESTAMPTZ NOT NULL,
  ends_at    TIMESTAMPTZ NOT NULL,
  note       TEXT NOT NULL DEFAULT '',
  CHECK (ends_at > starts_at)
);
CREATE INDEX time_off_coach_idx ON time_off (coach_id, starts_at);

-- status:
--   booked       upcoming, uses a credit
--   completed    delivered, releases that lesson's share
--   no_show      client didn't come, still releases
--   late_cancel  canceled inside the cancel window, still releases
--   canceled     canceled in time, credit goes back to the client
CREATE TABLE lessons (
  id              SERIAL PRIMARY KEY,
  coach_id        INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  purchase_id     INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  starts_at       TIMESTAMPTZ NOT NULL,
  ends_at         TIMESTAMPTZ NOT NULL,
  status          TEXT NOT NULL DEFAULT 'booked'
                  CHECK (status IN ('booked', 'completed', 'no_show', 'late_cancel', 'canceled')),
  client_note     TEXT NOT NULL DEFAULT '',
  closed_at       TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX lessons_coach_time_idx ON lessons (coach_id, starts_at);
CREATE INDEX lessons_client_idx ON lessons (client_id, starts_at);
CREATE INDEX lessons_purchase_idx ON lessons (purchase_id);

-- Money moving from the hold to the coach. One row per delivered lesson (kind 'lesson'), or one row
-- for the unused balance of an expired package the coach keeps (kind 'forfeit').
-- The UNIQUE lesson_id keeps a lesson from ever paying out twice.
CREATE TABLE releases (
  id                  SERIAL PRIMARY KEY,
  coach_id            INTEGER NOT NULL REFERENCES coaches(id) ON DELETE CASCADE,
  purchase_id         INTEGER NOT NULL REFERENCES purchases(id) ON DELETE CASCADE,
  lesson_id           INTEGER UNIQUE REFERENCES lessons(id) ON DELETE CASCADE,
  kind                TEXT NOT NULL DEFAULT 'lesson' CHECK (kind IN ('lesson', 'forfeit')),
  amount_cents        INTEGER NOT NULL,      -- share of the package taken off the hold
  fee_cents           INTEGER NOT NULL DEFAULT 0,
  status              TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'not_held')),
  stripe_transfer_id  TEXT,
  error               TEXT NOT NULL DEFAULT '',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at             TIMESTAMPTZ
);
CREATE INDEX releases_coach_idx ON releases (coach_id, status);
