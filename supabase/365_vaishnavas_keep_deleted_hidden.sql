-- Уточнение к 364: удалённые карточки по-прежнему видны только тем, кто их правит
-- (суперюзер или право edit_vaishnava) — как было до разделения гостей и сотрудников.
drop policy if exists "Users can view vaishnavas based on permissions" on public.vaishnavas;
create policy "Users can view vaishnavas based on permissions" on public.vaishnavas
  for select using (
    (select auth.uid()) is not null
    and (
      -- полный доступ, включая удалённых
      is_superuser((select auth.uid()))
      or has_permission((select auth.uid()), 'edit_vaishnava')
      -- сотрудники видят живой справочник
      or (is_deleted = false and (
            is_staff((select auth.uid()))
            or has_permission((select auth.uid()), 'view_vaishnavas')
         ))
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
