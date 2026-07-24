-- Утечка через ленту оборотного счёта: перевод «ИП ШРСК → Подушка» оставляет
-- на ИП ШРСК видимую расходную строку (обязана быть видна — иначе сверка ИП
-- не сойдётся), но её комментарий мог назвать подушку. Маскируем: если у
-- операции есть проводка на ограниченный счёт, невидимый этому пользователю,
-- то в его ленте комментарий и причина такой строки заменяются на нейтральные.
-- Сумма и остаток остаются настоящими — сверка честная, назначение скрыто.
CREATE OR REPLACE VIEW public.fin_v_account_ledger AS
SELECT p.id AS posting_id, p.ledger_seq, p.operation_id, o.type, o.approval, o.is_reversed,
    o.occurred_on, o.created_at,
    CASE WHEN v_hidden.hidden THEN 'Перевод' ELSE o.comment END AS comment,
    CASE WHEN v_hidden.hidden THEN NULL ELSE o.reason END AS reason,
    o.created_at::date > o.occurred_on AS is_late,
    p.account_id, a.name AS account_name, p.currency_code, p.direction, p.amount,
    CASE p.direction WHEN 'in'::fin_direction THEN p.amount ELSE - p.amount END AS signed_amount,
    p.amount_base, p.rate_used, p.category_id, cat.name AS category_name,
    p.cost_center_id, cc.name AS cost_center_name, p.object_id, obj.display_name AS object_name,
    p.participant_id, fin_private_person_name(p.participant_id) AS participant_name,
    p.contractor_id, con.name AS contractor_name, p.payment_channel, p.is_post_close,
    sum(CASE p.direction WHEN 'in'::fin_direction THEN p.amount ELSE - p.amount END)
        OVER (PARTITION BY p.account_id ORDER BY p.ledger_seq) AS running_balance,
    fin_private_analytics_hash(p.category_id, p.cost_center_id, p.object_id, p.participant_id, p.participant_balance_kind, p.contractor_id) AS analytics_hash,
    p.participant_balance_kind
FROM fin_postings p
JOIN fin_operations o ON o.id = p.operation_id
JOIN fin_accounts a ON a.id = p.account_id
LEFT JOIN fin_categories cat ON cat.id = p.category_id
LEFT JOIN fin_cost_centers cc ON cc.id = p.cost_center_id
LEFT JOIN fin_accounting_objects obj ON obj.id = p.object_id
LEFT JOIN fin_contractors con ON con.id = p.contractor_id
JOIN LATERAL (
  SELECT EXISTS (
    SELECT 1 FROM fin_postings pr
    JOIN fin_accounts ar ON ar.id = pr.account_id
    WHERE pr.operation_id = p.operation_id
      AND ar.is_restricted
      AND NOT EXISTS (SELECT 1 FROM fin_account_access aa
                      WHERE aa.account_id = ar.id AND aa.user_id = auth.uid())
  ) AS hidden
) v_hidden ON true
WHERE fin_can_see_account(p.account_id);
REVOKE ALL ON public.fin_v_account_ledger FROM anon;
GRANT SELECT ON public.fin_v_account_ledger TO authenticated;
