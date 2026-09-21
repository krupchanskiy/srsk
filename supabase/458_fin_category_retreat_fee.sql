-- Статья расхода «Гонорар за ретрит» (ВГ, 21.09.2026): приглашённые повара,
-- премии и разовые выплаты людям за конкретный ретрит. Отдельно от
-- «Гонорара лектора» (lecture_fee) — тот только за лекции.
-- Скрыта от департаментов, как и lecture_fee: проводит казначей.
INSERT INTO fin_categories (code, name, direction, visible_to_departments)
SELECT 'retreat_fee', 'Гонорар за ретрит', 'out', false
WHERE NOT EXISTS (SELECT 1 FROM fin_categories WHERE code = 'retreat_fee');
