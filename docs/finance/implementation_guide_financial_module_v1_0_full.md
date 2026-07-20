# Implementation Guide: финансовый модуль бэк-офиса ШРСК

**Версия:** 1.0  
**Дата:** 19 июля 2026  
**Статус:** готов к передаче разработчику  
**Нормативное ТЗ:** `tz_financial_module_v4_2_10.md`  
**Дополнительные вводные:** отзыв АК по v4.2.10; требования Адриана и Ванамали Гопала по семьям и группам  
**Целевая аудитория:** разработчик финансового модуля, разработчик Guest Portal, владелец схемы Supabase, тестировщик, технический руководитель

---

## Содержание

1. Назначение, приоритет источников и нормативные уточнения  
2. Целевая архитектура и границы ответственности  
3. Этапность внедрения  
4. Репозиторий, миграции и enum-типы  
5. DDL-контракт 16 финансовых таблиц  
6. Индексы, views и формулы  
7. Идемпотентность и конкурентные блокировки  
8. Авторизация, RLS и приватность  
9. Каталог RPC  
10. Семьи и группы в Guest Portal  
11. Вложения, аудит, Storage и PDF  
12. UI-потоки  
13. Закрытие ретрита и отчётность  
14. Cutover  
15. Тестирование, эксплуатация и Definition of Done  
16. Приложения: ошибки, backlog и решения для Адриана/Ванамали

---

## 0. Назначение документа и порядок приоритета

Этот документ переводит предметное ТЗ в исполнимый технический контракт. Он определяет:

- порядок реализации независимыми релизами;
- структуру БД и обязательные ограничения;
- серверные RPC и их транзакционные границы;
- формулы views и отчётов;
- RLS и серверную авторизацию;
- конкурентные блокировки и идемпотентность;
- UI-потоки бэк-офиса и Guest Portal;
- загрузку файлов, аудит, закрытия и PDF;
- cutover, эксплуатацию и приёмочные тесты.

При расхождении источников действует следующий приоритет:

1. Явные решения раздела **0.2** этого Implementation Guide.
2. ТЗ `v4.2.10`.
3. Отзыв АК и дополнительные бизнес-вводные.
4. Технические примеры этого документа.

Если реализация требует изменить финансовый инвариант, разработчик не принимает решение самостоятельно: оформляется change request с примером операции, ожидаемым денежным и аналитическим результатом и миграционным воздействием.

### 0.1. Что не входит в этот документ

- банковская интеграция;
- CRM event processor;
- налоговый и бухгалтерский учёт;
- CAPEX;
- бюджеты и платёжный календарь;
- автоматическая номенклатура услуг гестхауса;
- сложное управление семейными приглашениями и юридическими согласиями.

### 0.2. Нормативные уточнения к v4.2.10

Следующие решения считаются принятыми и должны быть реализованы независимо от возможной неоднозначности текста ТЗ.

#### A. Расходный opening

`opening.out` допустим только для документированного отрицательного стартового остатка:

- банковский овердрафт;
- отрицательный custodial-счёт, когда ответственное лицо на дату X потратило собственных средств больше, чем получило средств организации;
- иной подтверждённый отрицательный остаток по выписке или акту cutover.

Для наличного реального счёта с `reconciliation_mode = cash_count` отрицательный opening запрещён.

#### B. Сверка custodial-счетов

Custodial-счёт является полноценным денежным счётом и подлежит сверке:

- физические наличные у ответственного — `reconciliation_mode = cash_count`;
- счёт, подтверждаемый внешней выпиской, — `statement`;
- передача ответственности невозможна без актуального чекпоинта, совпадающего с текущим `MAX(ledger_seq)`.

Рекомендуемая периодичность задаётся операционным регламентом, а не схемой БД: ежедневно для активно используемой кассы, не реже еженедельно для активно используемого custodial-счёта и обязательно при передаче ответственности.

#### C. Канал «Онлайн ₽»

UI-метка «Онлайн ₽» записывается как:

```text
payment_channel = bank_transfer
currency = RUB
```

`card` используется только для фактической карточной операции, `paypal` — для PayPal. Валюта определяется счётом, а не названием канала.

#### D. Дата события и порядок ленты

- фильтры, группировки, отчёты периода и закрытия используют `occurred_on`;
- лента одного счёта сортируется по `ledger_seq`;
- общая лента нескольких счетов — по `operation.created_at DESC, ledger_seq DESC`;
- поздно внесённая операция маркируется как поздняя, но относится к фактическому периоду по `occurred_on`.

#### E. Аналитика refund

После проведения refund неизменяемы:

```text
refund_of_posting_id
participant_id
participant_balance_kind
object_id
refund_recipient_contact_id
category_id
cost_center_id
contractor_id
```

Ошибка исправляется полным reversal refund и новым refund.

#### F. Технические типы проводок

Для `transfer`, `opening`, `reconciliation_adjustment` аналитические поля должны быть `NULL`, если ниже явно не указано обратное. Технические проводки не входят в аналитику ретрита, участника или cost center.

#### G. Ошибка денежного opening

- пока нет обычных проводок и нет checkpoint — атомарный `replace_opening`;
- если уже есть хотя бы одна обычная проводка или checkpoint — только `perform_reconciliation` с корректировкой;
- активный opening на счёт всегда ровно один.

#### H. Attachment-идемпотентность

`fin_attachments` хранит `request_hash`; `storage_path` уникален. Повтор по тому же UUID/hash возвращает существующую запись, а повтор того же path с другим UUID отклоняется.

#### I. Семьи и группы

Семья и группа не являются финансовыми субъектами и не меняют проводки. Они расширяют только серверную область чтения Guest Portal:

- семья: каждый активный член видит финансовые данные всей семьи;
- лидер группы: видит сводку участников своей группы по конкретному ретриту;
- обычный участник группы: видит только себя;
- факт оплаты за другого не создаёт права просмотра.

Семейная и групповая видимость реализуются в MVP после личного Guest Portal, если CONTACTS предоставляет явный состав отношений. При отсутствии такого источника функция включается feature flag после минимального расширения CONTACTS без миграции `fin_`-таблиц.

---

# 1. Целевая архитектура

## 1.1. Компоненты

```text
Browser: Back-office
  Vanilla JS + DaisyUI + Tailwind
        |
        | Supabase JS / RPC / safe views
        v
Supabase Auth ----> RBAC / user-to-contact mapping
        |
        v
PostgreSQL
  fin_* tables
  SECURITY DEFINER RPC
  safe views / RLS
  audit trigger
        |
        +------> Supabase Storage (private files)
        |
        +------> Edge Function / app worker (PDF generation)

Browser: Guest Portal
        |
        | portal-safe RPC only
        v
PostgreSQL portal functions
  participant visibility
  individual balances
  family details
  group summary
```

## 1.2. Границы ответственности

### PostgreSQL

- единственный источник истины денежных фактов;
- проверка ролей и прав;
- вычисление курсов и `amount_base`;
- блокировки и контроль конкуренции;
- идемпотентность;
- формулы остатка и долга;
- фиксация snapshot закрытия;
- аудит.

### Клиент

- формы и предварительные UX-расчёты;
- UUID запросов и строк;
- локальное сохранение незавершённой формы;
- загрузка временных файлов;
- отображение серверных ошибок;
- не вычисляет окончательные денежные значения и не принимает решения о правах.

### Edge Function / worker

- генерация PDF только из сохранённого `totals_snapshot`;
- повтор генерации при сбое;
- очистка временных файлов;
- не меняет финансовые данные напрямую.

### CONTACTS / регистрационный контур

- canonical contact и alias;
- связь `auth.uid() → contact_id`;
- семьи, группы, членство и лидерство;
- регистрации участника на ретрит;
- тарифные справочники, если уже существуют.

## 1.3. Основные архитектурные правила

1. Прямой DML клиента в `fin_`-таблицы запрещён.
2. Денежные изменения выполняются только через RPC.
3. Суммы, счета, дата события, курс и base-сумма проведённой операции не меняются.
4. Аналитика меняется только в разрешённом окне и всегда с аудитом.
5. Остатки не хранятся.
6. Все критические команды идемпотентны.
7. Блокировки берутся в едином порядке.
8. Права проверяются сервером независимо от UI.
9. Семейная/групповая видимость не даёт доступ к raw financial tables.
10. Закрытие фиксирует snapshot, а PDF является его представлением.

---

# 2. Порядок реализации

Реализация разбивается на самостоятельные релизы. Каждый релиз должен проходить миграции, SQL-интеграционные тесты, RLS-тесты и smoke-test UI до начала следующего.

## Этап 0. Технический фундамент

**Результат:** пустой, но защищённый финансовый контур.

Сделать:

- структуру миграций;
- enum-типы;
- роли и helpers авторизации;
- базовые справочники;
- `fin_audit_log` и триггер;
- запрет прямого DML;
- utility-функции канонизации hash, actor/contact lookup;
- CI для применения миграций на чистой БД;
- тестовый Supabase project.

**Gate:** неавторизованный пользователь не может читать и писать `fin_`-таблицы; аудит insert/update работает и не аудитирует себя.

## Этап 1. Денежное ядро

Сделать:

- счета, доступ, операции, проводки;
- курсы, статьи, cost centers, contractors, accounting objects;
- `create_opening`, `replace_opening`, `create_transfer`, `create_expense`, `create_income`, `create_donation`;
- вычисляемые остатки;
- общий и счётный ДДС;
- основные back-office формы.

