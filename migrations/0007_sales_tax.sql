-- NJ sales tax (6.625%) is added to every customer bill (decided Nov 1, 2026).
-- Amounts stay BEFORE tax (bookings.final_cents, membership_charges.amount_cents); the tax is stored next to them.
-- Old rows have no tax (NULL / 0).
ALTER TABLE bookings ADD COLUMN tax_cents INTEGER;                              -- sales tax on final_cents, set when the job is billed or paid
ALTER TABLE membership_charges ADD COLUMN tax_cents INTEGER NOT NULL DEFAULT 0; -- sales tax on amount_cents (the customer was charged amount + tax)
