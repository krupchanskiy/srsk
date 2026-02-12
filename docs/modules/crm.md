# Модуль CRM

## Обзор

Модуль управления заявками на участие в ретритах: воронка продаж, сделки, задачи менеджеров.

- **Цвет модуля**: `#10b981` (изумрудный)
- **Layout.init**: `module: 'crm'`
- **Утилиты**: `CrmUtils` (js/crm-utils.js)

---

## Структура файлов

```
crm/
├── index.html            # Редирект на dashboard
├── dashboard.html        # Дашборд: воронка, статистика
├── deals.html            # Список всех заявок
├── deal.html             # Карточка сделки
├── tasks.html            # Мои задачи
├── activity-log.html     # Лог активности
├── form.html             # Публичная форма заявки
├── templates.html        # Шаблоны сообщений
├── tags.html             # Теги
├── services.html         # Услуги и цены
├── currencies.html       # Курсы валют
└── managers.html         # Менеджеры ретритов
```

---

## Воронка продаж

### Статусы (порядок важен!)

| Статус | Название | Цвет | Описание |
|--------|----------|------|----------|
| `lead` | Новая заявка | Красный | Входящая заявка |
| `contacted` | Связались | Оранжевый | Первый контакт |
| `invoice_sent` | Счёт отправлен | Жёлтый | Выставлен счёт |
| `prepaid` | Предоплата | Лайм | Получена предоплата |
| `tickets` | Билеты | Зелёный | Билеты куплены |
| `room_booked` | Комната | Бирюзовый | Комната забронирована |
| `checked_in` | Заселен | Циан | Гость заселился |
| `fully_paid` | Оплачено | Синий | Полная оплата |
| `completed` | Завершено | Фиолетовый | Ретрит завершён |
| `upsell` | Допродажа | Пурпурный | Повторная продажа |
| `cancelled` | Отменено | Серый | Отмена |

### Переходы между статусами

```javascript
// Следующий статус
CrmUtils.getNextStatus('contacted')  // → 'invoice_sent'

// Допустимые переходы
CrmUtils.getAllowedTransitions('contacted')
// → ['invoice_sent', 'prepaid', ..., 'cancelled', 'lead']
```

---

## Страницы

### dashboard.html — Дашборд

**Функционал:**
- Воронка продаж (визуализация)
- Статистика по статусам
- Конверсия между этапами
- Просроченные заявки (>24ч без контакта)
- Быстрые фильтры

**Таблицы БД:**
- `crm_deals`
- `retreats`

---

### deals.html — Список заявок

**Функционал:**
- Таблица всех сделок
- Фильтры: ретрит, статус, менеджер
- Поиск по имени/контакту
- Сортировка
- Массовые операции

**Таблицы БД:**
- `crm_deals`
- `vaishnavas`
- `retreats`

---

### deal.html — Карточка сделки

**URL параметры:** `?id={deal_id}`

**Функционал:**
- Информация о сделке
- Данные гостя
- История статусов
- Услуги и платежи
- Коммуникации (звонки, сообщения)
- Задачи по сделке
- Смена статуса
- Назначение менеджера

**Секции:**
1. Шапка (статус, менеджер)
2. Гость (контакты, профиль)
3. Услуги (что заказано)
4. Платежи (оплаты, баланс)
5. Коммуникации (история контактов)
6. Задачи
7. История изменений

**Таблицы БД:**
- `crm_deals`
- `crm_deal_history`
- `crm_deal_services`
- `crm_communications`
- `crm_payments`
- `crm_tasks`
- `vaishnavas`

---

### tasks.html — Мои задачи

**Функционал:**
- Список задач текущего менеджера
- Фильтры: все / сегодня / просроченные
- Отметка выполнения
- Переход к сделке

**Приоритеты:**
| Приоритет | Цвет |
|-----------|------|
| `low` | Серый |
| `normal` | Синий |
| `high` | Оранжевый |
| `urgent` | Красный |

**Таблицы БД:**
- `crm_tasks`
- `crm_deals`
- `vaishnavas`

---

### activity-log.html — Лог активности

**Функционал:**
- История всех действий
- Фильтр по типу действия
- Фильтр по менеджеру
- Фильтр по дате

**Таблицы БД:**
- `crm_activity_log`
- `crm_deals`
- `vaishnavas`

---

### form.html — Публичная форма

**Функционал:**
- Форма заявки на ретрит
- Выбор ретрита
- Контактные данные
- Предпочтения проживания
- Автосоздание сделки

**Особенности:**
- Публичная страница (без авторизации)
- Создаёт запись в `vaishnavas` если нет
- Создаёт `crm_deals` со статусом `lead`
- Автоназначение менеджера (round-robin)

---

### templates.html — Шаблоны сообщений

