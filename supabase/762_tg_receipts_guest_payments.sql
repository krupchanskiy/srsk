-- Оплата за проживание — это оплата гостя, а не прасад: статью не подсказываем (ВГ, 02.11.2026).
-- «Похоже, уже внесено» находит и оплаты участников: их вносят через карточку гостя, а не приходом.
CREATE OR REPLACE VIEW public.fin_v_tg_receipts AS
SELECT i.id, i.chat_id, i.message_id, i.topic_id, i.text AS raw_text, i.full_name AS author,
       i.received_at, (i.received_at AT TIME ZONE 'Asia/Kolkata')::date AS received_date,
       i.amount, i.currency, i.is_receipt, i.department_id, d.name AS department,
       CASE WHEN i.receipt_status IN ('posted','linked') AND op.is_reversed THEN 'new'
            ELSE i.receipt_status END AS receipt_status,
       i.operation_id,
       a.id AS cash_account_id,
       g.category_code AS suggest_category_code,
       g.cafe_point AS suggest_cafe_point,
       s.id AS similar_operation_id, s.occurred_on AS similar_date,
       s.category AS similar_category, s.comment AS similar_comment
  FROM tg_incoming i
  LEFT JOIN fin_departments d ON d.id = i.department_id
  LEFT JOIN fin_operations op ON op.id = i.operation_id
  LEFT JOIN LATERAL (
    SELECT x.id FROM fin_accounts x
     WHERE x.cashbox_department_id = i.department_id AND x.currency_code = i.currency AND x.is_active
     LIMIT 1) a ON true
  LEFT JOIN LATERAL (
    SELECT CASE
             WHEN i.text ~* 'проживан' THEN NULL
             WHEN i.text ~* 'мурти' THEN 'murti'
             WHEN i.text ~* 'магазин' THEN 'shop_cash'
             WHEN i.text ~* 'кафе|этаж' THEN 'cafe_cash'
             WHEN i.text ~* 'обед|завтрак|прасад|питани' THEN 'Prasad_donation'
             WHEN i.text ~* 'пожертв' THEN 'participant_donation'
           END AS category_code,
           CASE
             WHEN i.text ~* 'мурти|магазин' THEN NULL
             WHEN i.text ~* '1\s*-?\s*й?\s*этаж' THEN 'self'
             WHEN i.text ~* '2\s*-?\s*й?\s*этаж' THEN 'cafe'
           END AS cafe_point) g ON true
  -- «Похоже, уже внесено»: та же сумма и валюта ±3 дня, приход ни к чему ещё не привязан
  LEFT JOIN LATERAL (
    SELECT o.id, o.occurred_on, c.name AS category, COALESCE(NULLIF(o.comment,''), p.note) AS comment
      FROM fin_postings p
      JOIN fin_operations o ON o.id = p.operation_id
      LEFT JOIN fin_categories c ON c.id = p.category_id
     WHERE i.amount IS NOT NULL AND i.receipt_status = 'new'
       AND p.direction = 'in' AND p.amount = i.amount AND p.currency_code = i.currency
       AND o.type IN ('income','donation','payment') AND NOT o.is_reversed
       AND o.occurred_on BETWEEN (i.received_at AT TIME ZONE 'Asia/Kolkata')::date - 3
                             AND (i.received_at AT TIME ZONE 'Asia/Kolkata')::date + 3
       AND NOT EXISTS (SELECT 1 FROM tg_incoming u WHERE u.operation_id = o.id)
     ORDER BY abs(o.occurred_on - (i.received_at AT TIME ZONE 'Asia/Kolkata')::date), o.created_at
     LIMIT 1) s ON true
 WHERE fin_can_read_all(auth.uid());
