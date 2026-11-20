-- «Расписание» (ВГ 20.11.2026): сколько номеров группе нужно по типам — двух-, трёх-, четырёхместных.
-- Расписание сверяет это со свободными номерами Гостевого дома по ночам и подсказывает резерв
-- (только арендные дома — решение ВГ; дома команды резервом не считаются).
-- rooms_count остаётся общим числом (сумма типов, если они указаны).

alter table public.retreat_plans
    add column rooms_2 int check (rooms_2 >= 0),
    add column rooms_3 int check (rooms_3 >= 0),
    add column rooms_4 int check (rooms_4 >= 0);

-- Раса-ретрит из Google-таблицы: 2 beds — 5, 3 beds — 2, 4 beds — 6
update public.retreat_plans set rooms_2 = 5, rooms_3 = 2, rooms_4 = 6
where title = 'Раса-ретрит (Махатма прабху и ученики)' and start_date = '2027-02-06';

insert into translations (key, ru, en, hi, context) values
('rc_rooms_2', 'Двухместных', 'Double rooms', 'दो-बिस्तर कमरे', 'Расписание: номера по типам'),
('rc_rooms_3', 'Трёхместных', 'Triple rooms', 'तीन-बिस्तर कमरे', 'Расписание: номера по типам'),
('rc_rooms_4', 'Четырёхместных', 'Quad rooms', 'चार-बिस्तर कमरे', 'Расписание: номера по типам'),
('rc_col_reserve', 'Резерв (аренда)', 'Reserve (rented)', 'आरक्षित (किराया)', 'Расписание: колонка')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;

-- Уточнение ВГ (20.11): трёхместных номеров нет — «два плюс один» это двухместный с доп. кроватью.
-- Колонка rooms_3 больше не заполняется; у Раса-ретрита 2 таких номера ушли в двухместные (5 + 2 = 7).
-- (выполнено отдельным точечным UPDATE по id после сухого прогона)
-- update retreat_plans set rooms_2 = 7, rooms_3 = null where id = '50867c74-1aef-4828-949a-46b23b0e2beb';