**Gate:** opening, перевод и расход проходят конкурентные тесты; остаток всегда воспроизводится из проводок.

## Этап 2. Сверка и ответственность

Сделать:

- `perform_reconciliation`;
- cash-count и statement режимы;
- история сверок;
- `transfer_account_responsibility`;
- алерты отрицательных реальных счетов;
- UI сверки.

**Gate:** stale-сверка отклоняется; adjustment и checkpoint атомарны; ответственность нельзя передать после новой проводки.

## Этап 3. Участники

Сделать:

- `fin_charges`;
- opening-позиции участников;
- платежи, групповые и мультивалютные;
- refund и reversal;
- `fin_participant_balance` и детализацию;
- админскую карточку участника;
- личный Guest Portal.

**Gate:** подробная и быстрая формулы совпадают; refund не превышает исходную проводку; пожертвование не гасит долг.

## Этап 4. Семьи и группы

Сделать:

- CONTACTS contract или минимальные таблицы отношений;
- `portal_visible_participants`;
- семейную детализацию;
- групповую сводку лидера;
- RLS/portal tests;
- feature flag.

**Gate:** лидер видит только участников своей группы выбранного ретрита; обычный член не видит группу; семейный доступ не возникает из факта оплаты.

## Этап 5. Согласование и вложения

Сделать:

- pending/approved/disputed;
- `set_approval` с optimistic locking;
- `update_posting_analytics`;
- временный upload-flow;
- attachment metadata и access rules;
- входящие операции администратора.

**Gate:** пользователь счёта не читает чужие строки и файлы составной операции; disputed не меняет деньги.

## Этап 6. Аналитика и закрытия

Сделать:

- ретритный и общий отчёт;
- cost-center analytics;
- `create_closure`, `reissue_closure`, `finalize_closure`;
- PDF worker;
- версии и `report_dirty_at`;
- export CSV/XLSX.

**Gate:** закрытие конкурирует с проводкой без потери; PDF failure не откатывает snapshot; post-close требует администратора.

## Этап 7. Cutover и запуск

Сделать:

- shadow-режим;
- reset-runbook;
- загрузчики opening;
- контрольный реестр Ванамали Гопала;
- три подряд успешных чекпоинта;
- rollback export.

**Gate:** баланс физической кассы + custodial-счетов равен привычному «всего под ответственностью» без двойного учёта.

---

# 3. Репозиторий и миграции

## 3.1. Рекомендуемая структура

```text
/supabase
  /migrations
    0001_fin_enums.sql
    0002_fin_tables_core.sql
    0003_fin_constraints.sql
    0004_fin_audit.sql
    0005_fin_views_core.sql
    0006_fin_rpc_core.sql
    0007_fin_reconciliation.sql
    0008_fin_participants.sql
    0009_fin_portal.sql
    0010_fin_attachments.sql
    0011_fin_closures.sql
    0012_fin_rls.sql
    0013_fin_seed.sql
  /tests
    fin_*.sql
  /functions
    generate-finance-report/
    cleanup-temp-finance-files/
/src
  /finance
    api.js
    permissions.js
    format.js
    pages/
    components/
  /guest-portal/finance/
/docs
  implementation_guide_financial_module_v1_0.md
  cutover_runbook.md
```

## 3.2. Правила миграций

- миграции только вперёд; rollback — отдельной компенсирующей миграцией;
- повторное применение на чистом project обязательно в CI;
- enum расширяется отдельной миграцией, не переписывается;
- destructive DDL после запуска требует backup и maintenance mode;
- все `SECURITY DEFINER` функции задают безопасный `search_path`;
- владельцем функций является отдельная техническая роль, не `anon`/`authenticated`;
- клиентским ролям выдаётся `EXECUTE` только на разрешённые RPC и `SELECT` только на safe views.

## 3.3. Схема имён

- таблицы: `fin_*`;
- внутренние helpers: `fin_private_*`, schema `private` или REVOKE ALL;
- публичные RPC: `fin_*` либо имена ТЗ без коллизий;
- safe views: `fin_v_*`;
- portal RPC/views: `portal_fin_*`;
- ошибки: стабильный `code`, человекочитаемый `message`, `details` JSON.

---

# 4. Enum-типы

Минимальный набор:

```text
fin_account_kind               real | custodial
fin_reconciliation_mode        cash_count | statement
fin_operation_type             payment | refund | transfer | expense | income |
                               donation | opening | reversal | reconciliation_adjustment
fin_direction                  in | out
fin_approval                   pending | approved | disputed | not_required
fin_payment_channel            cash | bank_transfer | card | paypal
fin_participant_balance_kind   none | org_fee | accommodation | meals | extra | general
fin_charge_kind                org_fee | accommodation | meals | extra
fin_attachment_parent_type     operation | accounting_object
fin_closure_status             report_pending | finalized | generation_error
fin_object_type                retreat
fin_contractor_type            person | organization
fin_opening_position_kind      debt | credit
```

Enum-значения являются API-контрактом. UI переводит их через словарь, но не хранит локальные альтернативные значения.

---

# 5. DDL-контракт

Ниже приведён исполнимый контракт. Конкретный SQL может отличаться синтаксисом, но не смыслом и ограничениями.

## 5.1. `fin_accounts`

```text
id                      uuid PK
name                    text NOT NULL
kind                    fin_account_kind NOT NULL
reconciliation_mode     fin_reconciliation_mode NOT NULL
currency_code           text FK fin_currencies(code) NOT NULL
group_name              text NULL
responsible_person_id   uuid FK contacts NULL
default_cost_center_id  uuid FK fin_cost_centers NULL
is_active               boolean NOT NULL default true
created_at              timestamptz NOT NULL default now()
created_by              uuid NOT NULL
```

Ограничения:

- `name` уникально среди активных счетов;
- валюта и `reconciliation_mode` не меняются после первой проводки/сверки;
- `default_cost_center_id` обязателен для custodial-департамента и nullable для общего реального счёта;
- деактивация возможна только при нулевом вычисляемом остатке;
- `cash_count` допускает наличные номиналы; `statement` — только сумму выписки.

## 5.2. `fin_operations`

```text
id                           uuid PK            -- client request/entity UUID
request_hash                 text NOT NULL
type                         fin_operation_type NOT NULL
occurred_on                  date NOT NULL
approval                     fin_approval NOT NULL
is_reversed                  boolean NOT NULL default false
original_operation_id        uuid FK fin_operations NULL
payer_contact_id             uuid FK contacts NULL
refund_recipient_contact_id  uuid FK contacts NULL
reason                       text NULL
comment                      text NULL
created_by                   uuid NOT NULL
created_at                   timestamptz NOT NULL default now()
```

`is_post_close` не хранить физически. В `fin_v_operations` вычислять:

```sql
bool_or(p.is_post_close)
```

Ограничения:

- `request_hash NOT NULL`;
- `type = reversal` ⇔ `original_operation_id IS NOT NULL`;
- не более одного активного reversal на исходную операцию;
- `reason` обязательно для reversal, reconciliation adjustment, post-close и disputed;
- payer используется только для payment/donation; refund получает его через источник;
- клиент не передаёт approval администратора, `created_by`, hash или post-close.

## 5.3. `fin_postings`

```text
id                          uuid PK
ledger_seq                  bigint generated by sequence NOT NULL UNIQUE
operation_id                uuid FK fin_operations NOT NULL
account_id                  uuid FK fin_accounts NOT NULL
direction                   fin_direction NOT NULL
amount                      numeric(14,2) NOT NULL CHECK amount > 0
currency_code               text NOT NULL
amount_base                 numeric(14,2) NOT NULL CHECK amount_base >= 0
rate_used                   numeric(12,6) NOT NULL CHECK rate_used > 0
category_id                 uuid FK fin_categories NULL
cost_center_id              uuid FK fin_cost_centers NULL
object_id                   uuid FK fin_accounting_objects NULL
is_post_close               boolean NOT NULL default false
participant_id              uuid FK contacts NULL
participant_balance_kind    fin_participant_balance_kind NULL
refund_of_posting_id        uuid FK fin_postings NULL
contractor_id               uuid FK fin_contractors NULL
payment_channel             fin_payment_channel NULL
```

Общие constraints:

```text
currency_code = account.currency_code
participant_id IS NULL ⇔ participant_balance_kind IS NULL
refund_of_posting_id IS NOT NULL только для refund
is_post_close = false при object_id IS NULL
```

Типовые constraints:

```text
payment:
  direction = in
  category_id NOT NULL
  participant_id/object_id обязательны для строк оплаты участника
  строка пожертвования может иметь balance_kind = none

refund:
  ровно одна posting
  direction = out
  refund_of_posting_id NOT NULL
  participant/object/balance kind/rate наследуются сервером
  вся аналитика refund immutable

transfer:
  ровно две postings: одна out, одна in
  разные account_id
  amount_base равны
  category_id, cost_center_id, object_id,
  participant_id, participant_balance_kind,
  contractor_id, payment_channel = NULL

opening:
  одна posting
  category_id, cost_center_id, object_id,
  participant_id, participant_balance_kind,
  contractor_id, payment_channel = NULL

reconciliation_adjustment:
  одна posting
  category_id, cost_center_id, object_id,
  participant_id, participant_balance_kind,
  contractor_id, payment_channel = NULL

expense:
  direction = out
  category_id NOT NULL
  participant_balance_kind = none, если participant_id указан

income/donation:
  direction = in
  category_id NOT NULL
  participant_balance_kind = none, если participant_id указан

reversal:
  полное зеркало всех postings источника
  наследует всю аналитику источника
```

