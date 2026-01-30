-- 074_housing_roles_permissions.sql
-- Создание ролей и прав для Housing модуля
-- 7 ролей и 45 прав доступа

-- Добавить модуль housing (если ещё нет)
INSERT INTO modules (code, name_ru, name_en, name_hi, is_active, sort_order)
VALUES ('housing', 'Проживание', 'Housing', 'आवास', true, 3)
ON CONFLICT (code) DO NOTHING;

-- ============================================================================
-- ПРАВА ДЛЯ HOUSING МОДУЛЯ (45 прав)
-- ============================================================================

-- Категория: Вайшнавы (6 прав)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_vaishnavas', 'Просмотр вайшнавов', 'View Vaishnavas', 'वैष्णव देखें', 'vaishnavas'),
    ('create_vaishnava', 'Создание вайшнава', 'Create Vaishnava', 'वैष्णव बनाएं', 'vaishnavas'),
    ('edit_vaishnava', 'Редактирование вайшнава', 'Edit Vaishnava', 'वैष्णव संपादित करें', 'vaishnavas'),
    ('delete_vaishnava', 'Удаление вайшнава', 'Delete Vaishnava', 'वैष्णव हटाएं', 'vaishnavas'),
    ('view_guests', 'Просмотр гостей', 'View Guests', 'अतिथि देखें', 'vaishnavas'),
    ('view_team', 'Просмотр команды', 'View Team', 'टीम देखें', 'vaishnavas')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Размещение (11 прав)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_bookings', 'Просмотр бронирований', 'View Bookings', 'बुकिंग देखें', 'placement'),
    ('create_booking', 'Создание бронирования', 'Create Booking', 'बुकिंग बनाएं', 'placement'),
    ('edit_booking', 'Редактирование бронирования', 'Edit Booking', 'बुकिंग संपादित करें', 'placement'),
    ('delete_booking', 'Удаление бронирования', 'Delete Booking', 'बुकिंग हटाएं', 'placement'),
    ('view_timeline', 'Просмотр таймлайна', 'View Timeline', 'समयरेखा देखें', 'placement'),
    ('manage_arrivals', 'Управление прибытиями', 'Manage Arrivals', 'आगमन प्रबंधित करें', 'placement'),
    ('manage_departures', 'Управление выездами', 'Manage Departures', 'प्रस्थान प्रबंधित करें', 'placement'),
    ('manage_transfers', 'Управление трансферами', 'Manage Transfers', 'स्थानांतरण प्रबंधित करें', 'placement'),
    ('view_preliminary', 'Просмотр предварительных', 'View Preliminary', 'प्रारंभिक देखें', 'placement'),
    ('edit_preliminary', 'Редактирование предварительных', 'Edit Preliminary', 'प्रारंभिक संपादित करें', 'placement'),
    ('view_retreat_guests', 'Просмотр гостей ретритов', 'View Retreat Guests', 'रिट्रीट अतिथि देखें', 'placement')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Ресепшн (10 прав)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_floor_plan', 'Просмотр плана этажей', 'View Floor Plan', 'फ्लोर प्लान देखें', 'reception'),
    ('edit_floor_plan', 'Редактирование плана этажей', 'Edit Floor Plan', 'फ्लोर प्लान संपादित करें', 'reception'),
    ('view_rooms', 'Просмотр комнат', 'View Rooms', 'कमरे देखें', 'reception'),
    ('create_room', 'Создание комнаты', 'Create Room', 'कमरा बनाएं', 'reception'),
    ('edit_room', 'Редактирование комнаты', 'Edit Room', 'कमरा संपादित करें', 'reception'),
    ('delete_room', 'Удаление комнаты', 'Delete Room', 'कमरा हटाएं', 'reception'),
    ('view_buildings', 'Просмотр зданий', 'View Buildings', 'भवन देखें', 'reception'),
    ('edit_buildings', 'Редактирование зданий', 'Edit Buildings', 'भवन संपादित करें', 'reception'),
    ('view_cleaning', 'Просмотр уборки', 'View Cleaning', 'सफाई देखें', 'reception'),
    ('manage_cleaning', 'Управление уборкой', 'Manage Cleaning', 'सफाई प्रबंधित करें', 'reception')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Ашрам (6 прав)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_retreats', 'Просмотр ретритов', 'View Retreats', 'रिट्रीट देखें', 'ashram'),
    ('create_retreat', 'Создание ретрита', 'Create Retreat', 'रिट्रीट बनाएं', 'ashram'),
    ('edit_retreat', 'Редактирование ретрита', 'Edit Retreat', 'रिट्रीट संपादित करें', 'ashram'),
    ('delete_retreat', 'Удаление ретрита', 'Delete Retreat', 'रिट्रीट हटाएं', 'ashram'),
    ('view_festivals', 'Просмотр праздников', 'View Festivals', 'त्योहार देखें', 'ashram'),
    ('edit_festivals', 'Редактирование праздников', 'Edit Festivals', 'त्योहार संपादित करें', 'ashram')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Настройки (5 прав)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_dictionaries', 'Просмотр справочников', 'View Dictionaries', 'शब्दकोश देखें', 'settings'),
    ('edit_dictionaries', 'Редактирование справочников', 'Edit Dictionaries', 'शब्दकोश संपादित करें', 'settings'),
    ('view_translations', 'Просмотр переводов', 'View Translations', 'अनुवाद देखें', 'settings'),
    ('edit_translations', 'Редактирование переводов', 'Edit Translations', 'अनुवाद संपादित करें', 'settings'),
    ('manage_users', 'Управление пользователями', 'Manage Users', 'उपयोगकर्ता प्रबंधित करें', 'settings')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Профиль (3 права)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_own_profile', 'Просмотр своего профиля', 'View Own Profile', 'अपनी प्रोफ़ाइल देखें', 'profile'),
    ('edit_own_profile', 'Редактирование своего профиля', 'Edit Own Profile', 'अपनी प्रोफ़ाइल संपादित करें', 'profile'),
    ('view_own_bookings', 'Просмотр своих бронирований', 'View Own Bookings', 'अपनी बुकिंग देखें', 'profile')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- Категория: Инвентарь (3 права - будущее)
