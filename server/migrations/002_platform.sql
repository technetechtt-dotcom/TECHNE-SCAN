ALTER TABLE sessions ADD COLUMN IF NOT EXISTS last_seen_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS revoked_at timestamptz;

ALTER TABLE employees ADD COLUMN IF NOT EXISTS mfa_secret text;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS mfa_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS failed_logins integer NOT NULL DEFAULT 0;
ALTER TABLE employees ADD COLUMN IF NOT EXISTS locked_until timestamptz;

ALTER TABLE companies ADD COLUMN IF NOT EXISTS qr_secret text;
ALTER TABLE companies ADD COLUMN IF NOT EXISTS settings jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'assets'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE assets DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE assets ADD CONSTRAINT assets_status_check CHECK (status IN ('available','out','reserved','maintenance','lost','damaged','stolen','retired','written_off'));
ALTER TABLE assets ADD COLUMN IF NOT EXISTS qr_version integer NOT NULL DEFAULT 1;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS purchase_date date;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS purchase_cost numeric(12,2);
ALTER TABLE assets ADD COLUMN IF NOT EXISTS supplier text NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS warranty_until date;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS insurance_policy text NOT NULL DEFAULT '';
ALTER TABLE assets ADD COLUMN IF NOT EXISTS insurance_until date;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS residual_value numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS useful_life_months integer NOT NULL DEFAULT 36;
ALTER TABLE assets ADD COLUMN IF NOT EXISTS attributes jsonb NOT NULL DEFAULT '{}'::jsonb;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'custody_events'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE custody_events DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE custody_events ADD CONSTRAINT custody_events_kind_check CHECK (kind IN ('out','in','transfer','reserve','release','maintenance','lifecycle','inspect'));
ALTER TABLE custody_events ADD COLUMN IF NOT EXISTS signature_name text NOT NULL DEFAULT '';
ALTER TABLE custody_events ADD COLUMN IF NOT EXISTS photo_note text NOT NULL DEFAULT '';

ALTER TABLE products ADD COLUMN IF NOT EXISTS reorder_level integer NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS unit text NOT NULL DEFAULT 'each';
ALTER TABLE products ADD COLUMN IF NOT EXISTS shelf text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS rack text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS bin text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS abc_class text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS lot text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS serial_no text NOT NULL DEFAULT '';
ALTER TABLE products ADD COLUMN IF NOT EXISTS expires_on date;
ALTER TABLE products ADD COLUMN IF NOT EXISTS cost numeric(12,2) NOT NULL DEFAULT 0;
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url text NOT NULL DEFAULT '';

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'stocktakes'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE stocktakes DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE stocktakes ADD CONSTRAINT stocktakes_status_check CHECK (status IN ('active','paused','completed','approved','cancelled'));
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS zone text NOT NULL DEFAULT '';
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS review_note text NOT NULL DEFAULT '';
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS double_count boolean NOT NULL DEFAULT false;
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS paused_at timestamptz;
ALTER TABLE stocktakes ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;

ALTER TABLE stocktake_lines ADD COLUMN IF NOT EXISTS counted_2 integer;
ALTER TABLE stocktake_lines ADD COLUMN IF NOT EXISTS recount integer;
ALTER TABLE stocktake_lines ADD COLUMN IF NOT EXISTS exception text NOT NULL DEFAULT '';

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'schedules'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%frequency%'
  LOOP
    EXECUTE format('ALTER TABLE schedules DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE schedules ADD CONSTRAINT schedules_frequency_check CHECK (frequency IN ('daily','weekly','monthly','interval'));
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS interval_days integer;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS paused boolean NOT NULL DEFAULT false;
ALTER TABLE schedules ADD COLUMN IF NOT EXISTS abc_class text NOT NULL DEFAULT '';

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'devices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE devices DROP CONSTRAINT %I', constraint_name);
  END LOOP;
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'devices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE devices DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check CHECK (kind IN ('OPN-2001','Phone','USB','Bluetooth','Other'));
ALTER TABLE devices ADD CONSTRAINT devices_status_check CHECK (status IN ('active','repair','retired'));
ALTER TABLE devices ADD COLUMN IF NOT EXISTS firmware text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS holder text NOT NULL DEFAULT '';