**Функционал:**
- Создание шаблонов
- Переменные: `{name}`, `{retreat}`, `{amount}`
- Копирование в буфер

**Таблицы БД:**
- `crm_message_templates`

---

### tags.html — Теги

**Функционал:**
- Создание тегов для сделок
- Цвет тега

**Таблицы БД:**
- `crm_tags`

---

### services.html — Услуги и цены

**Функционал:**
- Справочник услуг
- Базовая цена
- Цены для конкретных ретритов
- Категории: проживание, питание, транспорт

**Таблицы БД:**
- `crm_services`
- `crm_retreat_prices`

---

### currencies.html — Курсы валют

**Функционал:**
- Справочник валют
- Курс к INR
- Обновление курсов

**Таблицы БД:**
- `crm_currencies`

---

### managers.html — Менеджеры

**Функционал:**
- Назначение менеджеров на ретриты
- Очередь распределения (round-robin)
- Активность менеджера

**Таблицы БД:**
- `crm_retreat_managers`
- `crm_manager_queue`
- `vaishnavas`

---

## CrmUtils (js/crm-utils.js)

### Константы

```javascript
CrmUtils.STATUSES           // Массив статусов
CrmUtils.STATUS_COLORS      // Цвета статусов
CrmUtils.STATUS_SVG_ICONS   // SVG иконки статусов
CrmUtils.UI_ICONS           // Общие UI иконки
CrmUtils.COMM_SVG_ICONS     // Иконки коммуникаций

CrmUtils.WORK_MODES         // ['active', 'long_term', 'paused']
CrmUtils.SERVICE_CATEGORIES // ['accommodation', 'meals', 'transport', 'other']
CrmUtils.PAYMENT_TYPES      // ['org_fee', 'accommodation', 'meals', 'deposit', 'other']
CrmUtils.PAYMENT_METHODS    // ['cash', 'card', 'transfer']
CrmUtils.COMMUNICATION_TYPES // ['call', 'whatsapp', 'telegram', 'email', 'note']
CrmUtils.TASK_PRIORITIES    // ['low', 'normal', 'high', 'urgent']
```

### Форматирование

```javascript
CrmUtils.formatMoney(1500, 'INR')     // "₹ 1 500"
CrmUtils.formatDate('2026-02-04')     // "04.02.2026"
CrmUtils.formatDateTime(date)          // "04.02.2026 10:30"
CrmUtils.formatRelativeTime(date)      // "5 мин назад"
```

### Проверки

```javascript
CrmUtils.isOverdue(deal)       // Заявка без контакта >24ч
CrmUtils.isTaskOverdue(task)   // Задача просрочена
CrmUtils.isActive(deal)        // Не отменена и не завершена
```

### Гости

```javascript
CrmUtils.getGuestName(vaishnava)       // Полное имя
CrmUtils.getGuestShortName(vaishnava)  // Короткое имя
CrmUtils.getGuestContact(vaishnava)    // Телефон/telegram/email
CrmUtils.getProfileCompleteness(v)     // Процент заполненности
```

### Статусы

```javascript
CrmUtils.getStatusIndex('contacted')   // 1
CrmUtils.getNextStatus('contacted')    // 'invoice_sent'
CrmUtils.getStatusLabel('lead')        // "Новая заявка"
CrmUtils.getStatusBadge('lead', 'sm')  // HTML badge
```

### Финансы

```javascript
CrmUtils.getBalance(deal)              // Разница: оплачено - начислено
CrmUtils.getBalanceHtml(deal)          // HTML с цветом
CrmUtils.getServicePrice(serviceId, retreatId)  // Цена услуги
CrmUtils.convertToINR(amount, currency)         // Конвертация
```

### Менеджеры

```javascript
// Следующий менеджер по round-robin
const manager = await CrmUtils.getNextManager(retreatId);

// Обновить время назначения
await CrmUtils.updateManagerLastAssigned(managerId);
```

### Утилиты

```javascript
CrmUtils.fillTemplate(template, data)  // Заполнить шаблон
await CrmUtils.copyToClipboard(text)   // Копировать в буфер
```

---

## Таблицы БД

### crm_deals
```
id, retreat_id, vaishnava_id, manager_id
status, work_mode
total_charged, total_paid
first_contacted_at, created_at, updated_at
notes
```

### crm_communications
```
id, deal_id, type, direction
content, created_at, created_by
```

### crm_payments
```
id, deal_id, type, method
amount, currency, amount_inr
received_at, notes
```

### crm_tasks
```
id, deal_id, assigned_to
title, description
priority, due_date
completed_at
```

---

## Связанная документация

- [Архитектура](../architecture.md)
- [Утилиты](../utilities.md)
- [База данных](../database.md)
