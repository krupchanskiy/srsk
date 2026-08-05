-- Справочник людей видели все вошедшие — включая 439 гостей портала,
-- которым доставались 432 телефона и 522 почты чужих людей.
-- Теперь весь справочник открыт сотрудникам, а гостю — он сам, его дети и его семья.
-- ВНИМАНИЕ: уточнено миграцией 365 (удалённые карточки снова скрыты от сотрудников).
drop policy if exists "Users can view vaishnavas based on permissions" on public.vaishnavas;
create policy "Users can view vaishnavas based on permissions" on public.vaishnavas
  for select using (
    (select auth.uid()) is not null
    and (
      -- сотрудники и обладатели права видят справочник целиком
      is_staff((select auth.uid()))
      or is_superuser((select auth.uid()))
      or has_permission((select auth.uid()), 'view_vaishnavas')
      or has_permission((select auth.uid()), 'edit_vaishnava')
      -- гость видит себя
      or user_id = (select auth.uid())
      -- своих детей
      or parent_id in (select get_own_vaishnava_ids((select auth.uid())))
      -- и тех, с кем связан семейно (связь двусторонняя)
      or id in (
        select f.relative_id from family_links f
         where f.vaishnava_id in (select get_own_vaishnava_ids((select auth.uid())))
        union
        select f.vaishnava_id from family_links f
         where f.relative_id in (select get_own_vaishnava_ids((select auth.uid())))
      )
    )
  );
