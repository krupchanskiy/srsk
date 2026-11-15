-- 781: регистрация на «Шад Госвами Утсав» (17.11.2026) с rupaseva.com/utsav.
-- Гость оставляет имя и телефон, чтобы его покормили; список печатается для сверки на раздаче прасада
-- (страница reception/utsav.html). Записывает только функция utsav_register (её зовёт аноним с сайта),
-- читать и удалять могут только сотрудники.

create table if not exists public.utsav_registrations (
    id uuid primary key default gen_random_uuid(),
    event text not null default 'shad-gosvami-2026',
    name text not null check (char_length(name) between 2 and 120),
    phone text not null check (char_length(phone) between 7 and 20),
    lang text not null default 'ru' check (lang in ('ru', 'en')),
    created_at timestamptz not null default now()
);
create index if not exists utsav_registrations_event_idx on public.utsav_registrations (event, created_at);

alter table public.utsav_registrations enable row level security;
revoke all on table public.utsav_registrations from public, anon, authenticated;
grant select, delete on table public.utsav_registrations to authenticated;
grant all on table public.utsav_registrations to service_role;

drop policy if exists utsav_registrations_staff_select on public.utsav_registrations;
create policy utsav_registrations_staff_select on public.utsav_registrations
    for select to authenticated using (public.is_staff(auth.uid()));
drop policy if exists utsav_registrations_staff_delete on public.utsav_registrations;
create policy utsav_registrations_staff_delete on public.utsav_registrations
    for delete to authenticated using (public.is_staff(auth.uid()));

-- Запись с сайта. Возвращает {ok:true} или {ok:false, error:'closed'|'name'|'phone'|'limit'|'busy'|'event'}.
create or replace function public.utsav_register(p_event text, p_name text, p_phone text, p_lang text default 'ru')
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
    v_name text := regexp_replace(btrim(coalesce(p_name, '')), '\s+', ' ', 'g');
    v_phone text := regexp_replace(btrim(coalesce(p_phone, '')), '[^0-9+]', '', 'g');
    v_digits text;
begin
    if p_event is distinct from 'shad-gosvami-2026' then return jsonb_build_object('ok', false, 'error', 'event'); end if;
    -- регистрация закрывается 16.11.2026 в 18:00 по Индии
    if now() >= timestamptz '2026-11-16 18:00:00+05:30' then return jsonb_build_object('ok', false, 'error', 'closed'); end if;
    if char_length(v_name) < 2 or char_length(v_name) > 120 or v_name !~ '[[:alpha:]]' then
        return jsonb_build_object('ok', false, 'error', 'name'); end if;
    v_phone := left(v_phone, 1) || replace(substr(v_phone, 2), '+', '');
    v_digits := replace(v_phone, '+', '');
    if char_length(v_digits) < 7 or char_length(v_digits) > 15 then
        return jsonb_build_object('ok', false, 'error', 'phone'); end if;
    -- тот же человек второй раз — не дублируем
    if exists (select 1 from utsav_registrations where event = p_event and lower(name) = lower(v_name)
               and replace(phone, '+', '') = v_digits) then
        return jsonb_build_object('ok', true, 'dup', true); end if;
    -- защита от заливки: на один телефон не больше 15 человек, всего не больше 60 записей в минуту
    if (select count(*) from utsav_registrations where event = p_event and replace(phone, '+', '') = v_digits) >= 15 then
        return jsonb_build_object('ok', false, 'error', 'limit'); end if;
    if (select count(*) from utsav_registrations where created_at > now() - interval '1 minute') >= 60 then
        return jsonb_build_object('ok', false, 'error', 'busy'); end if;
    insert into utsav_registrations (event, name, phone, lang)
    values (p_event, v_name, v_phone, case when p_lang = 'en' then 'en' else 'ru' end);
    return jsonb_build_object('ok', true);
end;
$$;
revoke all on function public.utsav_register(text, text, text, text) from public;
grant execute on function public.utsav_register(text, text, text, text) to anon, authenticated, service_role;
