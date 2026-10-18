-- Модуль «Поклонение»: хранилище стандартов пуджарского отдела.
-- Блок 1.1 плана: модуль, права, роли.
--
-- Право чтения даётся роли «Команда», а не всем вошедшим. Гостевая регистрация
-- в системе одобряется автоматически, и на 22 сотрудника приходится 626 гостевых
-- учётных записей: если бы чтение открывалось по факту входа, внутренние стандарты
-- служения читал бы любой, кто когда-либо записывался на ретрит.

insert into modules (code, name_ru, name_en, name_hi, is_active, sort_order)
values ('worship', 'Поклонение', 'Worship', 'पूजा', true,
        coalesce((select max(sort_order) from modules), 0) + 1)
on conflict (code) do nothing;

insert into permissions (module_id, code, name_ru, name_en, name_hi, category, sort_order)
select m.id, v.code, v.ru, v.en, v.hi, 'worship', v.n
from modules m,
     (values
        ('worship_view',    'Поклонение: читать',   'Worship: read',    'पूजा: पढ़ना', 1),
        ('worship_write',   'Поклонение: писать',   'Worship: write',   'पूजा: लिखना', 2),
        ('worship_approve', 'Поклонение: утверждать','Worship: approve', 'पूजा: अनुमोदन', 3)
     ) as v(code, ru, en, hi, n)
where m.code = 'worship'
on conflict (code) do nothing;

insert into roles (module_id, code, name_ru, name_en, name_hi, description_ru, color, is_system, sort_order)
select m.id, v.code, v.ru, v.en, v.hi, v.descr, v.color, false, v.n
from modules m,
     (values
        ('worship_pujari', 'Пуджари', 'Pujari', 'पुजारी',
         'Пишет и правит стандарты служения, ведёт библиотеку и галерею', '#9b2226', 1),
        ('worship_senior', 'Старший пуджари', 'Senior pujari', 'मुख्य पुजारी',
         'Утверждает стандарты, ведёт расписание служб и людей отдела', '#7a1a1e', 2)
     ) as v(code, ru, en, hi, descr, color, n)
where m.code = 'worship'
on conflict (code) do nothing;

-- пуджари: читать и писать
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.code = 'worship_pujari' and p.code in ('worship_view', 'worship_write')
on conflict do nothing;

-- старший: всё перечисленное плюс утверждение
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.code = 'worship_senior'
  and p.code in ('worship_view', 'worship_write', 'worship_approve')
on conflict do nothing;

-- чтение стандартов — всей команде ашрама, как view_menu и view_timeline
insert into role_permissions (role_id, permission_id)
select r.id, p.id from roles r, permissions p
where r.code = 'team_member' and p.code = 'worship_view'
on conflict do nothing;
