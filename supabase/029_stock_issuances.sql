-- ============================================
-- ТАБЛИЦА ВЫДАЧ СО СКЛАДА
-- ============================================

-- Основная таблица выдач
CREATE TABLE IF NOT EXISTS stock_issuances (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID REFERENCES locations(id),
    number SERIAL,
    issuance_date DATE NOT NULL DEFAULT CURRENT_DATE,
    purpose TEXT, -- цель выдачи (приготовление, мероприятие и т.д.)
    notes TEXT,
    archived BOOLEAN DEFAULT FALSE,
    deleted BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Позиции выдачи
CREATE TABLE IF NOT EXISTS stock_issuance_items (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    issuance_id UUID REFERENCES stock_issuances(id) ON DELETE CASCADE,
    product_id UUID REFERENCES products(id),
    quantity DECIMAL(10,3) NOT NULL, -- в граммах
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE stock_issuances ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_issuance_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for stock_issuances" ON stock_issuances;
CREATE POLICY "Allow all for stock_issuances" ON stock_issuances FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow all for stock_issuance_items" ON stock_issuance_items;
CREATE POLICY "Allow all for stock_issuance_items" ON stock_issuance_items FOR ALL USING (true) WITH CHECK (true);

-- Индексы
CREATE INDEX IF NOT EXISTS idx_stock_issuances_location ON stock_issuances(location_id);
CREATE INDEX IF NOT EXISTS idx_stock_issuances_date ON stock_issuances(issuance_date);
CREATE INDEX IF NOT EXISTS idx_stock_issuance_items_issuance ON stock_issuance_items(issuance_id);

-- ============================================
-- ПЕРЕВОДЫ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
-- Страница выдачи - заголовки и вкладки
('issuance_title', 'Выдать продукты', 'Issue Products', 'उत्पाद जारी करें', 'Заголовок'),
('new_issuance_tab', 'Новая выдача', 'New issuance', 'नया जारी', 'Вкладка'),
('saved_issuances_tab', 'Сохранённые', 'Saved', 'सहेजे गए', 'Вкладка'),
('archived_issuances_tab', 'Архивные', 'Archived', 'संग्रहीत', 'Вкладка'),
('deleted_issuances_tab', 'Удалённые', 'Deleted', 'हटाए गए', 'Вкладка'),

-- Форма
('issuance_date', 'Дата выдачи', 'Issuance date', 'जारी करने की तारीख', 'Форма'),
('issuance_purpose', 'Цель выдачи', 'Purpose', 'उद्देश्य', 'Форма'),
('purpose_cooking', 'Приготовление', 'Cooking', 'खाना बनाना', 'Цель'),
('purpose_event', 'Мероприятие', 'Event', 'कार्यक्रम', 'Цель'),
('purpose_other', 'Другое', 'Other', 'अन्य', 'Цель'),
('save_issuance', 'Сохранить выдачу', 'Save issuance', 'जारी सहेजें', 'Кнопка'),

-- Карточки
('issuance', 'Выдача', 'Issuance', 'जारी', 'Карточка'),
('no_issuances', 'Нет сохранённых выдач', 'No saved issuances', 'कोई सहेजी गई जारी नहीं', 'Пустое состояние'),
('issuances_empty', 'Нет выдач в архиве', 'No archived issuances', 'कोई संग्रहीत जारी नहीं', 'Пустое состояние'),
('deleted_issuances_empty', 'Нет удалённых выдач', 'No deleted issuances', 'कोई हटाई गई जारी नहीं', 'Пустое состояние'),

-- Информационные сообщения
('issuance_completed_info', 'Выдача проведена, склад обновлён', 'Issuance completed, stock updated', 'जारी पूर्ण, स्टॉक अपडेट किया गया', 'Информация'),
('issuance_cancelled_info', 'Выдача отменена, склад не изменялся', 'Issuance cancelled, stock was not changed', 'जारी रद्द, स्टॉक नहीं बदला', 'Информация'),

-- Навигация
('nav_issue', 'Выдать', 'Issue', 'जारी करना', 'Навигация'),

-- Страница выдачи - выбор режима
('issue_from_menu_title', 'Выдать из меню', 'Issue from menu', 'मेनू से जारी', 'Карточка'),
('issue_from_menu_desc', 'Рассчитать продукты на основе меню на день', 'Calculate products based on daily menu', 'दैनिक मेनू के आधार पर उत्पादों की गणना करें', 'Карточка'),
('issue_manual_title', 'Выдать вручную', 'Issue manually', 'मैन्युअल रूप से जारी', 'Карточка'),
('issue_manual_desc', 'Ввести продукты для выдачи вручную', 'Enter products for issuance manually', 'जारी करने के लिए मैन्युअल रूप से उत्पाद दर्ज करें', 'Карточка'),
('create_issue', 'Создать выдачу', 'Create issuance', 'जारी बनाएं', 'Кнопка'),
('new_issue', 'Новая выдача', 'New issuance', 'नया जारी', 'Заголовок'),
('back', 'Назад', 'Back', 'वापस', 'Кнопка'),

-- Загрузка из меню
('from_menu', 'Из меню', 'From menu', 'मेनू से', 'Кнопка'),
('load_from_menu', 'Загрузить из меню', 'Load from menu', 'मेनू से लोड करें', 'Заголовок'),
('date', 'Дата', 'Date', 'तारीख', 'Форма'),
('meal_type', 'Приём пищи', 'Meal', 'भोजन', 'Форма'),
('load', 'Загрузить', 'Load', 'लोड करें', 'Кнопка'),
('select_meal', 'Выберите хотя бы один приём пищи', 'Select at least one meal', 'कम से कम एक भोजन चुनें', 'Валидация'),
('no_menu_for_date', 'На выбранную дату меню не найдено', 'No menu found for selected date', 'चयनित तारीख के लिए कोई मेनू नहीं मिला', 'Сообщение'),
('no_ingredients', 'Для выбранных приёмов пищи нет блюд', 'No dishes for selected meals', 'चयनित भोजन के लिए कोई व्यंजन नहीं', 'Сообщение'),
('load_error', 'Ошибка загрузки', 'Load error', 'लोड त्रुटि', 'Ошибка'),
('insufficient_stock', 'Недостаточно на складе', 'Insufficient stock', 'स्टॉक में अपर्याप्त', 'Валидация')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
