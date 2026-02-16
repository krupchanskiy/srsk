# Роли и права доступа ШРСК

> Актуально на: 2026-02-13

## Сводная таблица

| Роль | Код | Пользователей | Прав | Зона ответственности |
|------|-----|---------------|------|---------------------|
| Шеф-повар | `chef` | 3 | 26 | Полное управление кухней и складом |
| Повар | `cook` | 3 | 21 | Работа на кухне, взаимодействие со складом |
| Зав. складом | `warehouse_manager` | 3 | 16 | Полное управление складом |
| Ресепшенист | `receptionist` | 1 | 35 | Полное управление размещением |
| Организатор | `organizer` | 0 | 29 | Ретриты, бронирования, потоки гостей |
| Руководитель продаж | `sales_head` | 2 | 4 | CRM и дашборд продаж |
| Менеджер продаж | `sales_manager` | 0 | 2 | Работа в CRM |
| Член команды | `team_member` | 23 | 5 | Минимальный просмотр |
| Гость | `guest` | 0 | 3 | Только свой профиль и бронирования |

---

## Детализация по ролям

### Шеф-повар (`chef`) — 26 прав

**Кухня (полное управление):**
- `view_menu`, `edit_menu` — Меню
- `view_menu_templates`, `edit_menu_templates` — Шаблоны меню
- `view_recipes`, `create_recipe`, `edit_recipe`, `delete_recipe` — Рецепты
- `view_products`, `edit_products` — Продукты
- `view_kitchen_dictionaries`, `edit_kitchen_dictionaries` — Кухонные справочники

**Склад (полное управление):**
- `view_stock`, `view_stock_settings`, `edit_stock_settings` — Склад и настройки
- `view_requests`, `create_request`, `edit_request`, `delete_request` — Заявки
- `issue_stock`, `receive_stock` — Выдача / приёмка
- `conduct_inventory` — Инвентаризация

**Контекст:**
- `view_timeline` — Шахматка (для понимания количества гостей)
- `view_vaishnavas` — Вайшнавы

**Профиль:**
- `view_own_profile`, `edit_own_profile`

---

### Повар (`cook`) — 21 право

**Кухня (работа):**
- `view_menu`, `edit_menu` — Меню
- `view_menu_templates`, `edit_menu_templates` — Шаблоны меню
- `view_recipes`, `create_recipe`, `edit_recipe`, `delete_recipe` — Рецепты
- `view_products`, `edit_products` — Продукты

**Склад (взаимодействие):**
- `view_stock` — Просмотр склада
- `view_requests`, `create_request`, `edit_request`, `delete_request` — Заявки
- `issue_stock`, `receive_stock` — Выдача / приёмка

**Контекст:**
- `view_timeline` — Шахматка
- `view_vaishnavas` — Вайшнавы

**Профиль:**
- `view_own_profile`, `edit_own_profile`

**Отличие от шефа:** нет управления настройками склада, инвентаризации и кухонных справочников.

---

### Зав. складом (`warehouse_manager`) — 16 прав

**Склад (полное управление):**
- `view_stock`, `view_stock_settings`, `edit_stock_settings` — Склад и настройки
- `view_requests`, `create_request`, `edit_request`, `delete_request` — Заявки
- `issue_stock`, `receive_stock` — Выдача / приёмка
- `conduct_inventory` — Инвентаризация
- `view_products` — Просмотр продуктов

**Контекст:**
- `view_timeline` — Шахматка (планирование запасов)
- `view_vaishnavas` — Вайшнавы
- `view_menu` — Меню (понимание потребностей кухни)

**Профиль:**
- `view_own_profile`, `edit_own_profile`

---

### Ресепшенист (`receptionist`) — 35 прав

**Размещение (полное управление):**
- `view_buildings`, `edit_buildings` — Здания
- `view_rooms`, `create_room`, `edit_room`, `delete_room` — Комнаты
- `view_floor_plan`, `edit_floor_plan` — Этажные планы
- `view_housing_dictionaries`, `edit_housing_dictionaries` — Справочники размещения
- `view_cleaning`, `manage_cleaning` — Уборка

**Бронирования:**
- `view_bookings`, `create_booking`, `edit_booking`, `delete_booking`
- `view_preliminary`, `edit_preliminary` — Предварительные
- `view_timeline`, `edit_timeline` — Шахматка

**Потоки гостей:**
- `view_arrivals`, `manage_arrivals` — Прибытия
- `view_departures`, `manage_departures` — Выезды
- `view_transfers`, `manage_transfers` — Трансферы

**Гости:**
- `view_guests` — Список гостей
- `view_vaishnavas`, `create_vaishnava`, `edit_vaishnava` — Вайшнавы
- `view_retreats`, `view_retreat_guests` — Ретриты (для заселения)

**Контекст:**
- `view_menu` — Меню (информирование гостей)

**Профиль:**
- `view_own_profile`, `edit_own_profile`

---

### Организатор (`organizer`) — 29 прав

**Ретриты:**
- `view_retreats`, `create_retreat`, `edit_retreat` — Управление ретритами
- `view_retreat_guests`, `import_guests` — Гости ретритов

**Бронирования:**
- `view_bookings`, `create_booking`, `edit_booking`
- `view_preliminary`, `edit_preliminary` — Предварительные
- `view_timeline`, `edit_timeline` — Шахматка

**Потоки гостей:**
- `view_arrivals`, `manage_arrivals` — Прибытия
- `view_departures`, `manage_departures` — Выезды
- `view_transfers`, `manage_transfers` — Трансферы

**Гости:**
- `view_guests` — Список гостей
- `view_vaishnavas`, `create_vaishnava`, `edit_vaishnava` — Вайшнавы
- `view_festivals`, `edit_festivals` — Фестивали

**Контекст:**
- `view_buildings`, `view_rooms` — Здания и комнаты (для планирования)
- `view_menu` — Меню

**Профиль:**
- `view_own_profile`, `edit_own_profile`

---

### Руководитель продаж (`sales_head`) — 4 права

- `view_crm` — Просмотр CRM
- `edit_crm` — Редактирование CRM
- `view_crm_dashboard` — Дашборд продаж
- `edit_crm_settings` — Настройки CRM

---

### Менеджер продаж (`sales_manager`) — 2 права

- `view_crm` — Просмотр CRM
- `edit_crm` — Редактирование CRM

---

### Член команды (`team_member`) — 5 прав

- `view_timeline` — Шахматка
- `view_menu` — Меню
- `view_vaishnavas` — Вайшнавы
- `view_own_profile`, `edit_own_profile` — Профиль

Минимальная роль для сотрудников. Видит только общую информацию.

---

### Гость (`guest`) — 3 права

- `view_own_profile`, `edit_own_profile` — Свой профиль
- `view_own_bookings` — Свои бронирования

---

## Принципы

1. **Минимальные привилегии** — каждая роль видит только то, что нужно для работы
2. **Роли комбинируются** — пользователь может иметь несколько ролей, права суммируются
3. **Без роли = гостевой портал** — пользователь без ролей перенаправляется на гостевой портал
4. **Контекстные права** — `view_timeline`, `view_menu`, `view_vaishnavas` даются большинству ролей как общий контекст
