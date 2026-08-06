-- Ретрит, заведённый в CRM, не появлялся в финмодуле: объекты учёта создавались вручную,
-- а fin_ensure_accounting_object вызывается только при открытии страницы «Участники».
-- Так «Ретрит Художников» (создан 03.08) не попал в списки статей и отчётов.
-- Теперь объект учёта заводится вместе с ретритом, а переименование ретрита доезжает до него.

create or replace function public.fin_sync_retreat_object()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $$
begin
  insert into fin_accounting_objects (type, retreat_id, display_name)
  values ('retreat', new.id, coalesce(new.name_ru, new.name_en, 'Ретрит ' || new.id::text))
  on conflict (retreat_id) do update
    set display_name = excluded.display_name
   where fin_accounting_objects.display_name is distinct from excluded.display_name;
  return new;
end;
$$;

drop trigger if exists trg_fin_sync_retreat_object on public.retreats;
create trigger trg_fin_sync_retreat_object
  after insert or update of name_ru, name_en on public.retreats
  for each row execute function public.fin_sync_retreat_object();

-- Разовая досылка: ретриты, которые ещё не закончились. Прошедшие 2025 года без сделок
-- не трогаем — они только замусорили бы выпадающие списки.
insert into fin_accounting_objects (type, retreat_id, display_name)
select 'retreat', r.id, coalesce(r.name_ru, r.name_en, 'Ретрит ' || r.id::text)
  from retreats r
 where r.end_date >= current_date
   and not exists (select 1 from fin_accounting_objects o where o.retreat_id = r.id)
on conflict (retreat_id) do nothing;
