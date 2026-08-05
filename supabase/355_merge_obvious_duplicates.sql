-- Склейка бесспорных дублей карточек (5 из 14 общих входов).
--
-- Ночной сторож shared_login_blocks_portal нашёл 14 логинов, где одна почта
-- на нескольких вайшнавов: портал в такой ситуации отказывается показывать
-- финансы, чтобы не выдать чужой баланс (274_portal_finances_refuse_shared_login).
--
-- Здесь склеиваем только те случаи, где сомнений нет вовсе: совпадают ИМЯ,
-- ПОЧТА и ТЕЛЕФОН, а на лишней карточке висит максимум одна строка. Всё
-- спорное (духовное имя против мирского, семьи, пары) — отдано Нитья-виласини
-- разбирать вручную, см. docs/housing/duplicates_for_review.md.
--
-- Приём: лишнюю карточку не удаляем, а помечаем удалённой и снимаем логин.
-- История сохраняется, из списков она пропадает, вход перестаёт быть общим —
-- сторож смотрит именно на user_id, is_deleted он не проверяет.

begin;

-- ---------------------------------------------------------------------------
-- 1. Перенос одиночных связей на основную карточку
-- ---------------------------------------------------------------------------

-- Оксана Цикина и Evelina Galčienė числились участниками ЧУЖИХ групповых
-- сделок (Уттама-бхакти и Гаури прия) под старой карточкой, а свою сделку
-- с авансом завели на новой. Конфликта нет: в этих сделках человек один раз.
update crm_deal_members dm
   set vaishnava_id = (select v2.id from vaishnavas v2
                        where v2.user_id = v.user_id and v2.id <> v.id
                          and exists (select 1 from fin_participant_opening_balances o
                                       where o.participant_id = v2.id))
  from vaishnavas v
  join auth.users u on u.id = v.user_id
 where dm.vaishnava_id = v.id
   and u.email in ('oxipri@gmail.com', 'evelina.galciene@gmail.com')
   and not exists (select 1 from fin_participant_opening_balances o where o.participant_id = v.id);

-- Ольга Попова и Мадхурья-бхакти: перенос предоплаты 5 000 ₽ старого контура
-- (сам контур заморожен при cutover, но ссылка не должна вести на погашенную карточку)
update crm_prepayment_operations po
   set vaishnava_id = (select v2.id from vaishnavas v2
                        where v2.user_id = v.user_id and v2.id <> v.id
                          and exists (select 1 from fin_participant_opening_balances o
                                       where o.participant_id = v2.id))
  from vaishnavas v
  join auth.users u on u.id = v.user_id
 where po.vaishnava_id = v.id
   and u.email in ('o_popova1808@mail.ru', 'shpak-64@inbox.ru')
   and not exists (select 1 from fin_participant_opening_balances o where o.participant_id = v.id);

-- ---------------------------------------------------------------------------
-- 2. Гасим опустевшие карточки
-- ---------------------------------------------------------------------------
-- Условие намеренно параноидальное: гасим только карточку, на которой после
-- переноса не осталось ВООБЩЕ ничего. Если что-то всплывёт — карточка уцелеет,
-- а сигнал просто останется гореть, и мы разберём вручную.
update vaishnavas v
   set is_deleted = true, user_id = null
  from auth.users u
 where u.id = v.user_id
   and u.email in ('oxipri@gmail.com', 'evelina.galciene@gmail.com',
                   'o_popova1808@mail.ru', 'juliivanova.2015.sam@gmail.com',
                   'shpak-64@inbox.ru')
   and not exists (select 1 from retreat_registrations x where x.vaishnava_id = v.id)
   and not exists (select 1 from residents x where x.vaishnava_id = v.id)
   and not exists (select 1 from crm_deals x where x.vaishnava_id = v.id)
   and not exists (select 1 from crm_deal_members x where x.vaishnava_id = v.id)
   and not exists (select 1 from fin_participant_opening_balances x where x.participant_id = v.id)
   and not exists (select 1 from fin_charges x where x.participant_id = v.id)
   and not exists (select 1 from fin_postings x where x.participant_id = v.id)
   and not exists (select 1 from crm_prepayment_operations x where x.vaishnava_id = v.id)
   and not exists (select 1 from crm_payments x where x.received_by = v.id or x.confirmed_by = v.id)
   and not exists (select 1 from family_links x where x.vaishnava_id = v.id or x.relative_id = v.id)
   and not exists (select 1 from face_tags x where x.vaishnava_id = v.id)
   and not exists (select 1 from tg_user_links x where x.vaishnava_id = v.id)
   and not exists (select 1 from stock_issuances x where x.receiver_id = v.id)
   and not exists (select 1 from vaishnavas x where x.parent_id = v.id or x.senior_id = v.id);

commit;
