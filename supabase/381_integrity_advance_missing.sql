-- Сторож ловил только расхождение при существующем начальном остатке. Тех, у кого
-- остатка нет вовсе, он не видел: 13 человек с подтверждёнными взносами на 162 700 ₹
-- просто отсутствовали в учёте, и никто об этом не знал. Добавляем проверку.
do $$
declare
  v_def text;
  v_якорь text := '    jsonb_build_object(''name'',''advance_partial_load'',';
  v_новая text :=
'    jsonb_build_object(''name'',''advance_missing'',
      ''detail'',''Взносы подтверждены в CRM, но человека нет в учёте: ни начального остатка, ни проводок'',
      ''sql'',''SELECT count(*) FROM (SELECT cd.vaishnava_id, cd.retreat_id FROM crm_payments cp JOIN crm_deals cd ON cd.id=cp.deal_id WHERE cp.is_confirmed AND NOT EXISTS (SELECT 1 FROM fin_operations o WHERE o.id=cp.id) AND NOT EXISTS (SELECT 1 FROM fin_participant_opening_balances ob WHERE ob.participant_id=cd.vaishnava_id AND ob.retreat_id=cd.retreat_id) GROUP BY 1,2) x''),
';
begin
  select pg_get_functiondef(p.oid) into v_def
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_run_integrity_checks';

  if position(v_якорь in v_def) = 0 then
    raise exception 'якорь advance_partial_load не найден — правка отменена';
  end if;
  if position('advance_missing' in v_def) > 0 then
    raise notice 'проверка advance_missing уже есть';
    return;
  end if;

  execute replace(v_def, v_якорь, v_новая || v_якорь);
end $$;
