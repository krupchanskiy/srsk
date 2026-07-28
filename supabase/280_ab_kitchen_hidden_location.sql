-- Скрытая кухонная локация AB Kitchen.
-- Она не отображается в общей навигации и открывается только через /ab-kitchen/.

INSERT INTO public.locations (slug, name_ru, name_en, name_hi, color)
VALUES (
    'ab-kitchen',
    'AB Kitchen',
    'AB Kitchen',
    'AB Kitchen',
    '#f49800'
)
ON CONFLICT (slug) DO UPDATE SET
    name_ru = EXCLUDED.name_ru,
    name_en = EXCLUDED.name_en,
    name_hi = EXCLUDED.name_hi,
    color = EXCLUDED.color,
    updated_at = NOW();
