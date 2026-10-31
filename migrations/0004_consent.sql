-- Records of what the customer agreed to (helps with disputes / chargebacks)
ALTER TABLE bookings ADD COLUMN terms_version TEXT;
ALTER TABLE bookings ADD COLUMN terms_at INTEGER;
ALTER TABLE bookings ADD COLUMN terms_ip TEXT;
ALTER TABLE bookings ADD COLUMN sms_ok INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN mem_auth_at INTEGER;
ALTER TABLE customers ADD COLUMN sms_ok INTEGER DEFAULT 0;
ALTER TABLE customers ADD COLUMN sms_ok_at INTEGER;
