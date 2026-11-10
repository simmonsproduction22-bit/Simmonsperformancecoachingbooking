-- Card payments through the coach's own Stripe account ('stripe'): paid straight to the coach, nothing held.
ALTER TABLE purchases DROP CONSTRAINT purchases_method_check;
ALTER TABLE purchases ADD CONSTRAINT purchases_method_check CHECK (method IN ('card', 'offline', 'zelle', 'cashapp', 'stripe'));

-- Packages only new clients can buy (the intro lesson).
ALTER TABLE packages ADD COLUMN first_time_only BOOLEAN NOT NULL DEFAULT FALSE;

-- $60 intro lesson for the coach account that's already set up.
INSERT INTO packages (coach_id, name, description, lesson_count, price_cents, expires_days, sort_order, kind, min_people, max_people, first_time_only)
SELECT c.id, 'Intro Lesson', 'Your first private lesson at an intro price. New clients only.', 1, 6000, 0, 35, 'private', 1, 1, TRUE
FROM coaches c
WHERE c.id = (SELECT MIN(id) FROM coaches)
  AND NOT EXISTS (SELECT 1 FROM packages p WHERE p.coach_id = c.id AND p.name = 'Intro Lesson');
