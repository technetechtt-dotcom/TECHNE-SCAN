ALTER TABLE companies ADD COLUMN IF NOT EXISTS stripe_customer_id text NOT NULL DEFAULT '';
ALTER TABLE employees ADD COLUMN IF NOT EXISTS phone text NOT NULL DEFAULT '';

CREATE TABLE IF NOT EXISTS integrations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  provider text NOT NULL CHECK (provider IN ('xero','sage','pastel','pos','erp','sms','whatsapp')),
  status text NOT NULL DEFAULT 'disconnected' CHECK (status IN ('disconnected','connected')),
  external_id text NOT NULL DEFAULT '',
  access_token text NOT NULL DEFAULT '',
  refresh_token text NOT NULL DEFAULT '',
  token_expires_at timestamptz,
  secret text NOT NULL DEFAULT '',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sync_at timestamptz,
  last_error text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, provider)
);

CREATE TABLE IF NOT EXISTS integration_events (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  provider text NOT NULL,
  direction text NOT NULL CHECK (direction IN ('in','out')),
  kind text NOT NULL,
  external_ref text NOT NULL DEFAULT '',
  status text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS integration_events_ref ON integration_events (company_id, provider, external_ref) WHERE external_ref <> '' AND status = 'ok';

CREATE TABLE IF NOT EXISTS channel_nonces (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  provider text NOT NULL,
  redirect text NOT NULL DEFAULT '',
  expires_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS sales_orders (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual','pos','erp')),
  external_ref text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('open','waved','picking','picked','short','cancelled')),
  created_by uuid REFERENCES employees(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS sales_orders_external ON sales_orders (company_id, source, external_ref) WHERE external_ref <> '';

CREATE TABLE IF NOT EXISTS sales_order_lines (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
  product_id uuid NOT NULL REFERENCES products(id),
  qty integer NOT NULL CHECK (qty > 0)
);

CREATE TABLE IF NOT EXISTS pick_waves (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  branch_id uuid NOT NULL REFERENCES branches(id),
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('released','picking','completed','cancelled')),
  assigned_employee_id uuid REFERENCES employees(id),
  created_by uuid REFERENCES employees(id),
  released_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS pick_lines (
  id uuid PRIMARY KEY,
  wave_id uuid NOT NULL REFERENCES pick_waves(id) ON DELETE CASCADE,
  order_id uuid NOT NULL REFERENCES sales_orders(id),
  order_line_id uuid NOT NULL REFERENCES sales_order_lines(id),
  product_id uuid NOT NULL REFERENCES products(id),
  sequence integer NOT NULL,
  qty_requested integer NOT NULL CHECK (qty_requested > 0),
  qty_picked integer NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','picked','short'))
);

CREATE INDEX IF NOT EXISTS pick_lines_wave_idx ON pick_lines (wave_id, sequence);
CREATE INDEX IF NOT EXISTS sales_orders_company_idx ON sales_orders (company_id, branch_id, status);
