-- 299: «вести расписание» — и справочник служб (просьба Адриана 09.11.2026).
--
-- В 296 справочник служб (время, длительность, добавить, отключить, удалить)
-- оставили старшему. Ямуне-расе, которая ведёт расписание, этого не хватило:
-- составлять расписание — значит и службы со временем править.
-- Утверждение стандартов, состав отдела и допуски по-прежнему у старшего.

drop policy if exists "worship services write" on worship_services;
create policy "worship services write" on worship_services for insert to authenticated
    with check ((select worship_can_schedule()) and (created_by is null or created_by = (select auth.uid())));
drop policy if exists "worship services update" on worship_services;
create policy "worship services update" on worship_services for update to authenticated
    using ((select worship_can_schedule())) with check ((select worship_can_schedule()));
drop policy if exists "worship services delete" on worship_services;
create policy "worship services delete" on worship_services for delete to authenticated
    using ((select worship_can_schedule()));
