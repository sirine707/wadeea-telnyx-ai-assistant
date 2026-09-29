-- Wadeea demo seed data (fictional, Postgres / Neon)
-- Applied via: psql $DATABASE_URL -f sql/seed.sql

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
  ('min_age',              '21',     'Minimum driver age'),
  ('min_duration_days',    '1',      'Minimum rental duration'),
  ('license_required',     'yes',    'Valid driving license required'),
  ('security_deposit_cents', '150000', 'Security deposit (1500 AED)')
ON CONFLICT (rule_key) DO NOTHING;

INSERT INTO document_requirements (id, name, required_for, description) VALUES
  ('uae_license',  'UAE Driving License',          'residents', 'Valid UAE driving license'),
  ('intl_license', 'International Driving Permit', 'tourists',  'Valid IDP with passport'),
  ('passport',     'Passport',                     'tourists',  'Original passport'),
  ('emirates_id',  'Emirates ID',                  'residents', 'Emirates ID card'),
  ('credit_card',  'Credit Card',                  'all',       'Credit card for security deposit')
ON CONFLICT (id) DO NOTHING;
