-- ============================================
-- Справочник департаментов
-- ============================================

CREATE TABLE IF NOT EXISTS departments (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    name_ru VARCHAR(255) NOT NULL,
    name_en VARCHAR(255),
    name_hi VARCHAR(255),
    color VARCHAR(7) DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read departments" ON departments;
DROP POLICY IF EXISTS "Public insert departments" ON departments;
DROP POLICY IF EXISTS "Public update departments" ON departments;
DROP POLICY IF EXISTS "Public delete departments" ON departments;
CREATE POLICY "Public read departments" ON departments FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert departments" ON departments FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update departments" ON departments FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete departments" ON departments FOR DELETE TO anon USING (true);

-- Начальные департаменты
INSERT INTO departments (name_ru, name_en, color, sort_order) VALUES
    ('Кухня', 'Kitchen', '#f59e0b', 1),
    ('Пуджа', 'Puja', '#ec4899', 2),
    ('Хозяйство', 'Household', '#10b981', 3),
    ('Офис', 'Office', '#3b82f6', 4),
    ('Гостевой дом', 'Guest House', '#8b5cf6', 5),
    ('Охрана', 'Security', '#6b7280', 6)
ON CONFLICT DO NOTHING;

-- ============================================
-- Члены команды
-- ============================================

CREATE TABLE IF NOT EXISTS team_members (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    first_name VARCHAR(255) NOT NULL,
    last_name VARCHAR(255),
    spiritual_name VARCHAR(255),
    department_id UUID REFERENCES departments(id) ON DELETE SET NULL,
    phone VARCHAR(50),
    email VARCHAR(255),
    telegram VARCHAR(100),
    whatsapp VARCHAR(50),
    passport VARCHAR(50),
    birthdate DATE,
    notes TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE team_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read team_members" ON team_members;
DROP POLICY IF EXISTS "Public insert team_members" ON team_members;
DROP POLICY IF EXISTS "Public update team_members" ON team_members;
DROP POLICY IF EXISTS "Public delete team_members" ON team_members;
CREATE POLICY "Public read team_members" ON team_members FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert team_members" ON team_members FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update team_members" ON team_members FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete team_members" ON team_members FOR DELETE TO anon USING (true);

-- Добавляем недостающие колонки если таблица уже существовала
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS department_id UUID REFERENCES departments(id) ON DELETE SET NULL;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS spiritual_name VARCHAR(255);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS phone VARCHAR(50);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS email VARCHAR(255);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS telegram VARCHAR(100);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(50);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS passport VARCHAR(50);
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS birthdate DATE;
ALTER TABLE team_members ADD COLUMN IF NOT EXISTS notes TEXT;

-- Убираем NOT NULL constraint со старых полей если они есть
ALTER TABLE team_members ALTER COLUMN name_ru DROP NOT NULL;
ALTER TABLE team_members ALTER COLUMN name_en DROP NOT NULL;

CREATE INDEX IF NOT EXISTS idx_team_members_department ON team_members(department_id);

-- ============================================
-- Периоды пребывания
-- ============================================

CREATE TABLE IF NOT EXISTS team_member_stays (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    member_id UUID NOT NULL REFERENCES team_members(id) ON DELETE CASCADE,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    comment VARCHAR(255),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE team_member_stays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read team_member_stays" ON team_member_stays;
DROP POLICY IF EXISTS "Public insert team_member_stays" ON team_member_stays;
DROP POLICY IF EXISTS "Public update team_member_stays" ON team_member_stays;
DROP POLICY IF EXISTS "Public delete team_member_stays" ON team_member_stays;
CREATE POLICY "Public read team_member_stays" ON team_member_stays FOR SELECT TO anon USING (true);
CREATE POLICY "Public insert team_member_stays" ON team_member_stays FOR INSERT TO anon WITH CHECK (true);
CREATE POLICY "Public update team_member_stays" ON team_member_stays FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "Public delete team_member_stays" ON team_member_stays FOR DELETE TO anon USING (true);

CREATE INDEX IF NOT EXISTS idx_team_member_stays_member ON team_member_stays(member_id);
CREATE INDEX IF NOT EXISTS idx_team_member_stays_dates ON team_member_stays(start_date, end_date);

-- ============================================
-- Переводы
-- ============================================

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('team_title', 'Команда', 'Team', 'टीम', 'team'),
    ('add_member', 'Добавить', 'Add', 'जोड़ें', 'team'),
    ('edit_member', 'Редактировать', 'Edit', 'संपादित करें', 'team'),
    ('stat_total', 'Всего в команде', 'Total in team', 'टीम में कुल', 'team'),
    ('stat_present', 'Сейчас присутствуют', 'Currently present', 'वर्तमान में मौजूद', 'team'),
    ('stat_expected', 'Ожидаются', 'Expected', 'अपेक्षित', 'team'),
    ('filter_all', 'Все', 'All', 'सभी', 'team'),
    ('filter_present', 'Присутствуют', 'Present', 'मौजूद', 'team'),
    ('filter_absent', 'Отсутствуют', 'Absent', 'अनुपस्थित', 'team'),
    ('first_name', 'Имя', 'First name', 'नाम', 'team'),
    ('last_name', 'Фамилия', 'Last name', 'उपनाम', 'team'),
    ('spiritual_name', 'Духовное имя', 'Spiritual name', 'आध्यात्मिक नाम', 'team'),
    ('department', 'Департамент', 'Department', 'विभाग', 'team'),
    ('phone', 'Телефон', 'Phone', 'फ़ोन', 'team'),
    ('email', 'Email', 'Email', 'ईमेल', 'team'),
    ('telegram', 'Telegram', 'Telegram', 'टेलीग्राम', 'team'),
    ('whatsapp', 'WhatsApp', 'WhatsApp', 'व्हाट्सएप', 'team'),
    ('passport', 'Паспорт', 'Passport', 'पासपोर्ट', 'team'),
    ('birthdate', 'Дата рождения', 'Date of birth', 'जन्म तिथि', 'team'),
    ('notes', 'Заметки', 'Notes', 'नोट्स', 'team'),
    ('contacts', 'Контакты', 'Contacts', 'संपर्क', 'team'),
    ('documents', 'Документы', 'Documents', 'दस्तावेज़', 'team'),
    ('stays', 'Периоды присутствия', 'Stay periods', 'ठहरने की अवधि', 'team'),
    ('add_stay', 'Добавить период', 'Add period', 'अवधि जोड़ें', 'team'),
    ('arrival', 'Приезд', 'Arrival', 'आगमन', 'team'),
    ('departure', 'Отъезд', 'Departure', 'प्रस्थान', 'team'),
    ('comment', 'Комментарий', 'Comment', 'टिप्पणी', 'team'),
    ('here_now', 'Здесь', 'Here', 'यहाँ', 'team'),
    ('present_until', 'Присутствует до', 'Present until', 'तक मौजूद', 'team'),
    ('expected_on', 'Ожидается', 'Expected on', 'अपेक्षित', 'team'),
    ('no_planned_visits', 'Нет запланированных визитов', 'No planned visits', 'कोई नियोजित दौरा नहीं', 'team'),
    ('no_members', 'Никого не найдено', 'No one found', 'कोई नहीं मिला', 'team'),
    ('delete_member', 'Удалить', 'Delete', 'हटाएं', 'team'),
    ('delete_member_confirm', 'Удалить этого человека из команды?', 'Remove this person from the team?', 'इस व्यक्ति को टीम से हटाएं?', 'team'),
    ('delete_stay_confirm', 'Удалить этот период?', 'Delete this period?', 'इस अवधि को हटाएं?', 'team'),
    ('no_department', 'Без департамента', 'No department', 'कोई विभाग नहीं', 'team')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;

-- Тестовые данные
DO $$
DECLARE
    kitchen_id UUID;
    puja_id UUID;
    office_id UUID;
    member1_id UUID;
    member2_id UUID;
    member3_id UUID;
BEGIN
    SELECT id INTO kitchen_id FROM departments WHERE name_en = 'Kitchen' LIMIT 1;
    SELECT id INTO puja_id FROM departments WHERE name_en = 'Puja' LIMIT 1;
    SELECT id INTO office_id FROM departments WHERE name_en = 'Office' LIMIT 1;

    INSERT INTO team_members (first_name, last_name, spiritual_name, department_id, phone, telegram)
    VALUES ('Раджеш', 'Шарма', 'Радха Рамана дас', kitchen_id, '+91 98765 43210', '@radharamana')
    RETURNING id INTO member1_id;

    INSERT INTO team_members (first_name, last_name, spiritual_name, department_id, phone, email, telegram)
    VALUES ('Анна', 'Петрова', 'Ганга деви даси', office_id, '+7 916 123-45-67', 'anna@example.com', '@anna_ganga')
    RETURNING id INTO member2_id;

    INSERT INTO team_members (first_name, last_name, spiritual_name, department_id, phone, telegram)
    VALUES ('Михаил', 'Сидоров', 'Мадхава дас', puja_id, '+7 926 987-65-43', '@madhava_das')
    RETURNING id INTO member3_id;

    INSERT INTO team_member_stays (member_id, start_date, end_date, comment) VALUES
        (member1_id, '2024-10-01', '2025-03-31', 'Зимний сезон'),
        (member2_id, '2024-01-01', '2025-12-31', 'Постоянно'),
        (member3_id, '2025-01-10', '2025-01-25', 'Зимний ретрит'),
        (member3_id, '2025-03-01', '2025-03-20', 'Гаура-пурнима');
END $$;
