-- Права на CRM — по правам CRM, а не «любой сотрудник».
--
-- Было: все таблицы CRM открывались is_staff — любым сотрудником с любой
-- ролью. Повар, фотограф, продавец магазина видели 347 сделок, 1936 записей
-- переписки, 200 платежей и могли удалить все задачи и всю переписку
-- (проверено аудитом 19.10.2026). Решение Адриана: «это безобразие,
-- ограничивай права; читать — мне, Ванамали Гопалу и Нитья Виласини»
-- (все трое — суперпользователи).
--
-- Стало три уровня:
--   полный CRM (чтение)  — суперпользователи, права CRM (view_crm, edit_crm,
--                          view_crm_dashboard, edit_crm_settings) и финансы
--                          (fin_admin, fin_observer — им нужны платежи и
--                          история общения для расчётов с участниками);
--   запись               — суперпользователи, edit_crm, fin_admin;
--   выжимка сделок       — шахматке, бронированиям, предварительным спискам:
--                          только гость, ретрит, стадия, особые нужды,
--                          «живу сам», оплачено, бронь (crm_v_deals_brief).
-- Переписку, историю сделки и журнал действий удаляет только суперпользователь.
-- Справочники (валюты, услуги, типы проживания, причины отмены, теги,
-- системы оплаты, цены) — как раньше, любому сотруднику на чтение.

create or replace function public.crm_can_read(p_user uuid)
returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
    select p_user is not null and (
           is_superuser(p_user)
        or has_permission(p_user, 'view_crm') or has_permission(p_user, 'edit_crm')
        or has_permission(p_user, 'view_crm_dashboard') or has_permission(p_user, 'edit_crm_settings')
        or has_permission(p_user, 'fin_admin') or has_permission(p_user, 'fin_observer'))
$$;

create or replace function public.crm_can_write(p_user uuid)
returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
    select p_user is not null and (
           is_superuser(p_user)
        or has_permission(p_user, 'edit_crm') or has_permission(p_user, 'edit_crm_settings')
        or has_permission(p_user, 'fin_admin'))
$$;

create or replace function public.crm_can_brief(p_user uuid)
returns boolean language sql stable security definer
set search_path to 'public', 'pg_temp'
as $$
    select p_user is not null and (
           crm_can_read(p_user)
        or has_permission(p_user, 'view_timeline') or has_permission(p_user, 'view_bookings')
        or has_permission(p_user, 'view_retreat_guests') or has_permission(p_user, 'view_preliminary')
        or has_permission(p_user, 'create_booking'))
$$;

revoke all on function public.crm_can_read(uuid), public.crm_can_write(uuid), public.crm_can_brief(uuid)
    from public, anon;
grant execute on function public.crm_can_read(uuid), public.crm_can_write(uuid), public.crm_can_brief(uuid)
    to authenticated;

-- выжимка сделок для шахматки и размещения
create or replace view public.crm_v_deals_brief as
select d.id, d.vaishnava_id, d.retreat_id, d.status, d.special_needs,
       d.checklist_accommodation, d.total_paid, d.booking_id, d.room_id
  from public.crm_deals d
 where public.crm_can_brief(auth.uid());
revoke all on public.crm_v_deals_brief from anon, public;
grant select on public.crm_v_deals_brief to authenticated;
comment on view public.crm_v_deals_brief is
    'Сделки для шахматки и размещения: только поля, нужные этим страницам (миграция 269)';

-- политики «чувствительных» таблиц
do $$
declare
    т text;
    п record;
    чтение text := '(select crm_can_read((select auth.uid())))';
    запись text := '(select crm_can_write((select auth.uid())))';
    без_удаления text[] := array['crm_communications', 'crm_deal_history', 'crm_activity_log'];
begin
    foreach т in array array['crm_deals', 'crm_payments', 'crm_communications', 'crm_tasks',
        'crm_deal_history', 'crm_activity_log', 'crm_deal_members', 'crm_deal_services',
        'crm_deal_tags', 'crm_deal_terms', 'crm_advance_decisions', 'crm_prepayment_operations',
        'crm_participant_balance', 'crm_payment_history', 'crm_manager_queue',
        'crm_retreat_managers', 'crm_message_templates', 'crm_task_templates', 'crm_utm_links']
    loop
        -- снимаем «сотрудничьи» политики; гостевые (свои сделки и платежи в портале) не трогаем
        for п in select policyname from pg_policies
                  where schemaname = 'public' and tablename = т
                    and policyname not ilike 'guest%' and policyname not ilike '%guest read own%'
        loop
            execute format('drop policy %I on public.%I', п.policyname, т);
        end loop;

        execute format('create policy %I on public.%I for select to authenticated using (%s)',
                       'crm read', т, чтение);
        if т not in ('crm_participant_balance', 'crm_payment_history') then
            execute format('create policy %I on public.%I for insert to authenticated with check (%s)',
                           'crm insert', т, запись);
            execute format('create policy %I on public.%I for update to authenticated using (%s) with check (%s)',
                           'crm update', т, запись, запись);
            execute format('create policy %I on public.%I for delete to authenticated using (%s)',
                           'crm delete', т,
                           case when т = any(без_удаления)
                                then '(select is_superuser((select auth.uid())))' else запись end);
        end if;
    end loop;
end $$;

-- бронирование (страница брони и шахматка) привязывает бронь к сделке
create policy "booking links deal" on public.crm_deals for update to authenticated
    using ((select has_permission((select auth.uid()), 'create_booking')))
    with check ((select has_permission((select auth.uid()), 'create_booking')));

-- аноним больше не видит очередь менеджеров: форме заявки она не нужна
drop policy if exists anon_read_crm_manager_queue on public.crm_manager_queue;

-- Триггерные функции, которые пишут в CRM от имени вызвавшего: при узких
-- правах отмена сделки финансистом падала бы на создании автозадачи
alter function public.crm_auto_tasks() security definer;
alter function public.crm_auto_tasks() set search_path to 'public', 'pg_temp';
alter function public.sync_deal_currency() security definer;
alter function public.sync_deal_currency() set search_path to 'public', 'pg_temp';
