-- Период питания может не совпадать с периодом проживания
-- (например, гость съезжает из комнаты раньше, но продолжает питаться).
-- NULL = питание по датам проживания (check_in/check_out), как раньше.
ALTER TABLE residents ADD COLUMN IF NOT EXISTS meal_start_date DATE;
ALTER TABLE residents ADD COLUMN IF NOT EXISTS meal_end_date DATE;
