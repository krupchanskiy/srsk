-- Денежные таблицы CRM были открыты любому вошедшему — включая гостей портала.
-- Найдено аудитом 19.10.2026 (проверено в откате под гостем):
--   * crm_payment_history: гость читал всю историю платежей (501 строку)
--     и вставлял поддельные записи «подтверждено»;
--   * crm_prepayment_operations: гость читал, менял (amount × 100)
--     и удалял операции предоплат — триггер пересчитывал балансы;
--   * crm_participant_balance: гость видел балансы всех участников;
--   * crm_payment_systems: список систем оплаты — любому вошедшему.
--   * crm_sync_transfer (security definer, без проверки прав) — гость
--     переписывал рейс и «трансфер нужен» любой регистрации.
-- Теперь — как у остальных таблиц CRM: только сотрудники (is_staff).
-- Историю платежей пишет только триггер crm_payment_log_history (definer).

alter policy crm_payment_history_read on public.crm_payment_history
    using ((select is_staff((select auth.uid()))));
drop policy if exists crm_payment_history_write on public.crm_payment_history;

alter policy ppo_select on public.crm_prepayment_operations to authenticated
    using ((select is_staff((select auth.uid()))));
alter policy ppo_insert on public.crm_prepayment_operations to authenticated
    with check ((select is_staff((select auth.uid()))));
alter policy ppo_update on public.crm_prepayment_operations to authenticated
    using ((select is_staff((select auth.uid()))));
alter policy ppo_delete on public.crm_prepayment_operations to authenticated
    using ((select is_staff((select auth.uid()))));

alter policy pb_select on public.crm_participant_balance to authenticated
    using ((select is_staff((select auth.uid()))));

alter policy crm_payment_systems_read on public.crm_payment_systems
    using ((select is_staff((select auth.uid()))));
alter policy crm_payment_systems_write on public.crm_payment_systems
    using ((select exists (select 1 from superusers where user_id = (select auth.uid()))))
    with check ((select exists (select 1 from superusers where user_id = (select auth.uid()))));

-- функцию вызывают только триггеры
revoke execute on function public.crm_sync_transfer(uuid, text, timestamptz, text, text)
    from public, anon, authenticated;
