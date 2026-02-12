# Guest Portal (Портал гостя)

## Обзор

Отдельный мини-модуль для гостей ашрама. Имеет собственный дизайн, отличающийся от основного приложения.

- **Цвета**: Зелёный (#147D30), оранжевый (#FFBA47), бежевый фон (#F5F3EF)
- **Особенность**: Не использует Layout.js, имеет собственные portal-*.js

---

## Структура файлов

```
guest-portal/
├── index.html            # Главная (профиль гостя)
├── retreats.html         # Ретриты гостя
├── materials.html        # Материалы
├── contacts.html         # Контакты ашрама
│
├── css/
│   └── portal.css        # Стили портала
│
├── js/
│   ├── portal-config.js  # Конфигурация Supabase
│   ├── portal-auth.js    # Авторизация
│   ├── portal-layout.js  # Хедер, переводы
│   ├── portal-data.js    # Загрузка данных
│   └── portal-index.js   # Логика главной страницы
│
├── login/                # Страница входа
├── auth-callback/        # OAuth callback
├── reset-password/       # Сброс пароля
└── img/                  # Изображения
```

---

## Отличия от основного приложения

| Аспект | Основное приложение | Guest Portal |
|--------|---------------------|--------------|
| Layout | Layout.js (DaisyUI) | portal-layout.js |
| Стили | DaisyUI + Tailwind | Tailwind + portal.css |
| Цвета | --current-color | srsk-green, srsk-orange |
| Авторизация | auth-check.js | portal-auth.js |
| Меню | Полное меню модулей | Простое меню гостя |

---

## Страницы

### index.html — Профиль гостя

**Функционал:**
- Фото профиля (с Cropper.js для редактирования)
- Личные данные
- Духовная информация
- Контакты
- Редактирование профиля

**Секции:**
1. Фото + имя
2. Личные данные (ФИО, дата рождения)
3. Контакты (телефон, email, telegram)
4. Духовная информация (учитель, инициация)
5. Паспортные данные (опционально)

**URL параметры:**
- `?view={vaishnava_id}` — просмотр чужого профиля (только чтение)
- Без параметров — свой профиль (редактирование)

---

### retreats.html — Ретриты

**Функционал:**
- Список ретритов гостя
- Текущие и прошедшие
- Статус регистрации
- Детали проживания

---

### materials.html — Материалы

**Функционал:**
- Полезные материалы для гостей
- Инструкции
- Расписания

---

### contacts.html — Контакты

**Функционал:**
- Контакты ашрама
- Карта
- Как добраться

---

## JavaScript файлы

### portal-config.js

```javascript
// Конфигурация Supabase
const SUPABASE_URL = '...';
const SUPABASE_ANON_KEY = '...';
const supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
```

### portal-auth.js

```javascript
// Проверка авторизации
// Загрузка профиля пользователя
// Редирект неавторизованных
```

### portal-layout.js

```javascript
// Рендер хедера
// Система переводов (упрощённая)
// Переключение языков
```

### portal-data.js

```javascript
// Загрузка данных профиля
// Загрузка ретритов
// Сохранение изменений
```

### portal-index.js

```javascript
// Логика главной страницы
// Редактирование профиля
// Загрузка фото (Cropper.js)
// View/Edit режимы
```

---

## Дизайн

### Цветовая схема

```javascript
tailwind.config = {
    theme: {
        extend: {
            colors: {
                'srsk-green': '#147D30',    // Основной зелёный
                'srsk-orange': '#FFBA47',   // Акцентный оранжевый
                'srsk-bg': '#F5F3EF',       // Бежевый фон
            }
        }
    }
}
```

### Компоненты

```css
/* Карточки */
.card {
    background: white;
    border-radius: 16px;
    padding: 20px;
}

/* Метки секций */
.card-label {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1.5px;
    color: #999;
}
```

---

## Авторизация

### Вход

1. Гость регистрируется через `guest-signup.html`
2. После подтверждения email → автоматический `approval_status = 'approved'`
3. Вход через `guest-portal/login/`
4. Редирект на `guest-portal/index.html`

### Проверка доступа

```javascript
// portal-auth.js
const { data: { session } } = await supabaseClient.auth.getSession();
if (!session) {
    window.location.href = '/guest-portal/login/';
    return;
}

// Загрузка профиля
const { data: profile } = await supabaseClient
    .from('profiles')
    .select('*, vaishnavas(*)')
    .eq('user_id', session.user.id)
    .single();
```

---

## Особенности

### Режим просмотра чужого профиля

```javascript
// URL: ?view=vaishnava_id
const urlParams = new URLSearchParams(window.location.search);
const viewId = urlParams.get('view');

if (viewId) {
    // Режим просмотра — скрыть кнопки редактирования
    isViewMode = true;
    loadProfile(viewId);
} else {
    // Свой профиль — полный доступ
    loadMyProfile();
}
```

### Редактирование фото

Используется Cropper.js для обрезки фото:

```javascript
// Загрузка в Supabase Storage
const { data, error } = await supabaseClient.storage
    .from('vaishnava-photos')
    .upload(filePath, croppedBlob);
```

---

## Связь с основным приложением

### Ссылка из index.html

На главной странице основного приложения есть ссылка "свой профайл":

```html
<a href="/guest-portal/index.html?view=${vaishnavaId}">свой профайл</a>
```

### Общие данные

Портал работает с теми же таблицами:
- `vaishnavas` — профили
- `profiles` — авторизация
- `retreat_registrations` — регистрации на ретриты
- `retreats` — информация о ретритах

---

## Связанная документация

- [Авторизация](../auth.md)
- [База данных](../database.md)
