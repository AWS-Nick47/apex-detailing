-- Customer accounts (sign in with an emailed 6-digit code)

CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  phone TEXT,
  address TEXT,
  town TEXT,
  lat REAL,
  lon REAL,
  notes TEXT,                         -- spigot/outlet/gate notes the customer saves
  cars TEXT NOT NULL DEFAULT '[]',    -- JSON [{name, color, size}]
  remind INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  square_customer_id TEXT,
  card TEXT                           -- JSON {id, brand, last4, exp} of the saved Square card
);

CREATE TABLE IF NOT EXISTS login_codes (
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS login_codes_email ON login_codes(email, created_at);

CREATE TABLE IF NOT EXISTS sessions (
  id_hash TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

ALTER TABLE bookings ADD COLUMN customer_id TEXT;
CREATE INDEX IF NOT EXISTS bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS bookings_email ON bookings(email);
