-- Wadeea schema + seed for Telnyx SQLDB (SQLite dialect) — ADR 0003.
-- Applied via: telnyx-edge storage sqldb execute <id> --file sql/sqldb_schema_seed.sql
-- Reservations are NOT here: the FleetInventory actor owns them (per-category
-- actor storage). This DB holds reference data + booking records only.

CREATE TABLE IF NOT EXISTS vehicle_categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  total_units INTEGER NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS pricing (
  category_id      TEXT PRIMARY KEY REFERENCES vehicle_categories(id),
  daily_rate_cents INTEGER NOT NULL,
  currency         TEXT NOT NULL DEFAULT 'AED'
);

CREATE TABLE IF NOT EXISTS rental_rules (
  rule_key    TEXT PRIMARY KEY,
  rule_value  TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS document_requirements (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  required_for TEXT NOT NULL,
  description  TEXT
);

CREATE TABLE IF NOT EXISTS bookings (
  booking_id        TEXT PRIMARY KEY,
  customer_name     TEXT NOT NULL,
  customer_phone    TEXT,
  category_id       TEXT NOT NULL REFERENCES vehicle_categories(id),
  start_date        TEXT NOT NULL,
  end_date          TEXT NOT NULL,
  duration_days     INTEGER NOT NULL,
  daily_rate_cents  INTEGER NOT NULL,
  total_cents       INTEGER NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'AED',
  delivery_area     TEXT,
  status            TEXT NOT NULL DEFAULT 'confirmed',
  created_at        TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_phone);

INSERT INTO vehicle_categories (id, name, total_units, description) VALUES
  ('suv',     'SUV',     3, 'Spacious SUV for families'),
  ('sedan',   'Sedan',   5, 'Comfortable sedan'),
  ('luxury',  'Luxury',  2, 'Premium luxury vehicle'),
  ('economy', 'Economy', 4, 'Budget-friendly economy car')
ON CONFLICT (id) DO NOTHING;

INSERT INTO pricing (category_id, daily_rate_cents, currency) VALUES
  ('suv',     25000, 'AED'),
  ('sedan',   15000, 'AED'),
  ('luxury',  50000, 'AED'),
  ('economy', 12000, 'AED')
ON CONFLICT (category_id) DO NOTHING;

INSERT INTO rental_rules (rule_key, rule_value, description) VALUES
  ('min_age',                '21',     'Minimum driver age'),
  ('min_duration_days',      '1',      'Minimum rental duration'),
  ('license_required',       'yes',    'Valid driving license required'),
  ('security_deposit_cents', '150000', 'Security deposit (1500 AED)')
ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO document_requirements (id, name, required_for, description) VALUES
  ('uae_license',  'UAE Driving License',          'residents', 'Valid UAE driving license'),
  ('intl_license', 'International Driving Permit', 'tourists',  'Valid IDP with passport'),
  ('passport',     'Passport',                     'tourists',  'Original passport'),
  ('emirates_id',  'Emirates ID',                  'residents', 'Emirates ID card'),
  ('credit_card',  'Credit Card',                  'all',       'Credit card for security deposit')
ON CONFLICT (id) DO NOTHING;
