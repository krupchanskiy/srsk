-- =============================================================
-- Финмодуль, Этап 7: покрывающие индексы для FK (perf-advisors,
-- 18 находок). Закрываем до боевого объёма cutover.
-- =============================================================

CREATE INDEX IF NOT EXISTS fin_account_access_account_idx      ON fin_account_access (account_id);
CREATE INDEX IF NOT EXISTS fin_accounts_currency_idx           ON fin_accounts (currency_code);
CREATE INDEX IF NOT EXISTS fin_accounts_default_cc_idx         ON fin_accounts (default_cost_center_id) WHERE default_cost_center_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_accounts_responsible_idx        ON fin_accounts (responsible_person_id) WHERE responsible_person_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_attachments_posting_idx         ON fin_attachments (posting_id) WHERE posting_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_charges_retreat_idx             ON fin_charges (retreat_id);
CREATE INDEX IF NOT EXISTS fin_contractors_contact_idx         ON fin_contractors (contact_id) WHERE contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_exchange_rates_currency_idx     ON fin_exchange_rates (from_currency);
CREATE INDEX IF NOT EXISTS fin_closures_attachment_idx         ON fin_object_closures (attachment_id) WHERE attachment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_operations_payer_idx            ON fin_operations (payer_contact_id) WHERE payer_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_operations_refund_recipient_idx ON fin_operations (refund_recipient_contact_id) WHERE refund_recipient_contact_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_pob_corrects_idx                ON fin_participant_opening_balances (corrects_opening_balance_id) WHERE corrects_opening_balance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_pob_retreat_idx                 ON fin_participant_opening_balances (retreat_id);
CREATE INDEX IF NOT EXISTS fin_postings_category_idx           ON fin_postings (category_id) WHERE category_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_postings_contractor_idx         ON fin_postings (contractor_id) WHERE contractor_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_postings_cost_center_idx        ON fin_postings (cost_center_id) WHERE cost_center_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS fin_postings_currency_idx           ON fin_postings (currency_code);
CREATE INDEX IF NOT EXISTS fin_reconciliations_adjustment_idx  ON fin_reconciliations (adjustment_operation_id) WHERE adjustment_operation_id IS NOT NULL;
