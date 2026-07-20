-- Финансовый модуль, Этап 6: snapshot версии закрытия для PDF + переводы

-- totals_snapshot конкретной версии (таблица deny-all — доступ через RPC)
CREATE OR REPLACE FUNCTION fin_get_closure_snapshot(p_closure uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_snap jsonb;
BEGIN
  IF NOT fin_can_read_all() THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Недостаточно прав';
  END IF;
  SELECT totals_snapshot INTO v_snap FROM fin_object_closures WHERE id = p_closure;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'invalid_payload' USING DETAIL = 'Версия закрытия не найдена';
  END IF;
  RETURN jsonb_build_object('ok', true, 'result', v_snap);
END;
$$;

REVOKE ALL ON FUNCTION fin_get_closure_snapshot(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION fin_get_closure_snapshot(uuid) TO authenticated;

INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('nav_fin_analytics', 'Аналитика', 'Analytics', 'विश्लेषण', 'Навигация Финансы'),
  ('fin_page_title_analytics', 'Аналитика — Финансы — ШРСК', 'Analytics — Finance — SRSK', 'विश्लेषण — वित्त — SRSK', 'Заголовок страницы'),
  ('fin_analytics_retreat', 'По ретриту', 'By retreat', 'रिट्रीट अनुसार', 'Аналитика'),
  ('fin_analytics_summary', 'Общая', 'Summary', 'सारांश', 'Аналитика'),
  ('fin_participants_count', 'Участники', 'Participants', 'प्रतिभागी', 'Аналитика'),
  ('fin_income', 'Приход', 'Income', 'आय', 'Аналитика'),
  ('fin_expense', 'Расход', 'Expense', 'व्यय', 'Аналитика'),
  ('fin_net', 'Сальдо', 'Net', 'शेष', 'Аналитика'),
  ('fin_income_by_category', 'Приходы по статьям', 'Income by category', 'श्रेणी अनुसार आय', 'Аналитика'),
  ('fin_expense_by_category', 'Расходы по статьям', 'Expenses by category', 'श्रेणी अनुसार व्यय', 'Аналитика'),
  ('fin_debtors', 'Должники', 'Debtors', 'बकायादार', 'Аналитика'),
  ('fin_no_debts', 'Долгов нет', 'No debts', 'कोई बकाया नहीं', 'Аналитика'),
  ('fin_no_fin_data', 'По этому ретриту ещё нет финансовых данных', 'No financial data for this retreat yet', 'इस रिट्रीट के लिए अभी वित्तीय डेटा नहीं', 'Аналитика'),
  ('fin_closure', 'Закрытие', 'Closure', 'समापन', 'Аналитика'),
  ('fin_status_open', 'Открыт', 'Open', 'खुला', 'Аналитика'),
  ('fin_status_closed', 'Финансово закрыт', 'Financially closed', 'वित्तीय रूप से बंद', 'Аналитика'),
  ('fin_report_dirty', 'Отчёт требует перевыпуска', 'Report needs reissue', 'रिपोर्ट पुनः जारी करें', 'Аналитика'),
  ('fin_close_retreat', 'Закрыть ретрит', 'Close retreat', 'रिट्रीट बंद करें', 'Аналитика'),
  ('fin_close_warning', 'После закрытия новые операции по ретриту возможны только как post-close с обязательной причиной. Убедитесь, что долги отработаны или осознанно зафиксированы.', 'After closure, new operations are only possible as post-close with a mandatory reason. Make sure debts are settled or consciously recorded.', 'बंद करने के बाद नई गतिविधियाँ केवल कारण सहित post-close के रूप में संभव हैं।', 'Аналитика'),
  ('fin_reissue', 'Перевыпустить отчёт', 'Reissue report', 'रिपोर्ट पुनः जारी करें', 'Аналитика'),
  ('fin_initial', 'первичное', 'initial', 'प्रारंभिक', 'Аналитика'),
  ('fin_finalized', 'Готов', 'Finalized', 'तैयार', 'Аналитика'),
  ('fin_report_pending', 'Отчёт формируется', 'Report pending', 'रिपोर्ट बन रही है', 'Аналитика'),
  ('fin_generate_pdf', 'Сформировать PDF', 'Generate PDF', 'PDF बनाएँ', 'Аналитика'),
  ('fin_generating_pdf', 'Формируем PDF…', 'Generating PDF…', 'PDF बन रही है…', 'Аналитика'),
  ('fin_pdf_ready', 'PDF сформирован и связан с версией', 'PDF generated and linked', 'PDF तैयार और संलग्न', 'Аналитика'),
  ('fin_pdf_failed', 'Не удалось сформировать PDF', 'PDF generation failed', 'PDF बनाने में विफल', 'Аналитика'),
  ('fin_export_csv', 'Выгрузить CSV', 'Export CSV', 'CSV निर्यात', 'Аналитика'),
  ('fin_show', 'Показать', 'Show', 'दिखाएँ', 'Аналитика'),
  ('fin_by_category', 'По статьям', 'By category', 'श्रेणी अनुसार', 'Аналитика'),
  ('fin_by_month', 'По месяцам', 'By month', 'माह अनुसार', 'Аналитика'),
  ('fin_by_object', 'По ретритам/объектам', 'By retreat/object', 'रिट्रीट/वस्तु अनुसार', 'Аналитика')
ON CONFLICT (key) DO UPDATE SET
  ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi,
  context = EXCLUDED.context, updated_at = NOW();
