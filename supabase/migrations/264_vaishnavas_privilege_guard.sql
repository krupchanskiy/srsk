-- Гость портала мог сам сделать себя сотрудником.
--
-- Найдено аудитом 19.10.2026. Политика «vaishnavas_update_own_telegram_chat_id»
-- (и ветка edit_own_profile) разрешают человеку UPDATE своей карточки
-- без ограничения колонок, а is_staff() верит полю user_type. Запрос
--     update vaishnavas set user_type = 'staff' where user_id = auth.uid()
-- из консоли браузера открывал гостю все сделки CRM, переписку, платежи
-- и почти весь контур, закрытый is_staff. То же через INSERT «ребёнка»
-- (политика «Parents can create children»): строка с user_type = 'staff'
-- и своим user_id.
--
-- Сторож: прямой запрос со страницы (роль authenticated/anon) от человека
-- без права edit_vaishnava не может менять поля, от которых зависят права
-- и вход. Функции базы (security definer: регистрация гостя, привязка
-- входа, слияние карточек) этим не задеты — они проверяют права сами,
-- и current_user у них — владелец функции. Сам сторож — security invoker:
-- в definer-функции current_user был бы владельцем, и проверка «запрос
-- со страницы» не срабатывала бы никогда (проверено).
create or replace function public.vaishnavas_guard_privileged()
returns trigger
language plpgsql
security invoker
set search_path to 'public', 'pg_temp'
as $function$
declare
    v_кто uuid := auth.uid();
begin
    if current_user not in ('authenticated', 'anon') then
        return new;
    end if;
    if v_кто is not null
       and (is_superuser(v_кто) or has_permission(v_кто, 'edit_vaishnava')
            or (tg_op = 'INSERT' and has_permission(v_кто, 'create_vaishnava'))) then
        return new;
    end if;

    if tg_op = 'INSERT' then
        if coalesce(new.user_type, 'guest') <> 'guest'
           or coalesce(new.is_superuser, false)
           or coalesce(new.is_team_member, false)
           or coalesce(new.status, 'guest') = 'team'
           or new.user_id is not null then
            raise exception 'Нет прав создавать карточку сотрудника или привязывать вход'
                using errcode = '42501';
        end if;
        return new;
    end if;

    if new.user_type is distinct from old.user_type
       or new.user_id is distinct from old.user_id
       or new.is_active is distinct from old.is_active
       or new.is_superuser is distinct from old.is_superuser
       or new.is_team_member is distinct from old.is_team_member
       or new.status is distinct from old.status
       or new.approval_status is distinct from old.approval_status
       or new.is_deleted is distinct from old.is_deleted then
        raise exception 'Нет прав менять тип, статус, вход или активность карточки'
            using errcode = '42501';
    end if;
    return new;
end $function$;

revoke all on function public.vaishnavas_guard_privileged() from public, anon, authenticated;

-- «a_» в начале имени: BEFORE-триггеры идут по алфавиту, сторож — первым,
-- до триггера, который из is_team_member выводит status
drop trigger if exists a_vaishnavas_guard_privileged on public.vaishnavas;
create trigger a_vaishnavas_guard_privileged
    before insert or update on public.vaishnavas
    for each row execute function public.vaishnavas_guard_privileged();

-- Прямая вставка анонимом больше не нужна: публичная форма заявки работает
-- через функцию crm_submit_public_application. Через эту политику аноним
-- мог завести карточку с чужим user_id и сломать «свою карточку» сотрудника.
drop policy if exists anon_insert_vaishnavas on public.vaishnavas;
revoke insert, update, delete on table public.vaishnavas from anon;
