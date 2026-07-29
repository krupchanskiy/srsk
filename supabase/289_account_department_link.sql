-- Замечание ВГ от 26.07.2026 по ДДС: при выборе счёта департамента не видно
-- ни остатка на руках, ни сколько заявок из чатов по нему ещё не проведено.
-- Чтобы связать выбранный счёт с его департаментом, витринам не хватало
-- department_id.
--
-- fin_v_account_balances: добавлено department_id в конец.
-- fin_v_chat_drafts: добавлено department_id (category_id добавлен в 287).

CREATE OR REPLACE VIEW public.fin_v_account_balances AS
 SELECT a.id AS account_id, a.name, a.kind, a.reconciliation_mode, a.currency_code,
    a.group_name, a.responsible_person_id, a.default_cost_center_id, a.is_active,
    COALESCE(s.balance, 0::numeric)::numeric(14,2) AS balance,
    s.last_ledger_seq,
    COALESCE(s.balance, 0::numeric) < 0::numeric AS is_negative,
    r.cutoff_ledger_seq AS last_checkpoint_seq,
    r.performed_at AS last_checkpoint_at,
    ( SELECT count(*) FROM fin_postings p
       WHERE p.account_id = a.id AND p.ledger_seq > COALESCE(r.cutoff_ledger_seq, 0::bigint)) AS unreconciled_count,
    a.department_id
   FROM fin_accounts a
     LEFT JOIN ( SELECT fin_postings.account_id,
            sum(CASE fin_postings.direction WHEN 'in'::fin_direction THEN fin_postings.amount
                     ELSE - fin_postings.amount END) AS balance,
            max(fin_postings.ledger_seq) AS last_ledger_seq
           FROM fin_postings GROUP BY fin_postings.account_id) s ON s.account_id = a.id
     LEFT JOIN LATERAL ( SELECT rr.cutoff_ledger_seq, rr.performed_at
           FROM fin_reconciliations rr WHERE rr.account_id = a.id
          ORDER BY rr.performed_at DESC, rr.cutoff_ledger_seq DESC LIMIT 1) r ON true
  WHERE fin_can_see_account(a.id);

CREATE OR REPLACE VIEW public.fin_v_chat_drafts AS
  SELECT t.id, t.chat_id, t.source_message_id, t.kind, t.amount, t.currency,
         t.raw_text, t.purpose, c.name AS category, a.name AS source_account, t.created_at,
         d.name AS department, td.name AS target_department,
         COALESCE(NULLIF(v.spiritual_name, ''), TRIM(BOTH FROM COALESCE(v.first_name,'') || ' ' || COALESCE(v.last_name,''))) AS author,
         t.category_id, t.department_id
  FROM tg_drafts t
    JOIN fin_departments d ON d.id = t.department_id
    LEFT JOIN fin_departments td ON td.id = t.target_department_id
    LEFT JOIN fin_categories c ON c.id = t.category_id
    LEFT JOIN fin_accounts a ON a.id = t.source_account_id
    LEFT JOIN vaishnavas v ON v.id = t.author_vaishnava_id
  WHERE t.status = 'pending' AND fin_can_read_all(auth.uid());

NOTIFY pgrst, 'reload schema';
