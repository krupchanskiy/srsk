-- Переводы для magic link авторизации в guest-portal

INSERT INTO translations (key, ru, en, hi) VALUES
    ('portal_tab_password', 'По паролю', 'Password', 'पासवर्ड'),
    ('portal_tab_magic', 'По ссылке', 'Email link', 'ईमेल लिंक'),
    ('portal_magic_hint', 'Мы отправим ссылку для входа на вашу почту', 'We will send a login link to your email', 'हम आपके ईमेल पर लॉगिन लिंक भेजेंगे'),
    ('portal_send_link', 'Отправить ссылку', 'Send link', 'लिंक भेजें'),
    ('portal_link_sent', 'Ссылка отправлена!', 'Link sent!', 'लिंक भेज दिया गया!'),
    ('portal_check_email', 'Проверьте вашу почту и перейдите по ссылке', 'Check your email and click the link', 'अपना ईमेल जांचें और लिंक पर क्लिक करें'),
    ('portal_send_again', 'Отправить ещё раз', 'Send again', 'फिर से भेजें'),
    ('error_not_registered', 'Этот email не зарегистрирован. Пожалуйста, зарегистрируйтесь.', 'This email is not registered. Please sign up.', 'यह ईमेल पंजीकृत नहीं है। कृपया साइन अप करें।'),
    ('error_send_failed', 'Не удалось отправить ссылку. Попробуйте позже.', 'Failed to send link. Please try again.', 'लिंक भेजने में विफल। कृपया पुनः प्रयास करें।')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi;
