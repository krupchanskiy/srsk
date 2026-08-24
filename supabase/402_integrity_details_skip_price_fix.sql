-- 402: Сторож advance_partial_load сверяет «платежи CRM ↔ загруженный остаток».
-- Дельта-корректировки пересчёта по прайсу (миграция 401) сознательно меняют
-- остаток относительно сумм CRM — из сверки их исключаем, иначе все 10
-- пересчитанных людей выглядят «расхождением». Настоящие расхождения
-- (Адхиягья, Элиада) остаются видимыми.
do $$
declare
  src text := pg_get_functiondef('fin_get_integrity_details(text)'::regprocedure);
  anchor text := 'sum(ob.amount) as в_остатке,';
begin
  if (length(src) - length(replace(src, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'fin_get_integrity_details: якорь не найден или неоднозначен';
  end if;
  src := replace(src, anchor,
    'sum(case when ob.source_document = ''opening_correction''
                    and ob.correction_reason like ''Пересчёт по прайсу CRM%'' then 0
               else ob.amount end) as в_остатке,');
  execute src;
end $$;
