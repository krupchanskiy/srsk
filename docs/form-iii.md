# Form III (бывш. Form C) — регистрация иностранцев в FRRO

Инструкция для Claude: как подавать Form III по гостю ШРСК.

## Что это и сроки

- Портал: https://indianfrro.gov.in/formIII/ (МВД Индии, NIC).
- Аккаунт: SRIMAD BHAGAVATA VIDYAPITHAM TRUST (DHARMSHALA), Shri Rupa Seva Kunj, FRRO: FRO Mathura.
- Подаётся на **каждого иностранца**, включая держателей **OCI** (с Immigration and Foreigners Act 2025).
- Срок — **24 часа после заезда**. Если заезд был раньше — подавать сразу и сказать ВГ о просрочке.
- После отъезда гостя — **отметить выезд** на портале (вкладка «Pending for checkout»).

## Основной путь: чат + раздел «Form III» в ШРСК

Так работаем с 16.11.2026. Портал руками (раздел «Порядок работы» ниже) — запасной путь.

### 1. ВГ присылает фото
Паспорт (разворот с фото и обе строки MRZ), виза (письмо ETA или штамп e-Visa; для OCI — карта OCI),
по возможности обычное фото лица. Иногда сразу пишет комнату, дату/время приезда, телефон, почту.

### 2. Проверка документов
- **MRZ — скриптом** по контрольным цифрам (веса 7-3-1, `<`=0, буква = код−55): номер паспорта, ДР, срок,
  опциональное поле, итоговая. Скрипт — в scratchpad, `python3 -I`. Расхождение = ошибка чтения, перечитать.
- Виза ↔ паспорт: имя, номер паспорта, ДР. Срок визы ↔ выезд по шахматке.
- Номер бланка (у EST — в углу, LB…) ≠ номер паспорта; верный — в MRZ и в ETA.
- Неразборчивое (рукописный номер визы на штампе, O/0 в ETA) — ⚠ и спросить, не угадывать.
- Ответ ВГ — таблица: латиница, гражданство ISO3, пол/ДР, паспорт+срок, виза+срок, тип/подтип для портала, ⚠.

### 3. Найти человека в ШРСК
- Карточка: по латинской и русской фамилии, имени, почте (`vaishnavas`).
- Место: в шахматке гости ретрита часто стоят **бронью «на имя»** — `residents.guest_name`
  («Фамилия Имя» или духовное имя), `vaishnava_id is null`. Искать по комнате, которую назвал ВГ,
  или по ретриту. Кто из двух в комнате кто — **спросить**.
- Нет места → заселить новой строкой `residents` по образцу соседа по брони (тот же `booking_id`,
  `retreat_id`, `category_id`), проверив вместимость комнаты (пиковая загрузка < `rooms.capacity`).

### 4. Спросить одним списком всё неизвестное
дата и время приезда к нам · телефон в Индии · почта · откуда приехал и где останавливался до этого ·
цель визита (туристическая виза → Tourism; OCI и прочее — спросить) · комната/даты, если не в шахматке.
**Ничего не придумывать.** Нет своих контактов → по решению ВГ контакты руководителя группы
(взять из карточки руководителя группы). Выдуманные данные в FRRO — нельзя.

### 5. Запись в базу (каждый раз сухой прогон `begin; … rollback;`)
```sql
-- карточка (имя в карточке: как у нас принято; духовное — ровно как в шахматке, без добавок)
insert into vaishnavas (spiritual_name, first_name, last_name, gender, birth_date, citizenship, visa_type, visa_expiry)
values (...) returning id;           -- citizenship = ISO3; visa_type 'tourist' или null (у OCI null)
-- документы (видят только суперпользователи)
insert into vaishnava_documents (vaishnava_id, passport_number, passport_surname, passport_given_name,
  passport_expiry, visa_number, portal_visa_type, portal_visa_subtype) values (...);
  -- e-Visa: 'e-VISA' / 'e-TV', visa_number = ETA Number; OCI: 'OCI' / null, visa_number = номер карты OCI
-- телефон: 10 цифр, без +91 и пробелов (портал принимает только цифры)
update vaishnavas set indian_phone = '9XXXXXXXXX', email = '...' where id = ...;
-- привязать бронь «на имя»
update residents set vaishnava_id = ..., guest_name = null where id = ... and vaishnava_id is null;
-- данные заезда для анкеты
insert into form3_entries (vaishnava_id, resident_id, arrival_date, arrival_time, expected_checkout,
  arrived_from, previous_place, purpose) values (...);
```
- **Шахматку не двигать** ради анкеты: фактический приезд — в `form3_entries.arrival_date/time`
  (ВГ: «регистрируем фактическим, шахматку не трогаем»). Даты шахматки влияют на начисления.
