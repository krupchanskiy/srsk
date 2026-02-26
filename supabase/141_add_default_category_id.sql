-- Default category_id = 'Гость' для residents (без него бронирование падало с 400)
ALTER TABLE residents ALTER COLUMN category_id SET DEFAULT '6ad3bfdd-cb95-453a-b589-986717615736';
