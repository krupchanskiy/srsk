-- Замечание ВГ от 26.07.2026: «не понятно, с какого ретрита пришла оплата».
-- В общей ленте ДДС видно плательщика (он в комментарии), но не объект учёта.
-- В режиме одного счёта колонка «Ретрит» есть — в общей ленте её не было,
-- хотя это тот же журнал.
--
-- Операция может задевать несколько объектов (расход одной операцией на два
-- ретрита) — поэтому перечисляем через запятую, как и счета.

CREATE OR REPLACE VIEW public.fin_v_operations AS
 SELECT o.id AS operation_id,
    o.type,
    o.occurred_on,
    o.approval,
    o.is_reversed,
    o.original_operation_id,
    o.payer_contact_id,
    fin_private_person_name(o.payer_contact_id) AS payer_name,
    o.reason,
    o.comment,
    o.created_by,
    o.created_at,
    o.created_at::date > o.occurred_on AS is_late,
    agg.has_post_close,
    agg.accounts_count,
    agg.max_ledger_seq,
    agg.amounts_by_currency,
    (EXISTS ( SELECT 1
           FROM fin_attachments att
          WHERE att.parent_type = 'operation'::fin_attachment_parent_type AND att.parent_id = o.id)) AS has_attachments,
    CASE
      WHEN agg.acc_out IS NOT NULL AND agg.acc_in IS NOT NULL THEN agg.acc_out || ' → ' || agg.acc_in
      ELSE COALESCE(agg.acc_out, agg.acc_in)
    END AS accounts,
    agg.objects
   FROM fin_operations o
     JOIN LATERAL ( SELECT bool_or(p.is_post_close) AS has_post_close,
            count(DISTINCT p.account_id) AS accounts_count,
            max(p.ledger_seq) AS max_ledger_seq,
            string_agg(DISTINCT regexp_replace(a.name, '\s*\((₹|₽|\$|€)\)\s*$', ''), ', ')
              FILTER (WHERE p.direction = 'out'::fin_direction) AS acc_out,
            string_agg(DISTINCT regexp_replace(a.name, '\s*\((₹|₽|\$|€)\)\s*$', ''), ', ')
              FILTER (WHERE p.direction = 'in'::fin_direction) AS acc_in,
            ( SELECT string_agg(DISTINCT ob.display_name, ', ')
                FROM fin_postings po
                JOIN fin_accounting_objects ob ON ob.id = po.object_id
               WHERE po.operation_id = o.id ) AS objects,
            ( SELECT jsonb_object_agg(x.currency_code, x.total) AS jsonb_object_agg
                   FROM ( SELECT pp.currency_code,
                                CASE
                                    WHEN o.type = 'transfer'::fin_operation_type THEN sum(pp.amount) FILTER (WHERE pp.direction = 'in'::fin_direction)
                                    ELSE sum(
                                    CASE pp.direction
                                      WHEN 'in'::fin_direction THEN pp.amount
                                      ELSE - pp.amount
                                    END)
                                END AS total
                           FROM fin_postings pp
                          WHERE pp.operation_id = o.id
                          GROUP BY pp.currency_code) x
                  WHERE x.total IS NOT NULL) AS amounts_by_currency
           FROM fin_postings p
           JOIN fin_accounts a ON a.id = p.account_id
          WHERE p.operation_id = o.id) agg ON true
  WHERE fin_can_read_all() AND NOT (EXISTS ( SELECT 1
           FROM fin_postings pr
             JOIN fin_accounts ar ON ar.id = pr.account_id
          WHERE pr.operation_id = o.id AND ar.is_restricted AND NOT (EXISTS ( SELECT 1
                   FROM fin_account_access aa
                  WHERE aa.account_id = ar.id AND aa.user_id = auth.uid()))));

NOTIFY pgrst, 'reload schema';
