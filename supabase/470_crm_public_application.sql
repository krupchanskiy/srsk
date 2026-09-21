-- 470. Приём заявки с публичной формы одной защищённой функцией
--
-- Форма crm/form.html молчала с начала августа: последняя сделка с сайта —
-- 03.08.2026. Анониму оставили INSERT в vaishnavas, но не SELECT (и правильно:
-- иначе вся база людей читается публичным ключом), а форма после вставки
-- просила id обратно — RLS резала возврат строки, ответ 401. На crm_deals
-- у анонима нет политики вставки вовсе, выбор менеджера для него закрыт.
--
-- Вместо того чтобы открывать таблицы, заявка принимается целиком здесь:
-- поиск гостя, дубль, менеджер, сделка. Анониму — только EXECUTE.
create or replace function crm_submit_public_application(payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $fn$
declare
  v_retreat    retreats%rowtype;
  v_first      text := nullif(trim(payload->>'first_name'), '');
  v_last       text := nullif(trim(payload->>'last_name'), '');
  v_spiritual  text := nullif(trim(payload->>'spiritual_name'), '');
  v_phone      text := nullif(trim(payload->>'phone'), '');
  v_email      text := nullif(lower(trim(payload->>'email')), '');
  v_telegram   text := nullif(trim(payload->>'telegram'), '');
  v_notes      text := nullif(trim(payload->>'notes'), '');
  v_person     uuid;
  v_manager    uuid;
  v_deal       uuid;
begin
  -- Грубая защита от мусора: форма публичная
  if v_first is null or length(v_first) > 100 or length(coalesce(v_last,'')) > 100
     or length(coalesce(v_spiritual,'')) > 150 or length(coalesce(v_notes,'')) > 4000
     or length(coalesce(v_phone,'')) > 40 or length(coalesce(v_email,'')) > 200
     or length(coalesce(v_telegram,'')) > 100 then
    return jsonb_build_object('ok', false, 'error', 'invalid');
  end if;
  if v_phone is null and v_email is null then
    return jsonb_build_object('ok', false, 'error', 'contact_required');
  end if;

  select * into v_retreat from retreats where id = (payload->>'retreat_id')::uuid;
  if not found or not coalesce(v_retreat.is_public, false) then
    return jsonb_build_object('ok', false, 'error', 'retreat_not_found');
  end if;

  -- Тот же порядок поиска, что был в форме: телефон, почта, полное имя
  if v_phone is not null then
    select id into v_person from vaishnavas where phone = v_phone and not is_deleted limit 1;
  end if;
  if v_person is null and v_email is not null then
    select id into v_person from vaishnavas where lower(email) = v_email and not is_deleted limit 1;
  end if;
  if v_person is null then
    select id into v_person from vaishnavas
     where not is_deleted and lower(first_name) = lower(v_first)
       and (case when v_last is null then last_name is null else lower(last_name) = lower(v_last) end)
     limit 1;
  end if;

  if v_person is null then
    insert into vaishnavas (first_name, last_name, spiritual_name, phone, email, telegram, is_deleted)
    values (v_first, v_last, v_spiritual, v_phone, v_email, v_telegram, false)
    returning id into v_person;
  else
    -- Анонимная форма не перезаписывает чужие контакты — только дополняет
    -- пустые поля. Иначе через неё можно было бы подменить почту любого
    -- человека в базе
    update vaishnavas set
      spiritual_name = coalesce(spiritual_name, v_spiritual),
      last_name      = coalesce(last_name, v_last),
      phone          = coalesce(phone, v_phone),
      email          = coalesce(email, v_email),
      telegram       = coalesce(telegram, v_telegram)
    where id = v_person;
  end if;

  if exists (select 1 from crm_deals where vaishnava_id = v_person
               and retreat_id = v_retreat.id and status <> 'cancelled') then
    return jsonb_build_object('ok', false, 'error', 'duplicate');
  end if;

  v_manager := assign_next_manager_for_retreat(v_retreat.id);

  insert into crm_deals (vaishnava_id, retreat_id, manager_id, status, source, notes,
                         utm_source, utm_medium, utm_campaign, utm_content)
  values (v_person, v_retreat.id, v_manager, 'lead',
          coalesce(nullif(payload->>'utm_source',''), 'website'), v_notes,
          nullif(payload->>'utm_source',''), nullif(payload->>'utm_medium',''),
          nullif(payload->>'utm_campaign',''), nullif(payload->>'utm_content',''))
  returning id into v_deal;

  return jsonb_build_object('ok', true);
end;
$fn$;

revoke all on function crm_submit_public_application(jsonb) from public;
grant execute on function crm_submit_public_application(jsonb) to anon, authenticated, service_role;
