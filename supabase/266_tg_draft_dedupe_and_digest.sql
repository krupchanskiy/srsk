-- 1. Одно сообщение — одна заявка.
--
-- Telegram повторяет доставку обновления, если вебхук ответил не сразу; кроме
-- того, бот обрабатывает edited_message. И то, и другое давало ВТОРУЮ заявку на
-- то же сообщение с тем же расходом. Провести можно было обе — деньги списались
-- бы дважды. Идемпотентность ядра тут не спасала: у разных заявок разные
-- request_id, для ядра это две законные операции.
CREATE UNIQUE INDEX IF NOT EXISTS tg_drafts_one_per_message
  ON tg_drafts (chat_id, source_message_id);

-- Повторную доставку теперь молча игнорируем: NULL → бот не рисует вторую
-- карточку. Правка сообщения тоже не создаёт новую заявку — если сумма в
-- карточке уже неверна, человек нажимает «Не надо» и пишет заново.
CREATE OR REPLACE FUNCTION tg_create_draft(p jsonb)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_author uuid; v_dept uuid;
BEGIN
  SELECT vaishnava_id INTO v_author FROM tg_user_links WHERE tg_user_id = (p->>'tg_user_id')::bigint;
  SELECT department_id INTO v_dept FROM tg_chat_links WHERE chat_id = (p->>'chat_id')::bigint AND is_active;
  IF v_dept IS NULL THEN RETURN NULL; END IF;
  INSERT INTO tg_drafts (chat_id, source_message_id, tg_user_id, author_vaishnava_id,
                         department_id, target_department_id, kind, amount, currency,
                         purpose, raw_text, status)
  VALUES ((p->>'chat_id')::bigint, (p->>'source_message_id')::bigint, (p->>'tg_user_id')::bigint, v_author,
          v_dept, NULLIF(p->>'target_department_id','')::uuid, NULLIF(p->>'kind',''),
          (p->>'amount')::numeric, NULLIF(p->>'currency',''),
          NULLIF(btrim(p->>'purpose'),''), p->>'raw_text', 'proposed')
  ON CONFLICT (chat_id, source_message_id) DO NOTHING
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

-- 2. Заявки из чатов — в утреннюю сводку.
--
-- Проведённые ждут фин-админа во «Входящих», а вот карточки без ответа не
-- видел никто: человек написал трату, кнопку не нажал — и расход растворился.
CREATE OR REPLACE FUNCTION fin_tg_chat_drafts_line()
RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_pending int; v_stuck int; v_out text := '';
BEGIN
  SELECT count(*) INTO v_pending FROM tg_drafts WHERE status = 'pending';
  SELECT count(*) INTO v_stuck FROM tg_drafts
   WHERE status = 'proposed' AND created_at < now() - interval '12 hours';

  IF v_pending > 0 THEN
    v_out := v_out || format(E'\n• из чатов ждут проведения — <b>%s %s</b>',
      v_pending, fin_plural(v_pending, 'заявка', 'заявки', 'заявок'));
  END IF;
  IF v_stuck > 0 THEN
    v_out := v_out || format(E'\n• в чатах без ответа — <b>%s %s</b>',
      v_stuck, fin_plural(v_stuck, 'карточка', 'карточки', 'карточек'));
  END IF;
  RETURN v_out;
END;
$$;

REVOKE ALL ON FUNCTION fin_tg_chat_drafts_line() FROM PUBLIC, anon;

-- Разовая доливка: у заявок, созданных до появления поля «на что», описания
-- нет, и провести их было нельзя вообще — защита в tg_post_draft отклоняла,
-- а починить из интерфейса нечем. Берём текст самого сообщения.
UPDATE tg_drafts SET purpose = btrim(raw_text)
WHERE purpose IS NULL AND status IN ('proposed','pending');
