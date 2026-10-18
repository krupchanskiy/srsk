-- Кто в отделе: постоянная команда или волонтёр на время.
-- Нагрузку этих двух групп смотрят порознь: с команды спрос другой,
-- а волонтёра, который приехал на две недели, не ставят в мангала-арати
-- семь дней подряд.
alter table worship_people
    add column if not exists kind text not null default 'team';

do $$
begin
    if not exists (
        select 1 from pg_constraint
         where conname = 'worship_people_kind_check'
           and conrelid = 'worship_people'::regclass)
    then
        alter table worship_people
            add constraint worship_people_kind_check check (kind in ('team', 'volunteer'));
    end if;
end $$;

comment on column worship_people.kind is
    'team — постоянная команда отдела, volunteer — временный помощник';

-- У кого стоит срок участия, тот и есть волонтёр: проставляем разом,
-- чтобы не размечать отдел руками
update worship_people set kind = 'volunteer'
 where active_to is not null and kind = 'team';

create index if not exists worship_people_kind_idx on worship_people (kind);
