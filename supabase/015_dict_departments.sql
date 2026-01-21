-- Перевод для вкладки "Департаменты" в справочниках

INSERT INTO translations (key, ru, en, hi, page) VALUES
    ('dict_departments', 'Департаменты', 'Departments', 'विभाग', 'dictionaries')
ON CONFLICT (key) DO UPDATE SET
    ru = EXCLUDED.ru,
    en = EXCLUDED.en,
    hi = EXCLUDED.hi,
    page = EXCLUDED.page;
