-- Стоп-кран на время переноса 1 августа.
--
-- Запрос ВГ (30.07.2026): «Да нужно, для перестраховки и избегания расхождений».
-- Пока идёт снимок → сброс → ввод остатков, любая операция, внесённая менеджером,
-- разъедется с тем, что мы переносим руками.
--
-- Блокировка стоит в fin_actor(): через неё проходят ВСЕ операции записи
-- финмодуля (движок проводок, сторно, курсы, согласование). Чтения не касается —
-- журнал и остатки видны, просто ничего нельзя внести.
--
-- Тот, кто включил режим, продолжает работать: перенос делает он же. Остальные
-- получают внятный отказ, а не молчаливую ошибку.

create or replace function fin_maintenance_by()
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $$ SELECT nullif(value, '')::uuid FROM fin_settings WHERE key = 'maintenance_by' $$;

grant execute on function fin_maintenance_by() to authenticated;

-- Включить/выключить. Только администратор финансов; при включении запоминаем,
-- кто именно — ему блокировка не мешает.
create or replace function fin_set_maintenance(p_on boolean)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE v_uid uuid := auth.uid();
BEGIN
  IF NOT fin_is_admin(v_uid) THEN
    RETURN jsonb_build_object('ok', false, 'error',
      jsonb_build_object('code', 'forbidden', 'message', 'Режим переноса включает только администратор финансов'));
  END IF;

  IF p_on THEN
    INSERT INTO fin_settings (key, value, updated_at) VALUES ('maintenance_by', v_uid::text, now())
    ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now();
  ELSE
    DELETE FROM fin_settings WHERE key = 'maintenance_by';
  END IF;

  RETURN jsonb_build_object('ok', true, 'result', jsonb_build_object('maintenance', p_on));
END;
$function$;

grant execute on function fin_set_maintenance(boolean) to authenticated;

-- Сам стоп-кран внутри единой точки входа всех операций записи
create or replace function fin_actor()
returns uuid
language plpgsql
stable
security definer
set search_path to 'public'
as $function$
DECLARE
  v_uid uuid;
  v_by  uuid;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN
    RAISE EXCEPTION 'unauthorized' USING ERRCODE = '28000';
  END IF;

  v_by := fin_maintenance_by();
  IF v_by IS NOT NULL AND v_by <> v_uid THEN
    RAISE EXCEPTION 'maintenance'
      USING DETAIL = 'Идёт перенос на новый учёт: операции временно не проводятся. '
                  || 'Запишите трату и внесите её, когда перенос закончится.';
  END IF;

  RETURN v_uid;
END;
$function$;
