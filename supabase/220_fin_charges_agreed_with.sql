-- Этап 5 интеграции: поле «согласовано с» у начисления (вопрос 7 интеграционных
-- ответов: факт согласования скидки должен быть проверяем в системе).
-- Свободный текст, а не ссылка на человека: орг-вопрос «кто согласует» ещё
-- открыт (сценарии А/Б/В), жёсткая ссылка преждевременна.
--
-- fin_create_charge переопределена целиком (CREATE OR REPLACE в применённой
-- миграции): 'agreed_with' добавлен в разрешённые ключи строки, участвует
-- в request_hash и пишется в INSERT. Прочая логика функции не менялась.
-- Полный текст функции — в применённой миграции 220 на проде
-- (SELECT pg_get_functiondef('fin_create_charge'::regproc)).

ALTER TABLE fin_charges ADD COLUMN IF NOT EXISTS agreed_with text;
COMMENT ON COLUMN fin_charges.agreed_with IS
'С кем согласовано начисление/скидка (вопрос 7 интеграционных ответов). Свободный текст до решения орг-вопроса о согласующем.';

-- Переводы этапа 5
INSERT INTO translations (key, ru, en, hi) VALUES
  ('fin_agreed_with', 'Согласовано с', 'Approved with', 'किसके साथ सहमति'),
  ('fin_days', 'Дней', 'Days', 'दिन'),
  ('fin_row_total', 'Итого по строке', 'Row total', 'पंक्ति योग')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
