-- Связь заявки из чата с её операциями.
--
-- Замечание ВГ (01.08.2026): «может быть одна отметка у Ашиша например такси
-- из аэропорта 6000, едут 2 или 3 человека из разных департаментов, те должна
-- быть возможность разбить сумму между департаментами».
--
-- Одна заявка теперь порождает до четырёх операций: свой расход, передача
-- получателю и расход получателя — по каждому департаменту. Поле
-- tg_drafts.operation_id вмещает одну, поэтому историю ведём здесь.
-- tg_drafts.operation_id остаётся главной операцией — на нём держатся витрины.

create table if not exists tg_draft_operations (
  draft_id     uuid not null references tg_drafts(id) on delete cascade,
  operation_id uuid not null references fin_operations(id),
  role         text not null check (role in ('expense', 'transfer', 'dept_expense')),
  seq          int  not null default 0,
  created_at   timestamptz not null default now(),
  primary key (draft_id, operation_id)
);

create index if not exists tg_draft_operations_operation_idx
  on tg_draft_operations (operation_id);

comment on table tg_draft_operations is
  'Операции, порождённые заявкой из чата департамента. Пишется только через tg_post_draft.';
comment on column tg_draft_operations.role is
  'expense — расход своего департамента; transfer — передача получателю; dept_expense — расход получателя';

alter table tg_draft_operations enable row level security;

-- Читают те же, кто видит финмодуль целиком. Записи политики нет намеренно:
-- таблицу наполняет только tg_post_draft (security definer).
drop policy if exists "Draft operations read fin" on tg_draft_operations;
create policy "Draft operations read fin" on tg_draft_operations
  for select to authenticated
  using (fin_can_read_all((select auth.uid())));

grant select on tg_draft_operations to authenticated;

-- Уже проведённые заявки: заносим их единственную операцию, чтобы история
-- была полной с самого начала.
insert into tg_draft_operations (draft_id, operation_id, role, seq)
select d.id, d.operation_id,
       case when d.kind = 'transfer' then 'transfer' else 'expense' end,
       0
  from tg_drafts d
  join fin_operations o on o.id = d.operation_id
 where d.operation_id is not null
on conflict do nothing;