## 5.4. `fin_charges`

```text
id                  uuid PK -- client UUID
request_hash        text NOT NULL
participant_id      uuid FK contacts NOT NULL
retreat_id          uuid FK retreats NOT NULL
kind                fin_charge_kind NOT NULL
description         text NOT NULL
quantity            numeric NOT NULL CHECK quantity > 0
unit_price          numeric(14,2) NOT NULL CHECK unit_price >= 0
amount              numeric(14,2) NOT NULL
discount_amount     numeric(14,2) NOT NULL default 0
currency_code       text NOT NULL CHECK currency_code = 'INR'
discount_reason     text NULL
is_cancelled        boolean NOT NULL default false
cancelled_reason    text NULL
cancelled_at        timestamptz NULL
cancelled_by        uuid NULL
creation_reason     text NULL
created_at          timestamptz NOT NULL default now()
created_by          uuid NOT NULL
```

Сервер вычисляет:

```text
amount = ROUND(quantity × unit_price, 2)
net_amount = amount − discount_amount
```

Ограничения:

- `0 ≤ discount_amount ≤ amount`;
- скидка > 0 ⇒ причина;
- cancelled ⇒ reason/at/by;
- финансовые поля и participant/retreat/kind immutable;
- исправление: cancel + новая строка;
- после closure создание/отмена только admin и ставит `report_dirty_at`.

## 5.5. Справочники

### `fin_categories`

```text
id uuid PK
code text UNIQUE NOT NULL
name text NOT NULL
direction in|out NOT NULL
visible_to_departments boolean NOT NULL default false
is_active boolean NOT NULL default true
```

### `fin_currencies`

```text
code text PK
symbol text NOT NULL
name text NOT NULL
minor_units int NOT NULL default 2 CHECK minor_units = 2
is_active boolean NOT NULL default true
```

### `fin_exchange_rates`

```text
id uuid PK
object_id uuid FK fin_accounting_objects NULL
effective_date date NOT NULL
from_currency text FK fin_currencies NOT NULL
rate numeric(12,6) NOT NULL CHECK rate > 0
created_by uuid NOT NULL
created_at timestamptz NOT NULL
UNIQUE NULLS NOT DISTINCT (object_id, effective_date, from_currency)
```

### `fin_contractors`

```text
id uuid PK
name text NOT NULL
type person|organization NOT NULL
contact_id uuid FK contacts NULL
contact_info text NULL
note text NULL
is_active boolean NOT NULL default true
```

### `fin_cost_centers`

```text
id uuid PK
code text UNIQUE NOT NULL
name text NOT NULL
is_active boolean NOT NULL default true
created_at timestamptz NOT NULL
```

## 5.6. `fin_reconciliations`

```text
id                       uuid PK -- request UUID
request_hash             text NOT NULL
account_id               uuid FK fin_accounts NOT NULL
performed_at             timestamptz NOT NULL
performed_by             uuid NOT NULL
system_balance           numeric(14,2) NOT NULL
counted_balance          numeric(14,2) NOT NULL
original_difference      numeric(14,2) NULL
difference               numeric(14,2) NOT NULL
cutoff_ledger_seq        bigint NOT NULL
adjustment_operation_id  uuid FK fin_operations NULL
counts                   jsonb NULL
comment                  text NULL
is_checkpoint            boolean NOT NULL
```

Constraints:

- cash_count ⇒ counts present;
- statement ⇒ counts NULL;
- `difference = counted_balance - system_balance` после adjustment должен быть 0;
- adjustment link nullable только при исходном difference = 0;
- `id`/hash идемпотентны.

## 5.7. `fin_audit_log`

```text
id              bigint PK
entity          text NOT NULL
entity_id       uuid NOT NULL
action          insert|update|delete NOT NULL
before_data     jsonb NULL
after_data      jsonb NULL
user_id         uuid NULL
reason          text NULL
request_id      uuid NULL
correlation_id  uuid NULL
at              timestamptz NOT NULL default now()
```

- append-only;
- trigger на все `fin_` таблицы, кроме самой;
- state RPC устанавливают transaction-local context;
- observer читает маскирующий view.

## 5.8. `fin_account_access`

```text
user_id    uuid NOT NULL
account_id uuid FK fin_accounts NOT NULL
PRIMARY KEY (user_id, account_id)
```

В MVP доступ означает разрешённые account-user операции согласно общей роли. Расширение до capabilities возможно миграцией, но не требуется для первой версии.

## 5.9. `fin_attachments`

```text
id            uuid PK -- client UUID
request_hash  text NOT NULL
parent_type   operation|accounting_object NOT NULL
parent_id     uuid NOT NULL
posting_id    uuid FK fin_postings NULL
storage_path  text NOT NULL UNIQUE
sha256        text NOT NULL
mime_type     text NOT NULL
size_bytes    bigint NOT NULL CHECK size_bytes > 0
file_name     text NOT NULL
uploaded_by   uuid NOT NULL
uploaded_at   timestamptz NOT NULL default now()
```

Constraint trigger:

```text
posting_id NOT NULL ⇒ parent_type=operation
posting.operation_id = parent_id
parent_type=accounting_object ⇒ posting_id IS NULL
parent существует
```

## 5.10. `fin_accounting_objects`

```text
id               uuid PK
type             fin_object_type NOT NULL
retreat_id       uuid FK retreats NULL UNIQUE
display_name     text NOT NULL
report_dirty_at  timestamptz NULL
created_at       timestamptz NOT NULL
```

MVP constraint: type=retreat и retreat_id NOT NULL.

## 5.11. `fin_participant_opening_balances`

```text
id                           uuid PK
participant_id               uuid FK contacts NOT NULL
retreat_id                   uuid FK retreats NOT NULL
amount                       numeric(14,2) NOT NULL CHECK amount > 0
currency_code                text NOT NULL CHECK currency_code='INR'
kind                         debt|credit NOT NULL
balance_kind                 org_fee|accommodation|meals|extra|general NOT NULL
source_document              text NOT NULL
corrects_opening_balance_id  uuid FK self NULL
request_hash                 text NULL
correction_reason            text NULL
cutover_batch_id             uuid NULL
source_row_id                text NULL
source_payload_hash          text NULL
comment                      text NULL
created_at                   timestamptz NOT NULL
created_by                   uuid NOT NULL
UNIQUE(cutover_batch_id, source_document, source_row_id)
```

Правила:

- cutover row: request_hash/correction fields NULL;
- correction: id=request UUID, request_hash/reason/source link NOT NULL;
- повтор source key + тот же payload hash → существующая строка;
- тот же source key + другой payload → `cutover_row_conflict`;
- коррекция в рамках того же participant/retreat;
- исходная строка immutable.

## 5.12. `fin_object_closures`

```text
id                       uuid PK -- client request UUID
request_hash             text NOT NULL
object_id                uuid FK fin_accounting_objects NOT NULL
version                  int NOT NULL CHECK version > 0
is_initial               boolean NOT NULL
status                   report_pending|finalized|generation_error NOT NULL
closed_at                timestamptz NOT NULL
closed_by                uuid NOT NULL
finalized_at             timestamptz NULL
finalized_by             uuid NULL
totals_snapshot          jsonb NOT NULL
snapshot_schema_version  int NOT NULL
attachment_id            uuid FK fin_attachments NULL
reason                   text NULL
UNIQUE(object_id, version)
```

Constraints:

- один initial closure на объект;
- `is_initial ⇔ version=1`;
- finalized ⇒ PDF attachment;
- version > 1 ⇒ reason;
- attachment принадлежит объекту, MIME PDF и не используется другой closure.

---
# 6. Индексы и ограничения производительности

Минимальный набор индексов:

```sql
CREATE INDEX ON fin_postings(account_id, ledger_seq);
CREATE INDEX ON fin_postings(operation_id);
CREATE INDEX ON fin_postings(object_id, ledger_seq) WHERE object_id IS NOT NULL;
CREATE INDEX ON fin_postings(participant_id, object_id) WHERE participant_id IS NOT NULL;
CREATE INDEX ON fin_postings(refund_of_posting_id) WHERE refund_of_posting_id IS NOT NULL;
CREATE INDEX ON fin_operations(created_at DESC);
CREATE INDEX ON fin_operations(approval) WHERE approval IN ('pending','disputed');
CREATE INDEX ON fin_charges(participant_id, retreat_id) WHERE is_cancelled = false;
CREATE INDEX ON fin_participant_opening_balances(participant_id, retreat_id);
CREATE INDEX ON fin_reconciliations(account_id, cutoff_ledger_seq DESC);
CREATE INDEX ON fin_audit_log(entity, entity_id, at DESC);
CREATE INDEX ON fin_object_closures(object_id, version DESC);
CREATE INDEX ON fin_attachments(parent_type, parent_id);
```

Дополнительные partial unique indexes:

```text
одно полное reversal на original_operation_id;
один initial closure на object_id;
один активный opening на account_id;
```

