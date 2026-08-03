-- Авторегистрация на ретрит при оплате брони в CRM.
--
-- До сих пор перевод сделки в регистрацию не был реализован нигде в продукте
-- (констатировано ещё в 296_participants_from_crm_deals.sql: 99 сделок,
-- 44 регистрации, пересечение — ноль). Решение Адриана 03.08.2026: сделка
-- в оплаченном статусе — человек автоматически регистрируется на ретрит.
--
-- Идемпотентность: UNIQUE (vaishnava_id, retreat_id). Удалённую регистрацию
-- воскрешаем (оплата сильнее старого удаления), но статус живой регистрации
-- не переопределяем: если орги руками поставили cancelled — сделка не должна
-- молча перебивать их решение.
--
-- Отмена сделки регистрацию не трогает намеренно: противоречие «оплатил,
-- но отменён» должен разруливать человек.

create or replace function crm_register_on_booked()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_paid constant text[] := array['booked', 'checklist', 'ready', 'completed'];
begin
  -- Только вход в оплаченный статус (не переходы внутри набора)
  if new.status <> all (v_paid) then return new; end if;
  if tg_op = 'UPDATE' and old.status = any (v_paid) then return new; end if;
  if new.vaishnava_id is null or new.retreat_id is null then return new; end if;

  insert into retreat_registrations
         (retreat_id, vaishnava_id, status, meal_type, registration_date, org_notes)
  values (new.retreat_id, new.vaishnava_id, 'guest', 'prasad', current_date,
          'Создано автоматически: оплачена бронь в CRM')
  on conflict (vaishnava_id, retreat_id) do update
     set is_deleted = false
   where retreat_registrations.is_deleted;

  return new;
end;
$$;

drop trigger if exists trg_crm_register_on_booked on crm_deals;
create trigger trg_crm_register_on_booked
  after insert or update of status on crm_deals
  for each row execute function crm_register_on_booked();

-- Бэкфилл: регистрации для уже оплаченных сделок. Строго ПОСЛЕ миграции 346
-- (связка заглушек): иначе резидент без vaishnava_id не дедуплицируется
-- с регистрацией того же человека и счёт питания удваивается.
insert into retreat_registrations
       (retreat_id, vaishnava_id, status, meal_type, registration_date, org_notes)
select d.retreat_id, d.vaishnava_id, 'guest', 'prasad', current_date,
       'Создано автоматически: оплачена бронь в CRM (бэкфилл 03.08.2026)'
  from crm_deals d
 where d.status in ('booked', 'checklist', 'ready', 'completed')
   and d.vaishnava_id is not null
   and d.retreat_id is not null
on conflict (vaishnava_id, retreat_id) do update
   set is_deleted = false
 where retreat_registrations.is_deleted;
