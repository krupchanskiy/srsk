-- Уборка по решениям Адриана 19.10.2026.

-- 1. worship_reorder — ручной порядок статей стрелками. Стрелки убраны
--    (статьи сортируются по алфавиту или по дате изменения), вызывающих нет
--    ни в страницах, ни в базе.
drop function if exists public.worship_reorder(uuid, integer);

-- 2. Финансовые представления (definer) были доступны анониму на select.
--    Данных они ему не отдавали — каждое упирается в функцию-привратник
--    (fin_can_read_all, fin_is_admin, fin_can_see_account), а её аноним
--    вызвать не может. Но держать дверь открытой ради замка внутри незачем:
--    одна правка привратника — и финансы видны всему интернету.
--    Вошедшим права не меняются; служебный ключ функций их не использует.
revoke all on table public.fin_v_account_ledger,
                    public.fin_v_charges,
                    public.fin_v_chat_drafts_unfinished,
                    public.fin_v_department_categories,
                    public.fin_v_departments,
                    public.fin_v_payroll_accruals,
                    public.fin_v_payroll_payments,
                    public.fin_v_payroll_positions
    from anon;
