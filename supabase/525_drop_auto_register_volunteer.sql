-- Решение ВГ 25.09.2026 (вариант А): команда и волонтёры не участники ретрита, если
-- приехали не под ретрит. Старый триггер регистрировал волонтёра на ВСЕ ретриты,
-- пересекающиеся с проживанием по датам. Теперь регистрация — только по ретриту
-- самой брони (триггер trg_residents_link_retreat_registration, миграция 524).
drop trigger if exists trg_auto_register_volunteer on public.residents;
drop function if exists public.auto_register_volunteer();