INSERT INTO permissions (module_id, code, name_ru, name_en, name_hi, category)
SELECT m.id, p.code, p.name_ru, p.name_en, p.name_hi, p.category
FROM modules m, (VALUES
    ('view_inventory', 'Просмотр инвентаря', 'View Inventory', 'इन्वेंटरी देखें', 'inventory'),
    ('manage_inventory', 'Управление инвентарём', 'Manage Inventory', 'इन्वेंटरी प्रबंधित करें', 'inventory'),
    ('conduct_inventory', 'Проведение инвентаризации', 'Conduct Inventory', 'इन्वेंटरी करें', 'inventory')
) AS p(code, name_ru, name_en, name_hi, category)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- ============================================================================
-- РОЛИ ДЛЯ HOUSING (8 ролей)
-- ============================================================================

INSERT INTO roles (module_id, code, name_ru, name_en, name_hi, description_ru, description_en, is_system)
SELECT m.id, r.code, r.name_ru, r.name_en, r.name_hi, r.description_ru, r.description_en, r.is_system
FROM modules m, (VALUES
    ('administrator', 'Администратор', 'Administrator', 'व्यवस्थापक', 'Полный доступ ко всем функциям Housing', 'Full access to all Housing functions', false),
    ('reception_manager', 'Менеджер ресепшн', 'Reception Manager', 'रिसेप्शन प्रबंधक', 'Управление размещением, комнатами, зданиями', 'Manage placement, rooms, buildings', false),
    ('placement_manager', 'Менеджер размещения', 'Placement Manager', 'प्लेसमेंट प्रबंधक', 'Управление бронированиями и размещением гостей', 'Manage bookings and guest placement', false),
    ('receptionist', 'Администратор', 'Receptionist', 'रिसेप्शनिस्ट', 'Базовый доступ к ресепшн', 'Basic reception access', false),
    ('cleaner', 'Уборщик', 'Cleaner', 'सफाई कर्मचारी', 'Доступ к управлению уборкой', 'Access to cleaning management', false),
    ('team_coordinator', 'Координатор команды', 'Team Coordinator', 'टीम समन्वयक', 'Управление командой и вайшнавами', 'Manage team and vaishnavas', false),
    ('observer', 'Наблюдатель', 'Observer', 'पर्यवेक्षक', 'Только просмотр', 'View only', false),
    ('guest', 'Гость', 'Guest', 'अतिथि', 'Доступ только к своему профилю', 'Access to own profile only', true)
) AS r(code, name_ru, name_en, name_hi, description_ru, description_en, is_system)
WHERE m.code = 'housing'
ON CONFLICT (module_id, code) DO NOTHING;

-- ============================================================================
-- НАЗНАЧЕНИЕ ПРАВ РОЛЯМ
-- ============================================================================

-- Administrator: все права
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'administrator' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
ON CONFLICT DO NOTHING;

-- Reception Manager: всё кроме управления пользователями
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'reception_manager' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND p.code != 'manage_users'
ON CONFLICT DO NOTHING;

-- Placement Manager: размещение + просмотр всего остального
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'placement_manager' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND (p.category IN ('placement', 'vaishnavas', 'ashram') OR p.code LIKE 'view_%')
ON CONFLICT DO NOTHING;

-- Receptionist: базовый доступ к ресепшн и размещению
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'receptionist' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND (p.code LIKE 'view_%'
       OR p.code IN ('create_booking', 'edit_booking', 'manage_arrivals', 'manage_departures'))
ON CONFLICT DO NOTHING;

-- Cleaner: только уборка
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'cleaner' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND p.code IN ('view_cleaning', 'manage_cleaning', 'view_floor_plan', 'view_rooms')
ON CONFLICT DO NOTHING;

-- Team Coordinator: управление командой и вайшнавами
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'team_coordinator' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND (p.category = 'vaishnavas' OR p.code LIKE 'view_%')
ON CONFLICT DO NOTHING;

-- Observer: только просмотр
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'observer' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND p.code LIKE 'view_%'
ON CONFLICT DO NOTHING;

-- Guest: только свой профиль
INSERT INTO role_permissions (role_id, permission_id)
SELECT r.id, p.id
FROM roles r, permissions p
WHERE r.code = 'guest' AND r.module_id = 'housing'
  AND p.module_id = 'housing'
  AND p.code IN ('view_own_profile', 'edit_own_profile', 'view_own_bookings', 'view_retreats', 'view_festivals')
ON CONFLICT DO NOTHING;
