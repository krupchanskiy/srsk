-- Календарь ретритов (ВГ 20.11.2026): замена Google-таблицы «Расписание ретритов ШРСК».
-- Подтверждённые ретриты и праздники календарь берёт из retreats / holidays — здесь только то,
-- чего там нет: планы, предварительные брони групп, выезды Гурудева, заметки.
-- Предварительное живёт отдельно от retreats нарочно: ретриты видят CRM, оплаты, кухня, бот —
-- «Хинди-ретрит???» туда попадать не должен. «Создать ретрит» из записи заводит настоящий
-- ретрит и ставит retreat_id; с этого момента календарь показывает сам ретрит.
-- Связь с шахматкой: бронь группы, созданная из записи, помнит её в bookings.plan_id.

create table public.retreat_plans (
    id uuid primary key default gen_random_uuid(),
    kind text not null default 'event' check (kind in ('event', 'guru', 'note')),
    status text not null default 'plan' check (status in ('plan', 'tentative', 'confirmed', 'cancelled')),
    title text not null check (length(trim(title)) > 0),
    start_date date not null,
    end_date date not null,
    contact_name text,
    contact_phone text,
    people_count int check (people_count >= 0),
    rooms_count int check (rooms_count >= 0),
    needs_cafe boolean not null default false,
    needs_hall boolean not null default false,
    prepayment text,
    confirm_by date,
    notes text,
    retreat_id uuid references public.retreats(id) on delete set null,
    created_by uuid default auth.uid(),
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    check (end_date >= start_date)
);
create index on public.retreat_plans (start_date, end_date);
create index on public.retreat_plans (retreat_id);

create trigger trg_retreat_plans_updated_at
    before update on public.retreat_plans
    for each row execute function public.update_updated_at_column();

alter table public.bookings add column plan_id uuid references public.retreat_plans(id) on delete set null;
create index on public.bookings (plan_id) where plan_id is not null;

-- Права: смотреть календарь — как «Ретриты» (view_retreats); предварительное и планы —
-- отдельное право (там телефоны, предоплаты, неподтверждённые договорённости); править — своё.
-- Суперпользователи (ВГ, Ачинтья Кришна, Нитья) имеют всё через has_permission.
insert into permissions (code, name_ru, name_en, name_hi, category, sort_order) values
('view_retreat_plans', 'Календарь ретритов: видеть планы и предварительные брони', 'Retreat calendar: see plans and tentative bookings', 'रिट्रीट कैलेंडर: योजनाएँ और अस्थायी बुकिंग देखें', 'ashram', 0),
('edit_retreat_plans', 'Календарь ретритов: править', 'Retreat calendar: edit', 'रिट्रीट कैलेंडर: संपादित करें', 'ashram', 0)
on conflict (code) do nothing;

alter table public.retreat_plans enable row level security;
-- Подтверждённое (выезды Гурудева, подтверждённые брони групп) — всем сотрудникам с доступом к ретритам;
-- план, предварительное, отменённое — только с view_retreat_plans / edit_retreat_plans
create policy "Read retreat plans" on public.retreat_plans
    for select to authenticated using (
        (status = 'confirmed' and public.has_permission((select auth.uid()), 'view_retreats'))
        or public.has_permission((select auth.uid()), 'view_retreat_plans')
        or public.has_permission((select auth.uid()), 'edit_retreat_plans'));
create policy "Edit retreat plans" on public.retreat_plans
    for all to authenticated
    using (public.has_permission((select auth.uid()), 'edit_retreat_plans'))
    with check (public.has_permission((select auth.uid()), 'edit_retreat_plans'));

insert into translations (key, ru, en, hi, context) values
('retreat_calendar', 'Расписание', 'Schedule', 'कार्यक्रम', 'Меню: Управление — вкладка между «Ретриты» и «Праздники»'),
('rc_add', 'Добавить', 'Add', 'जोड़ें', 'Календарь ретритов'),
('rc_today', 'Сегодня', 'Today', 'आज', 'Календарь ретритов'),
('rc_col_date', 'Дата', 'Date', 'तिथि', 'Календарь ретритов'),
('rc_col_holiday', 'Праздник', 'Festival', 'उत्सव', 'Календарь ретритов'),
('rc_col_retreats', 'Ретриты и брони', 'Retreats & bookings', 'रिट्रीट और बुकिंग', 'Календарь ретритов'),
('rc_col_plans', 'Предварительно и планы', 'Tentative & plans', 'अस्थायी और योजनाएँ', 'Календарь ретритов'),
('rc_col_guru', 'Гурудев', 'Gurudev', 'गुरुदेव', 'Календарь ретритов'),
('rc_col_load', 'Гостевой дом', 'Guest house', 'अतिथि गृह', 'Календарь ретритов: загрузка'),
('rc_status_plan', 'План', 'Plan', 'योजना', 'Календарь ретритов: статус'),
('rc_status_tentative', 'Предварительно', 'Tentative', 'अस्थायी', 'Календарь ретритов: статус'),
('rc_status_confirmed', 'Подтверждено', 'Confirmed', 'पुष्ट', 'Календарь ретритов: статус'),
('rc_status_cancelled', 'Отменено', 'Cancelled', 'रद्द', 'Календарь ретритов: статус'),
('rc_kind_event', 'Ретрит / группа', 'Retreat / group', 'रिट्रीट / समूह', 'Календарь ретритов: вид'),
('rc_kind_guru', 'Выезд Гурудева', 'Gurudev travel', 'गुरुदेव यात्रा', 'Календарь ретритов: вид'),
('rc_kind_note', 'Заметка', 'Note', 'नोट', 'Календарь ретритов: вид'),
('rc_title', 'Название', 'Title', 'नाम', 'Календарь ретритов'),
('rc_confirm_by', 'Подтвердить до', 'Confirm by', 'तक पुष्टि करें', 'Календарь ретритов'),
('rc_people', 'Людей', 'People', 'लोग', 'Календарь ретритов'),
('rc_rooms', 'Номеров', 'Rooms', 'कमरे', 'Календарь ретритов'),
('rc_needs_cafe', 'Нужно кафе', 'Needs café', 'कैफ़े चाहिए', 'Календарь ретритов'),
('rc_needs_hall', 'Нужен лекционный зал', 'Needs lecture hall', 'व्याख्यान कक्ष चाहिए', 'Календарь ретритов'),
('rc_prepayment', 'Предоплата', 'Prepayment', 'अग्रिम भुगतान', 'Календарь ретритов'),
('rc_create_retreat', 'Создать ретрит', 'Create retreat', 'रिट्रीट बनाएँ', 'Календарь ретритов'),
('rc_open_retreat', 'Открыть ретрит', 'Open retreat', 'रिट्रीट खोलें', 'Календарь ретритов'),
('rc_book_places', 'Забронировать места в шахматке', 'Book places in the timeline', 'टाइमलाइन में स्थान बुक करें', 'Календарь ретритов'),
('rc_booked_places', 'В шахматке', 'In the timeline', 'टाइमलाइन में', 'Календарь ретритов'),
('rc_overdue', 'срок ответа прошёл', 'reply overdue', 'उत्तर की समय सीमा बीत गई', 'Календарь ретритов'),
('rc_free_rooms', 'свободно номеров', 'free rooms', 'खाली कमरे', 'Календарь ретритов'),
('rc_whole_house', 'весь ГД', 'whole GH', 'पूरा अतिथि गृह', 'Календарь ретритов'),
('rc_show_cancelled', 'Показывать отменённое', 'Show cancelled', 'रद्द दिखाएँ', 'Календарь ретритов')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
