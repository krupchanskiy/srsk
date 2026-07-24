-- Правки ВГ: валюту спрашивать всегда, если не названа; если признаков
-- траты нет, а сумма есть — переспросить. Заявка рождается неполной,
-- карточка становится мини-диалогом. (Полный текст — в applied migration.)
ALTER TABLE tg_drafts ALTER COLUMN kind DROP NOT NULL;
ALTER TABLE tg_drafts ALTER COLUMN currency DROP NOT NULL;
ALTER TABLE tg_drafts ALTER COLUMN currency DROP DEFAULT;
