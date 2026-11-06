-- Clients can reschedule or cancel online up to 12 hours before a lesson (was 24).
ALTER TABLE coaches ALTER COLUMN cancel_window_hours SET DEFAULT 12;
UPDATE coaches SET cancel_window_hours = 12 WHERE cancel_window_hours = 24;
