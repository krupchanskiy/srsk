-- ============================================
-- ТАБЛИЦА ЗАКУПЩИКОВ
-- ============================================

-- Создаём таблицу если не существует
CREATE TABLE IF NOT EXISTS buyers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    phone TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- RLS
ALTER TABLE buyers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all for buyers" ON buyers;
CREATE POLICY "Allow all for buyers" ON buyers FOR ALL USING (true) WITH CHECK (true);

-- Удаляем дубликаты если есть (оставляем первую запись по каждому имени)
DELETE FROM buyers a USING buyers b
WHERE a.id > b.id AND a.name = b.name;

-- ============================================
-- ПЕРЕВОДЫ
-- ============================================

INSERT INTO translations (key, ru, en, hi, context) VALUES
('dict_buyers', 'Закупщики', 'Buyers', 'खरीदार', 'Справочники'),
('col_name', 'Имя', 'Name', 'नाम', 'Колонка таблицы'),
('col_phone', 'Телефон', 'Phone', 'फ़ोन', 'Колонка таблицы')

ON CONFLICT (key) DO UPDATE SET
    ru = excluded.ru,
    en = excluded.en,
    hi = excluded.hi,
    context = excluded.context;
