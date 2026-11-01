-- Rate limits (audit IA-033): one row per counted request; the cron deletes rows older than a day.
CREATE TABLE IF NOT EXISTS ratelog (k TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS ratelog_k ON ratelog(k, at);
-- Data integrity (audit IA-038): one live membership per customer; one paid monthly charge per membership per billing day.
CREATE UNIQUE INDEX IF NOT EXISTS memberships_one_live ON memberships(customer_id) WHERE status != 'cancelled';
CREATE UNIQUE INDEX IF NOT EXISTS membership_charges_once ON membership_charges(membership_id, for_day) WHERE status = 'paid' AND kind = 'monthly';
