-- 388: гостевая роль больше не считается «сотрудником»
--
-- is_staff() лежит в основе 53 политик RLS, и последним слагаемым в ней было
-- «есть любая активная роль». Роль «Гость» — тоже роль, поэтому каждый гость,
-- у которого она проставлена, читал через API всю базу: 562 вайшнавы с
-- телефонами, 189 сделок CRM, 730 записей проживания, 880 регистраций и
-- 114 платежей. В интерфейсе он этого не видел — но ключ anon публичен,
-- и запрос напрямую отдавал всё.
--
-- Гостевые роли теперь исключены поимённо, как это давно сделано в
-- abk_has_general_staff_access(). Кому нужен доступ — выдаём роль или
-- точечное право явно, а не через побочный эффект.
--
-- Замер на живой базе (сухой прогон): гость 562→1 вайшнава (только своя
-- карточка), сделки 189→0, проживание 730→0, регистрации 880→0, платежи 114→0.
-- У ресепшена и сотрудников всё осталось прежним.

create or replace function public.is_staff(user_uuid uuid)
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
    SELECT EXISTS(SELECT 1 FROM superusers WHERE user_id = user_uuid)
        OR EXISTS(SELECT 1 FROM vaishnavas WHERE user_id = user_uuid
                    AND user_type = 'staff' AND is_active = true AND is_deleted = false)
        -- Роль сотрудника — любая, кроме гостевой и кухни AB (у неё свой контур abk_*)
        OR EXISTS(SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id
                   WHERE ur.user_id = user_uuid AND ur.is_active = true
                     AND r.code NOT IN ('guest', 'ab_kitchen_admin'))
$$;

comment on function public.is_staff(uuid) is
    'Сотрудник ашрама: суперпользователь, карточка с user_type=staff или активная роль, кроме guest и ab_kitchen_admin';