Активный opening определяется как opening-операция, не имеющая активного reversal. Если это сложно выразить индексом, уникальность проверяется под account lock в RPC и регулярно проверяется integrity-тестом.

---

# 7. Базовые функции и views

## 7.1. Знаковая сумма проводки

```sql
CASE direction
  WHEN 'in'  THEN amount
  WHEN 'out' THEN -amount
END
```

Для base аналогично используется `amount_base`.

## 7.2. `fin_v_account_balances`

Возвращает по каждому счёту:

```text
account_id
currency_code
balance
last_ledger_seq
last_checkpoint_seq
last_checkpoint_at
is_negative
unreconciled_count
```

Формула:

```text
balance = Σ signed amount всех postings счёта
```

Никакие approval/reversal flags строки из расчёта не исключают. Reversal уже создаёт зеркальные проводки.

## 7.3. `fin_get_account_balance(account_id, cutoff_seq nullable)`

- без cutoff — текущий баланс;
- с cutoff — только `ledger_seq ≤ cutoff`;
- используется сверкой и тестами;
- `STABLE`, без динамического SQL.

## 7.4. `fin_v_operations`

Сводная лента:

```text
operation metadata
has_post_close_postings = bool_or(posting.is_post_close)
amounts_by_currency jsonb
accounts count
is_late = created_at::date > occurred_on
has_attachments
```

Не использовать этот view для account-user без маскирования.

## 7.5. `fin_v_account_ledger`

Одна строка на проводку:

```text
ledger_seq
operation_id
occurred_on
created_at
type
approval
account
signed_amount
currency
category
cost_center
object
participant
contractor
running_balance
is_post_close
is_late
```

`running_balance` вычисляется window function по `(account_id ORDER BY ledger_seq)`.

## 7.6. `fin_v_participant_finance_base`

Внутренний view, не доступный participant-role напрямую. Собирает исходные факты по ключу:

```text
(participant_id, retreat_id)
```

Источники:

- активные charges;
- opening debt/credit;
- payment/refund/reversal postings с balance kind;
- contact alias resolution только для отображения и поиска, не переписывания FK.

## 7.7. `fin_get_participant_balance(participant_id, retreat_id)`

Возвращает:

```text
org_fee:        charged, paid, balance
accommodation: charged, paid, balance
meals:          charged, paid, balance
extra:          charged, paid, balance
general_debt
general_credit
total_debt
total_advance
net_balance
```

### Алгоритм

Для каждого блока `k`:

```text
block_debt[k] =
    active_charges.net_amount[k]
  + opening_debt[k]
  - opening_credit[k]
  - signed_postings[k]
```

Общий блок:

```text
general_debt = opening(kind=debt, general)

general_credit =
    opening(kind=credit, general)
  + signed_postings(general)
```

`general_credit` применяется по порядку:

```text
org_fee → accommodation → meals → extra → general_debt
```

Остаток положительного кредита — `total_advance`. Остаток положительных долгов — `total_debt`.

### Быстрая контрольная формула

```text
net_debt =
    Σ active charges
  + Σ opening debt
  - Σ opening credit
  - Σ signed balance-affecting postings
```

Подробная и быстрая формулы обязаны совпадать до копейки. Это отдельный SQL integrity test.

## 7.8. `fin_v_participant_payment_details`

Portal-safe поля по конкретному участнику/ретриту:

```text
posting_id
occurred_on
operation_type
amount
currency
amount_base
payment_channel
balance_kind
status: active | refunded_partially | refunded_fully | reversed
```

Не возвращает:

- account_id и внутреннее название счёта;
- created_by;
- внутренний комментарий;
- audit;
- чеки;
- сведения о других участниках той же операции.

## 7.9. `fin_v_cost_center_analytics`

```text
Σ signed amount_base
WHERE cost_center_id = X
  AND operation.type NOT IN ('transfer','opening','reconciliation_adjustment')
```

`reconciliation_adjustment` исключается: это техническая корректировка счёта, а не деятельность подразделения.

## 7.10. `fin_v_object_analytics`

По `object_id`:

```text
income_by_category
expense_by_category
net_balance
participant_debts
participant_advances
pending_count
disputed_count
post_close_delta
```

Не включает transfer/opening/reconciliation adjustment. Прасад-пожертвование показывается как приход и отдельный показатель чистого расхода прасада.

## 7.11. `fin_build_closure_snapshot(object_id)`

Возвращает канонический JSON с фиксированной сортировкой:

```json
{
  "schema_version": 1,
  "object": {"id": "...", "name": "..."},
  "generated_at": "...",
  "income": [{"category_code": "...", "amount_base": "..."}],
  "expenses": [{"category_code": "...", "amount_base": "..."}],
  "net": "...",
  "participants": {
    "count": 0,
    "debt_total": "...",
    "advance_total": "..."
  },
  "pending": 0,
  "disputed": 0,
  "post_close": false,
  "unit_cost": null
}
```

Snapshot должен строиться одним SQL-контрактом, который используется и в UI, и в PDF. Клиент не собирает snapshot самостоятельно.

---

# 8. Идемпотентность

## 8.1. Command-idempotency

Применяется к создающим RPC:

```text
create_payment
create_refund
create_reversal
create_transfer
create_expense
create_income
create_donation
create_opening
replace_opening
create_charge
perform_reconciliation
create_closure
reissue_closure
create_opening_correction
create_attachment
```

Алгоритм:

1. Клиент передаёт `request_id` и payload.
2. Сервер валидирует структуру и канонизирует payload.
3. Сервер вычисляет SHA-256 или `digest(canonical_json, 'sha256')`.
4. Сервер ищет строку по `request_id`.
5. Совпавший hash — возвращает существующий результат **до** проверки изменившихся предусловий.
6. Другой hash — `idempotency_conflict`.
7. Строки нет — блокировки и бизнес-проверки.

## 8.2. Канонизация

- JSON keys сортируются;
- UUID приводятся к lowercase canonical text;
- пустая строка нормализуется в `NULL`, если поле nullable;
- денежные числа нормализуются до decimal string с 2 знаками;
- массивы, где порядок бизнес-значим, не сортируются;
- массивы независимых строк сортируются по client row UUID;
- неизвестные поля отклоняются;
- серверные поля (`rate_used`, `amount_base`, actor, status) в hash клиентского payload не входят как входные значения; входит результат серверного выбора там, где это нужно для стабильного повтора.

## 8.3. State-idempotency

Для команд изменения состояния:

```text
cancel_charge
set_approval
update_posting_analytics
finalize_closure
transfer_account_responsibility
```

Повтор целевого состояния возвращает success/no-op, если reason и ключевые параметры совпадают. Для защиты от потерянного обновления:

```text
set_approval: expected_approval
update_posting_analytics: expected_audit_version или expected_analytics_hash
transfer_account_responsibility: expected_seq
```

## 8.4. Пакетный cutover

Ключ строки:

```text
(cutover_batch_id, source_document, source_row_id)
```

Дополнительно `source_payload_hash`:

- тот же key + тот же payload — существующая строка;
- тот же key + другие данные — `cutover_row_conflict`;
- после запуска исходная строка не меняется, только opening correction.

---

# 9. Конкуренция и блокировки

## 9.1. Единый порядок

Каждая RPC берёт блокировки только в порядке:

1. accounting objects по UUID;
2. исходные operations/postings по UUID;
3. accounts по UUID;
4. проверки и allocation `ledger_seq`;
5. запись.

Нарушение порядка запрещено code review checklist.

## 9.2. Протокол read-lock-recheck

Когда объект определяется из существующей проводки:

```text
1. Предварительно прочитать object_id.
2. Заблокировать объект(ы).
3. Заблокировать исходную operation/posting.
4. Перечитать object_id.
5. Изменился — rollback и retry.
6. Заблокировать accounts.
```

Используется для refund, reversal и переноса object_id.

## 9.3. Блокировка счёта

Любая денежная RPC:

```sql
SELECT id
FROM fin_accounts
WHERE id = ANY(p_account_ids)
ORDER BY id
FOR UPDATE;
```

После lock:

- проверить активность;
- вычислить текущий баланс;
- проверить минус;
- выделить `ledger_seq`;
- вставить postings.

## 9.4. Refund lock

`create_refund` блокирует исходную posting. Под lock вычисляет:

```text
net_refunded = Σ всех refund − Σ reversal(refund)
available = original.amount − net_refunded
```

Это предотвращает два параллельных возврата сверх лимита.

## 9.5. Object lock

Обязателен для любого изменения snapshot-содержимого:

- новая posting с object;
- аналитическая правка posting;
- approval disputed до closure;
- charge create/cancel;
- opening correction;
- closure/reissue.

При переносе A→B блокируются оба объекта.

## 9.6. Сверка

`perform_reconciliation` блокирует account и сравнивает:

```text
MAX(ledger_seq) = opened_seq
```

Если нет — `reconciliation_stale`.

## 9.7. Передача ответственности

Под account lock:

```text
latest_checkpoint.cutoff_seq = expected_seq
AND current MAX(ledger_seq) = expected_seq
```

Иначе `account_changed_since_reconciliation`.

---

# 10. Авторизация и RLS

## 10.1. Роли приложения

```text
finance_admin
finance_observer
finance_account_user
participant
```

RBAC хранится в существующем контуре. Все RPC дополнительно проверяют права, не полагаясь только на RLS.

