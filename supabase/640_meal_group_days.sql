-- 640: «Разовое питание» — разное число завтраков и обедов по дням (ВГ, 08.10.2026).
-- Группа Дикша-ретрита ест 7–22.10, каждый день своё число: раньше на каждый день и приём
-- заводилась отдельная строка. Теперь запись одна, переключатель «По дням» (by_day) и
-- таблица meal_group_days: дата · завтраков · обедов · примечание к дню (уходит поварам).
-- Без «По дням» — как раньше: people_count × галочки на все дни.
--
-- Кухня: eating_detail для записи «По дням» отдаёт на день две строки — завтрак (people =
-- завтраков) и обед (people = обедов). eating_by_event и бот суммируют их как прежде.

create table if not exists public.meal_group_days (
    group_id  uuid not null references public.meal_groups(id) on delete cascade,
    d         date not null,
    breakfast integer not null default 0 check (breakfast >= 0),
    lunch     integer not null default 0 check (lunch >= 0),
    note      text,
    primary key (group_id, d)
);

alter table public.meal_group_days enable row level security;
drop policy if exists "Staff manage meal_group_days" on public.meal_group_days;
create policy "Staff manage meal_group_days" on public.meal_group_days
    for all to authenticated
    using (is_staff((select auth.uid())))
    with check (is_staff((select auth.uid())));

alter table public.meal_groups add column if not exists by_day boolean not null default false;

comment on column public.meal_groups.by_day is 'Число завтраков и обедов задано по дням в meal_group_days (ВГ 08.10.2026)';
comment on table public.meal_group_days is 'Питание записи «Разового питания» по дням: завтраков, обедов, примечание поварам';

-- eating_detail: меняем только раздел групп. Остальная функция (живущие, регистрации)
-- остаётся как есть — подставляем в текущее определение, чтобы не переписывать его копией.
do $mig$
declare
    src text := pg_get_functiondef('public.eating_detail(date,date)'::regprocedure);
    old_part text := $o$  SELECT dd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups',
         COALESCE(mg.breakfast, false), COALESCE(mg.lunch, false), mg.people_count
    FROM meal_groups mg
    JOIN days dd ON dd.d BETWEEN mg.start_date AND mg.end_date
$o$;
    new_part text := $n$  SELECT dd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups',
         COALESCE(mg.breakfast, false), COALESCE(mg.lunch, false), mg.people_count
    FROM meal_groups mg
    JOIN days dd ON dd.d BETWEEN mg.start_date AND mg.end_date
   WHERE NOT mg.by_day
  UNION ALL
  -- «По дням» (640): завтрак и обед — отдельными строками со своим числом
  SELECT gd.d, 'group', mg.id, NULL, mg.retreat_id, 'groups', m.b, NOT m.b, m.n
    FROM meal_groups mg
    JOIN meal_group_days gd ON gd.group_id = mg.id
    CROSS JOIN LATERAL (VALUES (true, gd.breakfast), (false, gd.lunch)) m(b, n)
   WHERE mg.by_day
     AND gd.d BETWEEN p_from AND p_to
     AND gd.d BETWEEN mg.start_date AND mg.end_date
     AND m.n > 0
$n$;
begin
    if position(old_part in src) = 0 then
        raise exception 'eating_detail: раздел групп не найден — функция менялась, правьте миграцию';
    end if;
    execute replace(src, old_part, new_part);
end
$mig$;
