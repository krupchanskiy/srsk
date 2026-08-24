-- 405: Стартовые general-кредит и general-долг — одна позиция, их нужно
-- неттить ДО раскладки кредита по блокам. Иначе (Николай Зайцев, ВГ 24.08):
-- кредит 25 200 растекается по блокам (25 000 в оргвзнос + 200 в проживание),
-- а долг-коррекция 200 (пересчёт по прайсу, миграция 401) повисает отдельным
-- general-долгом — остаток проживания занижен, и после оплаты «по подсказкам»
-- остаются 200 ₹. После неттинга: кредит 25 000 → оргвзнос закрыт, проживание
-- 25 500 целиком (= полной цене CRM), итог не меняется.
-- Сухой прогон по Сева-ретриту: меняются только Николай Зайцев и Ирина
-- Воронцова (у остальных долг-коррекции полностью покрыты кредитом), net у всех
-- без изменений.
do $$
declare
  src text := pg_get_functiondef('fin_private_participant_balance(uuid,uuid)'::regprocedure);
  anchor text := 'v_remaining := v_general_credit + v_general_signed;';
begin
  if (length(src) - length(replace(src, anchor, ''))) / length(anchor) <> 1 then
    raise exception 'fin_private_participant_balance: якорь не найден или неоднозначен';
  end if;
  src := replace(src, anchor,
    '-- стартовые general-кредит и general-долг — одна позиция: сначала неттинг,
  -- иначе кредит растекается по блокам, а долг-коррекция повисает отдельно
  v_apply := LEAST(v_general_credit, GREATEST(v_general_debt, 0));
  v_general_credit := v_general_credit - v_apply;
  v_general_debt := v_general_debt - v_apply;
  ' || anchor);
  execute src;
end $$;
