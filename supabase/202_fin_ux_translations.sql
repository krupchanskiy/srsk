-- =============================================================
-- Финмодуль: переводы UX-улучшений по итогам дизайн-критики
-- (impeccable critique 20.07.2026). Кэш переводов: v10 → v11.
-- =============================================================

INSERT INTO translations (key, ru, en, hi) VALUES
('fin_network_error', 'Нет соединения с сервером. Проверьте интернет и повторите — повторное сохранение не создаст дубль', 'No connection to the server. Check your internet and retry — resubmitting will not create a duplicate', 'सर्वर से कनेक्शन नहीं है। इंटरनेट जांचें और पुनः प्रयास करें — दोबारा सहेजने से डुप्लिकेट नहीं बनेगा'),
('fin_custodial_group', 'Подотчётные', 'Custodial', 'जिम्मेदारी के खाते'),
('fin_select_category', '— выберите статью —', '— select category —', '— श्रेणी चुनें —'),
('fin_remove_row', 'Удалить строку', 'Remove row', 'पंक्ति हटाएं'),
('fin_dds_full', 'Движение денежных средств — журнал всех операций', 'Cash flow — journal of all operations', 'नकदी प्रवाह — सभी लेनदेन की पत्रिका'),
('fin_search', 'Поиск', 'Search', 'खोज'),
('fin_search_placeholder', 'Комментарий или плательщик…', 'Comment or payer…', 'टिप्पणी या भुगतानकर्ता…'),
('fin_shown_count', 'Показано', 'Shown', 'दिखाया गया'),
('fin_load_more', 'Показать ещё', 'Load more', 'और दिखाएं'),
('fin_same_account_error', 'Счёт-источник и счёт-получатель совпадают', 'Source and target accounts are the same', 'स्रोत और प्राप्तकर्ता खाते समान हैं'),
('fin_confirm_discard', 'Закрыть форму? Введённые данные будут потеряны.', 'Close the form? Entered data will be lost.', 'फ़ॉर्म बंद करें? दर्ज किया गया डेटा खो जाएगा।'),
('fin_choose_files', 'Выбрать файлы', 'Choose files', 'फ़ाइलें चुनें'),
('fin_custody_hint', 'Деньги на руках у ответственных (подотчётные счета)', 'Money held by responsible persons (custodial accounts)', 'जिम्मेदार व्यक्तियों के पास नकदी (जिम्मेदारी के खाते)'),
('fin_total_resp_hint', 'Реальные счета + выдано под отчёт, без двойного счёта', 'Real accounts + given in custody, without double counting', 'वास्तविक खाते + जिम्मेदारी में दिया गया, बिना दोहरी गिनती'),
('fin_from_general', 'зачтено из общего', 'covered from general', 'सामान्य से समायोजित'),
('fin_select_retreat_hint', 'Выберите ретрит в списке сверху', 'Select a retreat in the list above', 'ऊपर सूची में रिट्रीट चुनें'),
('fin_general_hint', 'Платежи без привязки к блоку: гасят долги по приоритету, излишек — аванс', 'Payments not tied to a block: cover debts by priority, surplus becomes advance', 'बिना ब्लॉक के भुगतान: प्राथमिकता से ऋण चुकाते हैं, शेष अग्रिम बनता है'),
('fin_color_legend', 'Красным — долг участника · зелёным — аванс (мы должны участнику)', 'Red — participant owes · green — advance (we owe the participant)', 'लाल — प्रतिभागी का ऋण · हरा — अग्रिम (हम प्रतिभागी के देनदार हैं)')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;

-- Правки существующих ключей (находки критики)
UPDATE translations SET ru = 'Центр затрат', en = 'Cost center', hi = 'लागत केंद्र' WHERE key = 'fin_cost_center';
UPDATE translations SET ru = 'Дата', en = 'Date', hi = 'दिनांक' WHERE key = 'fin_occurred_on';
