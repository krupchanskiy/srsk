-- Вариант В (решения ВГ): состав группы сделки получает ссылку на человека
-- из справочника. Членов можно по-прежнему вписывать текстом (гостей без
-- записи в базе), но в «Объединить в семью» попадают только выбранные из
-- справочника с семейным видом связи.
ALTER TABLE crm_deal_members ADD COLUMN IF NOT EXISTS vaishnava_id uuid REFERENCES vaishnavas(id);
COMMENT ON COLUMN crm_deal_members.vaishnava_id IS
'Ссылка на человека в справочнике (вариант В семейной интеграции). NULL — член группы вписан текстом, в объединение в семью не попадает.';

INSERT INTO translations (key, ru, en, hi) VALUES
  ('crm_member_pick_person', 'Выбрать из базы (для семьи) или вписать имя', 'Pick from the database (for family) or type a name', 'परिवार हेतु डेटाबेस से चुनें या नाम लिखें'),
  ('crm_rel_parent', 'Родитель', 'Parent', 'माता-पिता'),
  ('crm_rel_sibling', 'Брат/сестра', 'Sibling', 'भाई/बहन'),
  ('crm_make_family', 'Объединить в семью', 'Link as family', 'परिवार के रूप में जोड़ें'),
  ('crm_family_links_created', 'Связей создано', 'Links created', 'संबंध बनाए गए'),
  ('crm_family_links_skipped', 'уже были', 'already existed', 'पहले से थे'),
  ('crm_family_nobody', 'Некого объединять: нужны члены из базы с семейной связью (супруг, ребёнок, родитель, брат/сестра)', 'Nobody to link: need members picked from the database with a family relation (spouse, child, parent, sibling)', 'जोड़ने के लिए कोई नहीं: डेटाबेस से पारिवारिक संबंध वाले सदस्य चाहिए'),
  ('crm_in_database', 'в базе', 'in database', 'डेटाबेस में')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
