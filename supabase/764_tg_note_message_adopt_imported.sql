-- Загруженные из копии чата поступления не знают номера сообщения. Телеграм присылает старое
-- сообщение заново как «исправленное» (например, при смене реакции) — и бот заводил вторую
-- строку на те же деньги: так задвоились ₹23 000 и ₹47 000 за 24.10 (ВГ, 02.11.2026).
-- Теперь такое сообщение находит свою строку и дополняет её номером.
CREATE OR REPLACE FUNCTION public.tg_note_message(p jsonb) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_id bigint;
  v_status text;
BEGIN
  SELECT i.id, i.receipt_status INTO v_id, v_status
    FROM tg_incoming i
   WHERE i.chat_id = (p->>'chat_id')::bigint AND i.message_id IS NULL
     AND regexp_replace(i.text, '\s+', ' ', 'g') = regexp_replace(p->>'text', '\s+', ' ', 'g')
     AND abs(extract(epoch FROM i.received_at - (p->>'received_at')::timestamptz)) <= 120
   ORDER BY i.id LIMIT 1;
  IF FOUND THEN
    UPDATE tg_incoming SET message_id = (p->>'message_id')::bigint,
           tg_user_id = (p->>'tg_user_id')::bigint, username = p->>'username',
           topic_id = (p->>'topic_id')::int
     WHERE id = v_id;
    IF v_status IN ('posted','linked') THEN
      PERFORM tg_set_reaction((p->>'chat_id')::bigint, (p->>'message_id')::bigint, '👍');
    END IF;
    RETURN;
  END IF;

  INSERT INTO tg_incoming (chat_id, chat_title, chat_type, tg_user_id, username, full_name,
                           message_id, topic_id, text, received_at,
                           department_id, amount, currency, is_receipt)
  SELECT l.chat_id, p->>'chat_title', p->>'chat_type', (p->>'tg_user_id')::bigint,
         p->>'username', p->>'full_name', (p->>'message_id')::bigint, (p->>'topic_id')::int,
         p->>'text', COALESCE((p->>'received_at')::timestamptz, now()),
         l.department_id, (p->>'amount')::numeric, p->>'currency', COALESCE((p->>'is_receipt')::boolean, false)
    FROM tg_chat_links l
   WHERE l.chat_id = (p->>'chat_id')::bigint AND l.is_active AND l.save_messages
     AND (l.topic_finance IS NULL OR l.topic_finance = (p->>'topic_id')::int)
  ON CONFLICT (chat_id, message_id) DO UPDATE
     SET text = EXCLUDED.text, amount = EXCLUDED.amount, currency = EXCLUDED.currency,
         is_receipt = tg_incoming.is_receipt OR EXCLUDED.is_receipt
   WHERE tg_incoming.receipt_status = 'new' AND tg_incoming.text IS DISTINCT FROM EXCLUDED.text;
END;
$$;

-- Двойники: номер сообщения — проведённой строке, лишнюю убрать. Деньги не затронуты.
DELETE FROM tg_incoming WHERE id IN (53, 54) AND receipt_status = 'new' AND operation_id IS NULL;
UPDATE tg_incoming SET message_id = 851, tg_user_id = 6728283774 WHERE id = 22 AND message_id IS NULL;
UPDATE tg_incoming SET message_id = 853, tg_user_id = 6728283774 WHERE id = 23 AND message_id IS NULL;
SELECT tg_set_reaction(-1004422931329, 851, '👍');
SELECT tg_set_reaction(-1004422931329, 853, '👍');

-- «Похоже, уже внесено» опирается на время сообщения, а не только на сумму
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
       -- Приход внесён раньше, чем написано сообщение, — это другие деньги: цены мурти одинаковы (ВГ, 02.11.2026)
       AND o.created_at >= i.received_at
       AND o.occurred_on BETWEEN (i.received_at AT TIME ZONE 'Asia/Kolkata')::date - 3
                             AND (i.received_at AT TIME ZONE 'Asia/Kolkata')::date + 3
       AND NOT EXISTS (SELECT 1 FROM tg_incoming u WHERE u.operation_id = o.id)
     ORDER BY abs(o.occurred_on - (i.received_at AT TIME ZONE 'Asia/Kolkata')::date), o.created_at
     LIMIT 1) s ON true
 WHERE fin_can_read_all(auth.uid());
