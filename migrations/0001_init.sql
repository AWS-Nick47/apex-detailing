-- Apex Detailing booking database (Cloudflare D1)

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,               -- short booking code shown to the customer, e.g. AX7K2M
  token TEXT NOT NULL UNIQUE,        -- secret for the customer's manage link
  ack_token TEXT NOT NULL UNIQUE,    -- secret for Nick's "Got it" link
  status TEXT NOT NULL DEFAULT 'confirmed',   -- confirmed | cancelled
  created_at INTEGER NOT NULL,       -- ms since epoch (UTC)
  start_utc INTEGER NOT NULL,        -- ms since epoch
  end_utc INTEGER NOT NULL,
  day TEXT NOT NULL,                 -- YYYY-MM-DD in New York time
  pkg TEXT NOT NULL,                 -- exterior | interior | full
  size INTEGER NOT NULL,             -- 0 sedan, 1 SUV, 2 truck
  adds TEXT NOT NULL DEFAULT '[]',   -- JSON array of add-on ids
  plan TEXT,                         -- JSON of the membership the customer asked for, if any
  quote INTEGER,                     -- total the customer saw, dollars
  travel_fee INTEGER DEFAULT 0,
  miles REAL,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL,
  address TEXT NOT NULL,
  town TEXT,
  car TEXT,
  color TEXT,
  water TEXT,
  power TEXT,
  concerns TEXT,
  heard TEXT,
  notes TEXT,
  card_on_file INTEGER DEFAULT 0,
  remind INTEGER DEFAULT 1,          -- customer wants a reminder email the day before
  reminded_at INTEGER,
  acked_at INTEGER,
  cancelled_at INTEGER,
  cal_href TEXT,                     -- where the event lives in the Apex Jobs calendar
  history TEXT DEFAULT '[]'          -- JSON log of reschedules
);
CREATE INDEX IF NOT EXISTS bookings_day ON bookings(day, status);
CREATE INDEX IF NOT EXISTS bookings_start ON bookings(start_utc);

-- Busy times copied from Nick's iCloud calendars every few minutes (no titles stored)
CREATE TABLE IF NOT EXISTS busy (
  start_utc INTEGER NOT NULL,
  end_utc INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'event'  -- event | blocked | job
);
CREATE INDEX IF NOT EXISTS busy_start ON busy(start_utc);

CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