## 10.2. Матрица

| Действие | Admin | Observer | Account user | Participant |
|---|---:|---:|---:|---:|
| Все счета и остатки | ✓ | ✓ | Только назначенные | — |
| Создание обычной операции | ✓ | — | В рамках своих счетов | — |
| Post-close операция | ✓ | — | — | — |
| Сторно | ✓ | — | — | — |
| Сверка | ✓ | — | — | — |
| Начисления | ✓ | — | — | — |
| Согласование | ✓ | — | — | — |
| Закрытие | ✓ | — | — | — |
| Audit | полный | маскированный | — | — |
| Личные финансы | при необходимости | — | — | ✓ |
| Семья | — | — | — | По relations |
| Группа | — | — | — | Только leader summary |

## 10.3. Запись

- RLS запрещает INSERT/UPDATE/DELETE всем клиентским ролям;
- `GRANT EXECUTE` выдаётся на конкретные RPC;
- RPC использует `auth.uid()` и серверный actor lookup;
- client payload не содержит `created_by`, `approval`, `is_post_close`, `ledger_seq`, `amount_base`, `rate_used`.

## 10.4. Чтение администратора/наблюдателя

Admin читает full views. Observer — те же отчёты, но:

- audit reason может быть виден согласно бизнес-решению;
- персональные телефоны, адреса, Storage paths и служебные права маскируются;
- signed URL файлов выдаётся отдельной функцией после проверки роли.

## 10.5. Чтение account user

`fin_v_my_postings` возвращает только postings доступных счетов. Не возвращает чужие строки той же operation.

Operation-level поля выдаются в урезанном виде:

```text
type, date, approval, own comment/status
```

Не выдаются:

- payer чужого платежа;
- другие participants;
- чужие account amounts;
- attachments чужой posting.

## 10.6. Participant

Participant не получает `SELECT` на `fin_` views. Только portal RPC, который сам определяет contact и разрешённый набор участников.

---
# 11. Каталог RPC

Все примеры payload условны; фактические имена параметров должны быть единообразны. Каждая RPC возвращает:

```json
{
  "ok": true,
  "result": {},
  "warnings": []
}
```

Ошибка:

```json
{
  "ok": false,
  "error": {
    "code": "stable_machine_code",
    "message": "Понятное сообщение",
    "details": {}
  }
}
```

## 11.1. `create_account`

**Роль:** admin.

Payload:

```json
{
  "name": "Кафе/₹",
  "kind": "custodial",
  "reconciliation_mode": "cash_count",
  "currency_code": "INR",
  "group_name": "Кафе",
  "responsible_person_id": "...",
  "default_cost_center_id": "..."
}
```

Проверки:

- уникальное имя;
- активная валюта;
- для cash-count доступны номиналы;
- responsible contact существует;
- mode после первой сверки не меняется.

## 11.2. `create_opening`

**Роль:** admin. **Command-idempotent.**

Payload:

```json
{
  "request_id": "uuid",
  "account_id": "uuid",
  "direction": "in",
  "amount": "347000.00",
  "occurred_on": "2026-08-01",
  "comment": "Cutover batch 2026-08"
}
```

Проверки под account lock:

- нет активного opening;
- нет обычных postings;
- нет checkpoint;
- `out` разрешён только документированному отрицательному стартовому остатку;
- `out` запрещён для cash-count real account;
- все аналитические поля NULL.

Результат: operation + posting.

Ошибки:

```text
opening_already_exists
account_has_activity
negative_cash_opening_forbidden
idempotency_conflict
```

## 11.3. `replace_opening`

**Роль:** admin. **Command-idempotent.**

Назначение: исправить opening до начала обычной деятельности.

Payload:

```json
{
  "request_id": "uuid",
  "original_opening_operation_id": "uuid",
  "new_direction": "in",
  "new_amount": "337000.00",
  "reason": "Ошибка в cutover-реестре"
}
```

В одной транзакции:

1. account lock;
2. исходный opening активен;
3. checkpoint отсутствует;
4. нет ordinary postings, кроме полностью сторнированных исторических opening-пар;
5. полный reversal;
6. новый opening;
7. активный opening ровно один.

Если ordinary posting уже есть — `opening_replacement_not_allowed`; использовать reconciliation.

## 11.4. `create_transfer`

**Роли:** admin; account user для разрешённого source и допустимого target custodial. **Command-idempotent.**

Payload:

```json
{
  "request_id": "uuid",
  "occurred_on": "2026-08-05",
  "source_account_id": "...",
  "target_account_id": "...",
  "source_amount": "83500.00",
  "target_amount": "1000.00",
  "comment": "Обмен INR→USD"
}
```

Проверки:

- разные счета;
- account locks в порядке UUID;
- source balance;
- same currency ⇒ суммы равны;
- different currency ⇒ server derives base equality;
- аналитика NULL;
- если это операция account user — approval pending; admin — not_required.

FX:

```text
source_base = ROUND(source_amount × source_rate, 2)
target_base = source_base
target_rate = target_base / target_amount
```

## 11.5. `create_expense`

Payload строки:

```json
{
  "id": "posting-uuid",
  "account_id": "...",
  "amount": "50000.00",
  "category_id": "...",
  "cost_center_id": "...",
  "object_id": "...",
  "participant_id": null,
  "contractor_id": "...",
  "payment_channel": "cash"
}
```

Операция может содержать несколько строк для разбивки суммы.

Проверки:

- account user использует только свои source accounts;
- cost center сервером заполняется явно: выбранное или account default;
- category active и direction out;
- participant balance kind только `none`;
- object lock до closure-check;
- post-close — только admin и reason;
- real account ordinary expense не уходит в минус;
- amount_base по курсу на `occurred_on`.

## 11.6. `create_income`

Зеркален expense, direction in. Используется для возврата от контрагента, маржи, личного возмещения спорной траты.

Обычный income никогда не гасит долг участника: при participant_id допустим только `none`.

## 11.7. `create_donation`

Payload поддерживает:

- именованного жертвователя через `payer_contact_id`;
- participant_id только для отображения связи, balance kind `none`;
- object optional;
- бокс — comment с источником выемки.

Donation не даёт payer права видеть участника и не входит в participant debt.

## 11.8. `create_payment`

**Роль:** admin. **Command-idempotent.**

Пример:

```json
{
  "request_id": "uuid",
  "occurred_on": "2026-08-05",
  "payer_contact_id": "payer",
  "comment": "Семейный платёж",
  "rows": [
    {
      "id": "uuid-1",
      "account_id": "paypal-usd",
      "amount": "200.00",
      "participant_id": "child-a",
      "object_id": "retreat-object",
      "participant_balance_kind": "general",
      "payment_channel": "paypal"
    },
    {
      "id": "uuid-2",
      "account_id": "paypal-usd",
      "amount": "150.00",
      "participant_id": "child-b",
      "object_id": "retreat-object",
      "participant_balance_kind": "general",
      "payment_channel": "paypal"
    }
  ]
}
```

Проверки:

- каждая строка participant/object;
- все строки group payment могут использовать один account/currency; мультивалютная форма допускается, но групповой платёж в двух валютах рекомендуется двумя операциями;
- category «Оплата участника» задаётся сервером или whitelist;
- server selects rate;
- general не требует существования charge;
- donation row использует balance kind none и donation category; предпочтительнее отдельная donation operation, но совместная форма допускается только если это закреплено UI и матрицей.

Комиссия PayPal создаётся отдельным `create_expense`, не строкой payment.

## 11.9. `create_refund`

**Роль:** admin. **Command-idempotent.**

Payload:

```json
{
  "request_id": "uuid",
  "refund_of_posting_id": "uuid",
  "source_account_id": "uuid",
  "amount": "40.00",
  "occurred_on": "2026-08-10",
  "refund_recipient_contact_id": null,
  "reason": "Частичный возврат"
}
```

Алгоритм:

1. idempotency;
2. read-lock-recheck objects;
3. lock source payment posting;
4. validate original payment active;
5. calculate net_refunded and base;
6. amount ≤ available;
7. lock refund account;
8. currency same as original;
9. derive base proportionally; last refund gets exact remainder;
10. inherit participant/object/balance kind/rate;
11. create one refund operation + one posting.

Refund analytics immutable.

Other account allowed only same currency, admin and reason. Other recipient requires reason and recommended attachment.

## 11.10. `create_reversal`

**Роль:** admin. **Command-idempotent.**

Payload:

```json
{
  "request_id": "uuid",
  "original_operation_id": "uuid",
  "occurred_on_policy": "same_as_original|actual_reverse_date",
  "occurred_on": "2026-08-11",
  "reason": "Ошибка ввода"
}
```

Проверки:

- source not reversal;
- no active reversal already;
- payment with net refund > 0 cannot be reversed;
- lock source operation/postings and accounts;
- full mirror only;
- reversal inherits all analytics;
- source and reversal analytics freeze forever;
- source `is_reversed=true` in same transaction.

Negative real balance allowed with warning.

## 11.11. `create_charge`

**Роль:** admin. **Command-idempotent.**

Payload:

```json
{
  "id": "uuid",
  "participant_id": "uuid",
  "retreat_id": "uuid",
  "kind": "accommodation",
  "description": "2-местный номер, 10 ночей",
  "quantity": "10",
  "unit_price": "1500.00",
  "discount_amount": "0.00",
  "discount_reason": null,
  "creation_reason": null
}
```

