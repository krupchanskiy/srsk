-- Этап 5: agreed_with в витрине начислений.
-- CREATE OR REPLACE не может вставить колонку в середину — пересоздаём view.
-- Он security-баррьерный только логикой WHERE fin_can_read_all(), политик на нём нет.
DROP VIEW public.fin_v_charges;
CREATE VIEW public.fin_v_charges AS
 SELECT id,
    participant_id,
    fin_private_person_name(participant_id) AS participant_name,
    retreat_id,
    kind,
    description,
    quantity,
    unit_price,
    amount,
    discount_amount,
    amount - discount_amount AS net_amount,
    discount_reason,
    agreed_with,
    is_cancelled,
    cancelled_reason,
    creation_reason,
    created_at
   FROM fin_charges c
  WHERE fin_can_read_all();
