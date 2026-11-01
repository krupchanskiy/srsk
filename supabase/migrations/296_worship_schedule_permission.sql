-- 296: право «Поклонение: вести расписание» отдельно от утверждения стандартов
-- (просьба Адриана 01.11.2026 — для Ямуны-расы).
--
-- Что даёт (как у старшего): ставить и снимать людей со служб, переносить
-- неделю, отменять/сдвигать/заводить разовые службы на день, отмечать отъезды
-- за других; приходят «Завтра не закрыто» и «такой-то не сможет».
-- Что остаётся только старшему: справочник служб (время, длительность,
-- состав), утверждение стандартов, состав отдела, допуски.

insert into permissions (module_id, code, name_ru, name_en, name_hi, category, sort_order)
select module_id, 'worship_schedule', 'Поклонение: вести расписание', 'Worship: manage schedule',
       'पूजा: समय-सारणी संभालना', category, 4
  from permissions where code = 'worship_approve'
on conflict (code) do nothing;

create or replace function worship_can_schedule()
returns boolean language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$ select worship_can_approve() or abk_current_user_has_permission('worship_schedule') $$;
revoke all on function worship_can_schedule() from public, anon;
grant execute on function worship_can_schedule() to authenticated;

-- функции расписания: старший → тот, кто ведёт расписание
do $$
declare ф text; d text; н integer;
begin
    foreach ф in array array['worship_duty_set', 'worship_duty_clear', 'worship_week_copy',
                             'worship_service_retime', 'worship_absence_set', 'worship_absence_clear'] loop
        d := pg_get_functiondef(ф::regproc);
        н := (length(d) - length(replace(d, 'worship_can_approve()', ''))) / length('worship_can_approve()');
        if н <> 1 then raise exception '%: ожидал одну проверку старшего, нашёл %', ф, н; end if;
        execute replace(d, 'worship_can_approve()', 'worship_can_schedule()');
    end loop;

    -- кому сообщать о дырах и отъездах: старшим и тем, кто ведёт расписание
    foreach ф in array array['worship_absence_set', 'worship_notify_gaps'] loop
        d := pg_get_functiondef(ф::regproc);
        if position('select worship_holders(''worship_approve'') loop' in d) = 0 then
            raise exception '%: рассылка старшим не найдена', ф;
        end if;
        execute replace(d, 'select worship_holders(''worship_approve'') loop',
            'select distinct h from (select worship_holders(''worship_approve'') h'
            || ' union select worship_holders(''worship_schedule'')) кто loop');
    end loop;
end $$;

-- особые дни (отмена, сдвиг, разовая)
drop policy if exists "worship day overrides write" on worship_day_overrides;
create policy "worship day overrides write" on worship_day_overrides for insert to authenticated
    with check ((select worship_can_schedule()) and (created_by is null or created_by = (select auth.uid())));
drop policy if exists "worship day overrides update" on worship_day_overrides;
create policy "worship day overrides update" on worship_day_overrides for update to authenticated
    using ((select worship_can_schedule())) with check ((select worship_can_schedule()));
drop policy if exists "worship day overrides delete" on worship_day_overrides;
create policy "worship day overrides delete" on worship_day_overrides for delete to authenticated
    using ((select worship_can_schedule()));

-- Ямуна-раса дд (kyushitsyna@gmail.com) ведёт расписание
insert into user_permissions (user_id, permission_id, is_granted, reason, granted_by, granted_at)
select 'cdfacb35-4de7-47ed-acbb-88beed469c0a', id, true, 'Ведёт расписание (просьба Адриана 01.11.2026)',
       '2160b531-4e37-4d2a-ba46-cc1ee230cfeb', now()
  from permissions where code = 'worship_schedule';