Server computes amount. Object lock. After closure only admin with creation reason; report dirty.

Batch create: array of rows with stable row UUIDs in one transaction.

## 11.12. `cancel_charge`

**State-idempotent.**

Payload:

```json
{
  "charge_id": "uuid",
  "reason": "Фактически проживал 8 ночей",
  "expected_is_cancelled": false,
  "audit_request_id": "uuid"
}
```

Object lock. If already cancelled with same reason — no-op; other reason — conflict. After closure — admin only and dirty.

## 11.13. `set_approval`

**Роль:** admin. **State-idempotent with optimistic locking.**

```json
{
  "operation_id": "uuid",
  "expected_approval": "pending",
  "target_approval": "approved",
  "reason": null,
  "audit_request_id": "uuid"
}
```

- object lock when object operation;
- expected must match;
- disputed requires reason;
- after initial closure pre-close operation approval cannot change;
- post-close operations created not_required.

## 11.14. `update_posting_analytics`

```json
{
  "posting_id": "uuid",
  "expected_analytics_hash": "...",
  "target": {
    "category_id": "...",
    "cost_center_id": "...",
    "object_id": "...",
    "participant_id": null,
    "participant_balance_kind": null,
    "contractor_id": "..."
  },
  "reason": "Уточнение статьи",
  "audit_request_id": "uuid"
}
```

Проверки:

- refund posting полностью immutable;
- active reversal ⇒ source/reversal analytics immutable;
- source payment with active refund ⇒ participant/object/payer locked;
- pre-close posting after closure immutable;
- post-close posting editable admin-only, report dirty;
- object transfer locks old/new, recalculates is_post_close;
- expected hash prevents lost update.

## 11.15. `perform_reconciliation`

```json
{
  "request_id": "uuid",
  "account_id": "uuid",
  "opened_seq": 1842,
  "statement_balance": "100000.00",
  "counts": null,
  "adjustment_reason": null,
  "comment": "Выписка на 15.07"
}
```

Cash version sends counts and no statement balance.

Алгоритм:

1. idempotency first;
2. account lock;
3. current max seq = opened seq;
4. validate mode-specific payload;
5. server counted balance;
6. calculate original difference;
7. if nonzero require reason and create internal adjustment;
8. include adjustment seq;
9. system balance becomes counted balance;
10. insert reconciliation.

`create_reconciliation_adjustment` is private.

## 11.16. `transfer_account_responsibility`

```json
{
  "account_id": "uuid",
  "expected_seq": 1842,
  "new_responsible_person_id": "uuid",
  "reason": "Передача на период отпуска",
  "audit_request_id": "uuid"
}
```

State-idempotent. Checks last checkpoint and current max seq both equal expected. Records old/new responsible, expected seq and reason in audit. No financial operation created.

## 11.17. `load_opening_balances`

Admin/cutover only. Batch payload with batch id, document, rows and source hashes.

Runs only in maintenance/cutover mode. Same source key with changed payload fails whole batch; no partial inserts.

## 11.18. `create_opening_correction`

Command-idempotent. Creates immutable compensating row; same participant/retreat as source; object lock; if closed report dirty.

## 11.19. `create_attachment`

```json
{
  "request_id": "uuid",
  "temp_storage_path": "finance-temp/user/file",
  "parent_type": "operation",
  "parent_id": "uuid",
  "posting_id": "uuid",
  "file_name": "receipt.jpg"
}
```

Server/worker verifies object metadata, sha256, MIME, size, ownership and token lifetime. Moves or marks file bound and inserts metadata.

## 11.20. `create_closure`

Command-idempotent. Object lock, no pending/disputed, snapshot, version 1, status pending. Object considered closed immediately.

## 11.21. `reissue_closure`

Command-idempotent. Object lock, initial exists, `report_dirty_at NOT NULL`, version+1, reason, snapshot, clear dirty. Concurrent second request with different UUID receives `report_not_dirty` after first commit.

## 11.22. `finalize_closure`

State-idempotent. Verifies attachment is PDF for same object and unused. Links and finalizes. Same attachment no-op, other attachment conflict.

---

# 12. Семьи и группы в Guest Portal

## 12.1. Решение

Финансовые данные остаются индивидуальными. Семья и группа определяют только read scope.

```text
balance key = participant_id + retreat_id
```

Не создаются:

- family financial account;
- group balance ledger;
- автоматический доступ плательщика к получателям платежа.

## 12.2. CONTACTS contract

Предпочтительно использовать существующие сущности. Если их нет, добавить вне `fin_`:

```text
contact_collections
  id
  type: family | retreat_group
  retreat_id nullable
  name
  is_active
  created_at/by

contact_collection_members
  collection_id
  contact_id
  role: member | leader | guardian
  finance_visibility: self | all_members
  valid_from
  valid_to
  is_active
```

Constraints:

```text
family.retreat_id IS NULL
retreat_group.retreat_id IS NOT NULL
one active leader per retreat_group
```

Нормативное поведение MVP:

- активный член семьи имеет `all_members`;
- обычный member группы имеет `self`;
- leader группы имеет group-summary permission;
- membership changes audited in CONTACTS.

## 12.3. `portal_fin_visible_participants(retreat_id)`

Функция сама получает viewer contact через `auth.uid()`.

Возвращает:

```text
participant_id
scope: self | family_detail | group_summary
source_collection_id
```

Алгоритм:

1. canonical viewer;
2. self;
3. active family members registered/financially present on retreat;
4. if viewer leader of retreat group — active group members;
5. merge duplicates, precedence `family_detail > group_summary > self`;
6. no rights across retreat.

## 12.4. `portal_get_finances(retreat_id)`

Ответ:

```json
{
  "retreat": {"id": "...", "name": "..."},
  "viewer_scope": ["self", "family", "group_leader"],
  "participants": [
    {
      "participant_id": "...",
      "display_name": "...",
      "scope": "family_detail",
      "balance": {},
      "payments": []
    }
  ],
  "group_summary": {
    "member_count": 10,
    "charged": "...",
    "paid": "...",
    "debt": "...",
    "advance": "...",
    "members": []
  }
}
```

## 12.5. Поля семейной детализации

Семья видит:

- начисления и описания;
- платежи/refunds/reversals;
- долг/аванс по блокам;
- итоги семьи.

Не видит:

- account names/IDs;
- internal comments;
- author/audit;
- receipts;
- source system metadata.

## 12.6. Поля лидера группы

Лидер видит:

```text
participant name
charged
paid
debt
advance
payment status
```

Не видит по умолчанию:

- детальные внутренние postings;
- payer identity чужого платежа;
- donation;
- receipts;
- другие retreats.

## 12.7. Обычный участник группы

Только self. Group membership не расширяет read scope.

## 12.8. Безопасность

- viewer contact не принимается от клиента;
- portal role не имеет SELECT к full views;
- every returned participant must be in visibility CTE;
- alias resolved to canonical for membership, but financial FK history preserved;
- direct URL guessing participant ID returns no data;
- family/group feature flag does not weaken personal portal RLS.

---

# 13. Вложения и Storage

## 13.1. Buckets

```text
finance-temp     private, TTL cleanup
finance-files    private, immutable bound files
finance-reports  private, immutable PDFs
```

Можно использовать один private bucket с prefixes, но политики должны различать temp/bound/report.

## 13.2. Upload-flow

1. Client requests allowed temp path.
2. Client uploads with signed token.
3. Client creates operation; missing receipt temporarily allowed while pending.
4. Client calls `create_attachment` with operation/posting.
5. Server verifies and binds metadata.
6. Worker removes unbound temp files older than 24h.

## 13.3. Download-flow

Client никогда не получает raw permanent path из full table. RPC проверяет role/ownership and returns short-lived signed URL.

## 13.4. File constraints

Default limits:

```text
images: jpg/png/webp, ≤ 10 MB
PDF: application/pdf, ≤ 25 MB
```

Executable and HTML rejected. Actual MIME verified, not just extension.

## 13.5. Closure PDF

PDF generated only from closure snapshot. Worker:

1. reads closure;
2. renders schema version;
3. uploads PDF;
4. creates accounting-object attachment;
5. calls finalize;
6. on failure marks generation_error or leaves pending with diagnostics;
7. retry is safe.

---

# 14. Audit

## 14.1. Trigger context

State RPC sets:

```sql
set_config('app.change_reason', reason, true);
set_config('app.request_id', request_id::text, true);
set_config('app.correlation_id', correlation_id::text, true);
```

Trigger copies current actor and context.

## 14.2. Immutable fields enforcement

Triggers reject direct changes even from mistakenly written RPC:

- operation money metadata as applicable;
- posting account/direction/amount/currency/base/rate;
- refund inherited analytics;
- source/reversal analytics after reversal;
- charge financial fields;
- opening position rows.

## 14.3. Audit view

`fin_v_audit_observer` masks:

- contact private fields;
- storage paths;
- access internals;
- discount reason if classified sensitive;
- raw request hashes.

## 14.4. Integrity job

Daily function `fin_assert_integrity()` checks:

- account currency;
- no duplicate active reversal;
- one active opening/account;
- refund net within original;
- refund analytics match source;
- transfer base balance;
- checkpoint balance reproducible;
- closure attachments valid;
- participant detailed/quick balance equality;
- no orphan attachments.

