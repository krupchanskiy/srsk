-- «Возможно, одно лицо» и «Слить» (ВГ 02.10.2026, чат «Вайшнавы 1: единая карточка»).
-- Человек сам зарегистрировался, а на него уже есть черновая карточка из брони — подсказываем
-- пару по имени (кириллица/латиница, без «дас/даси/деви»), телефону или почте. Сливает админ
-- только с подтверждением; «Это разные люди» убирает подсказку навсегда.

-- Ключ имени: латиница, без гласных и «h», без двойных букв, слова по алфавиту.
-- «Джаганнатх Прасад д» и «Jagannath Prasad das» → один ключ.
create or replace function vaishnava_name_key(p text)
returns text language sql immutable set search_path = public as $$
    with t as (
        select regexp_replace(translate(
                   replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
                       lower(coalesce(p, '')),
                       'дж', 'j'), 'ж', 'z'), 'х', 'h'), 'ц', 'ts'), 'ч', 'ch'), 'щ', 'sch'), 'ш', 'sh'),
                       'ю', 'yu'), 'я', 'ya'), 'ё', 'e'),
                   'абвгдезийклмнопрстуфыэwqcxьъ', 'abvgdeziyklmnoprstufyevkkk'),
               '[^a-z]+', ' ', 'g') s
    ), w as (
        select regexp_replace(regexp_replace(word, '[aeiouyh]', '', 'g'), '(.)\1+', '\1', 'g') k
          from t, regexp_split_to_table(t.s, ' ') word
         where word <> ''
           and word !~ '^(das|dasa|dasi|devi|dd|d|dg|prabhu|prabhuji|mataji)$'
    )
    select case when length(string_agg(k, '' order by k)) >= 4 then string_agg(k, '' order by k) end
      from w where k <> ''
$$;

-- Пары, которые админ отметил «это разные люди»
create table if not exists vaishnava_not_duplicates (
    a_id uuid not null references vaishnavas(id) on delete cascade,
    b_id uuid not null references vaishnavas(id) on delete cascade,
    created_at timestamptz not null default now(),
    created_by uuid default auth.uid(),
    primary key (a_id, b_id),
    check (a_id < b_id)
);
alter table vaishnava_not_duplicates enable row level security;
drop policy if exists vaishnava_not_duplicates_select on vaishnava_not_duplicates;
create policy vaishnava_not_duplicates_select on vaishnava_not_duplicates
    for select to authenticated using (true);

-- Входил ли человек на сайт. Учётная запись заводится сама по почте (мигр. 580),
-- поэтому «есть user_id» ещё не значит «пользуется сайтом» — смотрим на последний вход.
create or replace function vaishnava_signed_in(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
    select exists (select 1 from auth.users where id = p_user and last_sign_in_at is not null)
$$;
revoke all on function vaishnava_signed_in(uuid) from public, anon, authenticated;

-- Возможные дубли: все пары (p_id null) или пары одного человека
create or replace function vaishnava_duplicates(p_id uuid default null)
returns table (a_id uuid, b_id uuid, reason text, a_signed_in boolean, b_signed_in boolean)
language plpgsql stable security definer set search_path = public as $$
#variable_conflict use_column
begin
    if not (is_superuser(auth.uid()) or has_permission(auth.uid(), 'view_vaishnavas')
            or has_permission(auth.uid(), 'edit_vaishnava')) then
        raise exception 'Нет прав';
    end if;
    return query
    with v as (
        select id, parent_id, user_id,
               vaishnava_name_key(nullif(spiritual_name, '')) sk,
               vaishnava_name_key(nullif(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, '')), '')) fk,
               nullif(right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 10), '') ph,
               lower(nullif(trim(email), '')) em
          from vaishnavas
         where not coalesce(is_deleted, false)
    ), v2 as (
        -- телефон/почта — признак, только если они ровно у двух карточек
        -- (общая почта стоит у ~115 человек, общий телефон — у 12)
        select v.*, count(*) over (partition by ph) ph_n, count(*) over (partition by em) em_n from v
    ), pairs as (
        select a.id a_id, b.id b_id,
               case when a.sk = b.sk or a.fk = b.fk or a.sk = b.fk or a.fk = b.sk then 'name'
                    when length(a.ph) = 10 and a.ph = b.ph and a.ph_n = 2 then 'phone'
                    else 'email' end reason
          from v2 a join v2 b on a.id < b.id
           and (a.sk = b.sk or a.fk = b.fk or a.sk = b.fk or a.fk = b.sk
                or (length(a.ph) = 10 and a.ph = b.ph and a.ph_n = 2)
                or (a.em = b.em and a.em_n = 2))
         where (p_id is null or p_id in (a.id, b.id))
           -- родитель и ребёнок, семья — часто один телефон/почта, это не дубли
           and a.parent_id is distinct from b.id and b.parent_id is distinct from a.id
    )
    select p.a_id, p.b_id, p.reason,
           vaishnava_signed_in((select x.user_id from v x where x.id = p.a_id)),
           vaishnava_signed_in((select x.user_id from v x where x.id = p.b_id))
      from pairs p
     where not exists (select 1 from family_links f
                        where (f.vaishnava_id = p.a_id and f.relative_id = p.b_id)
                           or (f.vaishnava_id = p.b_id and f.relative_id = p.a_id))
       and not exists (select 1 from vaishnava_not_duplicates n
                        where n.a_id = p.a_id and n.b_id = p.b_id);
