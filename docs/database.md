# База данных

## Обзор

- **СУБД**: PostgreSQL (Supabase)
- **Project ID**: `llttmftapmwebidgevmg`
- **Количество таблиц**: 84
- **Миграции**: `supabase/001_*.sql` — `supabase/097_*.sql`+

---

## Таблицы по модулям

### Люди (vaishnavas)

| Таблица | Описание |
|---------|----------|
| `vaishnavas` | Все люди (гости + команда) |
| `departments` | Отделы (кухня, пуджари и т.д.) |
| `spiritual_teachers` | Духовные учителя |
| `vaishnava_stays` | Периоды пребывания команды |
| `team_presence` | Текущее присутствие |

**vaishnavas — ключевые поля:**
```
id, user_id, spiritual_name, first_name, last_name
email, phone, telegram, whatsapp
country, city, birth_date
spiritual_teacher, initiation_date
is_team_member, department_id, service, senior_id
photo_url, notes
```

---

### Проживание (Housing)

| Таблица | Описание |
|---------|----------|
| `buildings` | Здания |
| `building_types` | Типы зданий |
| `rooms` | Комнаты |
| `room_types` | Типы комнат |
| `residents` | Проживающие |
| `resident_categories` | Категории проживающих |
| `bookings` | Бронирования |
| `floor_plans` | Планы этажей (SVG) |
| `room_cleanings` | Уборка комнат |
| `cleaning_tasks` | Задачи уборки |

**residents — ключевые поля:**
```
id, vaishnava_id, room_id, booking_id
check_in, check_out
category_id, notes
```

**buildings — ключевые поля:**
```
id, name_ru, name_en, name_hi
building_type_id, sort_order, color
is_temporary, available_from, available_until
```

---

### Ретриты и регистрации

| Таблица | Описание |
|---------|----------|
| `retreats` | Ретриты |
| `holidays` | Праздники |
| `retreat_registrations` | Регистрации на ретриты |
| `guest_visas` | Визовая информация |
| `guest_payments` | Платежи гостей |
| `guest_transfers` | Трансферы (заезды/выезды) |
| `guest_notes` | Заметки о гостях |
| `guest_accommodations` | Предпочтения проживания |

**retreat_registrations — статусы:**
- `'guest'` — гость
- `'team'` — команда
- `'cancelled'` — отменено

---

### Кухня (Kitchen)

| Таблица | Описание |
|---------|----------|
| `recipes` | Рецепты |
| `recipe_categories` | Категории рецептов |
| `recipe_ingredients` | Ингредиенты рецептов |
| `products` | Продукты |
| `product_categories` | Категории продуктов |
| `product_densities` | Плотности (для конвертации единиц) |
| `units` | Единицы измерения |
| `locations` | Кухни (main, cafe, guest) |

**products — ключевые поля:**
```
id, name_ru, name_en, name_hi
category_id, unit, default_unit
waste_percent     -- % отходов при очистке
min_purchase_qty
purchase_url
```

---

### Меню

| Таблица | Описание |
|---------|----------|
| `menu_days` | Дни меню |
| `menu_meals` | Приёмы пищи |
| `menu_dishes` | Блюда меню |
| `menu_items` | Позиции меню (legacy) |
| `menu_templates` | Шаблоны меню |
| `menu_template_meals` | Приёмы пищи в шаблонах |
| `menu_template_dishes` | Блюда в шаблонах |

---

### Склад (Stock)

| Таблица | Описание |
|---------|----------|
| `stock` | Остатки на складе |
| `stock_requests` | Заявки на закупку |
| `stock_request_items` | Позиции заявок |
| `stock_receipts` | Поступления |
| `stock_receipt_items` | Позиции поступлений |
| `stock_issuances` | Выдачи |
| `stock_issuance_items` | Позиции выдач |
| `stock_issues` | Списания |
| `stock_issue_items` | Позиции списаний |
| `stock_inventories` | Инвентаризации |
| `stock_inventory_items` | Позиции инвентаризаций |
| `stock_transactions` | История транзакций |
| `purchase_requests` | Заявки на закупку (legacy) |
| `purchase_request_items` | Позиции заявок (legacy) |
| `buyers` | Закупщики |
| `materials` | Материалы (не продукты) |
| `price_history` | История цен |

---

### CRM

| Таблица | Описание |
|---------|----------|
| `crm_deals` | Сделки (заявки) |
| `crm_deal_history` | История изменений сделок |
| `crm_deal_services` | Услуги в сделках |
| `crm_deal_tags` | Теги сделок |
| `crm_tasks` | Задачи менеджеров |
| `crm_communications` | Коммуникации |
| `crm_payments` | Платежи |
| `crm_services` | Услуги (проживание, питание) |
| `crm_tags` | Теги |
| `crm_message_templates` | Шаблоны сообщений |
| `crm_currencies` | Валюты и курсы |
| `crm_retreat_managers` | Менеджеры ретритов |
| `crm_manager_queue` | Очередь распределения |
| `crm_retreat_prices` | Цены для ретритов |
| `crm_accommodation_types` | Типы размещения |
| `crm_cancellation_reasons` | Причины отмены |
| `crm_deposit_expenses` | Расходы депозита |
| `crm_final_settlements` | Финальные расчёты |
| `crm_activity_log` | Лог активности |

