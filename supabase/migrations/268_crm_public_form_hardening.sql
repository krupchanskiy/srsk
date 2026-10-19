-- Публичная форма заявки: аноним больше не правит чужие карточки, не узнаёт,
-- записан ли человек, не засыпает CRM и не кладёт в поля разметку.
-- Аудит 19.10.2026, решение Адриана «да, правь».
--
-- Было:
--   * человек искался и по одному имени-фамилии: заявка «Иван Петров»
--     с чужим телефоном вливалась в настоящую карточку и дописывала в неё
--     контакты атакующего, а сделка заводилась на реального человека;
--   * повторная заявка отвечала «duplicate» — по имени можно было узнать,
--     записан ли человек на ретрит;
--   * 30 заявок подряд — 30 людей, 30 сделок, 30 задач, сдвиг очереди
--     менеджеров; UTM-метки до 500 КБ;
--   * телефон, почта, Telegram, UTM — без проверки формата (отсюда XSS
--     в карточке сделки, закрытый на стороне страниц коммитом c07eb775);
--   * заявка человека, чья сделка на этот ретрит отменена, падала на
--     уникальном индексе — форма показывала общую ошибку, лид терялся.
create or replace function public.crm_submit_public_application(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_retreat    retreats%rowtype;
  v_first      text := nullif(trim(payload->>'first_name'), '');
  v_last       text := nullif(trim(payload->>'last_name'), '');
  v_spiritual  text := nullif(trim(payload->>'spiritual_name'), '');
  v_phone      text := nullif(trim(payload->>'phone'), '');
  v_email      text := nullif(lower(trim(payload->>'email')), '');
  v_telegram   text := nullif(regexp_replace(trim(coalesce(payload->>'telegram', '')),
                                              '^(https?://)?(t\.me/)?@?', ''), '');
  v_notes      text := nullif(trim(payload->>'notes'), '');
  v_utm        text[];
  v_person     uuid;
  v_manager    uuid;
  v_deal       uuid;
  v_старая     crm_deals%rowtype;
  i            int;
begin
  -- длины и форматы: всё это потом рисуется в карточке сделки
  if v_first is null or length(v_first) > 100 or length(coalesce(v_last,'')) > 100
     or length(coalesce(v_spiritual,'')) > 150 or length(coalesce(v_notes,'')) > 4000 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_phone is not null and v_phone !~ '^\+?[0-9 ()\-]{5,40}$' then
    return jsonb_build_object('ok', false, 'error', 'invalid_phone');
  end if;
  if v_email is not null and (length(v_email) > 200 or v_email !~ '^[^\s<>"''@]+@[^\s<>"''@]+\.[^\s<>"''@]+$') then
    return jsonb_build_object('ok', false, 'error', 'invalid_email');
  end if;
  -- ник Telegram необязателен: кривой просто не сохраняем
  if v_telegram is not null and v_telegram !~ '^[A-Za-z0-9_]{3,64}$' then
    v_telegram := null;
  end if;
  if v_phone is null and v_email is null then
    return jsonb_build_object('ok', false, 'error', 'contact_required');
  end if;

  -- UTM: до 100 знаков, буквы, цифры и . _ - + пробел; остальное отбрасываем
  v_utm := array[payload->>'utm_source', payload->>'utm_medium',
                 payload->>'utm_campaign', payload->>'utm_content'];
  for i in 1..4 loop
    v_utm[i] := nullif(trim(v_utm[i]), '');
    if v_utm[i] is not null and (length(v_utm[i]) > 100 or v_utm[i] !~ '^[[:alnum:]._+ \-]+$') then
      v_utm[i] := null;
    end if;
  end loop;

  select * into v_retreat from retreats where id = (payload->>'retreat_id')::uuid;
  if not found or not coalesce(v_retreat.is_public, false) then
    return jsonb_build_object('ok', false, 'error', 'retreat_not_found');
  end if;

  -- частота: с одного контакта — не больше трёх заявок в час; всего — не
  -- больше сорока за десять минут. Ответ тот же, что на принятую заявку:
  -- рассыльщику незачем знать, что его остановили
  if (select count(*) from crm_deals d join vaishnavas v on v.id = d.vaishnava_id
       where d.source is not null and d.created_at > now() - interval '1 hour'
         and ((v_phone is not null and v.phone = v_phone)
              or (v_email is not null and lower(v.email) = v_email))) >= 3
     or (select count(*) from crm_deals where created_at > now() - interval '10 minutes') >= 40 then
    return jsonb_build_object('ok', true);
  end if;

  -- человек — только по контакту вместе с именем; одно имя без контакта
  -- уже не повод влить заявку в чужую карточку
  if v_phone is not null then
    select id into v_person from vaishnavas
     where phone = v_phone and not is_deleted and (
           lower(first_name) = lower(v_first)
        or (v_spiritual is not null and lower(spiritual_name) = lower(v_spiritual)))
     limit 1;
  end if;
  if v_person is null and v_email is not null then
    select id into v_person from vaishnavas
     where lower(email) = v_email and not is_deleted and (
           lower(first_name) = lower(v_first)
        or (v_spiritual is not null and lower(spiritual_name) = lower(v_spiritual)))
     limit 1;
  end if;

  if v_person is null then
    insert into vaishnavas (first_name, last_name, spiritual_name, phone, email, telegram, is_deleted)
    values (v_first, v_last, v_spiritual, v_phone, v_email, v_telegram, false)
    returning id into v_person;
  else
    -- карточка найдена по её же контакту: дописываем только пустые поля
    update vaishnavas set
      spiritual_name = coalesce(spiritual_name, v_spiritual),
      last_name      = coalesce(last_name, v_last),
      phone          = coalesce(phone, v_phone),
      email          = coalesce(email, v_email),
      telegram       = coalesce(telegram, v_telegram)
    where id = v_person;
  end if;

  select * into v_старая from crm_deals where vaishnava_id = v_person and retreat_id = v_retreat.id
   order by created_at desc limit 1;

  if found and v_старая.status <> 'cancelled' then
    -- уже записан: ответ как на новую заявку — посторонний не узнает,
    -- записан ли человек; сам он увидит, что заявка принята
    return jsonb_build_object('ok', true);
  end if;

  if found then
    -- сделка на этот ретрит была и отменена: человек передумал обратно —
    -- открываем её заново, а не падаем на уникальном индексе
    begin
      update crm_deals
         set status = 'lead',
             notes = concat_ws(E'\n', notes, 'Повторная заявка с сайта: ' || coalesce(v_notes, '—'))
       where id = v_старая.id;
    exception when others then
      -- переход запрещён правилами стадий — оставляем заметку менеджеру
      update crm_deals
         set notes = concat_ws(E'\n', notes, 'Повторная заявка с сайта (сделка отменена): ' || coalesce(v_notes, '—'))
       where id = v_старая.id;
    end;
    return jsonb_build_object('ok', true);
  end if;

  v_manager := assign_next_manager_for_retreat(v_retreat.id);

  insert into crm_deals (vaishnava_id, retreat_id, manager_id, status, source, notes,
                         utm_source, utm_medium, utm_campaign, utm_content)
  values (v_person, v_retreat.id, v_manager, 'lead',
          coalesce(v_utm[1], 'website'), v_notes,
          v_utm[1], v_utm[2], v_utm[3], v_utm[4])
  returning id into v_deal;

  return jsonb_build_object('ok', true);
end;
$function$;
