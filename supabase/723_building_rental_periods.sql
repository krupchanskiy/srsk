-- Несколько периодов аренды у временного здания (ВГ 19.10).
-- Период — либо свои даты, либо ретрит ± до недели до и после (даты берутся из ретрита
-- и едут вместе с ним). Прошедшие периоды не удаляются — это история использования.
-- buildings.available_from/available_until остаются как охват (мин/макс по периодам) —
-- для старого кода и старого кэша; точная проверка — по периодам.

create table public.building_rental_periods (
    id uuid primary key default gen_random_uuid(),
    building_id uuid not null references public.buildings(id) on delete cascade,
    retreat_id uuid references public.retreats(id) on delete set null,
    days_before int not null default 0 check (days_before between 0 and 7),
    days_after int not null default 0 check (days_after between 0 and 7),
    date_from date not null,
    date_to date not null,
    created_at timestamptz not null default now(),
    check (date_to >= date_from)
);
create index on public.building_rental_periods (building_id);
create index on public.building_rental_periods (retreat_id);

alter table public.building_rental_periods enable row level security;
create policy "Read building rental periods" on public.building_rental_periods
    for select to authenticated using (true);
create policy "Staff manage building rental periods" on public.building_rental_periods
    for all to authenticated
    using (is_staff((select auth.uid()))) with check (is_staff((select auth.uid())));

-- Даты периода по ретриту
create or replace function public.building_rental_period_dates()
returns trigger language plpgsql set search_path = public as $$
declare r record;
begin
    if new.retreat_id is not null then
        select start_date, end_date into r from retreats where id = new.retreat_id;
        if r.start_date is not null and r.end_date is not null then
            new.date_from := r.start_date - new.days_before;
            new.date_to := r.end_date + new.days_after;
        end if;
    end if;
    return new;
end $$;
create trigger trg_building_rental_period_dates
    before insert or update on public.building_rental_periods
    for each row execute function public.building_rental_period_dates();

-- Охват периодов → buildings.available_from/available_until
create or replace function public.building_rental_sync_envelope()
returns trigger language plpgsql security definer set search_path = public as $$
declare b uuid;
begin
    for b in select distinct x from unnest(array[
        case when tg_op <> 'INSERT' then old.building_id end,
        case when tg_op <> 'DELETE' then new.building_id end]) x where x is not null
    loop
        update buildings set
            available_from = (select min(date_from) from building_rental_periods where building_id = b),
            available_until = (select max(date_to) from building_rental_periods where building_id = b)
        where id = b;
    end loop;
    return null;
end $$;
create trigger trg_building_rental_sync_envelope
    after insert or update or delete on public.building_rental_periods
    for each row execute function public.building_rental_sync_envelope();

-- Сдвинули даты ретрита — сдвигаются и привязанные периоды
create or replace function public.retreat_dates_to_rental_periods()
returns trigger language plpgsql security definer set search_path = public as $$
begin
    update building_rental_periods set retreat_id = retreat_id where retreat_id = new.id;
    return null;
end $$;
create trigger trg_retreat_dates_to_rental_periods
    after update of start_date, end_date on public.retreats
    for each row when (old.start_date is distinct from new.start_date or old.end_date is distinct from new.end_date)
    execute function public.retreat_dates_to_rental_periods();

-- Текущие даты аренды → первый период
insert into public.building_rental_periods (building_id, date_from, date_to)
select id, available_from, available_until from public.buildings
where is_temporary and available_from is not null and available_until is not null;

insert into translations (key, ru, en, hi, context) values
('rental_add_dates', 'Добавить даты', 'Add dates', 'तिथियाँ जोड़ें', 'Здания: период аренды'),
('rental_add_retreat', 'Добавить ретрит', 'Add retreat', 'रिट्रीट जोड़ें', 'Здания: период аренды'),
('rental_days_before', 'Дней до', 'Days before', 'पहले दिन', 'Здания: период аренды'),
('rental_days_after', 'Дней после', 'Days after', 'बाद के दिन', 'Здания: период аренды'),
('rental_history', 'История использования', 'Usage history', 'उपयोग इतिहास', 'Здания: прошедшие периоды аренды'),
('rental_guests', 'гостей', 'guests', 'मेहमान', 'Здания: история аренды'),
('rental_need_period', 'Добавьте хотя бы один период аренды или отметьте «Доступно всегда»', 'Add at least one rental period or tick “Always available”', 'कम से कम एक किराया अवधि जोड़ें या «हमेशा उपलब्ध» चुनें', 'Здания: период аренды'),
('rental_ended', 'Аренда закончилась', 'Rental ended', 'किराया समाप्त', 'Здания: карточка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
