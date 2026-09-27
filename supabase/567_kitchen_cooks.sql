-- =============================================================
-- Повара у блюд меню (просьба Сундары Рупы 27.09.2026): у каждого блюда в Планировщике
-- и в Меню на день — буквы повара своим цветом (БК, СС…).
-- Справочник поваров — Кухня → Справочники → «Повара»: имя, буквы, цвет; можно завести
-- и человека не из базы вайшнавов (Бридж Кишор). Меняет тот, у кого право на справочники кухни.
-- =============================================================

create table if not exists public.kitchen_cooks (
  id           uuid primary key default gen_random_uuid(),
  name         text not null,
  short        text not null check (char_length(short) between 1 and 4),
  color        text not null default '#8b5cf6',
  vaishnava_id uuid references public.vaishnavas(id) on delete set null,
  is_active    boolean not null default true,
  sort_order   integer not null default 0,
  created_at   timestamptz not null default now()
);
alter table public.kitchen_cooks enable row level security;
drop policy if exists "Kitchen users read cooks" on public.kitchen_cooks;
create policy "Kitchen users read cooks" on public.kitchen_cooks for select to authenticated using (true);
drop policy if exists "Kitchen editors manage cooks" on public.kitchen_cooks;
create policy "Kitchen editors manage cooks" on public.kitchen_cooks for all to authenticated
  using (abk_current_user_has_permission('edit_kitchen_dictionaries'))
  with check (abk_current_user_has_permission('edit_kitchen_dictionaries'));

alter table public.menu_dishes add column if not exists cook_ref uuid references public.kitchen_cooks(id) on delete set null;

-- команда кухни + Бридж Кишор
insert into public.kitchen_cooks (name, short, color, vaishnava_id, sort_order)
select x.name, x.short, x.color, x.vid, x.ord from (values
  ('Бридж Кишор', 'БК', '#16a34a', null::uuid, 1),
  ('Сундара рупа дас', 'СР', '#2563eb', '70e8f35c-f1a9-40fe-b510-93e6ad05a52e'::uuid, 2),
  ('Садху-санга дас', 'СС', '#9333ea', 'c57960b0-ad75-44d7-9ace-1f34b90bc256'::uuid, 3),
  ('Ачинтья Чайтанья дас', 'АЧ', '#ea580c', 'edca3c76-6689-4146-b8b0-beb4c6ea4403'::uuid, 4),
  ('Кешава Гопал дас', 'КГ', '#0891b2', '52785010-d932-46f4-b1cb-1a83bdd3b349'::uuid, 5),
  ('Ниламани-прия деви даси', 'НП', '#db2777', '932b665e-2d17-466b-8dae-507e63e9b6a7'::uuid, 6)
) as x(name, short, color, vid, ord)
where not exists (select 1 from public.kitchen_cooks c where c.name = x.name);

insert into translations (key, ru, en, hi, context) values
('dict_kitchen_cooks', 'Повара', 'Cooks', 'रसोइये', 'Кухня → Справочники'),
('cook_short', 'Буквы', 'Initials', 'संक्षेप', 'Справочник поваров: буквы у блюда'),
('cook_name', 'Имя', 'Name', 'नाम', 'Справочник поваров'),
('dish_cook', 'Повар блюда', 'Dish cook', 'व्यंजन का रसोइया', 'Планировщик: повар у блюда'),
('dish_cook_none', '— не указан —', '— not set —', '— नहीं चुना —', 'Планировщик: повар у блюда')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;

