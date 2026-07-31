-- Запоминаем карточку сразу при отправке.
--
-- card_message_id записывался только когда человек нажимал кнопку. У «молчаливых»
-- заявок — ровно тех, кому потом идут напоминания, — ссылки на кнопки не было,
-- и напоминание приходилось цеплять к исходному сообщению.
-- Теперь бот сохраняет id карточки в момент её отправки.

create or replace function tg_set_card_message(p_id uuid, p_message_id bigint)
returns void
language sql
security definer
set search_path to 'public'
as $$
  UPDATE tg_drafts SET card_message_id = p_message_id
  WHERE id = p_id AND card_message_id IS NULL;
$$;

grant execute on function tg_set_card_message(uuid, bigint) to authenticated, anon, service_role;
