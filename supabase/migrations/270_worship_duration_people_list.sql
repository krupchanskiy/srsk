-- 270: длительность служб и люди отдела одним запросом
--
-- 1) Сколько служба занимает времени. Нужна «Загрузке»: две бхоги по
--    десять минут и одно двухчасовое одевание — не «три службы против
--    одной». Не обязательна: пока старший не проставил, считаем штуками.
alter table worship_services
    add column if not exists duration_minutes int
        check (duration_minutes is null or duration_minutes between 5 and 720);
alter table worship_day_overrides
    add column if not exists duration_minutes int
        check (duration_minutes is null or duration_minutes between 5 and 720);

comment on column worship_services.duration_minutes is
    'Сколько минут занимает служба; null — не указано';
comment on column worship_day_overrides.duration_minutes is
    'Сколько минут занимает разовая служба; null — не указано';

-- 2) Люди отдела сразу с именами. Раньше каждая страница модуля шла
--    за именами в vaishnavas вторым кругом, а vaishnavas отдаёт чужие
--    карточки только сотрудникам — у пуджари без этих прав коллеги
--    значились «без имени». Отдаём только то, что нужно отделу; телефон —
--    тем же, кому его и так показывает vaishnavas.
create or replace function worship_people_list()
returns table (
    id uuid, vaishnava_id uuid, kind text, is_active boolean,
    active_from date, active_to date,
    name text, user_id uuid, has_telegram boolean, phone text
)
language sql stable security definer
set search_path = public, pg_temp
set "TimeZone" = 'Asia/Kolkata'
as $$
    select p.id, p.vaishnava_id, p.kind, p.is_active, p.active_from, p.active_to,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'без имени'),
           v.user_id,
           v.telegram_chat_id is not null,
           case when is_superuser(auth.uid()) or is_staff(auth.uid())
                     or has_permission(auth.uid(), 'view_vaishnavas')
                     or has_permission(auth.uid(), 'edit_vaishnava')
                then v.phone end
      from worship_people p
      join vaishnavas v on v.id = p.vaishnava_id
     where worship_can_view()
$$;

revoke all on function worship_people_list() from public, anon;
grant execute on function worship_people_list() to authenticated;
