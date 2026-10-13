-- UI language chosen by the user (en | tr). NULL = follow the browser.
ALTER TABLE user ADD COLUMN language TEXT;
