-- ============================================
-- Переводы для страницы редактирования рецепта
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    -- Основные действия
    ('edit_recipe', 'Редактирование рецепта', 'Edit Recipe', 'रेसिपी संपादित करें', 'recipe-edit'),
    ('new_recipe', 'Новый рецепт', 'New Recipe', 'नई रेसिपी', 'recipe-edit'),
    ('save', 'Сохранить', 'Save', 'सहेजें', 'recipe-edit'),
    ('cancel', 'Отмена', 'Cancel', 'रद्द करें', 'recipe-edit'),
    ('delete_recipe', 'Удалить рецепт', 'Delete Recipe', 'रेसिपी हटाएं', 'recipe-edit'),
    ('delete_confirm', 'Удалить этот рецепт? Это действие нельзя отменить.', 'Delete this recipe? This action cannot be undone.', 'यह रेसिपी हटाएं? इसे पूर्ववत नहीं किया जा सकता।', 'recipe-edit'),
    ('save_error', 'Ошибка сохранения', 'Save error', 'सहेजने में त्रुटि', 'recipe-edit'),
    ('delete_error', 'Ошибка удаления', 'Delete error', 'हटाने में त्रुटि', 'recipe-edit'),

    -- Секции формы
    ('section_basic', 'Основная информация', 'Basic Information', 'मूल जानकारी', 'recipe-edit'),
    ('section_ingredients', 'Ингредиенты', 'Ingredients', 'सामग्री', 'recipe-edit'),
    ('section_instructions', 'Приготовление', 'Instructions', 'विधि', 'recipe-edit'),

    -- Поля формы
    ('field_photo', 'Фото', 'Photo', 'फोटो', 'recipe-edit'),
    ('photo_hint', 'Нажмите для загрузки', 'Click to upload', 'अपलोड करने के लिए क्लिक करें', 'recipe-edit'),
    ('field_translit', 'Транслитерация (IAST)', 'Transliteration (IAST)', 'लिप्यंतरण (IAST)', 'recipe-edit'),
    ('field_category', 'Категория', 'Category', 'श्रेणी', 'recipe-edit'),
    ('field_time', 'Время (мин)', 'Time (min)', 'समय (मिनट)', 'recipe-edit'),
    ('field_output', 'Выход', 'Output', 'उत्पादन', 'recipe-edit'),
    ('field_portion', 'Порция', 'Portion', 'पोर्शन', 'recipe-edit'),
    ('field_description', 'Описание', 'Description', 'विवरण', 'recipe-edit'),

    -- Ингредиенты
    ('add_product', 'Добавить продукт', 'Add product', 'उत्पाद जोड़ें', 'recipe-edit'),
    ('nothing_found', 'Ничего не найдено', 'Nothing found', 'कुछ नहीं मिला', 'recipe-edit'),
    ('product_already_added', 'Этот продукт уже добавлен', 'This product is already added', 'यह उत्पाद पहले से जोड़ा गया है', 'recipe-edit'),

    -- Инструкции
    ('add_step', 'Добавить шаг', 'Add step', 'चरण जोड़ें', 'recipe-edit'),
    ('no_steps', 'Добавьте шаги приготовления', 'Add cooking steps', 'खाना पकाने के चरण जोड़ें', 'recipe-edit'),

    -- Кнопка редактирования на странице просмотра
    ('edit', 'Редактировать', 'Edit', 'संपादित करें', 'recipe')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
