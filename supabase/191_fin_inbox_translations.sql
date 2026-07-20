-- Финансовый модуль, Этап 5: переводы «Входящих», вложений и правки аналитики

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_fin_inbox', 'Входящие', 'Inbox', 'इनबॉक्स', 'Навигация Финансы'),
  ('fin_page_title_inbox', 'Входящие — Финансы — ШРСК', 'Inbox — Finance — SRSK', 'इनबॉक्स — वित्त — SRSK', 'Заголовок страницы'),
  ('fin_tab_pending', 'Не проверено', 'Pending', 'अपुष्ट', 'Входящие'),
  ('fin_tab_disputed', 'Оспоренные', 'Disputed', 'विवादित', 'Входящие'),
  ('fin_approve', 'Подтвердить', 'Approve', 'पुष्टि करें', 'Входящие'),
  ('fin_dispute', 'Оспорить', 'Dispute', 'विवाद करें', 'Входящие'),
  ('fin_return_pending', 'Вернуть в «не проверено»', 'Return to pending', 'अपुष्ट में लौटाएँ', 'Входящие'),
  ('fin_dispute_reason', 'Причина спора', 'Dispute reason', 'विवाद का कारण', 'Входящие'),
  ('fin_no_pending', 'Нет операций на согласование', 'No operations awaiting approval', 'अनुमोदन हेतु कोई गतिविधि नहीं', 'Входящие'),
  ('fin_no_disputed', 'Нет оспоренных операций', 'No disputed operations', 'कोई विवादित गतिविधि नहीं', 'Входящие'),
  ('fin_attachments', 'Вложения', 'Attachments', 'संलग्नक', 'Финансы'),
  ('fin_attach_file', 'Прикрепить файл', 'Attach file', 'फ़ाइल संलग्न करें', 'Финансы'),
  ('fin_edit_analytics', 'Изменить аналитику', 'Edit analytics', 'विश्लेषण बदलें', 'Финансы')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
