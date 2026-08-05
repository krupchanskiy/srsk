-- Периметр анонима, часть 2: политики таблиц.
-- До этой миграции неавторизованный посетитель читал весь справочник людей
-- (551 человек с телефонами и почтами), все сделки CRM и мог править живые карточки.

-- 1. Справочник людей: читать может только вошедший.
--    Условие is_deleted = false срабатывало и для анонима — добавляем проверку входа.
drop policy if exists "Users can view vaishnavas based on permissions" on public.vaishnavas;
create policy "Users can view vaishnavas based on permissions" on public.vaishnavas
  for select using (
    (select auth.uid()) is not null
    and (
      user_id = (select auth.uid())
      or is_deleted = false
      or is_superuser((select auth.uid()))
      or has_permission((select auth.uid()), 'edit_vaishnava')
    )
  );

-- 2. Аноним не правит карточки людей. Саморегистрация использует INSERT-политику,
--    она остаётся (там жёсткий WITH CHECK: только гость, не команда, не суперюзер).
drop policy if exists anon_update_vaishnavas on public.vaishnavas;

-- 3. Сделки CRM анониму не нужны ни на чтение, ни на запись:
--    ни одна публичная страница к ним не обращается.
drop policy if exists anon_read_crm_deals on public.crm_deals;
drop policy if exists anon_insert_crm_deals on public.crm_deals;

-- 4. Модель прав — только для вошедших.
drop policy if exists "Public read modules" on public.modules;
create policy "Public read modules" on public.modules
  for select to authenticated using (true);

drop policy if exists "Public read permissions" on public.permissions;
create policy "Public read permissions" on public.permissions
  for select to authenticated using (true);

drop policy if exists "Public read roles" on public.roles;
create policy "Public read roles" on public.roles
  for select to authenticated using (true);

drop policy if exists "Public read role_permissions" on public.role_permissions;
create policy "Public read role_permissions" on public.role_permissions
  for select to authenticated using (true);

drop policy if exists "Public read user_permissions" on public.user_permissions;
create policy "Public read user_permissions" on public.user_permissions
  for select to authenticated using (true);

drop policy if exists "Public read user_roles" on public.user_roles;
create policy "Public read user_roles" on public.user_roles
  for select to authenticated using (true);

-- 5. Распознанные лица на фото — персональные данные.
drop policy if exists face_tags_select on public.face_tags;
create policy face_tags_select on public.face_tags
  for select to authenticated using (true);

drop policy if exists photo_faces_select on public.photo_faces;
create policy photo_faces_select on public.photo_faces
  for select to authenticated using (true);