- Отметку «заехал» (`arrived_at`) ставить только новой строке, которую заселил сам.

### 6. Фото
Вырезать лицо: `sips -c H W --cropOffset Y X in.jpg --out ~/Downloads/form3/<фамилия>_photo.jpg`,
посмотреть результат (Read), показать `open -R`. Ксерокопия — плохо, попросить живое фото.
В карточку фото загружает **ВГ** кнопкой «Загрузить фото» в разделе Form III
(самому через служебный ключ — запрещено).

### 7. Подача — делает ВГ
ШРСК → Ресепшен → **Form III** → «Подать» (список, кто ждёт, и чего не хватает) → закладка заполняет портал →
Submit → закладка «ШРСК ← номер анкеты» возвращает ID (видно в `form3_entries.form3_id`, `submitted_at`).
Проверить после «подал»:
```sql
select v.first_name, v.last_name, e.form3_id, e.submitted_at, v.photo_url is not null photo
from form3_entries e join vaishnavas v on v.id = e.vaishnava_id where e.vaishnava_id in (...);
```

### 8. Выезд
Отметить на портале (см. «Выписка» ниже), в ШРСК — вкладка «Выписка».

### Что сказать ВГ в конце
Кто подан (таблица с номерами анкет), кто ждёт и чего не хватает, срок подачи (приезд + 24 ч), дата выезда.

## Порядок работы

1. Вход — **только сам пользователь** (логин, пароль, капча). Открыть портал во встроенном браузере (`preview_start` с url), попросить войти.
2. Меню → **Form III Details** → **New Entry** → открывается окно «Search Existing Form III».
   - **Сначала поиск**: пользователь вводит номер паспорта, Claude выбирает гражданство → Search.
     Если гостя уже регистрировали (например, отель во Вриндаване) — анкета придёт **частично заполненной**;
     Claude сверяет подставленное с паспортом/ШРСК и дозаполняет пустое.
   - Если «No matching Records Found» — кнопка **New Entry**, пустая анкета.
   В узкой панели меню скрыто — задать viewport 1280×900 (`resize_window`).
3. Собрать данные (см. ниже) и **до заполнения** одним списком спросить всё неизвестное. **Ничего не придумывать** — ни цель визита, ни города, ни время.
4. Заполнить шаги 1–3. **Номера паспорта и визы вводит пользователь** (Claude не вводит номера документов) — дать их текстом.
5. Отправку (**Submit**) нажимает пользователь или Claude только после явного «да».

## Откуда брать данные

| Поле портала | Источник |
|---|---|
| Given Name, Surname | паспорт, латиница как в MRZ (IVAN, IVANOV) |
| Gender | паспорт / ШРСК |
| Nationality | паспорт (выпадающий список: RUSSIAN FEDERATION и т.д.) |
| DOB | паспорт |
| Contact Phone Number in India* | спросить (индийский номер гостя); **10 цифр, без +91 и пробелов** — портал принимает только цифры. Нет своего — по решению ВГ контакт руководителя группы, не выдумывать |
| Email Id* | спросить или `vaishnavas.email` |
| Special Category | «Others» (по умолчанию) |
| Passport Number* | паспорт — **вписывает пользователь** |
| Visa Number / OCI Card Number* | для e-Visa — **ETA Number** из письма ETA; для OCI — **номер карты OCI** (вида A1234567) — **вписывает пользователь** |
| Visa Type / Subtype | e-Tourist → **e-VISA / e-TV**; держатель OCI → тип **OCI** (подтип — по списку портала, уточнить при первой подаче). Цель визита у OCI — спрашивать (ВГ 16.11: Tourism) |
| Arrived From | спросить (город, откуда приехал в ашрам) |
| Date / Time Of Arrival | дата — `residents.check_in`; время — спросить |
| Purpose Of Visit | спросить (для туристов — Tourism) |
| Previous place of stay | спросить |
| Duration Of Stay (In days) | от заезда до выезда: `check_out − check_in` |
| Expected Checkout Date | `residents.check_out` — **сверить с гостем**; если другое — продлить в шахматке |
| Photo | JPEG; можно вырезать лицо из фото паспорта (`sips -c H W --cropOffset Y X`). **Файл класть в `~/Downloads/`** (`<фамилия>_photo.jpg`) и показать `open -R`. Загружает пользователь (Upload Photo), встроенный браузер файлы не грузит |

