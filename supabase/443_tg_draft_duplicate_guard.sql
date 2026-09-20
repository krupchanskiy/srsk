-- Защита бота от двойной отправки одной и той же траты (ВГ, сен 2026).
--
-- 07.09 в чат кафе с разницей в 2,6 секунды пришло два одинаковых сообщения
-- («Я купил продукты для кухни кафе 32020», №701 и №702 — клиент Telegram
-- продублировал отправку). Индекс «одно сообщение — одна заявка» (266) от
-- этого не спасает: номера сообщений разные. Обе заявки провели — расход и
-- перевод на ₹32 020 задвоились (сторнировано вручную).
--
-- Теперь: если тот же автор в том же чате за последние 10 минут уже прислал
-- такой же текст на ту же сумму и заявка не отклонена — второй заявки нет,
-- а в чат приходит пояснение. «Отклонил и написал заново» по-прежнему
-- работает (отклонённые не считаются). Настоящую вторую такую же покупку
-- можно провести, дописав в сообщении отличие.
--
-- Всё на стороне БД: вебхук уже молча пропускает NULL из tg_create_draft,
-- а сообщение уходит через tg_send_chat (очередь с повторами, 385) — правка
-- и передеплой самого бота не нужны.
CREATE OR REPLACE FUNCTION tg_create_draft(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_id uuid; v_author uuid; v_dept uuid;
  v_chat bigint := (p->>'chat_id')::bigint;
  v_user bigint := (p->>'tg_user_id')::bigint;
  v_msg  bigint := (p->>'source_message_id')::bigint;
  v_amount numeric := (p->>'amount')::numeric;
  v_currency text := NULLIF(p->>'currency','');
  v_norm text := lower(regexp_replace(btrim(coalesce(p->>'raw_text','')), '\s+', ' ', 'g'));
  v_dup_at timestamptz;
  v_secs int;
BEGIN
  SELECT vaishnava_id INTO v_author FROM tg_user_links WHERE tg_user_id = v_user;
  SELECT department_id INTO v_dept FROM tg_chat_links WHERE chat_id = v_chat AND is_active;
  IF v_dept IS NULL THEN RETURN NULL; END IF;

  -- Два почти одновременных сообщения обрабатываются параллельно: без
  -- блокировки оба не увидели бы друг друга
  PERFORM pg_advisory_xact_lock(hashtextextended(v_chat::text || ':' || v_user::text, 0));

  -- Валюта и сумма у прежней заявки могли уточниться кнопками, а в новом
  -- сообщении не названы — пустое значение с любой стороны не мешает совпадению
  SELECT d.created_at INTO v_dup_at
    FROM tg_drafts d
   WHERE d.chat_id = v_chat AND d.tg_user_id = v_user
     AND d.source_message_id <> v_msg
     AND d.status <> 'dismissed'
     AND d.created_at > now() - interval '10 minutes'
     AND (v_amount IS NULL OR d.amount IS NULL OR d.amount = v_amount)
     AND (v_currency IS NULL OR d.currency IS NULL OR d.currency = v_currency)
     AND lower(regexp_replace(btrim(coalesce(d.raw_text,'')), '\s+', ' ', 'g')) = v_norm
   ORDER BY d.created_at DESC
   LIMIT 1;

  IF FOUND THEN
    v_secs := greatest(extract(epoch FROM now() - v_dup_at)::int, 1);
    PERFORM tg_send_chat(v_chat,
      format(E'⚠️ Такую же заявку от вас я уже принял %s назад — вторую не создаю, чтобы не записать трату дважды.\nЕсли это правда вторая такая же покупка, допишите в сообщении отличие (например, «вторая партия») и отправьте снова.',
             CASE WHEN v_secs < 90 THEN v_secs || ' сек' ELSE round(v_secs / 60.0)::int || ' мин' END),
      v_msg, 'finance');
    RETURN NULL;
  END IF;

  INSERT INTO tg_drafts (chat_id, source_message_id, tg_user_id, author_vaishnava_id,
                         department_id, target_department_id, kind, amount, currency,
                         purpose, raw_text, status)
  VALUES (v_chat, v_msg, v_user, v_author,
          v_dept, NULLIF(p->>'target_department_id','')::uuid, NULLIF(p->>'kind',''),
          v_amount, v_currency,
          NULLIF(btrim(p->>'purpose'),''), p->>'raw_text', 'proposed')
  ON CONFLICT (chat_id, source_message_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;
