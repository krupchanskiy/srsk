-- 407: Дата начисления (ВГ, 25.08): у перерасчёта должна быть дата изменения,
-- как у платежа, а не только служебная отметка создания.
alter table fin_charges add column if not exists occurred_on date not null default current_date;

-- вью пересоздано с колонкой occurred_on в конце (порядок колонок вью менять нельзя)
-- и fin_create_charge принимает ключ occurred_on (COALESCE к CURRENT_DATE) —
-- полный текст применён через MCP apply_migration, см. историю миграций 407/407b.