**crm_deals — статусы воронки:**
```
lead → contacted → invoice_sent → prepaid → tickets →
room_booked → checked_in → fully_paid → completed
(+ upsell, cancelled)
```

---

### Авторизация (Auth)

| Таблица | Описание |
|---------|----------|
| `profiles` | Профили пользователей |
| `modules` | Модули системы |
| `roles` | Роли |
| `permissions` | Права |
| `role_permissions` | Связь ролей и прав |
| `user_roles` | Роли пользователей |
| `user_permissions` | Индивидуальные права |
| `superusers` | Суперпользователи (без RLS!) |
| `user_invitations` | Приглашения |

**profiles — ключевые поля:**
```
id, user_id, vaishnava_id
email, avatar_url
approval_status   -- 'pending', 'approved', 'rejected', 'blocked'
user_type         -- 'guest', 'staff'
```

---

### Переводы

| Таблица | Описание |
|---------|----------|
| `translations` | Переводы интерфейса (key → ru, en, hi) |

**Более 1168 записей** — требуется пагинация при загрузке.

---

## Связи между таблицами

### Главная сущность — vaishnava

```
vaishnavas ─┬── profiles (user_id ↔ vaishnava.user_id)
            ├── residents (vaishnava_id)
            ├── retreat_registrations (vaishnava_id)
            ├── guest_transfers (vaishnava_id)
            ├── guest_visas (vaishnava_id)
            ├── guest_payments (vaishnava_id)
            ├── guest_notes (vaishnava_id)
            ├── crm_deals (vaishnava_id)
            ├── vaishnava_stays (vaishnava_id)
            └── stock_issuances (receiver_id → vaishnava_id)
```

### Проживание

```
buildings ─── rooms ─── residents
                   └─── bookings
                   └─── room_cleanings
```

### CRM сделки

```
crm_deals ─┬── crm_deal_history
           ├── crm_deal_services
           ├── crm_deal_tags
           ├── crm_communications
           ├── crm_payments
           └── crm_tasks
```

---

## RLS политики

**Большинство таблиц:**
```sql
CREATE POLICY "all_access" ON table_name
FOR ALL USING (true);
```

**Справочники (публичное чтение):**
```sql
CREATE POLICY "public_read" ON reference_table
FOR SELECT TO public USING (true);
```

**Важно:** Таблица `superusers` имеет **RLS disabled** для избежания рекурсии.

---

## Типичные запросы

### Загрузка списка людей

```javascript
const { data } = await Layout.db
    .from('vaishnavas')
    .select(`
        id, spiritual_name, first_name, last_name,
        email, phone, country, city,
        is_team_member, department_id,
        departments(id, name_ru, name_en)
    `)
    .order('spiritual_name');
```

### Загрузка проживающих на дату

```javascript
const { data } = await Layout.db
    .from('residents')
    .select(`
        id, check_in, check_out,
        vaishnava:vaishnavas(id, spiritual_name, first_name, last_name),
        room:rooms(id, name, building_id),
        booking:bookings(id, status)
    `)
    .lte('check_in', date)
    .or(`check_out.is.null,check_out.gte.${date}`);
```

### Загрузка сделок с подробностями

```javascript
const { data } = await Layout.db
    .from('crm_deals')
    .select(`
        *,
        vaishnava:vaishnavas(id, spiritual_name, first_name, last_name, phone, email),
        retreat:retreats(id, name_ru, name_en, start_date, end_date),
        manager:vaishnavas!manager_id(id, spiritual_name, first_name),
        services:crm_deal_services(*, service:crm_services(*)),
        tags:crm_deal_tags(tag:crm_tags(*))
    `)
    .eq('retreat_id', retreatId)
    .order('created_at', { ascending: false });
```

---

## Миграции

Файлы в `supabase/` выполняются последовательно:

| Диапазон | Содержание |
|----------|------------|
| 001-010 | Основная схема, seed-данные, рецепты |
| 011-030 | Переводы, RLS, склад, команда |
| 031-050 | Инвентаризация, меню-шаблоны, справочники |
| 051-066 | Модуль Housing (здания, комнаты, уборка) |
| 067-078 | Система пользователей, роли, права |
| 079-097 | CRM модуль |

### Применение миграций

```javascript
// Через MCP
mcp__supabase__apply_migration({
    project_id: 'llttmftapmwebidgevmg',
    name: 'add_new_field',
    query: 'ALTER TABLE vaishnavas ADD COLUMN telegram varchar;'
});
```

---

## Realtime

Таблицы с подпиской на изменения:

```sql
-- Включить realtime для таблицы
ALTER PUBLICATION supabase_realtime ADD TABLE residents;
```

**Включены:**
- `residents`, `bookings` — шахматка
- `room_cleanings` — уборка
- `stock`, `purchase_requests` — склад
- `guest_transfers` — трансферы
- `retreat_registrations` — регистрации

---

## Storage Buckets

| Bucket | Описание |
|--------|----------|
| `vaishnava-photos` | Фотографии людей |
| `floor-plans` | Планы этажей (SVG) |

---

## Связанная документация

- [Архитектура](./architecture.md)
- [Авторизация](./auth.md)