Поиск гостя в ШРСК:

```sql
select v.id, v.spiritual_name, v.first_name, v.last_name, v.phone, v.email,
       r.id resident_id, r.room_id, r.check_in, r.check_out
from vaishnavas v join residents r on r.vaishnava_id = v.id
where (v.last_name ilike '%<фамилия>%' or v.email ilike '%<почта>%')
  and r.check_out >= current_date;
```

Продление в шахматке — `update residents set check_out=... where id=<resident_id>` после сухого прогона (`begin; ... rollback;`) и проверки свободных мест в комнате.

## Особенности интерфейса портала

- Поле **DOB** только для чтения — выбирать через календарь: «Choose month and year» → «Previous 24 years» → год → месяц → день (удобно через `find`).
- Выпадающие списки (mat-select): открыть кликом, найти пункт через `find`, `scroll_to`, клик.
- После ввода фамилии портал на пару секунд показывает загрузку — следующие поля вводить после неё.
- Шаг 2 не открывается, пока не заполнены обязательные поля шага 1 (включая номера).
- **Next сохраняет черновик** на портале («Form III Id generated», «Arrival details saved») — это ещё не подача.
- После поиска по паспорту портал подставил имя, пол, гражданство, DOB, паспорт и номер визы; пустыми остались телефон, почта, Special Category, тип/подтип визы.
- **Time Of Arrival** — часы: клик по полю → час на циферблате (внутренний круг 13–00) → минуты → OK. Анимация закрытия ~1 с — не кликать сразу.
- **Expected Checkout Date** портал считает сам из Date Of Arrival + Duration — проверить, что совпало с шахматкой.
- Purpose Of Visit — варианты: Accompanying Parents/Patient/Spouse, Business, Diplomatic, Education, Employment, Internship, Joining spouse, Journalism, Medical Treatment of self, Meeting friends/relatives, Minor child, Official, Others, Seminar/conference in India, Studies, Surrogacy, **Tourism**. Выбор — по ответу ВГ.
- Шаг 3 → Next открывает **Preview** (сводка + фото, Form III ID) с кнопками Cancel / **Submit**. **Cancel предлагает сбросить анкету** — не нажимать; закрывать крестиком X. Submit — окончательная подача, только после «да» пользователя (или жмёт сам).
- **Дата приезда/выезда.** Со слов ВГ, есть устное правило FRRO: в анкете дата не раньше суток до подачи (портал технически принимает любую прошедшую дату — `min` у поля нет). Claude вписывает **фактическую** дату (из шахматки, сверив с ВГ) и не подменяет её; если ВГ решает поставить другую — правит сам.
- После Submit анкета пропадает из DRAFT и появляется в **PENDING FOR CHECKOUT** (колонки: ID, имя, гражданство, паспорт, Date Of Arrival, Date Of Submission; действия: 👁 просмотр, ✏ правка, ⏱ выезд).
- **Печать.** Кнопки печати на портале нет (ни в просмотре, ни в Reports — там только сводки за период). Делать так: открыть 👁, забрать `mat-dialog-container` (фото — data:base64 внутри), собрать HTML с простыми стилями A4 и сохранить PDF через headless Chrome:
  `"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --no-pdf-header-footer --print-to-pdf=$HOME/Downloads/FormIII_<ID>_<ФАМИЛИЯ>.pdf file://...html`
  PDF — в `~/Downloads`, открыть `open`, проверить превью (`qlmanage -t`).
