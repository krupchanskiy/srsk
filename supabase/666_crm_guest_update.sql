-- 666: правка карточки гостя из сделки CRM (ВГ, 09.10.2026).
-- У «Менеджера по продажам» нет права edit_vaishnava: прямой UPDATE vaishnavas отсекался RLS
-- без ошибки (0 строк), а сделка писала «Сохранено» — дата рождения Timur Bakhromov, телефоны
-- и прочее «откатывались» после перезагрузки. Общее право edit_vaishnava менеджерам не выдаём:
-- с ним через API меняется вся строка (вплоть до is_superuser). Вместо этого — функция, которая
-- меняет только контактные поля гостя, для тех, кто работает в CRM.
create or replace function public.crm_guest_update(p_vaishnava uuid, p_fields jsonb)
returns void
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_uid uuid := auth.uid();
    v_bad text;
    v_n int;
begin
    if v_uid is null or not (is_superuser(v_uid) or has_permission(v_uid, 'edit_crm')
                             or has_permission(v_uid, 'edit_vaishnava')) then
        raise exception 'Нет права менять карточку гостя' using errcode = '42501';
    end if;
    select string_agg(k, ', ') into v_bad
      from jsonb_object_keys(coalesce(p_fields, '{}'::jsonb)) k
     where k not in ('spiritual_name', 'first_name', 'last_name', 'phone', 'email', 'telegram',
                     'birth_date', 'gender', 'spiritual_teacher', 'guru_name');
    if v_bad is not null then
        raise exception 'Из сделки эти поля карточки не меняются: %', v_bad using errcode = '22023';
    end if;

    update vaishnavas set
        spiritual_name    = case when p_fields ? 'spiritual_name'    then nullif(trim(p_fields->>'spiritual_name'), '')    else spiritual_name end,
        first_name        = case when p_fields ? 'first_name'        then nullif(trim(p_fields->>'first_name'), '')        else first_name end,
        last_name         = case when p_fields ? 'last_name'         then nullif(trim(p_fields->>'last_name'), '')         else last_name end,
        phone             = case when p_fields ? 'phone'             then nullif(trim(p_fields->>'phone'), '')             else phone end,
        email             = case when p_fields ? 'email'             then nullif(trim(p_fields->>'email'), '')             else email end,
        telegram          = case when p_fields ? 'telegram'          then nullif(trim(p_fields->>'telegram'), '')          else telegram end,
        birth_date        = case when p_fields ? 'birth_date'        then nullif(p_fields->>'birth_date', '')::date        else birth_date end,
        gender            = case when p_fields ? 'gender'            then nullif(p_fields->>'gender', '')                  else gender end,
        spiritual_teacher = case when p_fields ? 'spiritual_teacher' then nullif(trim(p_fields->>'spiritual_teacher'), '') else spiritual_teacher end,
        guru_name         = case when p_fields ? 'guru_name'         then nullif(trim(p_fields->>'guru_name'), '')         else guru_name end
     where id = p_vaishnava and coalesce(is_deleted, false) = false;
    get diagnostics v_n = row_count;
    if v_n = 0 then
        raise exception 'Карточка гостя не найдена' using errcode = 'P0002';
    end if;
end;
$function$;
revoke all on function public.crm_guest_update(uuid, jsonb) from public, anon;
grant execute on function public.crm_guest_update(uuid, jsonb) to authenticated;
