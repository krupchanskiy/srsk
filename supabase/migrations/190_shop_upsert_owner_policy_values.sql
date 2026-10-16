-- В таблице политика потерь зовётся 'owner', а функция проверяла 'owner_risk' —
-- карточка владельца «за его счёт» падала на check-ограничении.
create or replace function shop_upsert_owner(payload jsonb)
returns jsonb
language plpgsql security definer
set search_path to 'public', 'pg_temp'
as $$
declare
    v_id        uuid := nullif(payload->>'owner_id', '')::uuid;
    v_имя       text := nullif(btrim(payload->>'name'), '');
    v_политика  text := coalesce(nullif(payload->>'loss_policy', ''), 'compensate');
    v_тип       text := coalesce(nullif(payload->>'type', ''), 'person');
    v_контакт   text := nullif(btrim(payload->>'contact_info'), '');
    v_note      text := nullif(btrim(payload->>'note'), '');
    v_активен   boolean := coalesce((payload->>'is_active')::boolean, true);
    v_contr     uuid;
begin
    if not abk_current_user_has_permission('shop_manage') then
        raise exception 'Владельцев товара ведёт заведующий магазином' using errcode = '42501';
    end if;
    if v_имя is null then
        raise exception 'Укажите имя владельца';
    end if;
    if v_политика not in ('compensate', 'owner') then
        raise exception 'Непонятная политика потерь: %', v_политика;
    end if;
    if v_тип not in ('person', 'organization') then
        raise exception 'Непонятный тип контрагента: %', v_тип;
    end if;

    if v_id is not null then
        select contractor_id into v_contr from shop_owners where id = v_id;
        if v_contr is null then raise exception 'Владелец не найден'; end if;

        update fin_contractors
           set name = v_имя,
               contact_info = coalesce(v_контакт, contact_info)
         where id = v_contr;

        update shop_owners
           set loss_policy = v_политика, note = v_note, is_active = v_активен
         where id = v_id;

        return jsonb_build_object('ok', true, 'owner_id', v_id, 'создан', false);
    end if;

    -- тёзку не плодим: одноимённый контрагент почти всегда тот же человек
    select id into v_contr from fin_contractors
     where lower(name) = lower(v_имя) and is_active limit 1;

    if v_contr is null then
        insert into fin_contractors (name, type, contact_info, note)
        values (v_имя, v_тип::fin_contractor_type, v_контакт, 'Владелец товара в магазине')
        returning id into v_contr;
    end if;

    if exists (select 1 from shop_owners where contractor_id = v_contr) then
        select id into v_id from shop_owners where contractor_id = v_contr;
        update shop_owners
           set loss_policy = v_политика, note = v_note, is_active = true
         where id = v_id;
        return jsonb_build_object('ok', true, 'owner_id', v_id, 'создан', false,
                                  'сообщение', 'Такой владелец уже был — карточка обновлена');
    end if;

    insert into shop_owners (contractor_id, loss_policy, note, is_active)
    values (v_contr, v_политика, v_note, v_активен)
    returning id into v_id;

    return jsonb_build_object('ok', true, 'owner_id', v_id, 'создан', true);
end $$;