- Special Category: Select / Born in India / Crew / Diplomat Exempted / Loss of Passport / Official/Service Exempted / **Others** (обычный гость).
- Имена полей формы (`formcontrolname`): given_name, surname, gender, nationality, dob, phnnuminind, emailId, spl_category_code, remark, passnum, visanum, visatype, visasubtype, arrivedFromPlace, dateOfArrivalInHotel, timeOfArrivalInHotel, purposeOfVisit, previousPlaceStay, durationofstay, expectedCheckoutDate; фото — input#imageUpload.

## Выписка (Mark Checkout)

Разведка 17.11.2026 (ничего не подтверждалось).

- **Form III Details → PENDING FOR CHECKOUT.** На 17.11 там **641 анкета** без выписки, заезды с 04.2025. Таблица по 5/10/15 строк (больше нельзя). Список отдаёт `GET /formiiiapi/app-details-pending-checkout?accoCode=…&frroFroCode=…&page=N&size=M` (поля: form_c_appl_id, given_name, surname, nationality, passnum, dob, date_of_arrival_in_hotel, expected_checkout_date, entered_on).
  Выгрузить всё: размер страницы 15, листать `button.mat-paginator-navigation-next` и собирать строки `tbody tr` (скрипт — в истории чата «Form III Checkout»).
- Действия в строке: `mattooltip="View"` 👁, `"Update Duration"` ✏ (продлить срок), `"Mark Checkout"` ⏱.
- **Mark Checkout** открывает диалог «Checkout Entry»: сверху Expected Checkout Date, Date of arrival, Duration; внизу «Applicant Details» (Form III ID, имя, паспорт, гражданство, DOB). Поля (все обязательные):
  | formcontrolname | что | как вводится |
  |---|---|---|
  | `date_of_departure` | Date Of Departure | только календарь (readonly); **min = дата заезда, max = сейчас** — будущую дату поставить нельзя, выписка только после факта |
  | `time_of_departure` | Time Of Departure | только часы-циферблат (readonly), как Time Of Arrival |
  | `next_destination` | Next Destination/proceed to | обычный текст |
  Кнопки: X (закрыть без изменений), Cancel, **Submit — необратимо**, только после «да» ВГ.
- После выписки анкета уходит во вкладку **CHECKED OUT**.
- **Exit Pending List** (Reports → `#/reports/overstay-table`, «Overstaying Applications»): кто пересидел Expected Checkout Date. На 17.11 пусто.

### Как выписывать скриптом (проверено 17.11.2026 на 12 анкетах)

