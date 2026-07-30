-- Предупреждение: платёж за ретрит на человека, которого нет в участниках.
--
-- Решение ВГ (30.07.2026): «если платеж именно как оплата за ретрит, то конечно
-- предупреждать, но не запрещать (человек в моменте захочет присоединиться)».
--
-- Опечатка в подсказке имён заводит постороннего в отчёт ретрита и в списки
-- должников, и заметить это потом почти невозможно. Функция возвращает имена
-- тех, кого нет в регистрациях выбранного мероприятия, — форма показывает их в
-- вопросе и всё равно даёт сохранить.

create or replace function fin_unregistered_participants(p_object_id uuid, p_participants uuid[])
returns table(participant_id uuid, participant_name text)
language sql
stable
security definer
set search_path to 'public'
as $function$
  SELECT v.id,
         coalesce(nullif(v.spiritual_name, ''),
                  nullif(trim(coalesce(v.first_name, '') || ' ' || coalesce(v.last_name, '')), ''),
                  '—')
  FROM unnest(p_participants) AS x(pid)
  JOIN vaishnavas v ON v.id = x.pid
  JOIN fin_accounting_objects ao ON ao.id = p_object_id
  WHERE ao.retreat_id IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM retreat_registrations rr
       WHERE rr.vaishnava_id = v.id
         AND rr.retreat_id = ao.retreat_id
         AND rr.status <> 'cancelled'
    );
$function$;

grant execute on function fin_unregistered_participants(uuid, uuid[]) to authenticated;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_not_in_participants',
   'Нет в участниках мероприятия: {names}. Всё равно записать платёж?',
   'Not in the event participants: {names}. Record the payment anyway?',
   'कार्यक्रम के प्रतिभागियों में नहीं: {names}. फिर भी भुगतान दर्ज करें?', 'Финансы')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
