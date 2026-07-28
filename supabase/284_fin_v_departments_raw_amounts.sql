-- Вьюха форматировала суммы через fin_fmt_money, а у роли authenticated прав на
-- эту функцию нет: вьюха исполняется с правами вызывающего, поэтому страница
-- падала с «permission denied for function fin_fmt_money». В SQL-тестах это не
-- всплыло — там я работал от postgres, которому можно всё.
--
-- Выдавать грант не стали: в остальном модуле витрины отдают сырые числа, а
-- форматирует их FinUtils.fmtMoney на клиенте. Делаем так же — заодно уходит
-- расхождение в разделителях между сервером и интерфейсом.
--
-- Тип колонки меняется (text → jsonb), поэтому вьюху пересоздаём целиком.
DROP VIEW IF EXISTS public.fin_v_departments;

CREATE VIEW public.fin_v_departments AS
SELECT d.id,
       d.name,
       d.responsible_person_id,
       fin_private_person_name(d.responsible_person_id) AS responsible_name,
       l.chat_id,
       k.title AS chat_title,
       (SELECT jsonb_agg(jsonb_build_object(
                 'currency', a.currency_code,
                 'amount', (SELECT COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)
                              FROM fin_postings p WHERE p.account_id = a.id))
                 ORDER BY a.currency_code)
          FROM fin_accounts a
         WHERE a.department_id = d.id AND a.kind = 'custodial' AND a.is_active) AS balances
FROM fin_departments d
LEFT JOIN tg_chat_links l ON l.department_id = d.id AND l.is_active
LEFT JOIN tg_known_chats k ON k.chat_id = l.chat_id
WHERE fin_can_read_all();

GRANT SELECT ON public.fin_v_departments TO authenticated;
NOTIFY pgrst, 'reload schema';
