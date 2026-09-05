-- 419. Формулировка комментария у добора начального остатка
--
-- Комментарий перечислял ВСЕ платежи до рубежа, хотя строка добирает только
-- разницу: «Оплачено до запуска: 5000 RUB + 182520 RUB» на строке в 191 646 ₹
-- читалось так, будто она задваивает уже учтённые 5 250 ₹.
do $do$
declare v_def text;
begin
  select pg_get_functiondef(p.oid) into v_def from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'fin_resolve_missing_advance';
  if position('Оплачено до запуска: %s (%s пл.)' in v_def) = 0 then
    raise notice 'Формулировка уже другая, менять нечего';
    return;
  end if;
  v_def := replace(v_def,
    'coalesce(v_note, format(''Оплачено до запуска: %s (%s пл.)'', d.расшифровка, d.штук)),',
    'coalesce(v_note, case when d.в_остатке > 0.005
        then format(''Добор до полной суммы: платежи до запуска %s (%s пл.), в остатке уже было %s'',
                    d.расшифровка, d.штук, fin_fmt_money(d.в_остатке, ''INR''))
        else format(''Оплачено до запуска: %s (%s пл.)'', d.расшифровка, d.штук) end),');
  execute v_def;
end
$do$;

-- Уже созданные три строки добора — привести к новой формулировке
update fin_participant_opening_balances ob
   set comment = format('Добор до полной суммы: платежи до запуска %s, в остатке уже было %s',
                        x.платежи, fin_fmt_money(x.было, 'INR'))
  from (values
    ('Оплачено до запуска: 5000 RUB + 182520 RUB (2 пл.)', '5000 RUB + 182520 RUB (2 пл.)', 5250::numeric),
    ('Оплачено до запуска: 11000 RUB (1 пл.)',             '11000 RUB (1 пл.)',             11000::numeric),
    ('Оплачено до запуска: 20000 RUB + 4000 RUB + 17280 RUB (3 пл.)', '20000 RUB + 4000 RUB + 17280 RUB (3 пл.)', 27400::numeric)
  ) as x(старый, платежи, было)
 where ob.source_document = 'Добор к загрузке рубежа: платёж подтверждён позже'
   and ob.comment = x.старый;
