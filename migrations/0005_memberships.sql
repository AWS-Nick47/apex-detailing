-- Apex Membership
CREATE TABLE IF NOT EXISTS memberships (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  status TEXT NOT NULL,              -- pending | active | past_due | paused | ending | cancelled
  type TEXT NOT NULL,                -- wash | int | both
  freq INTEGER NOT NULL,             -- visits per month: 1, 2 or 4
  size INTEGER NOT NULL,
  car TEXT,
  monthly_cents INTEGER NOT NULL,    -- price locked in at sign-up
  qualifying_booking TEXT,           -- the detail that started it
  start_day TEXT NOT NULL,           -- YYYY-MM-DD of the qualifying detail (billing anchor)
  next_bill TEXT,                    -- YYYY-MM-DD of the next charge
  period_start TEXT,                 -- current paid period
  period_end TEXT,
  period_visit_cents INTEGER,        -- value of one visit in the current period (for credits)
  period_type TEXT,                  -- what visits cover this period (winter: wash+int -> int)
  payments_made INTEGER NOT NULL DEFAULT 0,
  credit_cents INTEGER NOT NULL DEFAULT 0,
  fail_count INTEGER NOT NULL DEFAULT 0,
  retry_day TEXT,
  owed_cents INTEGER NOT NULL DEFAULT 0,
  cancel_mode TEXT,                  -- finish | now | after_min
  cancel_requested_at INTEGER,
  ends_on TEXT,                      -- membership ends at the end of this day
  pause_until TEXT,
  card_reminders INTEGER NOT NULL DEFAULT 0,
  terms_version TEXT,
  auth_at INTEGER,
  auth_ip TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memberships_customer ON memberships(customer_id, status);
CREATE INDEX IF NOT EXISTS memberships_bill ON memberships(status, next_bill);

CREATE TABLE IF NOT EXISTS membership_charges (
  id TEXT PRIMARY KEY,
  membership_id TEXT NOT NULL,
  kind TEXT NOT NULL,                -- monthly | cancel_fee | winter_skip | retry
  amount_cents INTEGER NOT NULL,
  credit_used_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,              -- paid | failed | skipped
  payment_id TEXT,
  receipt_url TEXT,
  error TEXT,
  for_day TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS membership_charges_m ON membership_charges(membership_id, created_at);

ALTER TABLE bookings ADD COLUMN kind TEXT DEFAULT 'detail';       -- detail | member
ALTER TABLE bookings ADD COLUMN membership_id TEXT;
ALTER TABLE bookings ADD COLUMN visit_value_cents INTEGER;
ALTER TABLE bookings ADD COLUMN credit_cents INTEGER DEFAULT 0;
CREATE INDEX IF NOT EXISTS bookings_membership ON bookings(membership_id, start_utc);
