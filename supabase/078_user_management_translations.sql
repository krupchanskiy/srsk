-- ============================================
-- 078: Переводы для системы управления пользователями
-- ============================================

INSERT INTO translations (key, ru, en, hi) VALUES
    -- Навигация
    ('user_management', 'Пользователи', 'Users', 'उपयोगकर्ता'),
    ('nav_user_management', 'Управление пользователями', 'User Management', 'उपयोगकर्ता प्रबंधन'),

    -- Регистрация команды
    ('team_signup_title', 'Регистрация команды', 'Team Registration', 'टीम पंजीकरण'),
    ('team_signup_subtitle', 'Заявка на вступление в команду ШРСК', 'Application to join SRSK team', 'एसआरएसके टीम में शामिल होने के लिए आवेदन'),
    ('team_signup_success', 'Заявка отправлена! Ожидайте одобрения администратора.', 'Application submitted! Awaiting admin approval.', 'आवेदन सबमिट हो गया! व्यवस्थापक अनुमोदन की प्रतीक्षा करें।'),
    ('register_as_team', 'Регистрация команды', 'Team Registration', 'टीम पंजीकरण'),

    -- Регистрация гостя
    ('guest_signup_title', 'Регистрация гостя', 'Guest Registration', 'अतिथि पंजीकरण'),
    ('guest_signup_subtitle', 'Создать аккаунт гостя', 'Create guest account', 'अतिथि खाता बनाएं'),
    ('guest_signup_success', 'Регистрация завершена! Перенаправляем в систему...', 'Registration complete! Redirecting...', 'पंजीकरण पूर्ण! रीडायरेक्ट कर रहे हैं...'),
    ('register_as_guest', 'Регистрация гостя', 'Guest Registration', 'अतिथि पंजीकरण'),

    -- Ожидание одобрения
    ('pending_approval', 'Ожидание одобрения', 'Pending Approval', 'अनुमोदन लंबित'),
    ('pending_approval_title', 'Ожидайте одобрения', 'Awaiting Approval', 'अनुमोदन की प्रतीक्षा करें'),
    ('pending_approval_message', 'Ваша заявка на регистрацию отправлена администратору.', 'Your registration application has been sent to the administrator.', 'आपका पंजीकरण आवेदन व्यवस्थापक को भेजा गया है।'),
    ('pending_approval_next', 'После одобрения заявки вы получите уведомление на email и сможете войти в систему.', 'After approval, you will receive an email notification and will be able to log in.', 'अनुमोदन के बाद, आपको ईमेल सूचना प्राप्त होगी और आप लॉग इन कर सकेंगे।'),
    ('check_status', 'Проверить статус', 'Check Status', 'स्थिति जांचें'),

    -- Поля формы регистрации
    ('spiritual_name', 'Духовное имя', 'Spiritual Name', 'आध्यात्मिक नाम'),
    ('spiritual_name_optional', 'Духовное имя (если есть)', 'Spiritual Name (optional)', 'आध्यात्मिक नाम (वैकल्पिक)'),
    ('telegram_username', 'Telegram', 'Telegram', 'टेलीग्राम'),
    ('telegram_username_optional', 'Telegram (если есть)', 'Telegram (optional)', 'टेलीग्राम (वैकल्पिक)'),
    ('already_have_account', 'Уже есть аккаунт?', 'Already have an account?', 'पहले से खाता है?'),
    ('no_account', 'Нет аккаунта?', 'No account?', 'कोई खाता नहीं?'),

    -- Управление пользователями - табы
    ('users_all', 'Все', 'All', 'सभी'),
    ('users_pending', 'Ожидают', 'Pending', 'लंबित'),
    ('users_staff', 'Команда', 'Staff', 'कर्मचारी'),
    ('users_guests', 'Гости', 'Guests', 'अतिथि'),
    ('users_blocked', 'Заблокированные', 'Blocked', 'अवरुद्ध'),

    -- Управление пользователями - действия
    ('approve', 'Одобрить', 'Approve', 'अनुमोदित करें'),
    ('reject', 'Отклонить', 'Reject', 'अस्वीकार करें'),
    ('block_user', 'Заблокировать', 'Block', 'ब्लॉक करें'),
    ('unblock_user', 'Разблокировать', 'Unblock', 'अनब्लॉक करें'),
    ('manage_user', 'Управление', 'Manage', 'प्रबंधित करें'),
    ('view_user', 'Просмотр', 'View', 'देखें'),

    -- Роли и права
    ('assign_role', 'Назначить роль', 'Assign Role', 'भूमिका सौंपें'),
    ('manage_permissions', 'Управление правами', 'Manage Permissions', 'अनुमतियाँ प्रबंधित करें'),
    ('roles', 'Роли', 'Roles', 'भूमिकाएँ'),
    ('permissions', 'Права', 'Permissions', 'अनुमतियाँ'),
    ('individual_permissions', 'Индивидуальные права', 'Individual Permissions', 'व्यक्तिगत अनुमतियाँ'),
    ('add_permission', 'Добавить право', 'Add Permission', 'अनुमति जोड़ें'),
    ('remove_permission', 'Убрать право', 'Remove Permission', 'अनुमति हटाएं'),

    -- Типы пользователей
    ('superuser', 'Суперпользователь', 'Superuser', 'सुपर यूजर'),
    ('staff', 'Команда', 'Staff', 'कर्मचारी'),
    ('guest', 'Гость', 'Guest', 'अतिथि'),
    ('user_type', 'Тип пользователя', 'User Type', 'उपयोगकर्ता प्रकार'),

    -- Статусы одобрения
    ('approval_status', 'Статус одобрения', 'Approval Status', 'अनुमोदन स्थिति'),
    ('status_pending', 'Ожидает', 'Pending', 'लंबित'),
    ('status_approved', 'Одобрен', 'Approved', 'अनुमोदित'),
    ('status_rejected', 'Отклонён', 'Rejected', 'अस्वीकृत'),
    ('status_blocked', 'Заблокирован', 'Blocked', 'अवरुद्ध'),

    -- Модалка управления пользователем
    ('user_management_modal_title', 'Управление пользователем', 'User Management', 'उपयोगकर्ता प्रबंधन'),
    ('user_active', 'Активен', 'Active', 'सक्रिय'),
    ('user_inactive', 'Неактивен', 'Inactive', 'निष्क्रिय'),
    ('is_superuser', 'Суперпользователь', 'Superuser', 'सुपर यूजर'),
    ('grant_superuser', 'Сделать суперпользователем', 'Grant Superuser', 'सुपर यूजर बनाएं'),

    -- Сообщения
    ('approve_confirm', 'Одобрить регистрацию этого пользователя?', 'Approve this user registration?', 'इस उपयोगकर्ता पंजीकरण को अनुमोदित करें?'),
    ('reject_confirm', 'Отклонить регистрацию этого пользователя?', 'Reject this user registration?', 'इस उपयोगकर्ता पंजीकरण को अस्वीकार करें?'),
    ('block_confirm', 'Заблокировать этого пользователя?', 'Block this user?', 'इस उपयोगकर्ता को ब्लॉक करें?'),
    ('user_approved', 'Пользователь одобрен', 'User approved', 'उपयोगकर्ता अनुमोदित'),
    ('user_rejected', 'Пользователь отклонён', 'User rejected', 'उपयोगकर्ता अस्वीकृत'),
    ('user_blocked', 'Пользователь заблокирован', 'User blocked', 'उपयोगकर्ता अवरुद्ध'),
    ('changes_saved', 'Изменения сохранены', 'Changes saved', 'परिवर्तन सहेजे गए'),

    -- Поиск и фильтры
    ('search_users', 'Поиск пользователей...', 'Search users...', 'उपयोगकर्ता खोजें...'),
    ('filter_by_type', 'Фильтр по типу', 'Filter by Type', 'प्रकार से फ़िल्टर करें'),
    ('filter_by_status', 'Фильтр по статусу', 'Filter by Status', 'स्थिति से फ़िल्टर करें'),

    -- Таблица пользователей
    ('user_photo', 'Фото', 'Photo', 'फ़ोटो'),
    ('user_name', 'Имя', 'Name', 'नाम'),
    ('user_email', 'Email', 'Email', 'ईमेल'),
    ('user_roles_list', 'Роли', 'Roles', 'भूमिकाएँ'),
    ('user_actions', 'Действия', 'Actions', 'क्रियाएँ'),
    ('last_login', 'Последний вход', 'Last Login', 'अंतिम लॉगिन'),
    ('registered_at', 'Дата регистрации', 'Registration Date', 'पंजीकरण तिथि'),

    -- Роли Housing модуля
    ('role_administrator', 'Администратор', 'Administrator', 'व्यवस्थापक'),
    ('role_reception_manager', 'Менеджер ресепшн', 'Reception Manager', 'रिसेप्शन प्रबंधक'),
    ('role_placement_manager', 'Менеджер размещения', 'Placement Manager', 'प्लेसमेंट प्रबंधक'),
    ('role_receptionist', 'Администратор', 'Receptionist', 'रिसेप्शनिस्ट'),
    ('role_cleaner', 'Уборщик', 'Cleaner', 'सफाई कर्मचारी'),
    ('role_team_coordinator', 'Координатор команды', 'Team Coordinator', 'टीम समन्वयक'),
    ('role_observer', 'Наблюдатель', 'Observer', 'पर्यवेक्षक'),
    ('role_guest', 'Гость', 'Guest', 'अतिथि')

ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;
