-- The coach's own name for the About section, where each lesson happens, and the sender IP of
-- Zelle / Cash App submissions (used to rate-limit spam).
ALTER TABLE coaches ADD COLUMN person_name TEXT NOT NULL DEFAULT '';
ALTER TABLE lessons ADD COLUMN location TEXT NOT NULL DEFAULT '';
ALTER TABLE purchases ADD COLUMN submit_ip TEXT NOT NULL DEFAULT '';
CREATE INDEX purchases_submit_ip_idx ON purchases (submit_ip, submitted_at);