ALTER TABLE imports ADD COLUMN IF NOT EXISTS batch_key text;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash text PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS mfa_backup_codes (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  code_hash text NOT NULL,
  used_at timestamptz
);

CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rate_limits (
  bucket text PRIMARY KEY,
  hits integer NOT NULL,
  window_start timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  company_id uuid NOT NULL REFERENCES companies(id),
  key text NOT NULL,
  request_hash text NOT NULL,
  status_code integer NOT NULL,
  response jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (company_id, key)
);

CREATE TABLE IF NOT EXISTS scheduler_lock (
  id integer PRIMARY KEY,
  locked_until timestamptz NOT NULL
);
INSERT INTO scheduler_lock (id, locked_until) VALUES (1, '1970-01-01T00:00:00Z') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS asset_reservations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  person text NOT NULL,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'booked' CHECK (status IN ('booked','cancelled','fulfilled')),
  notes text NOT NULL DEFAULT '',
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_maintenance (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL,
  detail text NOT NULL DEFAULT '',
  cost numeric(12,2) NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  actor_id uuid REFERENCES employees(id)
);

CREATE TABLE IF NOT EXISTS asset_photos (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL,
  note text NOT NULL DEFAULT '',
  data_url text NOT NULL,
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS contractors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  company_name text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS asset_categories (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  attributes jsonb NOT NULL DEFAULT '[]'::jsonb,
  UNIQUE (company_id, name)
);

CREATE TABLE IF NOT EXISTS stocktake_assignees (
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  employee_id uuid NOT NULL REFERENCES employees(id),
  zone text NOT NULL DEFAULT '',
  PRIMARY KEY (stocktake_id, employee_id)
);

CREATE TABLE IF NOT EXISTS stocktake_evidence (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id uuid REFERENCES products(id),
  note text NOT NULL,
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS blackout_dates (
  company_id uuid NOT NULL REFERENCES companies(id),
  day date NOT NULL,
  reason text NOT NULL DEFAULT '',
  PRIMARY KEY (company_id, day)
);

CREATE TABLE IF NOT EXISTS device_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  device_id uuid NOT NULL REFERENCES devices(id),
  kind text NOT NULL,
  detail text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  supplier text NOT NULL,
  reference text NOT NULL DEFAULT '',
  lines jsonb NOT NULL,
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stock_transfers (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  from_branch_id uuid NOT NULL REFERENCES branches(id),
  to_branch_id uuid NOT NULL REFERENCES branches(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL,
  note text NOT NULL DEFAULT '',
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS deletion_requests (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  status text NOT NULL DEFAULT 'requested',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS invitations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  email text NOT NULL,
  role text NOT NULL,
  branch_id uuid NOT NULL REFERENCES branches(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  accepted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  created_by uuid REFERENCES employees(id),
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS webhooks (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  url text NOT NULL,
  event text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS imports_batch_key_unique ON imports (company_id, batch_key) WHERE batch_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS stock_ledger_count_once ON stock_ledger (ref_id, product_id) WHERE reason = 'count_adjustment' AND ref_id IS NOT NULL;

CREATE OR REPLACE FUNCTION techne_forbid_change() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'This record is immutable';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_log_immutable ON audit_log;
CREATE TRIGGER audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION techne_forbid_change();

DROP TRIGGER IF EXISTS stock_ledger_immutable ON stock_ledger;
CREATE TRIGGER stock_ledger_immutable BEFORE UPDATE OR DELETE ON stock_ledger
FOR EACH ROW EXECUTE FUNCTION techne_forbid_change();
