-- Free-form ticket labels, stored as a JSON array of strings.
ALTER TABLE tasks ADD COLUMN labels TEXT;
