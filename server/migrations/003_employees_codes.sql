ALTER TABLE employees ADD COLUMN IF NOT EXISTS public_id text;

UPDATE employees AS employee
SET public_id = 'TT-EMP-' || lpad(numbered.n::text, 3, '0')
FROM (
  SELECT id, row_number() OVER (PARTITION BY company_id ORDER BY created_at, id) AS n
  FROM employees
  WHERE public_id IS NULL OR public_id = ''
) AS numbered
WHERE employee.id = numbered.id;

CREATE UNIQUE INDEX IF NOT EXISTS employees_public_id ON employees (company_id, public_id) WHERE public_id IS NOT NULL;

INSERT INTO counters (company_id, name, value)
SELECT company_id, 'employee', count(*)::int FROM employees GROUP BY company_id
ON CONFLICT (company_id, name) DO UPDATE SET value = GREATEST(counters.value, EXCLUDED.value);

CREATE OR REPLACE FUNCTION techne_employee_code() RETURNS trigger AS $$
DECLARE next_value integer;
BEGIN
  IF NEW.public_id IS NULL OR NEW.public_id = '' THEN
    INSERT INTO counters (company_id, name, value) VALUES (NEW.company_id, 'employee', 1)
    ON CONFLICT (company_id, name) DO UPDATE SET value = counters.value + 1
    RETURNING value INTO next_value;
    NEW.public_id := 'TT-EMP-' || lpad(next_value::text, 3, '0');
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS employees_public_id ON employees;
CREATE TRIGGER employees_public_id BEFORE INSERT ON employees
FOR EACH ROW EXECUTE FUNCTION techne_employee_code();
