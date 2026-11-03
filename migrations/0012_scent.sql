-- Nov 2: scent choice + marketing-photo answer per customer
-- bookings.scent: the scent name the customer picked ("No scent" when they chose none); NULL when there's no interior work
-- or nobody picked one (older jobs, custom jobs Nick added).
ALTER TABLE bookings ADD COLUMN scent TEXT;
-- customers.photos_ok: their answer about marketing photos (Terms §10): 1 OK, 0 opted out, NULL never answered.
-- photos_by: "terms" (agreed by booking), "customer" (their own choice), "owner" (Nick recorded it). bookings.share_* mirror it per job.
ALTER TABLE customers ADD COLUMN photos_ok INTEGER;
ALTER TABLE customers ADD COLUMN photos_at INTEGER;
ALTER TABLE customers ADD COLUMN photos_by TEXT;
