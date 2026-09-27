-- Старая система расчёта с участниками — только Сева-ретрит (ВГ, 27.09)
--
-- Фаза 2 (docs/finance/phase2_debt_in_price_currency.md): новые события считают
-- долг участника в валюте, которую гость выбрал при оплате, без перевода в ₹.
-- Сева-ретрит сведён по старой системе (начисления и долг в ₹) и остаётся на
-- ней, в том числе для поздних доплат. Новая система — по умолчанию, пометка
-- ставится только старому событию. Сама по себе колонка пока ничего не меняет:
-- формулы начнут её читать на следующих шагах.

alter table fin_accounting_objects
  add column legacy_inr_settlement boolean not null default false;

comment on column fin_accounting_objects.legacy_inr_settlement is
  'Старая система расчёта (только прошлые ретриты): начисления и долг участника в ₹, каждый платёж переводится в ₹. false — новая система (валюта расчёта гостя).';

update fin_accounting_objects
   set legacy_inr_settlement = true
 where id = '84a9abec-fcf5-4abe-b166-8924290db0be';  -- Сева-ретрит
