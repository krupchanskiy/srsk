-- ============================================
-- Таблица ретритов
-- ============================================

CREATE TABLE IF NOT EXISTS retreats (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name_ru VARCHAR(255) NOT NULL,
    name_en VARCHAR(255),
    name_hi VARCHAR(255),
    description_ru TEXT,
    description_en TEXT,
    description_hi TEXT,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    expected_participants INTEGER DEFAULT 0,
    color VARCHAR(7) DEFAULT '#6366f1',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Добавляем недостающие колонки если таблица уже существовала
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS expected_participants INTEGER DEFAULT 0;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS color VARCHAR(7) DEFAULT '#6366f1';
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS description_ru TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS description_en TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS description_hi TEXT;
ALTER TABLE retreats ADD COLUMN IF NOT EXISTS name_hi VARCHAR(255);

-- RLS
ALTER TABLE retreats ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read retreats" ON retreats;
DROP POLICY IF EXISTS "Public insert retreats" ON retreats;
DROP POLICY IF EXISTS "Public update retreats" ON retreats;
DROP POLICY IF EXISTS "Public delete retreats" ON retreats;

CREATE POLICY "Public read retreats" ON retreats FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert retreats" ON retreats FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update retreats" ON retreats FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete retreats" ON retreats FOR DELETE TO anon USING (true);

-- Индекс для быстрого поиска по датам
CREATE INDEX IF NOT EXISTS idx_retreats_dates ON retreats(start_date, end_date);

-- ============================================
-- Переводы для страницы ретритов
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('retreats_title', 'Ретриты', 'Retreats', 'रिट्रीट', 'retreats'),
    ('upcoming_retreats', 'Предстоящие', 'Upcoming', 'आगामी', 'retreats'),
    ('past_retreats', 'Прошедшие', 'Past', 'पिछले', 'retreats'),
    ('all_retreats', 'Все', 'All', 'सभी', 'retreats'),
    ('view_list', 'Список', 'List', 'सूची', 'retreats'),
    ('view_calendar', 'Календарь', 'Calendar', 'कैलेंडर', 'retreats'),
    ('add_retreat', 'Добавить ретрит', 'Add retreat', 'रिट्रीट जोड़ें', 'retreats'),
    ('edit_retreat', 'Редактировать ретрит', 'Edit retreat', 'रिट्रीट संपादित करें', 'retreats'),
    ('retreat_name', 'Название', 'Name', 'नाम', 'retreats'),
    ('retreat_description', 'Описание', 'Description', 'विवरण', 'retreats'),
    ('retreat_dates', 'Даты', 'Dates', 'तारीखें', 'retreats'),
    ('retreat_start', 'Начало', 'Start', 'शुरू', 'retreats'),
    ('retreat_end', 'Окончание', 'End', 'समाप्त', 'retreats'),
    ('retreat_participants', 'Участники', 'Participants', 'प्रतिभागी', 'retreats'),
    ('expected_participants', 'Ожидаемое кол-во', 'Expected number', 'अपेक्षित संख्या', 'retreats'),
    ('retreat_color', 'Цвет', 'Color', 'रंग', 'retreats'),
    ('days', 'дн.', 'days', 'दिन', 'retreats'),
    ('participants_short', 'чел.', 'ppl', 'लोग', 'retreats'),
    ('no_retreats', 'Нет ретритов', 'No retreats', 'कोई रिट्रीट नहीं', 'retreats'),
    ('delete_retreat', 'Удалить ретрит', 'Delete retreat', 'रिट्रीट हटाएं', 'retreats'),
    ('delete_retreat_confirm', 'Удалить этот ретрит?', 'Delete this retreat?', 'इस रिट्रीट को हटाएं?', 'retreats'),
    ('today', 'Сегодня', 'Today', 'आज', 'retreats'),
    ('month_jan', 'Январь', 'January', 'जनवरी', 'retreats'),
    ('month_feb', 'Февраль', 'February', 'फ़रवरी', 'retreats'),
    ('month_mar', 'Март', 'March', 'मार्च', 'retreats'),
    ('month_apr', 'Апрель', 'April', 'अप्रैल', 'retreats'),
    ('month_may', 'Май', 'May', 'मई', 'retreats'),
    ('month_jun', 'Июнь', 'June', 'जून', 'retreats'),
    ('month_jul', 'Июль', 'July', 'जुलाई', 'retreats'),
    ('month_aug', 'Август', 'August', 'अगस्त', 'retreats'),
    ('month_sep', 'Сентябрь', 'September', 'सितंबर', 'retreats'),
    ('month_oct', 'Октябрь', 'October', 'अक्टूबर', 'retreats'),
    ('month_nov', 'Ноябрь', 'November', 'नवंबर', 'retreats'),
    ('month_dec', 'Декабрь', 'December', 'दिसंबर', 'retreats'),
    ('weekday_mon', 'Пн', 'Mon', 'सोम', 'retreats'),
    ('weekday_tue', 'Вт', 'Tue', 'मंगल', 'retreats'),
    ('weekday_wed', 'Ср', 'Wed', 'बुध', 'retreats'),
    ('weekday_thu', 'Чт', 'Thu', 'गुरु', 'retreats'),
    ('weekday_fri', 'Пт', 'Fri', 'शुक्र', 'retreats'),
    ('weekday_sat', 'Сб', 'Sat', 'शनि', 'retreats'),
    ('weekday_sun', 'Вс', 'Sun', 'रवि', 'retreats')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;

-- Тестовые данные
INSERT INTO retreats (name_ru, name_en, start_date, end_date, expected_participants, color, description_ru, description_en) VALUES
    ('Картика', 'Kartika', '2025-10-20', '2025-11-15', 150, '#f59e0b', 'Месяц Картика — особое время духовной практики', 'Kartika month — special time for spiritual practice'),
    ('Гаура Пурнима', 'Gaura Purnima', '2025-03-10', '2025-03-16', 200, '#ec4899', 'Празднование явления Шри Чайтаньи Махапрабху', 'Celebration of Sri Chaitanya Mahaprabhu appearance'),
    ('Джанмаштами', 'Janmashtami', '2025-08-14', '2025-08-18', 180, '#3b82f6', 'Празднование явления Шри Кришны', 'Celebration of Sri Krishna appearance'),
    ('Новогодний ретрит', 'New Year Retreat', '2025-12-28', '2026-01-05', 100, '#10b981', 'Встречаем Новый год в духовной атмосфере', 'Welcoming New Year in spiritual atmosphere')
ON CONFLICT DO NOTHING;
