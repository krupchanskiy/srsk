-- 829: Итоги — раскрытие любой строки до операций (только чтение, суперпользователи)
-- Те же правила, что в 827 (fin_itogi_month_rows), но по каждой проводке: ключ строки
-- (side, dept, grp, sub, item) + доля проводки в этой строке (amount). Сумма amount по ключу
-- = amount строки из 827. Плюс side = 'alloc' — «Выделено» департаменту за месяц:
-- выдачи с Кассы ДДС / Кассы ДДС у ГХ / ИП / карт ИП и перекидки между департаментами.

CREATE OR REPLACE FUNCTION public.fin_itogi_month_ops(p_month date)
RETURNS TABLE(side text, dept text, grp text, sub text, item text,
              posting_id uuid, operation_id uuid, occurred_on date, account text, who text,
              comment text, currency text, amount_orig numeric, amount_full numeric, amount numeric, note text)
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public'
AS $fn$
#variable_conflict use_column
DECLARE
  v_from date := date_trunc('month', p_month)::date;
  v_to   date := (date_trunc('month', p_month) + interval '1 month - 1 day')::date;
BEGIN
  IF NOT public.is_superuser(auth.uid()) THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Итоги видят только суперпользователи';
  END IF;

  RETURN QUERY
  WITH mon(num, re) AS (VALUES (1,'январ'),(2,'феврал'),(3,'март'),(4,'апрел'),(5,'ма[йя]'),(6,'июн'),(7,'июл'),
                                (8,'август'),(9,'сентябр'),(10,'октябр'),(11,'ноябр'),(12,'декабр')),
  pname AS (
    SELECT v.id, coalesce(nullif(v.spiritual_name,''), trim(coalesce(v.first_name,'') || ' ' || coalesce(v.last_name,''))) AS nm
    FROM vaishnavas v
  ),
  -- ===== РАСХОДЫ (как в 827) =====
  ex AS (
    SELECT p.id, p.operation_id AS op, o.occurred_on, c.name AS cat, a.name AS acc,
           coalesce(o2.comment, o.comment, '') || CASE WHEN p.note IS NOT NULL AND p.note <> '' THEN ' · ' || p.note ELSE '' END AS cmt,
           p.currency_code AS cur,
           CASE p.direction WHEN 'out' THEN p.amount ELSE -p.amount END AS amt_orig,
           CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END AS amt,
           lower(coalesce(o2.comment, o.comment, '') || ' ' || coalesce(p.note,'')) AS txt,
           CASE WHEN rr.id IS NOT NULL AND rr.start_date >= '2001-01-01' AND coalesce(d.name,'') NOT IN ('Кухня','Кафе') THEN 'Ретриты'
                ELSE coalesce(d.name, CASE WHEN ob.type::text = 'retreat' THEN 'Ретриты' ELSE 'Общие траты ШРСК' END) END AS dept,
           coalesce(d.name, a.name) AS payer, rr.name_ru AS retreat_name,
           coalesce(hp.nm, pp.nm) AS who, o.type::text AS otype
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    LEFT JOIN fin_operations o2 ON o2.id = o.original_operation_id
    JOIN fin_categories c ON c.id = p.category_id AND c.direction = 'out'
    JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN fin_departments d ON d.id = a.department_id
    LEFT JOIN fin_accounting_objects ob ON ob.id = p.object_id
    LEFT JOIN retreats rr ON rr.id = ob.retreat_id
    LEFT JOIN pname hp ON hp.id = p.holder_person_id
    LEFT JOIN pname pp ON pp.id = p.participant_id
    WHERE c.name NOT IN ('Возврат участнику','Сдача участнику')
      AND o.occurred_on BETWEEN v_from - 120 AND v_to + 120
  ),
  ex_months AS (
    SELECT ex.id, make_date(
             CASE WHEN m.num > extract(month FROM ex.occurred_on)::int + 1 THEN extract(year FROM ex.occurred_on)::int - 1
                  ELSE extract(year FROM ex.occurred_on)::int END, m.num, 1) AS per
    FROM ex JOIN mon m ON ex.txt ~ ('за [^.;]*' || m.re)
    WHERE ex.cat IN ('Оплата труда','Электричество, вода, газ','Аренда','Жилье за пределами ШРСК')
    UNION
    SELECT ex.id, to_date((regexp_match(ex.txt, 'за (\d{2})\.(\d{4})'))[2] || '-' || (regexp_match(ex.txt, 'за (\d{2})\.(\d{4})'))[1] || '-01', 'YYYY-MM-DD')
    FROM ex WHERE ex.txt ~ 'за \d{2}\.\d{4}' AND ex.cat = 'Оплата труда'
  ),
  ex_alloc AS (
    SELECT ex.*, ex.amt / count(*) OVER (PARTITION BY ex.id) AS part, count(*) OVER (PARTITION BY ex.id) AS nper, em.per
    FROM ex JOIN ex_months em ON em.id = ex.id
    UNION ALL
    SELECT ex.*, ex.amt, 1, date_trunc('month', ex.occurred_on)::date
    FROM ex WHERE NOT EXISTS (SELECT 1 FROM ex_months em WHERE em.id = ex.id)
  ),
  -- ===== ПРИХОДЫ (как в 827) =====
  inc AS (
    SELECT p.id, p.operation_id AS op, p.participant_id, o.occurred_on, c.name AS cat, p.participant_balance_kind::text AS kind,
           a.name AS acc, coalesce(o.comment, '') || CASE WHEN p.note IS NOT NULL AND p.note <> '' THEN ' · ' || p.note ELSE '' END AS cmt,
           p.currency_code AS cur,
           CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END AS amt_orig,
           CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END AS amt,
           ob.id AS obj, ob.display_name AS obj_name, r.id AS retreat_id, r.start_date, r.end_date,
           (r.id IS NOT NULL AND r.start_date >= '2001-01-01') AS dated,
           coalesce(pp.nm, hp.nm) AS who
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_categories c ON c.id = p.category_id AND c.direction = 'in'
    JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN fin_accounting_objects ob ON ob.id = p.object_id
    LEFT JOIN retreats r ON r.id = ob.retreat_id
    LEFT JOIN pname pp ON pp.id = p.participant_id
    LEFT JOIN pname hp ON hp.id = p.holder_person_id
    WHERE c.name NOT IN ('Передача денег Клубом 108','Принято под сдачу','Предоплата/Аванс')
  ),
  rb AS (
    SELECT inc.*, CASE WHEN cat = 'Оплата от участника' THEN coalesce(kind,'general')
                       WHEN cat = 'Прасад — оплата спонсора' THEN 'meals_sponsor'
                       ELSE 'sponsor' END AS blk
    FROM inc WHERE dated AND cat IN ('Оплата от участника','Оплата спонсора','Прасад — оплата спонсора')
      AND start_date <= v_to AND end_date >= v_from
  ),
  gen AS (
    SELECT retreat_id, participant_id, sum(amt) AS g FROM rb WHERE blk = 'general' AND participant_id IS NOT NULL
    GROUP BY 1,2 HAVING sum(amt) <> 0
  ),
  gen_bal AS (
    SELECT gen.*, public.fin_private_participant_balance_v2(gen.participant_id, gen.retreat_id) AS b FROM gen
  ),
  gen_sf AS (
    SELECT gb.retreat_id, gb.participant_id, gb.g, gb.b->>'currency' AS cur, k.blk,
           greatest(coalesce((gb.b->'blocks'->k.blk->>'charged')::numeric,0)
                  - coalesce((gb.b->'blocks'->k.blk->>'paid')::numeric,0)
                  - coalesce((gb.b->'blocks'->k.blk->>'offset')::numeric,0)
                  - coalesce((gb.b->'blocks'->k.blk->>'written_off')::numeric,0), 0) AS sf
    FROM gen_bal gb CROSS JOIN (VALUES ('accommodation'),('meals'),('org_fee'),('extra')) k(blk)
  ),
  -- разнесение общей оплаты участника по блокам (как в 827), но по участнику — чтобы раздать по его проводкам
  gen_alloc AS (
    SELECT retreat_id, participant_id, g, blk,
           CASE WHEN cur = 'INR' THEN sf * least(1, g / nullif(sum(sf) OVER w, 0))
                ELSE g * sf / nullif(sum(sf) OVER w, 0) END AS amt
    FROM gen_sf WHERE sf > 0
    WINDOW w AS (PARTITION BY retreat_id, participant_id)
    UNION ALL
    SELECT gb.retreat_id, gb.participant_id, gb.g, 'general',
           CASE WHEN t.tot = 0 THEN gb.g WHEN gb.b->>'currency' = 'INR' THEN gb.g - least(gb.g, t.tot) ELSE 0 END
    FROM gen_bal gb
    CROSS JOIN LATERAL (SELECT coalesce(sum(s.sf),0) AS tot FROM gen_sf s
                        WHERE s.retreat_id = gb.retreat_id AND s.participant_id = gb.participant_id) t
  ),
  -- проводки блоков: прямые — целиком, общие оплаты — долей разнесения (доля проводки в общей оплате участника)
  rb_post AS (
    SELECT rb.*, rb.blk AS to_blk, rb.amt AS val, NULL::text AS how
    FROM rb WHERE NOT (rb.blk = 'general' AND rb.participant_id IS NOT NULL)
    UNION ALL
    SELECT rb.*, ga.blk, ga.amt * rb.amt / ga.g,
           'общая оплата, разнесена по начислениям'
    FROM rb JOIN gen_alloc ga ON ga.retreat_id = rb.retreat_id AND ga.participant_id = rb.participant_id
    WHERE rb.blk = 'general' AND ga.amt IS NOT NULL AND ga.amt <> 0
  ),
  rb_month AS (
    SELECT rp.*, r.name_ru AS rname,
           (least(r.end_date, v_to) - greatest(r.start_date, v_from) + 1) AS d_in, (r.end_date - r.start_date + 1) AS d_all
    FROM rb_post rp JOIN retreats r ON r.id = rp.retreat_id
  ),
  other_in AS (
    SELECT * FROM inc
    WHERE occurred_on BETWEEN v_from AND v_to
      AND NOT (dated AND cat IN ('Оплата от участника','Оплата спонсора','Прасад — оплата спонсора'))
  ),
  -- ===== ВЫДЕЛЕНО: переводы (без статьи) на счета департаментов =====
  tr AS (
    SELECT p.id, p.operation_id AS op, o.occurred_on, a.name AS acc, d.name AS dept, p.account_id,
           coalesce(o2.comment, o.comment, '') || CASE WHEN p.note IS NOT NULL AND p.note <> '' THEN ' · ' || p.note ELSE '' END AS cmt,
           p.currency_code AS cur,
           CASE p.direction WHEN 'in' THEN p.amount ELSE -p.amount END AS amt_orig,
           CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END AS amt,
           p.direction::text AS dir, hp.nm AS who, d.id AS dept_id
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    LEFT JOIN fin_operations o2 ON o2.id = o.original_operation_id
    JOIN fin_accounts a ON a.id = p.account_id
    JOIN fin_departments d ON d.id = a.department_id
    LEFT JOIN pname hp ON hp.id = p.holder_person_id
    WHERE p.category_id IS NULL
      AND (o.type::text = 'transfer' OR (o.type::text = 'reversal' AND o2.type::text = 'transfer'))
      AND o.occurred_on BETWEEN v_from AND v_to
  ),
  tr_cp AS (
    SELECT tr.*, cp.name AS cp_acc, cpd.name AS cp_dept, cp.department_id AS cp_dept_id
    FROM tr
    CROSS JOIN LATERAL (
      SELECT a2.name, a2.department_id FROM fin_postings q JOIN fin_accounts a2 ON a2.id = q.account_id
      WHERE q.operation_id = tr.op AND q.id <> tr.id AND q.direction::text <> tr.dir AND q.category_id IS NULL
      ORDER BY q.ledger_seq LIMIT 1) cp
    LEFT JOIN fin_departments cpd ON cpd.id = cp.department_id
  )
  -- расходы
  SELECT 'out'::text, ea.dept, ea.cat,
         CASE WHEN ea.dept = 'Ретриты' THEN coalesce(ea.retreat_name, 'Без ретрита') END,
         CASE WHEN ea.dept = 'Ретриты' THEN ea.payer END,
         ea.id, ea.op, ea.occurred_on, ea.acc, ea.who, ea.cmt, ea.cur, ea.amt_orig, ea.amt, round(ea.part, 2),
         concat_ws('; ',
           CASE WHEN ea.nper > 1 THEN 'за ' || ea.nper || ' мес. — поровну' END,
           CASE WHEN date_trunc('month', ea.occurred_on)::date <> v_from THEN 'оплачено ' || to_char(ea.occurred_on, 'DD.MM.YYYY') END,
           CASE WHEN ea.otype = 'reversal' THEN 'сторно' END)
  FROM ex_alloc ea WHERE ea.per = v_from
  UNION ALL
  -- блоки ретритов
  SELECT 'in',
         CASE rm.to_blk WHEN 'accommodation' THEN 'Гест-хаус' WHEN 'meals' THEN 'Кухня' WHEN 'meals_sponsor' THEN 'Кухня' ELSE 'Ретриты' END,
         'Ретриты',
         rm.rname || CASE WHEN rm.d_in < rm.d_all THEN ' — часть: ' || rm.d_in || ' из ' || rm.d_all || ' дн.' ELSE '' END,
         CASE rm.to_blk WHEN 'accommodation' THEN 'Проживание' WHEN 'meals' THEN 'Прасад' WHEN 'meals_sponsor' THEN 'Прасад (спонсор)'
                     WHEN 'org_fee' THEN 'Оргвзнос' WHEN 'sponsor' THEN 'Расходы ретрита (спонсор)' WHEN 'extra' THEN 'Доп. услуги'
                     ELSE 'Аванс, не распределён' END,
         rm.id, rm.op, rm.occurred_on, rm.acc, rm.who, rm.cmt, rm.cur, rm.amt_orig, rm.amt,
         round(rm.val * rm.d_in::numeric / rm.d_all, 2),
         concat_ws('; ', rm.how, CASE WHEN rm.d_in < rm.d_all THEN rm.d_in || ' из ' || rm.d_all || ' дн.' END)
  FROM rb_month rm
  UNION ALL
  -- прочие приходы
  SELECT 'in',
         CASE WHEN oi.cat = 'Касса кафе' THEN 'Кафе'
              WHEN oi.cat IN ('Касса Магазин','Пожертвования в магазин','Мурти') THEN 'Магазин'
              WHEN oi.cat = 'Прасад - пожертвование' THEN 'Кухня'
              WHEN oi.cat = 'Пожертвование на деревья' THEN 'Зелёные'
              WHEN oi.cat = 'Оплата проживания (в не ретритов)' THEN 'Гест-хаус'
              WHEN oi.cat = 'Оплата от участника' AND oi.kind = 'accommodation' THEN 'Гест-хаус'
              WHEN oi.cat = 'Оплата от участника' AND oi.kind = 'meals' THEN 'Кухня'
              WHEN oi.cat = 'Оплата от участника' THEN 'Гест-хаус'
              ELSE 'Общие приходы ШРСК' END,
         CASE WHEN oi.cat = 'Касса кафе' THEN 'Кафе'
              WHEN oi.cat IN ('Касса Магазин','Пожертвования в магазин') THEN 'Магазин'
              WHEN oi.cat = 'Мурти' THEN 'Мурти'
              WHEN oi.cat IN ('Прасад - пожертвование','Именное пожертвование','Пожертвование от участника','Пожертвование на деревья') THEN 'Пожертвования'
              WHEN oi.cat IN ('Оплата от участника','Оплата проживания (в не ретритов)') THEN 'Гости без события'
              ELSE 'Прочие приходы' END,
         CASE WHEN oi.cat IN ('Касса кафе','Касса Магазин','Мурти') THEN coalesce(CASE WHEN oi.dated THEN oi.obj_name END, 'Вне ретритов')
              WHEN oi.cat = 'Прасад - пожертвование' THEN 'За прасад / талончики'
              WHEN oi.cat = 'Оплата от участника' THEN CASE oi.kind WHEN 'accommodation' THEN 'Проживание' WHEN 'meals' THEN 'Прасад' ELSE 'Без разбивки' END
              ELSE oi.cat END,
         NULL::text,
         oi.id, oi.op, oi.occurred_on, oi.acc, oi.who, oi.cmt, oi.cur, oi.amt_orig, oi.amt, round(oi.amt, 2), NULL::text
  FROM other_in oi
  UNION ALL
  -- выделено департаменту (переводы внутри одного департамента — обмен валют — не считаем)
  SELECT 'alloc', t.dept,
         CASE WHEN t.cp_dept_id IS NULL AND (t.cp_acc ~ '^Касса' OR t.cp_acc ~ 'ИП ШРСК') AND t.amt >= 0 THEN 'Выдано ШРСК'
              WHEN t.cp_dept_id IS NULL AND (t.cp_acc ~ '^Касса' OR t.cp_acc ~ 'ИП ШРСК') THEN 'Сдано в кассу ШРСК'
              WHEN t.cp_dept_id IS NOT NULL AND t.amt >= 0 THEN 'Получено от департамента'
              WHEN t.cp_dept_id IS NOT NULL THEN 'Передано департаменту'
              ELSE 'Прочие счета' END,
         CASE WHEN t.cp_dept_id IS NOT NULL THEN t.cp_dept ELSE t.cp_acc END,
         NULL::text,
         t.id, t.op, t.occurred_on, t.acc, t.who, t.cmt, t.cur, t.amt_orig, t.amt, round(t.amt, 2),
         NULL::text
  FROM tr_cp t
  WHERE t.cp_dept_id IS DISTINCT FROM t.dept_id;
END;
$fn$;

REVOKE ALL ON FUNCTION public.fin_itogi_month_ops(date) FROM public, anon;
GRANT EXECUTE ON FUNCTION public.fin_itogi_month_ops(date) TO authenticated;

-- пункт меню Финансы → «Итоги»
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_fin_itogi', 'Итоги', 'Results', 'परिणाम', 'Навигация Финансы')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context, updated_at = NOW();
