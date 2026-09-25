-- Бронь с ретритом = участник ретрита (решение ВГ 25.09.2026).
-- Ретрит в шахматке живёт на брони (residents.retreat_id), а карточка человека,
-- CRM и финансы смотрят на регистрацию (retreat_registrations). Раньше бронь
-- с ретритом без регистрации давала путаницу: в шахматке участник, в карточке — нет.
-- Теперь при привязке брони к ретриту регистрация создаётся (или восстанавливается
-- из удалённых), при смене/снятии ретрита — созданная так регистрация убирается,
-- если на неё больше ничего не опирается (другие брони, сделка в CRM).
create or replace function public.residents_link_retreat_registration()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE'
     and new.retreat_id is not distinct from old.retreat_id
     and new.vaishnava_id is not distinct from old.vaishnava_id then
    return new;
  end if;

  -- новая привязка
  if new.retreat_id is not null and new.vaishnava_id is not null and new.status <> 'cancelled' then
    insert into retreat_registrations (retreat_id, vaishnava_id, status, meal_type, is_auto_created, registration_date)
    select new.retreat_id, new.vaishnava_id,
           case (select slug from resident_categories where id = new.category_id)
             when 'team' then 'team' when 'volunteer' then 'volunteer' when 'vip' then 'vip' else 'guest' end,
           case when new.has_meals = false then 'self' else 'prasad' end,
           true, current_date
    on conflict (vaishnava_id, retreat_id) do update set is_deleted = false
      where retreat_registrations.is_deleted;
  end if;

  -- старая привязка: убрать авторегистрацию, если больше не нужна
  if tg_op = 'UPDATE' and old.retreat_id is not null and old.vaishnava_id is not null
     and (old.retreat_id is distinct from new.retreat_id or old.vaishnava_id is distinct from new.vaishnava_id) then
    update retreat_registrations rr set is_deleted = true
     where rr.vaishnava_id = old.vaishnava_id and rr.retreat_id = old.retreat_id
       and rr.is_auto_created and not rr.is_deleted
       and not exists (select 1 from residents r where r.vaishnava_id = old.vaishnava_id
                         and r.retreat_id = old.retreat_id and r.id <> new.id and r.status <> 'cancelled')
       and not exists (select 1 from crm_deals d where d.vaishnava_id = old.vaishnava_id
                         and d.retreat_id = old.retreat_id and d.status <> 'cancelled');
  end if;
  return new;
end;
$$;

drop trigger if exists trg_residents_link_retreat_registration on public.residents;
create trigger trg_residents_link_retreat_registration
  after insert or update of retreat_id, vaishnava_id on public.residents
  for each row execute function public.residents_link_retreat_registration();

insert into translations (key, ru, en, hi, context) values
('timeline_retreat_saved', 'Ретрит брони изменён', 'Booking retreat changed', 'बुकिंग का रिट्रीट बदला गया', 'Шахматка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
