-- Ежедневное напоминание о незавершённой заявке.
--
-- Решение ВГ (30.07.2026): напоминать «каждый день, будем вырабатывать привычку
-- делать все правильно и вовремя», тегая того, кто не довёл операцию до конца.
--
-- Заявка застревает, когда бот задал вопрос («какая статья?»), а человек не
-- ответил: карточка уезжает вверх по чату, трата в учёт не попадает. На проде так
-- висели четыре настоящих траты возрастом 2–6 дней.

create or replace function tg_remind_unfinished()
returns integer
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
  r record;
  v_who   text;
  v_sent  integer := 0;
BEGIN
  FOR r IN
    SELECT d.id, d.chat_id, d.source_message_id, d.amount, d.currency, d.purpose,
           d.tg_user_id, d.author_vaishnava_id,
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
    -- Тегаем автора: по tg_user_id упоминание работает даже без ника в Telegram
    v_who := CASE WHEN r.tg_user_id IS NOT NULL
                  THEN format('<a href="tg://user?id=%s">%s</a>', r.tg_user_id, tg_escape(r.person))
                  ELSE tg_escape(r.person) END;

    PERFORM tg_send_chat(r.chat_id,
      v_who || ', заявка не дошла до конца — я задал вопрос, а ответа не было.'
      || coalesce(E'\n' || tg_escape(r.purpose), '')
      || coalesce(' · ' || r.amount::text || ' ' || tg_escape(coalesce(r.currency, '')), '')
      || format(E'\nВисит %s дн. Ответьте на карточку выше или пришлите трату заново одним сообщением.', r.days));

    v_sent := v_sent + 1;
  END LOOP;

  RETURN v_sent;
END;
$function$;

-- Каждый день в 04:30 UTC — это 10:00 по Мумбаи: люди уже на ногах, но день
-- ещё не начался, и напоминание не теряется в рабочей переписке.
select cron.schedule('remind-unfinished-drafts', '30 4 * * *', 'SELECT tg_remind_unfinished();');