Failure creates admin alert/log and must not silently self-correct.

---

# 15. UI implementation

## 15.1. Общие принципы

- Серверный response является источником истины; клиентские суммы только preview.
- После network error форма повторяет тот же request UUID.
- После success request UUID заменяется только при новой бизнес-команде.
- Все денежные поля вводятся decimal, не JavaScript float в итоговом payload.
- Ошибки concurrency показываются как необходимость обновить форму, а не общий «что-то пошло не так».
- `occurred_on` всегда явно видима в форме.
- Post-close reason показывается до submit.
- Отсутствие permission скрывает кнопку, но сервер всё равно проверяет.

## 15.2. Главная

Карточки:

- физический остаток real accounts по валютам;
- «выдано под отчёт» — сумма положительных custodial balances по валюте;
- «всего под ответственностью» = real physical + custodial;
- pending, disputed, negative accounts;
- participant debts current/next retreat;
- closure dirty reports.

Это реализует привычное представление Ванамали Гопала, не смешивая денежные счета:

```text
Касса ₹: физически 347 000
Выдано под отчёт: 143 000
Всего под ответственностью: 490 000
```

## 15.3. ДДС

Filters:

```text
account
group
object/retreat
category
cost center
participant
contractor
operation type
approval
occurred_on range
created_at range optional diagnostic
```

Default period filters use `occurred_on`.

Modes:

- one account: running balance by ledger seq;
- multiple accounts: no single running balance;
- all currencies: separate totals by currency;
- base totals shown separately and explicitly labelled INR-equivalent.

Late posting badge:

```text
created_at date > occurred_on
```

## 15.4. Payment form

Five blocks:

```text
org fee
accommodation
meals
extra
donation
```

Plus general prepayment option.

Each money row:

```text
account
amount
currency derived
channel
INR preview
participant
balance kind
```

UI labels:

```text
Наличные      -> cash
Онлайн ₽      -> bank_transfer + RUB account
Карта         -> card
PayPal        -> paypal
```

Backend rejects mismatched currency/account even if UI allowed it.

## 15.5. Group payment

- select payer;
- select retreat;
- select participants;
- suggest debt-based allocation;
- administrator may edit;
- one posting per participant;
- sum rows equals received amount in that account/currency;
- preview individual balances;
- one currency per group-payment operation; second currency creates second operation.

## 15.6. Refund form

Starts from a specific active payment posting.

Shows:

```text
original amount/currency/base
net refunded
available
participant
retreat
balance kind
payer
default account
```

Client cannot edit inherited analytics. Other account/recipient reveals reason field.

## 15.7. Expense form for account user

Fields:

```text
own account
allowed category
amount
occurred_on
cost center optional override
retreat optional
comment
receipt
```

If retreat closed — `object_closed`; no admin post-close fallback in same role.

## 15.8. Approval inbox

List pending operations with:

- account and own-visible context;
- amount;
- category/cost center/object;
- creator;
- date;
- receipt status.

Actions:

```text
Approve
Dispute + required reason
Edit analytics then approve
```

Use `expected_approval=pending`. Stale action refreshes row.

## 15.9. Reconciliation screen

Account selection determines mode.

Cash:

- locations;
- denomination rows;
- `other_amount` + required comment;
- auto sum.

Statement:

- statement balance only;
- optional statement document attachment outside atomic reconciliation.

Single button `Save reconciliation`.

If difference nonzero:

```text
Difference unresolved.
Create adjustment and save checkpoint?
```

Reason required. One RPC.

## 15.10. Accounts

Create account form includes:

```text
name
kind
reconciliation mode
currency
group
responsible person
default cost center
```

Changing reconciliation mode after first reconciliation prohibited.

Custodial account page shows:

- responsible person;
- balance;
- last checkpoint;
- pending/disputed;
- transfer responsibility button, only when current seq equals checkpoint.

## 15.11. Participant card

Five columns:

```text
org fee
accommodation
meals
extra
total
```

General debt/advance shown in total and separately labelled.

Extra hidden only if no charge, opening, posting and zero balance.

Actions:

```text
Add charges
Payment
Refund
Cancel charge
```

## 15.12. Guest Portal

Tabs/sections:

```text
My finances
Family
My group (leader only)
```

Personal/family detail uses identical participant card, but portal-safe fields.

Group leader summary table:

```text
Name | Charged | Paid | Debt | Advance | Status
```

No receipts/internal comments.

## 15.13. Closure UI

Before closure:

- checklist pending/disputed;
- debt/advance summary;
- snapshot preview;
- close button.

After close:

- version history;
- report status;
- dirty banner;
- reissue button with reason;
- download signed PDF.

Post-close operation forms visible only to admin and always require reason.

---

# 16. Reporting and closure

## 16.1. Initial closure transaction

Under object lock:

1. idempotency;
2. ensure no initial closure;
3. pending count = 0;
4. disputed count = 0;
5. build canonical snapshot;
6. insert version 1 pending;
7. object immediately considered closed;
8. commit.

## 16.2. Post-close changes

Admin-only types:

```text
payment, refund, income, expense,
donation, reversal, reconciliation_adjustment
```

Any posting for closed object:

- `is_post_close=true`;
- reason required;
- `report_dirty_at=now()`.

Charge create/cancel/opening correction and allowed post-close analytics also set dirty.

## 16.3. Reissue

Does not happen automatically after every late operation.

```text
late change -> dirty
admin clicks reissue -> version+1 snapshot
worker generates PDF -> finalize
```

## 16.4. PDF content

Minimum:

- object and report version;
- closed timestamp and author;
- income/expense by category;
- currencies actual and base;
- net;
- participant charged/paid/debt/advance totals;
- list of debts optional;
- post-close change indicator;
- calculation schema version;
- reason for version > 1.

PDF must not recompute from live DB; only snapshot.

## 16.5. Period semantics

Reports for date ranges use `occurred_on`. Closure includes all current postings attached to object, regardless of late insertion, except immutable previous snapshot versions.

---

# 17. Cutover runbook

## 17.1. Preparation workbook

The source registry should use Vanamali's familiar totals while preventing double counting.

Example INR block:

| Registry row | Amount |
|---|---:|
| Total under responsibility | 490000 |
| Distributed: Cafe | 143000 |
| Distributed: Kitchen | 0 |
| **Physical safe/hands = real cash opening** | **347000** |

Validation:

```text
total under responsibility
= physical real cash
+ Σ custodial balances
```

Loader creates:

- opening real cash = physical amount;
- opening each custodial = distributed amount;
- never both for same physical money.

## 17.2. Shadow period

- 2 weeks;
- Excel remains operational source;
- duplicate entry in production project allowed only before reset;
- daily comparison;
- test users trained;
- no cutover opening yet.

## 17.3. Reset

Maintenance mode, backup, no write sessions.

Delete only:

```text
operations
postings
reconciliations
participant opening positions
charges
closures
shadow attachments/audit
```

Keep dictionaries/accounts/access/objects/cost centers.

Reset sequence, dirty flags and temp Storage. Validate no orphans.

## 17.4. Date X load order

1. Verify preserved dictionaries and objects.
2. Create monetary opening for every account.
3. Load participant debts/credits.
4. Verify cutover equations.
5. Perform first reconciliation of all real and active custodial accounts.
6. Start production entry.

## 17.5. Participant opening mapping

```text
known detailed debt -> charge
known block but insufficient tariff data -> opening debt/block
unknown detail debt -> opening debt/general
advance -> opening credit/block or general
```

No amount loaded in two places.

## 17.6. Success criterion

Three consecutive daily checkpoints without unexplained differences on all real accounts. Active custodial accounts should also be reconciled according to the agreed schedule.

## 17.7. Rollback

Export:

- operations/postings;
- charges;
- participant opening corrections;
- approval statuses;
- reconciliations;
- attachment index;
- account balances.

Excel becomes active only after formal decision and reconciliation of exported period.

---

# 18. Testing strategy

## 18.1. Layers

1. SQL unit tests: helpers, formulas, constraints.
2. RPC integration tests: transactions and errors.
3. Concurrency tests: parallel sessions.
4. RLS tests: every role.
5. UI E2E: critical flows.
6. Cutover rehearsal.
7. Restore test.

## 18.2. Required SQL suites

```text
account_balance_test
transfer_test
opening_test
reconciliation_test
participant_balance_test
refund_test
reversal_test
approval_test
closure_test
portal_visibility_test
attachment_security_test
cutover_test
integrity_test
```

## 18.3. Core monetary tests

- same request UUID/hash -> one result;
- other hash -> conflict;
- two expenses race on 100 balance;
- transfer base sides equal;
- reversal mirrors every posting;
- source/reversal analytics frozen;
- technical operations cannot carry analytics;
- one active opening/account;
- opening error after ordinary activity uses adjustment.

## 18.4. Reconciliation tests

- cash rejects statement balance;
- statement rejects counts;
- counts normalized independent of order;
- duplicate location rejected;
- unknown denomination rejected;
- other amount requires comment;
- stale seq rejected;
- adjustment and checkpoint atomic;
- retry after successful adjustment returns same reconciliation.

## 18.5. Participant tests

- general prepayment applies ordered blocks;
- extra block;
- opening general debt;
- quick/detail equality;
- no cross-retreat offset;
- donation excluded;
- refund restores debt;
- reversed refund restores available refund and paid balance;
- refund analytics cannot change;
- two refunds race.

