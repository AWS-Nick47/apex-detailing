-- One payment at a time per bill (review after the audit build): a payment "claims" the booking before charging,
-- so two tabs, or Nick's "Charge card" while the customer pays the link, can't both charge the same bill.
ALTER TABLE bookings ADD COLUMN paying_at INTEGER;
