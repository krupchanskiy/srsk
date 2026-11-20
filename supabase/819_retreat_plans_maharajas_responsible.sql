-- 819: Расписание ретритов — Махараджи, ответственный, напоминание в Телеграм (ВГ 20.11.2026)
--  * справочник почётных гостей maharajas (в vaishnavas их почти нет); «Гурудев» — первый;
--    запись kind='guru' с maharaja_id = NULL — «Махараджи» без имени;
--  * статусы как в шахматке: «Бронь» (tentative) → «Подтверждено» → ретрит/бронь группы; «План» убран;
--  * responsible_id — сотрудник с входом в систему; БЕЗ FK на vaishnavas
--    (вторая связь к vaishnavas ломает встраивания PostgREST — см. мигр. 790/797);
--  * за 30 дней до «подтвердить до» — личное сообщение ответственному (один раз на каждую дату).

create table public.maharajas (
    id uuid primary key default gen_random_uuid(),
    name text not null check (length(trim(name)) > 0),
    sort_order int not null default 100,
    is_active boolean not null default true,
    notes text,
    created_at timestamptz not null default now()
);
alter table public.maharajas enable row level security;
create policy "Read maharajas" on public.maharajas
    for select to authenticated using (
        public.has_permission((select auth.uid()), 'view_retreat_plans')
        or public.has_permission((select auth.uid()), 'edit_retreat_plans'));
create policy "Edit maharajas" on public.maharajas
    for all to authenticated
    using (public.has_permission((select auth.uid()), 'edit_retreat_plans'))
    with check (public.has_permission((select auth.uid()), 'edit_retreat_plans'));
insert into public.maharajas (name, sort_order) values ('Гурудев', 0);

alter table public.retreat_plans
    add column maharaja_id uuid references public.maharajas(id) on delete set null,
    add column responsible_id uuid,
    add column reminded_for date;
create index on public.retreat_plans (responsible_id) where responsible_id is not null;

update public.retreat_plans set maharaja_id = (select id from public.maharajas where name = 'Гурудев')
 where kind = 'guru' and maharaja_id is null;

-- «План» → «Бронь» (tentative)
update public.retreat_plans set status = 'tentative' where status = 'plan';
alter table public.retreat_plans drop constraint retreat_plans_status_check;
alter table public.retreat_plans add constraint retreat_plans_status_check
    check (status in ('tentative', 'confirmed', 'cancelled'));
alter table public.retreat_plans alter column status set default 'tentative';

-- Напоминание ответственному: бронь, «подтвердить до» через 30 дней или меньше (ещё не прошло)
create or replace function public.tg_retreat_plan_remind()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $$
declare
    r record;
    v_id bigint;
    v_n int := 0;
    v_days int;
begin
    for r in
        select p.id, p.title, p.start_date, p.end_date, p.confirm_by, p.contact_name, p.contact_phone, l.tg_user_id
          from retreat_plans p
          join lateral (select tg_user_id from tg_user_links where vaishnava_id = p.responsible_id
                         order by linked_at desc limit 1) l on true
         where p.status = 'tentative'
           and p.confirm_by is not null
           and current_date between p.confirm_by - 30 and p.confirm_by
           and p.reminded_for is distinct from p.confirm_by
    loop
        begin
            v_days := r.confirm_by - current_date;
            insert into tg_outbox (chat_id, text, reply_to, kind)
            values (r.tg_user_id,
                E'Харе Кришна! Примите, пожалуйста, мои поклоны.\n\n📅 Напоминание из Расписания ретритов\n\n'
                || format('<b>%s</b>', tg_escape(r.title))
                || format(E'\nДаты: %s – %s', to_char(r.start_date, 'DD.MM.YYYY'), to_char(r.end_date, 'DD.MM.YYYY'))
                || format(E'\nПодтвердить до: <b>%s</b> (%s)', to_char(r.confirm_by, 'DD.MM.YYYY'),
                          case when v_days = 0 then 'сегодня' else 'осталось дней: ' || v_days end)
                || coalesce(format(E'\nКонтакт: %s', tg_escape(trim(concat_ws(' ', r.contact_name, r.contact_phone)))), '')
                || E'\n\nВы — ответственный от ШРСК. Пожалуйста, свяжитесь с организаторами и отметьте в Расписании «Подтверждено» или «Отменено».'
                || E'\nhttps://in.rupaseva.com/ashram/retreat-calendar.html',
                null, 'retreat_plan')
            returning id into v_id;
            perform tg_outbox_try(v_id);
            update retreat_plans set reminded_for = r.confirm_by where id = r.id;
            v_n := v_n + 1;
        exception when others then
            null;
        end;
    end loop;
    return v_n;
end;
$$;
revoke execute on function public.tg_retreat_plan_remind() from public, anon, authenticated;

select cron.schedule('retreat-plan-remind', '30 4 * * *', 'SELECT public.tg_retreat_plan_remind()');

insert into translations (key, ru, en, hi, context) values
('rc_status_tentative', 'Бронь', 'Hold', 'आरक्षण', 'Календарь ретритов: статус'),
('rc_kind_guru', 'Махараджи', 'Maharajas', 'महाराज', 'Календарь ретритов: вид'),
('rc_col_guru', 'Махараджи', 'Maharajas', 'महाराज', 'Календарь ретритов'),
('rc_maharaja', 'Махарадж', 'Maharaja', 'महाराज', 'Календарь ретритов'),
('rc_maharajas', 'Махараджи', 'Maharajas', 'महाराज', 'Календарь ретритов'),
('rc_responsible', 'Ответственный', 'Responsible', 'ज़िम्मेदार', 'Календарь ретритов'),
('rc_attention', 'Требуют внимания', 'Need attention', 'ध्यान चाहिए', 'Календарь ретритов'),
('rc_row_holidays', 'Праздники', 'Festivals', 'उत्सव', 'Календарь ретритов'),
('rc_row_retreats', 'Ретриты', 'Retreats', 'रिट्रीट', 'Календарь ретритов'),
('rc_row_bookings', 'Брони групп', 'Group bookings', 'समूह बुकिंग', 'Календарь ретритов'),
('rc_row_tentative', 'Предварительно', 'Tentative', 'अस्थायी', 'Календарь ретритов'),
('rc_row_notes', 'Заметки', 'Notes', 'नोट', 'Календарь ретритов'),
('rc_row_gd2', 'ГД двухместные', 'GH double rooms', 'अतिथि गृह: दो-बिस्तर', 'Календарь ретритов'),
('rc_row_gd4', 'ГД четырёхместные', 'GH 4-bed rooms', 'अतिथि गृह: चार-बिस्तर', 'Календарь ретритов')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
