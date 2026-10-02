-- Статус человека: Гость / Волонтёр / Команда (ВГ 02.10.2026, чат «Вайшнавы 1: единая карточка»).
-- Раньше волонтёр задавался только категорией проживания, а user_type смешивает статус с доступом
-- ('staff' пускает через is_staff()) — поэтому отдельное поле. user_type не трогаем.
-- is_team_member остаётся (на нём вкладки, Прасад, повара) и держится триггером: is_team_member = (status = 'team').
-- Статус — значение по умолчанию: категория брони берёт его как подсказку и может отличаться.

alter table vaishnavas add column if not exists status text not null default 'guest'
    check (status in ('guest', 'volunteer', 'team'));

create or replace function vaishnavas_status_sync()
returns trigger language plpgsql set search_path = public as $$
begin
    if tg_op = 'INSERT' then
        -- старые места вставки знают только is_team_member
        if new.status = 'guest' and coalesce(new.is_team_member, false) then
            new.status := 'team';
        end if;
    elsif new.status is not distinct from old.status
          and new.is_team_member is distinct from old.is_team_member then
        -- правка старой галочкой: сняли команду — волонтёр/гость остаётся как был
        new.status := case when new.is_team_member then 'team'
                           when old.status = 'team' then 'guest'
                           else old.status end;
    end if;
    new.is_team_member := new.status = 'team';
    return new;
end $$;

drop trigger if exists trg_vaishnavas_status_sync on vaishnavas;
create trigger trg_vaishnavas_status_sync before insert or update of status, is_team_member on vaishnavas
    for each row execute function vaishnavas_status_sync();

-- Начальная разметка (временная — окончательно расставляет чат «Вайшнавы 2: статусы по списку»)
update vaishnavas set status = 'team' where is_team_member;

-- Волонтёр: не в команде и либо отмечен user_type 'volunteer', либо живёт волонтёром сейчас/в будущем.
-- Правин — приглашённый гость (ВГ 02.10), не волонтёр.
update vaishnavas v set status = 'volunteer'
 where not coalesce(v.is_team_member, false)
   and v.id <> '98578cf3-c4a7-4f4e-9b5d-80a12de6d9db'
   and (v.user_type = 'volunteer'
        or exists (select 1 from residents r join resident_categories rc on rc.id = r.category_id
                    where r.vaishnava_id = v.id and r.status = 'confirmed'
                      and rc.slug = 'volunteer' and r.check_out >= current_date));

insert into translations (key, ru, en, hi) values
  ('person_status', 'Статус', 'Status', 'स्थिति'),
  ('person_status_guest', 'Гость', 'Guest', 'अतिथि'),
  ('person_status_volunteer', 'Волонтёр', 'Volunteer', 'स्वयंसेवक'),
  ('person_status_team', 'Команда', 'Team', 'टीम'),
  ('person_status_hint', 'По статусу подставляется категория при заселении — в брони её можно поменять', 'The status suggests the category when booking — it can be changed in the booking', 'स्थिति के अनुसार बुकिंग में श्रेणी सुझाई जाती है — उसे बदला जा सकता है'),
  ('person_documents', 'Документы', 'Documents', 'दस्तावेज़'),
  ('filter_volunteers', 'Волонтёры', 'Volunteers', 'स्वयंसेवक')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
