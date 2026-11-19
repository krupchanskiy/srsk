-- /баланс: показывать всех активных держателей департамента, даже у кого 0 (ВГ, 19.11.2026).
-- Раньше держатель с нулевым остатком пропадал из списка (HAVING <> 0) — в «Поклонении»
-- не было видно Амалы-Камалы, и непонятно, 0 у неё или её забыли. Теперь:
--  • активные держатели — всегда, с суммой (в том числе 0 ₹);
--  • «не привязано» / «выдано на сдачу» и бывшие держатели — только если не ноль;
--  • в валюте, где у департамента пусто и никто из держателей ничего не держал
--    (например «Поклонение (₽)» = 0), список нулей не выводим — это шум.
-- Остальное (итог, касса ДДС, «на хозяйство») — как в 711.

CREATE OR REPLACE FUNCTION public.tg_department_balance(p_chat bigint)
 RETURNS TABLE(department_name text, balance numeric, currency_code text, pending_drafts integer, formatted text, holders_line text)
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_dept uuid;
  v_name text;
  v_float boolean;
  v_pending int;
  r record;
  v_holders text;
  v_show_zero boolean;
BEGIN
  SELECT l.department_id INTO v_dept FROM tg_chat_links l
   WHERE l.chat_id = p_chat AND l.is_active;
  IF v_dept IS NULL THEN RETURN; END IF;
  SELECT d.name, d.change_float INTO v_name, v_float FROM fin_departments d WHERE d.id = v_dept;
  SELECT count(*)::int INTO v_pending FROM tg_drafts dr WHERE dr.department_id = v_dept AND dr.status = 'pending';

  FOR r IN
    SELECT x.cur,
           max(x.own_id::text)::uuid AS own_id,
           coalesce(sum(x.bal) FILTER (WHERE x.own), 0) AS own_bal,
           coalesce(sum(x.bal) FILTER (WHERE NOT x.own), 0) AS box_bal,
           bool_or(NOT x.own) AS has_box,
           bool_or(x.own) AS has_own
      FROM (
        SELECT a.currency_code AS cur, (a.department_id IS NOT DISTINCT FROM v_dept) AS own,
               CASE WHEN a.department_id = v_dept THEN a.id END AS own_id,
               (SELECT COALESCE(SUM(CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END), 0)
                  FROM fin_postings p WHERE p.account_id = a.id) AS bal
          FROM fin_accounts a
         WHERE a.is_active
           AND ((a.department_id = v_dept AND a.kind = 'custodial') OR a.cashbox_department_id = v_dept)
      ) x
     GROUP BY x.cur
  LOOP
    -- нули держателей показываем, только если в этой валюте у департамента что-то есть
    v_show_zero := r.own_id IS NOT NULL AND (r.own_bal <> 0 OR EXISTS (
      SELECT 1 FROM fin_postings p3 WHERE p3.account_id = r.own_id AND p3.holder_person_id IS NOT NULL));

    SELECT string_agg(format('  — %s: %s', tg_escape(h.label), fin_fmt_money(h.amt, r.cur)), E'\n'
                      ORDER BY h.amt DESC, h.label)
      INTO v_holders
      FROM (
        -- активные держатели — всегда, даже с нулём
        SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                        NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                        'без имени') AS label,
               COALESCE(SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END), 0) AS amt
          FROM fin_department_holders fh
          JOIN vaishnavas v ON v.id = fh.vaishnava_id
          LEFT JOIN fin_postings p2 ON p2.account_id = r.own_id AND p2.holder_person_id = fh.vaishnava_id
         WHERE fh.department_id = v_dept AND fh.is_active AND r.own_id IS NOT NULL
         GROUP BY fh.vaishnava_id, v.spiritual_name, v.first_name, v.last_name
        HAVING v_show_zero OR COALESCE(SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END), 0) <> 0
        UNION ALL
        -- без держателя и бывшие держатели — только если не ноль (как раньше)
        SELECT COALESCE(NULLIF(v.spiritual_name, ''),
                        NULLIF(TRIM(COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,'')), ''),
                        CASE WHEN v_float THEN 'выдано на сдачу' ELSE 'не привязано' END),
               SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END)
          FROM fin_postings p2
          LEFT JOIN vaishnavas v ON v.id = p2.holder_person_id
         WHERE p2.account_id = r.own_id
           AND NOT EXISTS (SELECT 1 FROM fin_department_holders fh
                            WHERE fh.department_id = v_dept AND fh.is_active
                              AND fh.vaishnava_id = p2.holder_person_id)
           AND (p2.holder_person_id IS NOT NULL
                OR EXISTS (SELECT 1 FROM fin_department_holders fh WHERE fh.department_id = v_dept AND fh.is_active))
         GROUP BY v.spiritual_name, v.first_name, v.last_name, p2.holder_person_id
        HAVING SUM(CASE p2.direction WHEN 'in' THEN p2.amount ELSE -p2.amount END) <> 0
      ) h;

    department_name := v_name;
    currency_code := r.cur;
    pending_drafts := v_pending;
    IF r.has_box THEN
      balance := r.own_bal + r.box_bal;
      formatted := 'всего ' || fin_fmt_money(balance, r.cur);
      holders_line := concat_ws(E'\n',
        format('  — на хозяйство: %s', fin_fmt_money(r.own_bal, r.cur)),
        v_holders,
        format('  — касса ДДС: %s', fin_fmt_money(r.box_bal, r.cur)));
    ELSE
      balance := r.own_bal;
      formatted := fin_fmt_money(balance, r.cur);
      holders_line := v_holders;
    END IF;
    RETURN NEXT;
  END LOOP;
END;
$function$;
