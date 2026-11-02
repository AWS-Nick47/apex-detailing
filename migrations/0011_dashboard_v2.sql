-- Owner dashboard v2 (Nov 2): vehicles, job photos + damage pins, Nick's notes, job status, owner log, Square fees.
-- Only adds tables and columns (safe to run on the live database). Apply by hand through the D1 query API.

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  year TEXT, make TEXT, model TEXT, color TEXT,
  plate TEXT,                        -- optional, stored in capitals
  size INTEGER,                      -- 0 sedan, 1 SUV, 2 truck
  notes TEXT,
  src TEXT,                          -- the booking car name it was first made from (so a rename doesn't bring the old one back)
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER                 -- deleting a vehicle keeps its past jobs and photos
);
CREATE INDEX IF NOT EXISTS vehicles_customer ON vehicles(customer_id);

-- the photo checklist for a job (built from the package the first time the job is opened)
CREATE TABLE IF NOT EXISTS job_angles (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  custom INTEGER NOT NULL DEFAULT 0,
  pins TEXT NOT NULL DEFAULT '[]',   -- damage pins on the Before photo: JSON [{x, y, label, note}] (x/y 0..1)
  notes TEXT,                        -- general damage notes for this angle
  removed_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS job_angles_booking ON job_angles(booking_id, sort);

-- photo files live in R2 (binding PHOTOS); this is the index
CREATE TABLE IF NOT EXISTS photos (
  id TEXT PRIMARY KEY,               -- made on the phone, so a repeated upload is the same photo
  booking_id TEXT NOT NULL,
  angle_id TEXT NOT NULL,
  phase TEXT NOT NULL,               -- before | after
  r2_key TEXT NOT NULL,
  thumb_key TEXT NOT NULL,
  w INTEGER, h INTEGER, bytes INTEGER,
  taken_at INTEGER,
  meta TEXT,                         -- JSON {lens, zoom, source}
  hidden INTEGER NOT NULL DEFAULT 0, -- hidden from the customer's gallery
  replaced_at INTEGER,               -- a retake replaced it (kept 30 days, then the files are removed)
  deleted_at INTEGER,
  purged_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_booking ON photos(booking_id, angle_id, phase);

CREATE TABLE IF NOT EXISTS owner_log (at INTEGER NOT NULL, who TEXT, what TEXT NOT NULL, ref TEXT, detail TEXT);
CREATE INDEX IF NOT EXISTS owner_log_ref ON owner_log(ref, at);

-- copy of Square payments (all of them, including Square app / Tap to Pay) for processing fees
CREATE TABLE IF NOT EXISTS square_payments (
  id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  amount_cents INTEGER NOT NULL,
  fee_cents INTEGER,
  refunded_cents INTEGER NOT NULL DEFAULT 0,
  status TEXT, source TEXT, note TEXT,
  updated_at INTEGER
);
CREATE INDEX IF NOT EXISTS square_payments_t ON square_payments(created_at);

ALTER TABLE bookings ADD COLUMN started_at INTEGER;       -- In progress (first photo or "Start job")
ALTER TABLE bookings ADD COLUMN vehicle_id TEXT;
ALTER TABLE bookings ADD COLUMN custom_name TEXT;         -- a custom package name (jobs Nick adds)
ALTER TABLE bookings ADD COLUMN owner_notes TEXT;         -- Nick's private notes
ALTER TABLE bookings ADD COLUMN source TEXT;              -- NULL booked online · 'owner' added from the dashboard
ALTER TABLE bookings ADD COLUMN cancel_reason TEXT;       -- customer | us | noshow
ALTER TABLE bookings ADD COLUMN photos_sent_at INTEGER;   -- the customer's photo gallery is open
ALTER TABLE bookings ADD COLUMN share_ok INTEGER;         -- OK to post the photos: 1 yes, 0 no, NULL not asked
ALTER TABLE bookings ADD COLUMN share_at INTEGER;
ALTER TABLE bookings ADD COLUMN share_by TEXT;            -- customer | owner
ALTER TABLE customers ADD COLUMN owner_notes TEXT;        -- Nick's private notes (gate codes, pets...)
ALTER TABLE customers ADD COLUMN archived_at INTEGER;     -- hidden from the list, records kept
