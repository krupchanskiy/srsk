-- Блок 1.6: замечания о неточности и события для рассылки.

-- ── кому уходит событие ───────────────────────────────────────────────────────
-- Носители права — те, кому его выдали ролью или персонально. Суперпользователи
-- сюда НЕ попадают: право у них есть по должности, а поток сообщений пуджарского
-- отдела им не нужен, и в первый же день такие уведомления выключили бы целиком.
create or replace function worship_holders(p_permission text)
returns setof uuid
language sql stable security definer set search_path to 'public', 'pg_temp'
as $$
    select u.user_id from (
        select ur.user_id
          from user_roles ur
          join role_permissions rp on rp.role_id = ur.role_id
          join permissions p on p.id = rp.permission_id
         where ur.is_active = true and p.code = p_permission
        union
        select up.user_id
          from user_permissions up
          join permissions p on p.id = up.permission_id
         where up.is_granted = true and p.code = p_permission
    ) u
    where not exists (
        select 1 from user_permissions up2
          join permissions p2 on p2.id = up2.permission_id
         where up2.user_id = u.user_id and p2.code = p_permission and up2.is_granted = false
    );
$$;

-- ── события ───────────────────────────────────────────────────────────────────
-- Пишутся функциями, отправляются служебным процессом. Из браузера утверждающего
-- слать нельзя: двойной клик дал бы два сообщения, закрытая вкладка — ни одного,
-- а любой вошедший смог бы отправить в чат отдела что угодно от имени системы.
create table if not exists worship_notifications (
    id          uuid primary key default gen_random_uuid(),
    kind        text not null check (kind in ('submitted','approved','returned','remark','stale')),
    article_id  uuid references worship_articles(id) on delete cascade,
    version_id  uuid references worship_versions(id) on delete cascade,
    remark_id   uuid,
    recipient   uuid,                     -- null = в общий чат отдела
    event_key   text not null,            -- чем событие отличается от повтора
    payload     jsonb not null default '{}'::jsonb,
    created_at  timestamptz not null default now(),
    sent_at     timestamptz,
    batch_id    uuid
);

-- повтор (двойной клик, повторный вызов функции) не даёт второго сообщения
create unique index if not exists worship_notifications_once on worship_notifications (event_key);
create index if not exists worship_notifications_pending
    on worship_notifications (created_at) where sent_at is null;

-- журнал отправщика: что ушло бы и что ушло. До подключения чата отдела
-- рассылка работает вхолостую, и единственный способ её проверить — этот журнал.
create table if not exists worship_notification_log (
    id         uuid primary key default gen_random_uuid(),
    batch_id   uuid not null,
    recipient  uuid,
    channel    text not null default 'telegram',
    message    text not null,
    events     integer not null default 0,
    dry_run    boolean not null default true,
    created_at timestamptz not null default now()
);

alter table worship_notifications enable row level security;
alter table worship_notification_log enable row level security;

-- читать журнал событий может старший: это служебная кухня, не содержимое
create policy "worship notifications view" on worship_notifications for select
    using (worship_can_approve());
create policy "worship notification log view" on worship_notification_log for select
    using (worship_can_approve());

-- ── замечания о неточности ────────────────────────────────────────────────────
create table if not exists worship_remarks (
    id          uuid primary key default gen_random_uuid(),
    article_id  uuid not null references worship_articles(id) on delete cascade,
    body        text not null check (length(btrim(body)) > 0),
    state       text not null default 'open' check (state in ('open','accepted','declined')),
    created_at  timestamptz not null default now(),
    created_by  uuid,
    closed_at   timestamptz,
    closed_by   uuid,
    close_reason text
);

create index if not exists worship_remarks_article_idx on worship_remarks (article_id, state);
create index if not exists worship_remarks_open_idx on worship_remarks (created_at) where state = 'open';

alter table worship_remarks enable row level security;

-- Замечание оставляет любой читатель модуля, а видят его пуджари и тот,
-- кто написал: для остальных это внутренняя кухня отдела.
create policy "worship remarks view" on worship_remarks for select
    using (worship_can_view() and (worship_can_write() or created_by = auth.uid()));
create policy "worship remarks insert" on worship_remarks for insert
    with check (worship_can_view() and created_by = auth.uid());

alter table worship_notifications
    add constraint worship_notifications_remark_fk
    foreign key (remark_id) references worship_remarks(id) on delete cascade;

comment on table worship_remarks is
    'Короткая заметка «здесь не так» от любого читателя. Закрывает её пуджари с пометкой учтено/не согласен.';
comment on table worship_notifications is
    'События для рассылки. Пишутся функциями, отправляются служебным процессом с группировкой.';