end $$;
revoke all on function vaishnava_duplicates(uuid) from public, anon;
grant execute on function vaishnava_duplicates(uuid) to authenticated;

create or replace function vaishnava_mark_not_duplicate(p_a uuid, p_b uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
    if not (is_superuser(auth.uid()) or has_permission(auth.uid(), 'edit_vaishnava')) then
        raise exception 'Нет прав';
    end if;
    insert into vaishnava_not_duplicates (a_id, b_id)
    values (least(p_a, p_b), greatest(p_a, p_b))
    on conflict do nothing;
end $$;
revoke all on function vaishnava_mark_not_duplicate(uuid, uuid) from public, anon;
grant execute on function vaishnava_mark_not_duplicate(uuid, uuid) to authenticated;

-- Слить две карточки: остаётся та, с которой человек входил на сайт; пустые поля дополняются из второй,
-- статус — старший из двух (команда > волонтёр > гость). Связи переносит merge_vaishnavas.
create or replace function vaishnava_merge(p_main uuid, p_dup uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
    m vaishnavas;
    d vaishnavas;
    v_tmp uuid;
    v_res jsonb;
    v_dup_user uuid;
begin
    if not (is_superuser(auth.uid()) or has_permission(auth.uid(), 'edit_vaishnava')) then
        raise exception 'Нет прав';
    end if;
    select * into m from vaishnavas where id = p_main and not coalesce(is_deleted, false);
    select * into d from vaishnavas where id = p_dup and not coalesce(is_deleted, false);
    if m.id is null or d.id is null then
        return jsonb_build_object('ok', false, 'error', 'Карточка не найдена');
    end if;
    if vaishnava_signed_in(m.user_id) and vaishnava_signed_in(d.user_id) then
        return jsonb_build_object('ok', false, 'error', 'С обеих карточек входили на сайт — такие сливает администратор вручную');
    end if;
    -- остаётся карточка, с которой входили; если ни с одной — основная, а без учётной записи берёт её у второй
    if vaishnava_signed_in(d.user_id) then
        v_tmp := p_main; p_main := p_dup; p_dup := v_tmp;
        select * into m from vaishnavas where id = p_main;
        select * into d from vaishnavas where id = p_dup;
    end if;

    v_dup_user := d.user_id;

    -- История департаментов: периоды не должны пересекаться — у кого она есть в основной, та и остаётся
    if exists (select 1 from vaishnava_departments where vaishnava_id = p_main) then
        delete from vaishnava_departments where vaishnava_id = p_dup;
    end if;

    -- Регистрации — заранее: перенос проживаний сам заводит регистрацию на ретрит,
    -- и merge_vaishnavas потом упирается в дубль (vaishnava_id, retreat_id)
    if exists (select 1 from retreat_registrations a join retreat_registrations b
                 on b.retreat_id = a.retreat_id and b.vaishnava_id = p_main
                where a.vaishnava_id = p_dup) then
        return jsonb_build_object('ok', false, 'error', 'Обе карточки записаны на один ретрит — разберите вручную');
    end if;
    update retreat_registrations set vaishnava_id = p_main where vaishnava_id = p_dup;

    v_res := merge_vaishnavas(p_main, p_dup);
    if not coalesce((v_res->>'ok')::boolean, false) then
        raise exception '%', v_res->>'error';
    end if;

    update vaishnavas set
        spiritual_name = coalesce(nullif(m.spiritual_name, ''), d.spiritual_name),
        first_name = coalesce(nullif(m.first_name, ''), d.first_name),
        last_name = coalesce(nullif(m.last_name, ''), d.last_name),
        phone = coalesce(nullif(m.phone, ''), d.phone),
        has_whatsapp = case when nullif(m.phone, '') is null then d.has_whatsapp else m.has_whatsapp end,
        email = coalesce(nullif(m.email, ''), d.email),
        telegram = coalesce(nullif(m.telegram, ''), d.telegram),
        telegram_username = coalesce(nullif(m.telegram_username, ''), d.telegram_username),
        telegram_chat_id = coalesce(m.telegram_chat_id, d.telegram_chat_id),
        birth_date = coalesce(m.birth_date, d.birth_date),
        gender = coalesce(nullif(m.gender, ''), d.gender),
        country = coalesce(nullif(m.country, ''), d.country),
        city = coalesce(nullif(m.city, ''), d.city),
        photo_url = coalesce(nullif(m.photo_url, ''), d.photo_url),
        india_experience = coalesce(nullif(m.india_experience, ''), d.india_experience),
        spiritual_teacher = coalesce(nullif(m.spiritual_teacher, ''), d.spiritual_teacher),
        service = coalesce(nullif(m.service, ''), d.service),
        senior_id = coalesce(m.senior_id, nullif(d.senior_id, p_main)),
        passport = coalesce(nullif(m.passport, ''), d.passport),
        visa_type = coalesce(nullif(m.visa_type, ''), d.visa_type),
        visa_expiry = coalesce(m.visa_expiry, d.visa_expiry),
        indian_phone = coalesce(nullif(m.indian_phone, ''), d.indian_phone),
        notes = case when nullif(m.notes, '') is null then d.notes
                     when nullif(d.notes, '') is null or d.notes = m.notes then m.notes
                     else m.notes || E'\n' || d.notes end,
        status = case when 'team' in (m.status, d.status) then 'team'
                      when 'volunteer' in (m.status, d.status) then 'volunteer'
                      else 'guest' end
     where id = p_main;

    if m.user_id is null and v_dup_user is not null then
        update vaishnavas set user_id = v_dup_user where id = p_main;
    end if;

    -- текущий департамент — по истории на сегодня (у черновой он мог быть, у основной — нет)
    if m.department_id is null then
        update vaishnavas set department_id = coalesce(vaishnava_department_on(p_main, current_date), d.department_id)
         where id = p_main;
    end if;

    return jsonb_build_object('ok', true, 'main', p_main, 'moved', v_res->'moved');
end $$;
revoke all on function vaishnava_merge(uuid, uuid) from public, anon;
grant execute on function vaishnava_merge(uuid, uuid) to authenticated;

-- Служебная склейка без проверки прав — только через vaishnava_merge
revoke all on function merge_vaishnavas(uuid, uuid) from public, anon, authenticated;

insert into translations (key, ru, en, hi) values
  ('person_incomplete', 'Неполная карточка', 'Incomplete card', 'अधूरा कार्ड'),
  ('person_missing_phone', 'телефон', 'phone', 'फ़ोन'),
  ('person_missing_email', 'почта', 'email', 'ईमेल'),
  ('person_missing_telegram', 'Телеграм', 'Telegram', 'टेलीग्राम'),
  ('person_missing_birth', 'год рождения', 'year of birth', 'जन्म वर्ष'),
  ('person_incomplete_hint', 'Не хватает: {list}. Нажмите, чтобы дополнить', 'Missing: {list}. Click to fill in', 'कमी है: {list}। भरने के लिए क्लिक करें'),
  ('person_stay_history', 'История проживания', 'Stay history', 'निवास इतिहास'),
  ('person_stay_history_empty', 'В шахматке проживаний нет', 'No stays in the timeline', 'टाइमलाइन में कोई निवास नहीं'),
  ('person_show_all', 'Показать все', 'Show all', 'सभी दिखाएँ'),
  ('person_hide', 'Свернуть', 'Collapse', 'छिपाएँ'),
  ('person_no_event', 'без события', 'no event', 'बिना आयोजन'),
  ('person_maybe_same', 'Возможно, одно лицо', 'Possibly the same person', 'संभवतः एक ही व्यक्ति'),
  ('person_dup_reason_name', 'похожее имя', 'similar name', 'मिलता-जुलता नाम'),
  ('person_dup_reason_phone', 'тот же телефон', 'same phone', 'वही फ़ोन'),
  ('person_dup_reason_email', 'та же почта', 'same email', 'वही ईमेल'),
  ('person_dup_has_login', 'входил на сайт', 'has signed in', 'साइट पर लॉगिन किया'),
  ('person_dup_draft', 'черновая', 'draft', 'प्रारूप'),
  ('person_merge', 'Слить', 'Merge', 'मिलाएँ'),
  ('person_not_same', 'Это разные люди', 'Different people', 'ये अलग लोग हैं'),
  ('person_merge_confirm', 'Слить карточки «{a}» и «{b}»? Останется карточка, с которой входили на сайт, пустые поля дополнятся из второй, брони, оплаты и история перейдут к ней. Отменить нельзя.', 'Merge «{a}» and «{b}»? The card that has signed in to the site stays, empty fields are filled from the other one, bookings, payments and history move to it. This cannot be undone.', '«{a}» और «{b}» को मिलाएँ? लॉगिन वाला कार्ड रहेगा, खाली फ़ील्ड दूसरे से भरेंगे, बुकिंग, भुगतान और इतिहास उसमें चले जाएँगे। इसे पूर्ववत नहीं किया जा सकता।'),
  ('person_merged', 'Карточки слиты', 'Cards merged', 'कार्ड मिला दिए गए'),
  ('filter_incomplete', 'Неполные', 'Incomplete', 'अधूरे'),
  ('filter_duplicates', 'Возможно, одно лицо', 'Possible duplicates', 'संभावित दोहराव'),
  ('incomplete_list_hint', 'Кто живёт сейчас или приедет: не хватает телефона, почты, Телеграма или года рождения. По дате заезда.', 'Staying now or arriving: missing phone, email, Telegram or year of birth. By arrival date.', 'अभी रह रहे या आने वाले: फ़ोन, ईमेल, टेलीग्राम या जन्म वर्ष नहीं। आगमन तिथि के अनुसार।'),
  ('incomplete_arrival', 'заезд', 'arrival', 'आगमन')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
