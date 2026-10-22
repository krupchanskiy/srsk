-- 735: итоги разделов, как они написаны в листе проходной (TOTAL под каждым разделом).
-- Нужны для сверки «строки раздела дают одно, а в листе написано другое» после того,
-- как вставка из Excel уже разобрана и сохранена. {"<раздел>": число}
alter table public.fin_gate_sheets add column if not exists section_totals jsonb;

create or replace view public.fin_v_gate_sheets as
  select s.id, s.period, s.payer_account_id, a.name as payer_account_name, a.currency_code,
         s.sheet_total, s.note, s.status, s.posted_at, s.created_at, s.updated_at, s.section_totals
    from fin_gate_sheets s
    join fin_accounts a on a.id = s.payer_account_id
   where fin_is_admin();

DO $mig$
DECLARE
  d text := pg_get_functiondef('public.fin_gate_sheet_save(jsonb)'::regprocedure);
  pairs text[][] := ARRAY[
    [E'''sheet_total'', ''note'', ''rows'']',
     E'''sheet_total'', ''note'', ''rows'', ''section_totals'']'],
    [E'insert into fin_gate_sheets (period, payer_account_id, sheet_total, note)\n    values (v_period, v_payer, nullif(payload->>''sheet_total'', '''')::numeric,',
     E'insert into fin_gate_sheets (period, payer_account_id, sheet_total, note, section_totals)\n    values (v_period, v_payer, nullif(payload->>''sheet_total'', '''')::numeric,'],
    [E'nullif(btrim(coalesce(payload->>''note'', '''')), ''''))\n    returning id into v_id;',
     E'nullif(btrim(coalesce(payload->>''note'', '''')), ''''), nullif(payload->''section_totals'', ''null''::jsonb))\n    returning id into v_id;'],
    [E'      updated_at = now()\n    where id = v_id;',
     E'      section_totals = nullif(payload->''section_totals'', ''null''::jsonb),\n      updated_at = now()\n    where id = v_id;']
  ];
  i int;
BEGIN
  FOR i IN 1 .. array_length(pairs, 1) LOOP
    IF (length(d) - length(replace(d, pairs[i][1], ''))) / length(pairs[i][1]) <> 1 THEN
      RAISE EXCEPTION 'fin_gate_sheet_save: замена % не нашлась ровно один раз', i;
    END IF;
    d := replace(d, pairs[i][1], pairs[i][2]);
  END LOOP;
  EXECUTE d;
END
$mig$;
