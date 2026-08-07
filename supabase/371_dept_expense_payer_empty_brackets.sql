-- Когда автор заявки неизвестен, строка получалась с пустыми скобками:
-- «Оплатил: «Завод» ()» — format() подставляет пустую строку вместо NULL,
-- поэтому COALESCE не срабатывал. Собираем скобки конкатенацией: с NULL она даёт NULL.
--
-- ВНИМАНИЕ: этой правки оказалось мало — tg_escape() тоже приводит NULL к пустой строке,
-- см. миграцию 372, где блок переписан целиком. Файл оставлен для истории.
do $$
declare
  v_def text;
  v_старое text := 'v_кто := format(''Оплатил: «%s»'', tg_escape(p_payer_dept))
             || COALESCE(format('' (%s)'', tg_escape(NULLIF(btrim(v_who), ''''))), '''');';
  v_новое text := 'v_кто := format(''Оплатил: «%s»'', tg_escape(p_payer_dept))
             || COALESCE('' ('' || tg_escape(NULLIF(btrim(v_who), '''')) || '')'', '''');';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_notify_dept_expense';

  if position(v_старое in v_def) = 0 then
    raise exception 'фрагмент со скобками не найден — правка отменена';
  end if;

  execute replace(v_def, v_старое, v_новое);
end $$;
