-- 638: вид связи «Родственник» в «Семье» (ВГ, 03.10).
--
-- Лаванья дд (Liudmila Sidarava) и Камала Манджари дд — родственницы, а кем
-- именно друг другу приходятся, неизвестно: ВГ просил «просто родственники».
-- Было только супруг/ребёнок/родитель/брат-сестра. «Родственник» — взаимный,
-- как брат/сестра (invertRelation в person.js возвращает его как есть).

alter table family_links drop constraint family_links_relation_check;
alter table family_links add constraint family_links_relation_check
    check (relation = any (array['spouse', 'child', 'parent', 'sibling', 'relative']));

insert into translations (key, ru, en, hi)
values ('family_rel_relative', 'Родственник', 'Relative', 'रिश्तेदार')
on conflict (key) do nothing;

insert into family_links (vaishnava_id, relative_id, relation)
select '44af2e31-4065-4dc6-b860-627661c7d216', '352653e5-a997-4edb-b223-67d175f9ae8c', 'relative'
where not exists (select 1 from family_links
                   where (vaishnava_id, relative_id) in (('44af2e31-4065-4dc6-b860-627661c7d216'::uuid, '352653e5-a997-4edb-b223-67d175f9ae8c'::uuid),
                                                         ('352653e5-a997-4edb-b223-67d175f9ae8c'::uuid, '44af2e31-4065-4dc6-b860-627661c7d216'::uuid)));
