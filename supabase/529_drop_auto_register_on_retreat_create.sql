-- Решение ВГ 25.09.2026 (вариант А): команда и волонтёры не записываются на ретрит
-- автоматически. Волонтёр, приехавший под ретрит, привязывается к нему через бронь
-- (триггер trg_residents_link_retreat_registration, миграция 524); остальные — за департаментом.
-- Старый триггер при создании ретрита записывал всю команду (is_team_member) и
-- волонтёров, проживающих в эти даты. Уже созданные им регистрации не трогаем —
-- их разбор в отдельной задаче.
drop trigger if exists trg_auto_register_on_retreat_create on public.retreats;
drop function if exists public.auto_register_on_retreat_create();
