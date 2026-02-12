-- ============================================
-- Переводы для публичной страницы ретрита
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('retreat_not_found', 'Ретрит не найден', 'Retreat not found', 'रिट्रीट नहीं मिला', 'retreat'),
    ('retreat_not_found_hint', 'Проверьте ссылку или вернитесь на главную', 'Check the link or go back home', 'लिंक जांचें या होम पेज पर वापस जाएं', 'retreat'),
    ('retreat_go_home', 'На главную', 'Go home', 'होम पेज', 'retreat'),
    ('retreat_register_btn', 'Подать заявку', 'Apply', 'आवेदन करें', 'retreat'),
    ('retreat_registration_closed', 'Регистрация на этот ретрит закрыта', 'Registration for this retreat is closed', 'इस रिट्रीट के लिए पंजीकरण बंद है', 'retreat'),
    ('retreat_already_registered', 'Вы уже зарегистрированы на этот ретрит', 'You are already registered for this retreat', 'आप पहले से इस रिट्रीट के लिए पंजीकृत हैं', 'retreat'),
    ('retreat_view_my_retreats', 'Мои ретриты', 'My retreats', 'मेरे रिट्रीट', 'retreat'),
    ('retreat_registration_title', 'Регистрация на ретрит', 'Retreat registration', 'रिट्रीट पंजीकरण', 'retreat'),
    ('retreat_enter_email', 'Введите ваш email', 'Enter your email', 'अपना ईमेल दर्ज करें', 'retreat'),
    ('retreat_email_hint', 'Мы проверим, есть ли у вас аккаунт', 'We will check if you have an account', 'हम जांचेंगे कि आपका खाता है या नहीं', 'retreat'),
    ('retreat_welcome_back', 'Добро пожаловать обратно,', 'Welcome back,', 'वापसी पर स्वागत है,', 'retreat'),
    ('retreat_login_hint', 'Войдите, чтобы продолжить', 'Sign in to continue', 'जारी रखने के लिए साइन इन करें', 'retreat'),
    ('retreat_login_continue', 'Войти и продолжить', 'Sign in and continue', 'साइन इन करें और जारी रखें', 'retreat'),
    ('retreat_create_account', 'Создайте аккаунт', 'Create an account', 'खाता बनाएं', 'retreat'),
    ('retreat_application_title', 'Заявка на ретрит', 'Retreat application', 'रिट्रीट आवेदन', 'retreat'),
    ('retreat_companions', 'С кем едете', 'Traveling with', 'किसके साथ यात्रा', 'retreat'),
    ('retreat_accommodation_wishes', 'Пожелания по размещению', 'Accommodation preferences', 'आवास प्राथमिकताएं', 'retreat'),
    ('retreat_questions', 'Вопросы организаторам', 'Questions for organizers', 'आयोजकों के लिए प्रश्न', 'retreat'),
    ('retreat_submit', 'Отправить заявку', 'Submit application', 'आवेदन जमा करें', 'retreat'),
    ('retreat_success', 'Заявка отправлена!', 'Application submitted!', 'आवेदन जमा हो गया!', 'retreat'),
    ('retreat_success_hint', 'Мы свяжемся с вами для подтверждения', 'We will contact you for confirmation', 'हम पुष्टि के लिए आपसे संपर्क करेंगे', 'retreat'),
    ('use_different_email', 'Использовать другой email', 'Use a different email', 'अलग ईमेल का उपयोग करें', 'retreat'),
    ('password_hint', 'Минимум 6 символов', 'At least 6 characters', 'कम से कम 6 अक्षर', 'common'),
    ('error_password_reset_sent', 'Ссылка для сброса пароля отправлена', 'Password reset link sent', 'पासवर्ड रीसेट लिंक भेजा गया', 'common')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
