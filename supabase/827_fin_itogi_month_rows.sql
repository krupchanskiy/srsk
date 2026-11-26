-- 827: Итоги — подсчёт месяца для страницы Финансы → «Итоги» (только чтение, суперпользователи)
-- Правила (ВГ 24–26.11): всё по месяцу, к которому относится; ретрит в двух месяцах — по дням;
-- общие оплаты участника разносятся по недоплаченным блокам; Клуб 108 и «Принято под сдачу» — не приход;
-- трата — у департамента своего счёта; без департамента: на ретрит — «Ретриты», иначе «Общие траты ШРСК».

CREATE OR REPLACE FUNCTION public.fin_itogi_month_rows(p_month date)
RETURNS TABLE(side text, dept text, grp text, sub text, item text, amount numeric, n int)
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
  -- ===== РАСХОДЫ =====
  ex AS (
    SELECT p.id, o.occurred_on, c.name AS cat,
           CASE p.direction WHEN 'out' THEN p.amount_base ELSE -p.amount_base END AS amt,
           lower(coalesce(o2.comment, o.comment, '') || ' ' || coalesce(p.note,'')) AS txt,
           -- трата с привязкой к ретриту — трата ретрита (кто платил — в payer); Кухня и Кафе остаются у себя (Ретрит/Прасад/Кафе)
           CASE WHEN rr.id IS NOT NULL AND rr.start_date >= '2001-01-01' AND coalesce(d.name,'') NOT IN ('Кухня','Кафе') THEN 'Ретриты'
                ELSE coalesce(d.name, CASE WHEN ob.type::text = 'retreat' THEN 'Ретриты' ELSE 'Общие траты ШРСК' END) END AS dept,
           coalesce(d.name, a.name) AS payer, rr.name_ru AS retreat_name
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    LEFT JOIN fin_operations o2 ON o2.id = o.original_operation_id
    JOIN fin_categories c ON c.id = p.category_id AND c.direction = 'out'
    JOIN fin_accounts a ON a.id = p.account_id
    LEFT JOIN fin_departments d ON d.id = a.department_id
    LEFT JOIN fin_accounting_objects ob ON ob.id = p.object_id
    LEFT JOIN retreats rr ON rr.id = ob.retreat_id
    WHERE c.name NOT IN ('Возврат участнику','Сдача участнику')
      AND o.occurred_on BETWEEN v_from - 120 AND v_to + 120
  ),
  -- месяцы «за …» для зарплаты, газа, аренды, жилья: из комментария; несколько месяцев — поровну
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
    SELECT ex.dept, ex.cat, ex.payer, ex.retreat_name, ex.amt / count(*) OVER (PARTITION BY ex.id) AS amt, em.per
    FROM ex JOIN ex_months em ON em.id = ex.id
    UNION ALL
    SELECT ex.dept, ex.cat, ex.payer, ex.retreat_name, ex.amt, date_trunc('month', ex.occurred_on)::date
    FROM ex WHERE NOT EXISTS (SELECT 1 FROM ex_months em WHERE em.id = ex.id)
  ),
  -- ===== ПРИХОДЫ =====
  inc AS (
    SELECT p.id, p.participant_id, o.occurred_on, c.name AS cat, p.participant_balance_kind::text AS kind,
           CASE p.direction WHEN 'in' THEN p.amount_base ELSE -p.amount_base END AS amt,
           ob.id AS obj, ob.display_name AS obj_name, r.id AS retreat_id, r.start_date, r.end_date,
           (r.id IS NOT NULL AND r.start_date >= '2001-01-01') AS dated
    FROM fin_postings p
    JOIN fin_operations o ON o.id = p.operation_id
    JOIN fin_categories c ON c.id = p.category_id AND c.direction = 'in'
    LEFT JOIN fin_accounting_objects ob ON ob.id = p.object_id
    LEFT JOIN retreats r ON r.id = ob.retreat_id
    WHERE c.name NOT IN ('Передача денег Клубом 108','Принято под сдачу','Предоплата/Аванс')
  ),
  -- блоки ретрита, которые делятся по дням
  rb AS (
    SELECT inc.*, CASE WHEN cat = 'Оплата от участника' THEN coalesce(kind,'general')
                       WHEN cat = 'Прасад — оплата спонсора' THEN 'meals_sponsor'
                       ELSE 'sponsor' END AS blk
    FROM inc WHERE dated AND cat IN ('Оплата от участника','Оплата спонсора','Прасад — оплата спонсора')
      AND start_date <= v_to AND end_date >= v_from
  ),
  -- общие оплаты разносим по недоплаченным блокам участника
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
  gen_alloc AS (
    -- блок получает свой недоплаченный остаток, но не больше общей оплаты (пропорционально).
    -- Недоплата считается в валюте расчёта участника: сравнить с рупиями можно только у рупийных;
    -- у остальных общая оплата делится по долям недоплаты целиком.
    SELECT retreat_id, blk,
           CASE WHEN cur = 'INR' THEN sf * least(1, g / nullif(sum(sf) OVER w, 0))
                ELSE g * sf / nullif(sum(sf) OVER w, 0) END AS amt
    FROM gen_sf WHERE sf > 0
    WINDOW w AS (PARTITION BY retreat_id, participant_id)
    UNION ALL   -- что не погасило блоки — остаётся авансом
    SELECT gb.retreat_id, 'general',
           CASE WHEN t.tot = 0 THEN gb.g WHEN gb.b->>'currency' = 'INR' THEN gb.g - least(gb.g, t.tot) ELSE 0 END
    FROM gen_bal gb
    CROSS JOIN LATERAL (SELECT coalesce(sum(s.sf),0) AS tot FROM gen_sf s
                        WHERE s.retreat_id = gb.retreat_id AND s.participant_id = gb.participant_id) t
  ),
  rb_blocks AS (
    SELECT retreat_id, blk, sum(amt) AS amt FROM rb WHERE NOT (blk = 'general' AND participant_id IS NOT NULL) GROUP BY 1,2
    UNION ALL SELECT retreat_id, blk, amt FROM gen_alloc
  ),
  rb_month AS (
    SELECT r.name_ru AS rname, b.blk,
           sum(b.amt) * (least(r.end_date, v_to) - greatest(r.start_date, v_from) + 1)::numeric
                      / (r.end_date - r.start_date + 1) AS amt,
           (least(r.end_date, v_to) - greatest(r.start_date, v_from) + 1) AS d_in, (r.end_date - r.start_date + 1) AS d_all
    FROM rb_blocks b JOIN retreats r ON r.id = b.retreat_id
    GROUP BY r.name_ru, b.blk, r.start_date, r.end_date
  ),
  -- остальные приходы — по дате
  other_in AS (
    SELECT * FROM inc
    WHERE occurred_on BETWEEN v_from AND v_to
      AND NOT (dated AND cat IN ('Оплата от участника','Оплата спонсора','Прасад — оплата спонсора'))
  )
  -- расходы
  -- расходы: у «Ретритов» — ретрит (sub) и кто платил (item)
  SELECT 'out', ea.dept, ea.cat,
         CASE WHEN ea.dept = 'Ретриты' THEN coalesce(ea.retreat_name, 'Без ретрита') END,
         CASE WHEN ea.dept = 'Ретриты' THEN ea.payer END,
         round(sum(ea.amt), 2), count(*)::int
  FROM ex_alloc ea WHERE ea.per = v_from GROUP BY 2,3,4,5
  UNION ALL
  -- блоки ретритов
  SELECT 'in',
         CASE rm.blk WHEN 'accommodation' THEN 'Гест-хаус' WHEN 'meals' THEN 'Кухня' WHEN 'meals_sponsor' THEN 'Кухня' ELSE 'Ретриты' END,
         'Ретриты',
         rm.rname || CASE WHEN rm.d_in < rm.d_all THEN ' — часть: ' || rm.d_in || ' из ' || rm.d_all || ' дн.' ELSE '' END,
         CASE rm.blk WHEN 'accommodation' THEN 'Проживание' WHEN 'meals' THEN 'Прасад' WHEN 'meals_sponsor' THEN 'Прасад (спонсор)'
                     WHEN 'org_fee' THEN 'Оргвзнос' WHEN 'sponsor' THEN 'Расходы ретрита (спонсор)' WHEN 'extra' THEN 'Доп. услуги'
                     ELSE 'Аванс, не распределён' END,
         round(rm.amt, 2), NULL::int
  FROM rb_month rm WHERE rm.amt <> 0
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
         NULL::text, round(sum(oi.amt), 2), count(*)::int
  FROM other_in oi
  GROUP BY 2,3,4;
END;
$fn$;
