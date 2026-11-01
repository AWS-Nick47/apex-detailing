-- A retry of the same booking (lost response, timeout) returns the booking already made instead of a duplicate. Audit IA-011.
ALTER TABLE bookings ADD COLUMN client_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_client_key ON bookings(client_key) WHERE client_key IS NOT NULL;
