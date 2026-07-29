-- Вложения: ответственный видит чеки по своим счетам.
--
-- Было: и список вложений, и сам файл в хранилище отдавались только админу
-- финансов и наблюдателю. Человек, у которого деньги под отчёт, не мог открыть
-- собственный чек — приложил и потерял из виду.
--
-- Решение ВГ (29.07.2026): открыть, но только в рамках своего департамента или
-- выделенных счетов. Право на счёт теперь считается в одном месте:
--   • администратор финансов и наблюдатель — видят всё;
--   • явная выдача доступа в fin_account_access — «выделенные счета»;
--   • ответственный за счёт (fin_accounts.responsible_person_id) — свой счёт.
-- Подотчётные счета департаментов заводятся с ответственным, поэтому кухня
-- видит чеки кухни и не видит чеков кафе.

create or replace function fin_can_read_account(p_account uuid, p_user uuid default auth.uid())
returns boolean
language sql
stable
security definer
set search_path to 'public'
as $$
  select p_account is not null and p_user is not null and (
       fin_can_read_all(p_user)
    or exists (select 1 from fin_account_access aa
                where aa.account_id = p_account and aa.user_id = p_user)
    or exists (select 1 from fin_accounts a
                 join vaishnavas v on v.id = a.responsible_person_id
                where a.id = p_account and v.user_id = p_user)
  );
$$;

-- Вью выполняется с правами вызывающего, поэтому функции нужен явный EXECUTE,
-- иначе у обычного пользователя страница падает с permission denied.
grant execute on function fin_can_read_account(uuid, uuid) to authenticated;

-- Вложение к операции целиком видно, только если доступны ВСЕ её проводки:
-- иначе по чеку можно было бы узнать о чужой операции.
create or replace view fin_v_attachments as
select
    a.id,
    a.parent_type,
    a.parent_id,
    a.posting_id,
    a.storage_path,
    a.file_name,
    a.mime_type,
    a.size_bytes,
    a.uploaded_at,
    fin_private_person_name((select v.id from vaishnavas v where v.user_id = a.uploaded_by limit 1)) as uploaded_by_name
from fin_attachments a
where fin_can_read_all()
   or (a.posting_id is not null and exists (
         select 1 from fin_postings p
          where p.id = a.posting_id and fin_can_read_account(p.account_id)))
   or (a.parent_type = 'operation'::fin_attachment_parent_type and a.posting_id is null and (
         a.uploaded_by = auth.uid()
         or (    exists (select 1 from fin_postings p where p.operation_id = a.parent_id)
             and not exists (select 1 from fin_postings p
                              where p.operation_id = a.parent_id
                                and not fin_can_read_account(p.account_id)))));

-- Сам файл в хранилище: то же правило, чтобы список и содержимое не разъезжались.
drop policy if exists fin_files_read on storage.objects;
create policy fin_files_read on storage.objects
for select to authenticated
using (
    bucket_id = 'finance-files'
    and exists (select 1 from public.fin_v_attachments t where t.storage_path = storage.objects.name)
);
