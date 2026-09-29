-- Wadeea SQL schema (Postgres / Neon)
-- Applied via: psql $DATABASE_URL -f sql/schema.sql

CREATE TABLE IF NOT EXISTS vehicle_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  total_units INTEGER NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS pricing (
  category_id      TEXT PRIMARY KEY,
  daily_rate_cents INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'AED',
  FOREIGN KEY (category_id) REFERENCES vehicle_categories(id)
);

CREATE TABLE IF NOT EXISTS rental_rules (
  rule_key    TEXT PRIMARY KEY,
  rule_value  TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS document_requirements (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  required_for TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id        TEXT PRIMARY KEY,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT,
  category_id       TEXT NOT NULL,
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  duration_days     INTEGER NOT NULL,
  daily_rate_cents  INTEGER NOT NULL,
  total_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'AED',
  delivery_area     TEXT,
  status            TEXT NOT NULL DEFAULT 'confirmed',
  created_at        TEXT NOT NULL DEFAULT (now()::text),
  FOREIGN KEY (category_id) REFERENCES vehicle_categories(id)
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_phone);
CREATE INDEX IF NOT EXISTS idx_bookings_status   ON bookings(status);
