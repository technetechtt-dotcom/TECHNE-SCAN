CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  timezone text NOT NULL DEFAULT 'Africa/Johannesburg',
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS branches (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  code text NOT NULL,
  address text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, code)
);

CREATE TABLE IF NOT EXISTS employees (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  email text NOT NULL,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner','admin','manager','supervisor','clerk','viewer')),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS employees_email_ci ON employees (lower(email));

CREATE TABLE IF NOT EXISTS sessions (
  id uuid PRIMARY KEY,
  employee_id uuid NOT NULL REFERENCES employees(id),
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS counters (
  company_id uuid NOT NULL REFERENCES companies(id),
  name text NOT NULL,
  value integer NOT NULL,
  PRIMARY KEY (company_id, name)
);

CREATE TABLE IF NOT EXISTS assets (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  public_id text NOT NULL,
  name text NOT NULL,
  category text NOT NULL,
  department text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  serial text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'available' CHECK (status IN ('available','out')),
  holder text NOT NULL DEFAULT '',
  due date,
  condition text NOT NULL DEFAULT 'Good',
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, public_id)
);

CREATE INDEX IF NOT EXISTS assets_company_idx ON assets (company_id, branch_id);

CREATE TABLE IF NOT EXISTS products (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  sku text NOT NULL,
  name text NOT NULL,
  department text NOT NULL DEFAULT '',
  aisle text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  qty integer NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS products_sku_ci ON products (company_id, lower(sku));
CREATE INDEX IF NOT EXISTS products_company_idx ON products (company_id, branch_id);

CREATE TABLE IF NOT EXISTS stock_ledger (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  product_id uuid NOT NULL REFERENCES products(id),
  qty_delta integer NOT NULL,
  balance_after integer NOT NULL,
  reason text NOT NULL,
  ref_type text NOT NULL DEFAULT '',
  ref_id uuid,
  note text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES employees(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stock_ledger_product_idx ON stock_ledger (product_id, at);

CREATE TABLE IF NOT EXISTS custody_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  asset_id uuid NOT NULL REFERENCES assets(id),
  kind text NOT NULL CHECK (kind IN ('out','in')),
  person text NOT NULL,
  condition text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  location text NOT NULL DEFAULT '',
  actor_id uuid REFERENCES employees(id),
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custody_events_company_idx ON custody_events (company_id, at);

CREATE TABLE IF NOT EXISTS schedules (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  scope text NOT NULL,
  scope_value text NOT NULL DEFAULT '',
  frequency text NOT NULL CHECK (frequency IN ('daily','weekly','monthly')),
  time_of_day text NOT NULL,
  weekday integer,
  day_of_month integer,
  assigned_employee_id uuid REFERENCES employees(id),
  active boolean NOT NULL DEFAULT true,
  next_run_at timestamptz NOT NULL,
  last_run_at timestamptz,
  created_by uuid REFERENCES employees(id),
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS stocktakes (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  schedule_id uuid REFERENCES schedules(id),
  name text NOT NULL,
  scope text NOT NULL,
  scope_value text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('active','completed','approved')),
  assigned_employee_id uuid REFERENCES employees(id),
  created_by uuid REFERENCES employees(id),
  snapshot_at timestamptz NOT NULL DEFAULT now(),
  submitted_at timestamptz,
  approved_by uuid REFERENCES employees(id),
  approved_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS stocktakes_company_idx ON stocktakes (company_id, branch_id);

CREATE TABLE IF NOT EXISTS stocktake_lines (
  stocktake_id uuid NOT NULL REFERENCES stocktakes(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  expected integer NOT NULL,
  counted integer,
  movement integer NOT NULL DEFAULT 0,
  variance integer,
  PRIMARY KEY (stocktake_id, product_id)
);

CREATE TABLE IF NOT EXISTS devices (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('OPN-2001','Phone','Other')),
  serial text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','retired')),
  last_seen_at timestamptz,
  version integer NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS imports (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  device_id uuid REFERENCES devices(id),
  name text NOT NULL,
  records jsonb NOT NULL,
  applied_stocktake_id uuid REFERENCES stocktakes(id),
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  employee_id uuid NOT NULL REFERENCES employees(id),
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  href text NOT NULL DEFAULT '',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notifications_employee_idx ON notifications (employee_id, created_at);

CREATE TABLE IF NOT EXISTS audit_log (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  actor_id uuid,
  action text NOT NULL,
  entity text NOT NULL,
  entity_id uuid,
  detail jsonb NOT NULL DEFAULT '{}',
  at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS audit_log_company_idx ON audit_log (company_id, at);
