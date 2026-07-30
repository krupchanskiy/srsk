-- Готовность департамента к работе с ботом.
--
-- Найдено 29.07.2026: чат к департаменту привязан, бот в него добавлен — но
-- ответственный всё равно получит «Не нахожу вас в системе», если у него в
-- профиле нет ника Telegram. Бот узнаёт человека либо по явной привязке, либо
-- по нику; e-mail в поле Telegram нормализация отбрасывает, и у «Завода» там
-- лежит именно адрес почты, а у «Зелёных» и «Кафе» поле пустое.
--
-- Раньше это выяснялось бы только в первый рабочий день, когда человек уже
-- написал трату и не получил ответа. Теперь неготовность видна в справочнике.

create or replace view fin_v_departments as
select
    d.id,
    d.name,
    d.responsible_person_id,
    fin_private_person_name(d.responsible_person_id) as responsible_name,
    l.chat_id,
    k.title as chat_title,
    (select jsonb_agg(jsonb_build_object('currency', a.currency_code, 'amount', (
                select coalesce(sum(case p.direction when 'in'::fin_direction then p.amount else -p.amount end), 0::numeric)
                  from fin_postings p where p.account_id = a.id)) order by a.currency_code)
       from fin_accounts a
      where a.department_id = d.id and a.kind = 'custodial'::fin_account_kind and a.is_active) as balances,
    -- Бот узнает ответственного? Либо привязка уже есть, либо в профиле годный ник
    (d.responsible_person_id is not null and (
        exists (select 1 from tg_user_links tl where tl.vaishnava_id = d.responsible_person_id)
        or exists (select 1 from vaishnavas v
                    where v.id = d.responsible_person_id
                      and nullif(tg_norm_username(v.telegram), '') is not null)
     )) as bot_knows_responsible
from fin_departments d
left join tg_chat_links l on l.department_id = d.id and l.is_active
left join tg_known_chats k on k.chat_id = l.chat_id
where fin_can_read_all();
