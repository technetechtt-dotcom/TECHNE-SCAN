ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan text NOT NULL DEFAULT 'starter';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_status text NOT NULL DEFAULT 'active';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS plan_until timestamptz;

DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'devices'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%kind%'
  LOOP
    EXECUTE format('ALTER TABLE devices DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE devices ADD CONSTRAINT devices_kind_check CHECK (kind IN ('OPN-2001','Phone','USB','Bluetooth','Wireless','Other'));

CREATE TABLE IF NOT EXISTS billing_checkouts (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES companies(id),
  plan text NOT NULL,
  amount_cents integer NOT NULL,
  currency text NOT NULL DEFAULT 'ZAR',
  status text NOT NULL DEFAULT 'pending',
  provider text NOT NULL,
  provider_ref text,
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
