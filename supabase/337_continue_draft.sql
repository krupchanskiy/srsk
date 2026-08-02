-- Незавершённую заявку можно продолжить, а не присылать заново.
--
-- Вопрос ВГ (02.08.2026): «а у не до конца проведенной заявки есть срок
-- годности получается? какой это срок? и зачем он вообще нужен… тут или не
-- дать провести старую запись или убрать срок годности».
--
-- Срока нет и никогда не было: заявки не протухают и не удаляются. Плохо было
-- другое — у заявок, заведённых до 31.07, бот не помнил, где карточка, и
-- предлагал прислать трату заново. Человек уже всё написал; заставлять его
-- повторяться — худший из ответов.
--
-- Теперь бот сам достаёт зависшую заявку и присылает по ней свежую карточку.

create or replace function tg_my_unfinished_draft(p_chat bigint, p_tg_user bigint)
returns uuid
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT id FROM tg_drafts
   WHERE chat_id = p_chat
     AND status = 'proposed'
     AND (tg_user_id = p_tg_user OR p_tg_user IS NULL)
   ORDER BY created_at DESC
   LIMIT 1;
$function$;

grant execute on function tg_my_unfinished_draft(bigint, bigint) to anon, authenticated, service_role;

-- Напоминание больше не просит присылать заново: ведёт к карточке, а если
-- её адрес неизвестен — подсказывает команду, по которой придёт новая.
create or replace function tg_remind_unfinished()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  r record;
  v_who   text;
  v_tail  text;
  v_sent  integer := 0;
BEGIN
  FOR r IN
    SELECT d.id, d.chat_id, d.source_message_id, d.card_message_id, d.amount, d.currency,
           d.purpose, d.tg_user_id,
           (current_date - d.created_at::date) AS days,
           coalesce(nullif(v.spiritual_name, ''),
                    nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                    'Прабху') AS person
    FROM tg_drafts d
    LEFT JOIN vaishnavas v ON v.id = d.author_vaishnava_id
    WHERE d.status = 'proposed'
      AND d.created_at < now() - interval '1 day'
      AND d.chat_id IS NOT NULL
  LOOP
    v_who := CASE WHEN r.tg_user_id IS NOT NULL
                  THEN format('<a href="tg://user?id=%s">%s</a>', r.tg_user_id, tg_escape(r.person))
                  ELSE tg_escape(r.person) END;

    v_tail := CASE WHEN r.card_message_id IS NOT NULL
                   THEN 'Нажмите кнопку на карточке — она в цитате над этим сообщением.'
                   ELSE 'Напишите «/продолжить» — пришлю карточку заново, повторять трату не нужно.'
              END;

    PERFORM tg_send_chat(r.chat_id,
      v_who || ', заявка не дошла до конца — я задал вопрос, а ответа не было.'
      || coalesce(E'\n' || tg_escape(r.purpose), '')
      || coalesce(' · ' || r.amount::text || ' ' || tg_escape(coalesce(r.currency, '')), '')
      || format(E'\nВисит %s дн. ', r.days) || v_tail,
      coalesce(r.card_message_id, r.source_message_id));

    v_sent := v_sent + 1;
  END LOOP;

  RETURN v_sent;
END;
$function$;
