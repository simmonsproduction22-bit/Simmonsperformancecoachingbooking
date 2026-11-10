-- Packages no longer expire. expires_days = 0 means "never"; purchases keep a NULL expires_at.
ALTER TABLE packages ALTER COLUMN expires_days SET DEFAULT 0;
UPDATE packages SET expires_days = 0;
UPDATE purchases SET expires_at = NULL WHERE status IN ('pending', 'paid');
