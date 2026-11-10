-- Public contact details and a one-line credentials strip for the About section.
ALTER TABLE coaches
  ADD COLUMN contact_email TEXT NOT NULL DEFAULT '',
  ADD COLUMN contact_phone TEXT NOT NULL DEFAULT '',   -- shown exactly as typed, e.g. "(469) 307 6899"
  ADD COLUMN credentials   TEXT NOT NULL DEFAULT '';   -- items separated by " · "