- Поиск в вкладке PENDING FOR CHECKOUT: вписать Form III ID в поле поиска **и нажать Enter** (без Enter не ищет).
- Дата: кнопка календаря в диалоге → `.mat-calendar-period-button` → ячейка года (`aria-label="2025"`) → месяца (`"September 2025"`) → дня (`"September 13, 2025"`).
- Время (ngx-mat-timepicker): клик по полю `time_of_departure`; на циферблате `.clock-face__number` найти час (внутренний круг 13–23 и 00), взять центр элемента и отправить `mousedown`/`mouseup`/`click` в `document.elementFromPoint(x,y)` с этими clientX/Y. Обычный клик по координатам скриншота промахивается на соседний час. Минуты — так же (шаг 5); 00 стоит по умолчанию. Потом кнопка OK.
- Next destination: `value` + событие `input` (портал сам переводит в верхний регистр).
- Перед Submit сверить: Form III ID в диалоге, дата, время, направление, форма `ng-valid`. После Submit всплывает «Checkout Details Submitted Successfully Form III Id: …» (swal2, кнопка OK), и страница **переключается на вкладку DRAFT**, поэтому перед следующим человеком снова открывать PENDING FOR CHECKOUT.
- Один вызов javascript_tool длится не больше 45 с, а это примерно 3 человека. Пачку гнать по 3, иначе скрипт продолжит работать без ответа.
- Проверка: вкладка CHECKED OUT, поиск по ID, колонка Date Of Departure; там есть кнопка `print`.
- Старые анкеты по учётной книге: брать дату, время и «куда» из книги. Человек мог приезжать несколько раз, на каждый приезд своя анкета, поэтому сопоставлять **по дате заезда** из книги, а не только по имени.
- **Пачкой надёжнее фоном.** Запустить цикл в странице без await (`window.__f3job=(async()=>{…})()`), прогресс писать в `window.__f3log`, а проверять отдельными вызовами. Остановка при любом расхождении. 17.11 так выписано 209 анкет примерно за 45 минут.
- Подводные камни: (1) циферблат помнит минуты прошлого человека, поэтому минуты ставить всегда, включая «00»; (2) примерно через 30 минут всплывает окно «Log out / Extend session», и перед каждым человеком надо жать **Extend session**; (3) при сужении окна браузера ломается раскладка, поэтому заново задавать 1280×900; (4) изредка поиск не успевает, и помогает повтор.
- Баг циферблата: час ровно «на девяти часах» (21 и 9) по точному центру не ставится — значение остаётся прежним. Нажимать с небольшим поворотом (около 3°). Минуты — по центру, без поворота. Переключение на часы/минуты — `FocusEvent('focus')` на `.timepicker-dial__control`.

### Выписка из ШРСК (вкладка «Выписка», закладка «ШРСК → выписка»; 17.11.2026)

- Очередь — `js/pages/form3-checkout.js`: иностранцы, у кого заезд (склейка `Form3.mergeStays`) закончился за последние 30 дней и нет `form3_entries.checkout_marked_at`. Время — `residents.departure_time`, «куда едет» — `residents.next_destination` (мигр. 788) у последней строки заезда. Срок — сутки от выезда, < 4 ч — красная плашка над вкладками.
- Брони «на имя» (`residents.guest_name`, без карточки) — тоже в очереди, с выездов **с 27.11.2026** (ВГ; раньше — по книге). Пометка «бронь на имя, без карточки», с порталом сверяются по имени из брони (латиница в скобках помогает) и заезду. Запись `form3_entries` у них без `vaishnava_id`, держится за `resident_id` (мигр. 836). Если потом бронь привязать к карточке, эта запись карточке не видна — выписку проверить заново.
- Шахматка, «Выселить» у иностранца: поле «Куда едет», без времени/направления — подтверждение; галочка «то же всем иностранцам брони с тем же днём выезда» (их не выселяет).
- Закладка на портале открывает `reception/form3.html#frro-checkout`, читает весь PENDING FOR CHECKOUT (по 15 строк) и шлёт его в ШРСК через postMessage. ШРСК: связывает анкеты без номера по имени (латиница/транслит) и заезду ±1 день (паспорт — сильнее), при связке ставит гражданство с портала. **Само (ВГ 27.11):** уверенные связки, «уже не в PENDING» → выписаны в ШРСК, и сразу на портал уходят только заполненные (номер, время, «куда едет», уже уехал). На портале панель справа сверху → «Выписать этих N чел.» → результат по каждому возвращается в ШРСК. Неуверенные связки и «уехавших без анкеты — убрать из очереди» — кнопками в ШРСК. «Сохранить» у строки в ШРСК обновляет список на портале.
- Проверено 17.11 на портале (без Submit, закрыто крестиком): чтение PENDING FOR CHECKOUT — 155 из 155, колонки FORM III ID / FULL NAME / NATIONALITY / PASSPORT NUMBER / DATE OF ARRIVAL / DATE OF SUBMISSION / ACTION; в окне Checkout Entry дата (`17/11/2026`), время по циферблату (`09:05`, час 9 — с поворотом), Next Destination — форма ng-valid. Календарь сразу после открытия окна не открывается — нужна пауза и повтор. У поля даты `min` = дата заезда, `max` = сейчас.
- Встроенный браузер Claude открывает `window.open` в той же вкладке — обмен окнами (закладка ↔ ШРСК) проверяется только в обычном Chrome.
