-- =============================================================
-- Событие для подсчёта вкушающих и затрат (этап 2 учёта себестоимости
-- прасада, см. ТЗ «Учёт затрат кухни», разделы 3.3–3.5).
--
-- Событие — это либо наш ретрит (retreats), либо группа из реестра
-- «Группы» (meal_groups), помеченная как отдельное событие.
--   * residents.retreat_id  — уже было (ссылка на ретрит)
--   * residents.group_id    — новое: проживающий относится к событию-группе
--   * meal_groups.retreat_id — новое: строка реестра относится к нашему ретриту
--     (участник ретрита, который живёт вне территории и питается с нами)
--   * meal_groups.is_event   — новое: строка сама является событием
--     (сторонняя группа, разовое мероприятие вроде «Инициации»)
-- Строка реестра без retreat_id и без is_event — «самостоятельные гости»,
-- отдельного события у неё нет.
-- =============================================================

alter table public.residents
  add column if not exists group_id uuid references public.meal_groups(id) on delete set null;
create index if not exists residents_group_id_idx on public.residents (group_id) where group_id is not null;

alter table public.meal_groups
  add column if not exists retreat_id uuid references public.retreats(id) on delete set null,
  add column if not exists is_event boolean not null default false;
create index if not exists meal_groups_retreat_id_idx on public.meal_groups (retreat_id) where retreat_id is not null;

-- строка реестра либо привязана к ретриту, либо сама событие, но не оба сразу
alter table public.meal_groups
  add constraint meal_groups_event_link_ck check (not (retreat_id is not null and is_event));

-- Общий список событий для выбора и отчётов. Ключ вида retreat:<id> / group:<id>.
create or replace view public.events
with (security_invoker = true) as
  select 'retreat:' || r.id::text as key,
         'retreat'::text as kind,
         r.id as source_id,
         r.name_ru, r.name_en, r.name_hi,
         r.start_date, r.end_date
    from public.retreats r
  union all
  select 'group:' || g.id::text,
         'group'::text,
         g.id,
         g.name, g.name, g.name,
         g.start_date, g.end_date
    from public.meal_groups g
   where g.is_event;

revoke all on public.events from anon;
grant select on public.events to authenticated;