## 18.6. Family/group tests

1. Self sees self.
2. Family member sees all active family members.
3. Family relation does not expose other retreat unless selected/authorized.
4. Group leader sees group summary for one retreat.
5. Ordinary group member sees only self.
6. Payer without relation sees no recipient data.
7. Leader removal revokes access immediately.
8. Alias contact resolves membership correctly.
9. Direct participant ID guessing returns no rows.
10. Group leader does not see receipts/payer/internal comments.

## 18.7. RLS tests

For each role:

- direct table select denied where required;
- direct insert/update/delete denied;
- permitted RPC succeeds;
- account user cannot see other posting in same operation;
- attachment access follows posting;
- observer cannot write;
- participant cannot call admin RPC.

## 18.8. Closure tests

- pending/disputed block closure;
- payment vs closure race;
- reissue concurrent calls create one version;
- generation failure does not reopen object;
- post-close only admin;
- pre-close analytics immutable;
- post-close analytics edit sets dirty;
- opening correction closed retreat sets dirty;
- PDF attachment same object and unique.

## 18.9. Cutover tests

- same source row identical retry no duplicate;
- changed source row conflict;
- real + custodial no double count;
- participant advance does not alter cash;
- second opening different UUID rejected;
- reset preserves dictionaries;
- sequence starts clean;
- first checkpoint reproduces registry.

## 18.10. Acceptance gate by phase

No phase closes with failing P0 monetary, concurrency or RLS tests. UI cosmetic defects may be deferred only if they cannot change or expose financial data.

---

# 19. Error catalog

Stable codes:

```text
unauthorized
forbidden
invalid_payload
idempotency_conflict
account_not_found
account_inactive
account_currency_mismatch
insufficient_funds
object_closed
post_close_reason_required
operation_already_reversed
reversal_not_allowed_after_refund
refund_source_invalid
refund_amount_exceeds_available
refund_analytics_immutable
analytics_frozen
analytics_stale
approval_stale
reconciliation_stale
invalid_reconciliation_payload
reconciliation_reason_required
account_changed_since_reconciliation
opening_already_exists
opening_replacement_not_allowed
negative_cash_opening_forbidden
cutover_row_conflict
report_not_dirty
closure_has_pending
closure_has_disputed
attachment_already_bound
attachment_parent_mismatch
attachment_invalid
charge_already_cancelled_conflict
contact_scope_forbidden
```

UI maps codes to localized messages and actionable next step.

---

# 20. Observability and operations

## 20.1. Logs

Every RPC logs structured fields:

```text
rpc_name
request_id
actor
result
error_code
duration_ms
locked_accounts_count
locked_objects_count
operation_id/reconciliation_id/closure_id
```

Do not log full sensitive payload or file paths to public logs.

## 20.2. Metrics

- RPC error rate by code;
- p95 duration;
- reconciliation stale rate;
- negative real accounts;
- pending/disputed aging;
- report dirty age;
- PDF generation failures;
- orphan temp files;
- integrity job failures;
- last successful backup/restore test.

## 20.3. Alerts

Immediate admin alert:

- integrity failure;
- real account negative;
- PDF generation error after retries;
- failed cutover equation;
- restore inconsistency;
- unusually high refund or reversal volume.

Daily digest:

- unreconciled active accounts;
- pending/disputed older threshold;
- dirty closures;
- temp files older 24h.

## 20.4. Backup and restore

Targets:

```text
RPO ≤ 1 hour
RTO ≤ 4 hours
restore rehearsal quarterly
```

Restore validation:

- balances;
- ledger seq;
- latest checkpoints;
- audit;
- attachment metadata to Storage sha256;
- finalized PDF accessibility;
- no orphan metadata/files;
- participant balance formula equality.

---

# 21. Security checklist

- fixed search_path in SECURITY DEFINER;
- no dynamic SQL from client values;
- explicit schema names;
- REVOKE table DML from authenticated/anon;
- EXECUTE grants per role;
- signed URLs short-lived;
- temp upload paths scoped to auth.uid;
- MIME and size validation;
- no raw Storage path in participant/account-user response;
- no viewer contact ID from client;
- no payer-based access inference;
- audit view masked;
- canonical contact resolution cannot expand finance scope beyond explicit relation;
- attachment parent/posting consistency enforced server-side.

---

# 22. Definition of Done

A feature is done only when:

1. Migration applies to empty DB and upgraded test DB.
2. RPC has documented payload/response/errors.
3. Authorization and RLS tests exist.
4. Idempotency retry test exists.
5. Concurrency test exists if money, refund, reconciliation or closure affected.
6. Audit contains actor/reason/request where required.
7. UI handles stable errors.
8. Data is exportable through safe view.
9. Monitoring metric/log exists for critical failure.
10. Acceptance test is linked to implementation.

MVP is ready for cutover when:

- all phase gates pass;
- 105 ТЗ scenarios plus added guide scenarios pass;
- cutover rehearsal passes;
- restore rehearsal passes;
- Vanamali approves account/opening registry;
- AK approves closure snapshot layout;
- CONTACTS relationship source is confirmed or family/group feature flag remains off.

---

# 23. Open decisions and defaults

These do not block core development if defaults below are used.

| Question | Default for implementation |
|---|---|
| Full category list | Seed minimal required codes; admin adds approved list before cutover |
| Unit cost formula | `null` in snapshot until approved |
| Non-standard accommodation | Manual charge with discount/creation reason |
| Club 108 | No automation; admin classifies after business decision |
| Family minors | Current requirement: symmetric family visibility; model supports future guardian-only policy |
| Contact group schema | Reuse existing if equivalent; otherwise add minimal collections outside `fin_` |
| Custodial reconciliation frequency | Operational config; mandatory before responsibility transfer |
| Negative custodial opening | Allowed with document and admin reason |

---

# Appendix A. Additional acceptance scenarios

```text
A1. Refund posting analytics edit is rejected.
A2. Transfer carrying object/category/cost center is rejected.
A3. Reconciliation adjustment carrying object/cost center is rejected.
A4. Opening carrying participant/category/object is rejected.
A5. Opening error after ordinary expense but before first checkpoint uses reconciliation adjustment.
A6. create_attachment same UUID/hash returns old row; same path other UUID rejected.
A7. Family member sees spouse/children selected retreat.
A8. Ordinary group member cannot retrieve group summary.
A9. Group leader sees debt totals but no receipts or payer identities.
A10. Payer for neighbor gets no neighbor access.
A11. create_charge retry does not duplicate.
A12. set_approval stale expected status rejected.
A13. transfer responsibility checks checkpoint and current max seq.
A14. Cutover row same key different amount conflicts.
A15. Report period uses occurred_on; account feed uses ledger seq.
A16. UI Online ₽ produces bank_transfer on RUB account.
A17. Cash custodial account can be reconciled and transferred only at current checkpoint.
A18. Negative cash real opening rejected; negative statement/custodial opening with reason allowed.
```

# Appendix B. Implementation backlog

| ID | Deliverable | Phase | Dependency |
|---|---|---:|---|
| FIN-001 | Enums and base dictionaries | 0 | — |
| FIN-002 | Audit infrastructure | 0 | FIN-001 |
| FIN-003 | Core tables and constraints | 1 | FIN-001 |
| FIN-004 | Core RLS and actor helpers | 1 | FIN-002 |
| FIN-005 | Opening/replace opening | 1 | FIN-003 |
| FIN-006 | Transfer/expense/income/donation | 1 | FIN-003 |
| FIN-007 | Balance and ledger views | 1 | FIN-006 |
| FIN-008 | Reconciliation | 2 | FIN-007 |
| FIN-009 | Responsibility transfer | 2 | FIN-008 |
| FIN-010 | Charges and participant opening | 3 | FIN-003 |
| FIN-011 | Payment/group payment | 3 | FIN-010 |
| FIN-012 | Refund/reversal | 3 | FIN-011 |
| FIN-013 | Participant balance views | 3 | FIN-012 |
| FIN-014 | Personal Guest Portal | 3 | FIN-013 |
| FIN-015 | CONTACTS family/group contract | 4 | CONTACTS |
| FIN-016 | Family/group portal RPC | 4 | FIN-014, FIN-015 |
| FIN-017 | Approval and analytics editing | 5 | FIN-006 |
| FIN-018 | Attachment flow | 5 | FIN-017 |
| FIN-019 | Object analytics and closure | 6 | FIN-013, FIN-017 |
| FIN-020 | PDF worker | 6 | FIN-019, FIN-018 |
| FIN-021 | Cutover loader/reset | 7 | All core |
| FIN-022 | Integrity/monitoring | 7 | All core |

---

# Appendix C. Decisions for Adrian and Vanamali

1. Family visibility is technically feasible in MVP and does not change the financial ledger.
2. Group leader summary is feasible in MVP if group membership/leader data is explicit in CONTACTS/registration.
3. `fin_participant_balance` remains per `(participant_id, retreat_id)`; family/group aggregation is a separate portal layer.
4. Family members see family financial detail; group leader sees summary; ordinary group member sees self.
5. Payment by one person for another never grants visibility.
6. If CONTACTS lacks relationship entities, add minimal collections there, not in `fin_`.

---

*End of Implementation Guide v1.0.*
