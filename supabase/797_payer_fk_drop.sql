-- 797: внешние ключи payer_id (790) сломали встраивание vaishnavas(...) из residents/bookings —
-- у PostgREST стало две связи с vaishnavas, все такие запросы отвечали 300 (пустая шахматка 18.11).
-- Ключи снимаем, «ON DELETE SET NULL» повторяем триггером.

ALTER TABLE residents DROP CONSTRAINT IF EXISTS residents_payer_id_fkey;
ALTER TABLE bookings  DROP CONSTRAINT IF EXISTS bookings_payer_id_fkey;

CREATE OR REPLACE FUNCTION vaishnavas_clear_payer() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE residents SET payer_id = NULL WHERE payer_id = OLD.id;
  UPDATE bookings  SET payer_id = NULL WHERE payer_id = OLD.id;
  RETURN OLD;
END $$;

DROP TRIGGER IF EXISTS trg_vaishnavas_clear_payer ON vaishnavas;
CREATE TRIGGER trg_vaishnavas_clear_payer
  BEFORE DELETE ON vaishnavas FOR EACH ROW EXECUTE FUNCTION vaishnavas_clear_payer();

NOTIFY pgrst, 'reload schema';
