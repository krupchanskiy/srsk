-- 297: заявки-бред с формы сайта — отсеивать сразу и убрать накопившиеся
-- (просьба Адриана 07.11.2026).
--
-- С 20.10 бот шлёт в форму заявки, где имя, фамилия, духовное имя и
-- комментарий — случайные латинские буквы вперемешку: «pvHoprYYQgvnkMOphAuUVdch».
-- Живой человек так не пишет: в длинном слове из одних латинских букв у него
-- одна-две заглавные, а не россыпь. На всей базе (419 сделок) правило
-- отделяет спам без единого промаха: у спама бред во всех четырёх полях,
-- у живых — ни в одном.
--
-- Бред — это слово из 10+ латинских букв, где и заглавных, и строчных хотя
-- бы по три. Заявка — спам, если бред хотя бы в двух полях из четырёх.
-- Боту отвечаем «принято», как на настоящую заявку: пусть не подбирает обход.
-- Отсеянное 30 дней лежит в crm_spam_log — если вдруг отсеется живой
-- человек, его заявку можно найти и завести руками.

create or replace function crm_is_gibberish(t text)
returns boolean language sql immutable
set search_path = public, pg_temp
as $$
    select exists (
        select 1 from regexp_split_to_table(coalesce(t, ''), '\s+') w
         where w ~ '^[A-Za-z]{10,}$'
           and length(regexp_replace(w, '[^A-Z]', '', 'g')) >= 3
           and length(regexp_replace(w, '[^a-z]', '', 'g')) >= 3)
$$;
revoke all on function crm_is_gibberish(text) from public, anon;

create table if not exists crm_spam_log (
    id         bigint generated always as identity primary key,
    payload    jsonb not null,
    created_at timestamptz not null default now()
);
-- читать только через SQL: политик нет, анониму и сотрудникам не видно
alter table crm_spam_log enable row level security;
revoke all on crm_spam_log from anon, authenticated;

-- проверка в форме: сразу после проверки длин, до создания человека и сделки
do $$
declare d text; якорь text := '  if v_phone is null and v_email is null then';
begin
    d := pg_get_functiondef('public.crm_submit_public_application(jsonb)'::regprocedure);
    if (length(d) - length(replace(d, якорь, ''))) / length(якорь) <> 1 then
        raise exception 'crm_submit_public_application: место для проверки не найдено';
    end if;
    execute replace(d, якорь,
'  -- бред вместо имени (бот): молча «принимаем», в CRM не пускаем
  if (crm_is_gibberish(v_first)::int + crm_is_gibberish(v_last)::int
      + crm_is_gibberish(v_spiritual)::int + crm_is_gibberish(v_notes)::int) >= 2 then
    delete from crm_spam_log where created_at < now() - interval ''30 days'';
    insert into crm_spam_log (payload) values (payload);
    return jsonb_build_object(''ok'', true);
  end if;
' || якорь);
end $$;

-- накопившийся спам: сделки (задачи и история уходят каскадом), их журнал
-- и сами карточки людей — у них нет ничего, кроме этих сделок
do $$
declare v_сделок int; v_людей int;
begin
    create temp table спам_люди on commit drop as
        select v.id from vaishnavas v
         where (crm_is_gibberish(v.first_name)::int + crm_is_gibberish(v.last_name)::int
                + crm_is_gibberish(v.spiritual_name)::int) >= 2;
    if exists (select 1 from crm_deals d where d.vaishnava_id in (select id from спам_люди)
                 and not (crm_is_gibberish(d.notes) or d.notes is null)) then
        raise exception 'У спамной карточки нашлась сделка с осмысленным комментарием — разобрать руками';
    end if;

    -- сделки защищены от удаления; спам — исключение, флаг только на эту транзакцию
    perform set_config('app.allow_deal_delete', 'on', true);
    delete from crm_activity_log where deal_id in
        (select id from crm_deals where vaishnava_id in (select id from спам_люди));
    delete from crm_deals where vaishnava_id in (select id from спам_люди);
    get diagnostics v_сделок = row_count;
    delete from vaishnavas where id in (select id from спам_люди);
    get diagnostics v_людей = row_count;
    raise notice 'Удалено спамных сделок: %, карточек: %', v_сделок, v_людей;
end $$;
