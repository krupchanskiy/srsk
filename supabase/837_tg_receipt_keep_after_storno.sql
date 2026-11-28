-- 837: поступление из чата не возвращается в «новые», когда его приход отсторнировали.
-- Раньше вид сам превращал «внесено» в «новое», если приход сторнирован (760).
-- Но сторно обычно делается вместе с перепроведением (сверка 23.11: касса магазина
-- 21 730 и 42 250 перепроведены другими приходами), и сообщения всплывали фантомами.
-- Теперь статус остаётся как был, а признак op_reversed показывает во «Внесено»
-- плашку «приход отсторнирован» и кнопку «Вернуть в новые» — если провести заново всё-таки нужно.
CREATE OR REPLACE VIEW public.fin_v_tg_receipts AS
 SELECT i.id,
    i.chat_id,
    i.message_id,
    i.topic_id,
    i.text AS raw_text,
    i.full_name AS author,
    i.received_at,
    (i.received_at AT TIME ZONE 'Asia/Kolkata'::text)::date AS received_date,
    i.amount,
    i.currency,
    i.is_receipt,
    i.department_id,
    d.name AS department,
    i.receipt_status,
    i.operation_id,
    a.id AS cash_account_id,
    g.category_code AS suggest_category_code,
    g.cafe_point AS suggest_cafe_point,
    s.id AS similar_operation_id,
    s.occurred_on AS similar_date,
    s.category AS similar_category,
    s.comment AS similar_comment,
    COALESCE(op.is_reversed, false) AS op_reversed
   FROM tg_incoming i
     LEFT JOIN fin_departments d ON d.id = i.department_id
     LEFT JOIN fin_operations op ON op.id = i.operation_id
     LEFT JOIN LATERAL ( SELECT x.id
           FROM fin_accounts x
          WHERE x.cashbox_department_id = i.department_id AND x.currency_code = i.currency AND x.is_active
         LIMIT 1) a ON true
     LEFT JOIN LATERAL ( SELECT
                CASE
                    WHEN i.text ~* 'проживан'::text THEN NULL::text
                    WHEN i.text ~* 'мурти'::text THEN 'murti'::text
                    WHEN i.text ~* 'магазин'::text THEN 'shop_cash'::text
                    WHEN i.text ~* 'кафе|этаж'::text THEN 'cafe_cash'::text
                    WHEN i.text ~* 'обед|завтрак|прасад|питани'::text THEN 'Prasad_donation'::text
                    WHEN i.text ~* 'пожертв'::text THEN 'participant_donation'::text
                    ELSE NULL::text
                END AS category_code,
                CASE
                    WHEN i.text ~* 'мурти|магазин'::text THEN NULL::text
                    WHEN i.text ~* '1\s*-?\s*й?\s*этаж'::text THEN 'self'::text
                    WHEN i.text ~* '2\s*-?\s*й?\s*этаж'::text THEN 'cafe'::text
                    ELSE NULL::text
                END AS cafe_point) g ON true
     LEFT JOIN LATERAL ( SELECT o.id,
            o.occurred_on,
            c.name AS category,
            COALESCE(NULLIF(o.comment, ''::text), p.note) AS comment
           FROM fin_postings p
             JOIN fin_operations o ON o.id = p.operation_id
             LEFT JOIN fin_categories c ON c.id = p.category_id
          WHERE i.amount IS NOT NULL AND i.receipt_status = 'new'::text AND p.direction = 'in'::fin_direction AND p.amount = i.amount AND p.currency_code = i.currency AND (o.type = ANY (ARRAY['income'::fin_operation_type, 'donation'::fin_operation_type, 'payment'::fin_operation_type])) AND NOT o.is_reversed AND o.created_at >= i.received_at AND o.occurred_on >= ((i.received_at AT TIME ZONE 'Asia/Kolkata'::text)::date - 3) AND o.occurred_on <= ((i.received_at AT TIME ZONE 'Asia/Kolkata'::text)::date + 3) AND NOT (EXISTS ( SELECT 1
                   FROM tg_incoming u
                  WHERE u.operation_id = o.id))
          ORDER BY (abs(o.occurred_on - (i.received_at AT TIME ZONE 'Asia/Kolkata'::text)::date)), o.created_at
         LIMIT 1) s ON true
  WHERE fin_can_read_all(auth.uid());
