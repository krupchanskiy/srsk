-- 823: Махарадж «всегда в Расписании» — строка видна даже без записей (ВГ 20.11.2026)
-- Записи Махараджей — только информация (даты и место), как Club108: статус всегда «confirmed».
alter table public.maharajas add column pinned boolean not null default false;
update public.maharajas set pinned = true where name = 'Бхакти Вигьяна Госвами';
update public.retreat_plans set status = 'confirmed' where kind = 'guru' and status = 'tentative';
