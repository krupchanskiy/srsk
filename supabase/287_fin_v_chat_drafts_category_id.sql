-- Витрина отдавала только название статьи, а модалке разбивки нужен id,
-- чтобы предвыбрать текущую статью в списке.
CREATE OR REPLACE VIEW public.fin_v_chat_drafts AS
  SELECT t.id, t.chat_id, t.source_message_id, t.kind, t.amount, t.currency,
         t.raw_text, t.purpose, c.name AS category, a.name AS source_account, t.created_at,
         d.name AS department, td.name AS target_department,
         COALESCE(NULLIF(v.spiritual_name, ''), TRIM(BOTH FROM COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))) AS author,
         t.category_id
  FROM tg_drafts t
    JOIN fin_departments d ON d.id = t.department_id
    LEFT JOIN fin_departments td ON td.id = t.target_department_id
    LEFT JOIN fin_categories c ON c.id = t.category_id
    LEFT JOIN fin_accounts a ON a.id = t.source_account_id
    LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending' AND fin_can_read_all(auth.uid());

NOTIFY pgrst, 'reload schema';
