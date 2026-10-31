-- Getting paid after the job (Square)
ALTER TABLE bookings ADD COLUMN card TEXT;             -- JSON {id, brand, last4} of the card the customer chose for THIS booking
ALTER TABLE bookings ADD COLUMN pay_token TEXT;        -- secret for the customer's pay / tip page
ALTER TABLE bookings ADD COLUMN completed_at INTEGER;   -- Nick marked the job done
ALTER TABLE bookings ADD COLUMN final_cents INTEGER;    -- final price Nick confirmed
ALTER TABLE bookings ADD COLUMN paid_at INTEGER;
ALTER TABLE bookings ADD COLUMN paid_method TEXT;       -- card_on_file | online | in_person
ALTER TABLE bookings ADD COLUMN payment_id TEXT;
ALTER TABLE bookings ADD COLUMN receipt_url TEXT;
ALTER TABLE bookings ADD COLUMN tip_cents INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN tip_payment_id TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS bookings_pay_token ON bookings(pay_token);
