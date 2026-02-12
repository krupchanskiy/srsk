-- Расширяем CHECK constraint для статусов регистрации: добавляем volunteer и vip
ALTER TABLE retreat_registrations
  DROP CONSTRAINT retreat_registrations_status_check;
ALTER TABLE retreat_registrations
  ADD CONSTRAINT retreat_registrations_status_check
  CHECK (status = ANY (ARRAY['guest','team','volunteer','vip','cancelled']));
