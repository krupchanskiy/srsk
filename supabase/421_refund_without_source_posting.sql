-- 421. Возврат аванса разрешён без ссылки на исходную проводку
--
-- Гвард fin_postings_validate требовал refund_of_posting_id у любого возврата.
-- Но у аванса, пришедшего из загрузки рубежа, исходной проводки нет вовсе —
-- ссылаться не на что. Послабление узкое: возврат без источника допустим,
-- только если проводка именная и гасит общий аванс участника.
do $do$
declare
  v_def   text;
  v_якорь text := 'IF v_op.type = ''refund'' AND NEW.refund_of_posting_id IS NULL THEN
      RAISE EXCEPTION ''invalid_payload'' USING DETAIL = ''refund требует refund_of_posting_id'';
    END IF;';
  v_новый text := 'IF v_op.type = ''refund'' AND NEW.refund_of_posting_id IS NULL
       AND NOT (NEW.participant_id IS NOT NULL AND NEW.participant_balance_kind = ''general'') THEN
      RAISE EXCEPTION ''invalid_payload''
        USING DETAIL = ''refund требует refund_of_posting_id — без него допустим только возврат аванса участника'';
    END IF;';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_postings_validate';

  if v_def is null then
    raise exception 'Функция fin_postings_validate не найдена';
  end if;
  if position('без него допустим только возврат аванса участника' in v_def) > 0 then
    raise notice 'Послабление уже внесено';
    return;
  end if;
  if position(v_якорь in v_def) = 0 then
    raise exception 'Якорь проверки refund_of_posting_id не найден — функция изменилась';
  end if;

  execute replace(v_def, v_якорь, v_новый);
end
$do$;
