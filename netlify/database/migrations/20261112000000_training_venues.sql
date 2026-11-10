-- Where lessons happen, shown on the coach page (items separated by " · ").
ALTER TABLE coaches ADD COLUMN venues TEXT NOT NULL DEFAULT '';
