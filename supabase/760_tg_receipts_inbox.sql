-- Поступления из чатов (ВГ, 02.11.2026). Бот тегал казначея «здесь про получение
-- денег» и забывал сообщение — приходы искали по чату вручную. Теперь сообщения
-- финансовой темы хранятся в tg_incoming, а во «Входящих» — вкладка «Поступления».
-- Бот по-прежнему не пишет в ядро: приход проводит казначей обычной формой ДДС.
-- Дата прихода — день приёма денег, день выручки («за 28/10») остаётся в комментарии.

-- Какие чаты сохраняем. Начинаем с Гест-хауса; другой чат — одна галочка.
ALTER TABLE tg_chat_links ADD COLUMN IF NOT EXISTS save_messages boolean NOT NULL DEFAULT false;
UPDATE tg_chat_links SET save_messages = true WHERE chat_id = -1004422931329;

ALTER TABLE tg_incoming
  ADD COLUMN department_id  uuid REFERENCES fin_departments(id),
  ADD COLUMN amount         numeric,
  ADD COLUMN currency       text,
  ADD COLUMN is_receipt     boolean NOT NULL DEFAULT false,
  ADD COLUMN receipt_status text NOT NULL DEFAULT 'new'
             CHECK (receipt_status IN ('new','posted','linked','dismissed')),
  ADD COLUMN operation_id   uuid REFERENCES fin_operations(id),
  ADD COLUMN resolved_by    uuid,
  ADD COLUMN resolved_at    timestamptz;
-- Телеграм шлёт правки тем же message_id. У загруженных из копии чата message_id нет.
CREATE UNIQUE INDEX tg_incoming_message_uq ON tg_incoming (chat_id, message_id);
CREATE INDEX tg_incoming_receipts_idx ON tg_incoming (receipt_status, received_at DESC) WHERE is_receipt;

-- Запись из бота. Только финансовая тема чата с включённым сохранением.
-- Правка обновляет текст, пока поступление не обработано.
CREATE OR REPLACE FUNCTION public.tg_note_message(p jsonb) RETURNS void
LANGUAGE sql SECURITY DEFINER SET search_path = public
AS $$
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
$$;
REVOKE ALL ON FUNCTION public.tg_note_message(jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_note_message(jsonb) TO service_role;

-- Сторнированный приход возвращает сообщение в «Не внесено»: деньги в кассе больше не учтены.
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
       AND o.type IN ('income','donation') AND NOT o.is_reversed
       AND o.occurred_on BETWEEN (i.received_at AT TIME ZONE 'Asia/Kolkata')::date - 3
                             AND (i.received_at AT TIME ZONE 'Asia/Kolkata')::date + 3
       AND NOT EXISTS (SELECT 1 FROM tg_incoming u WHERE u.operation_id = o.id)
     ORDER BY abs(o.occurred_on - (i.received_at AT TIME ZONE 'Asia/Kolkata')::date), o.created_at
     LIMIT 1) s ON true
 WHERE fin_can_read_all(auth.uid());
REVOKE ALL ON public.fin_v_tg_receipts FROM PUBLIC, anon;
GRANT SELECT ON public.fin_v_tg_receipts TO authenticated;

-- posted — проведён формой; linked — уже внесён раньше; dismissed — не поступление;
-- new — вернуть в список (и пометить как поступление сообщение, которое бот не распознал).
CREATE OR REPLACE FUNCTION public.fin_tg_receipt_set(p_id bigint, p_status text, p_operation uuid DEFAULT NULL)
RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  r tg_incoming%ROWTYPE;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Нет прав');
  END IF;
  IF p_status NOT IN ('new','posted','linked','dismissed') THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Неизвестный статус');
  END IF;
  SELECT * INTO r FROM tg_incoming WHERE id = p_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Сообщение не найдено');
  END IF;
  IF p_status = 'posted' AND p_operation IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Не указан приход');
  END IF;
  -- Один приход — одно сообщение; живой приход не отвязываем молча
  IF p_operation IS NOT NULL AND EXISTS (
       SELECT 1 FROM tg_incoming u WHERE u.operation_id = p_operation AND u.id <> p_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Этот приход уже привязан к другому сообщению');
  END IF;
  IF r.receipt_status IN ('posted','linked') AND p_status IN ('posted','linked')
     AND r.operation_id IS NOT NULL AND NOT (SELECT is_reversed FROM fin_operations WHERE id = r.operation_id) THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Это сообщение уже внесено');
  END IF;

  UPDATE tg_incoming
     SET receipt_status = p_status,
         is_receipt = is_receipt OR p_status = 'new',
         operation_id = p_operation,
         resolved_by = CASE WHEN p_status = 'new' THEN NULL ELSE auth.uid() END,
         resolved_at = CASE WHEN p_status = 'new' THEN NULL ELSE now() END
   WHERE id = p_id;

  IF p_status IN ('posted','linked') AND r.message_id IS NOT NULL THEN
    PERFORM tg_set_reaction(r.chat_id, r.message_id, '👍');
  END IF;
  RETURN jsonb_build_object('ok', true);
END;
$$;
REVOKE ALL ON FUNCTION public.fin_tg_receipt_set(bigint, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fin_tg_receipt_set(bigint, text, uuid) TO authenticated;
