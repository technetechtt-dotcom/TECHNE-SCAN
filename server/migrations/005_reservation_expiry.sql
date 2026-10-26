DO $$
DECLARE constraint_name text;
BEGIN
  FOR constraint_name IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'asset_reservations'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) ILIKE '%status%'
  LOOP
    EXECUTE format('ALTER TABLE asset_reservations DROP CONSTRAINT %I', constraint_name);
  END LOOP;
END $$;
ALTER TABLE asset_reservations ADD CONSTRAINT asset_reservations_status_check CHECK (status IN ('booked','cancelled','fulfilled','expired'));
