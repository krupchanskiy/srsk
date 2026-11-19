-- Исправление суммы заявки из чата во «Входящих» (ВГ 19.11.2026).
-- Раньше неверно прочитанную сумму («8 310» → 310) можно было только отклонить
-- и внести заново. Теперь фин-админ правит сумму до проведения; первоначальная
-- сумма бота хранится в amount_original, а в пояснение заявки дописывается
-- «сумма исправлена: 310 → 8 310 ₹» — оно уходит в комментарий операции и в ответ в чате.

ALTER TABLE tg_drafts ADD COLUMN IF NOT EXISTS amount_original numeric;
COMMENT ON COLUMN tg_drafts.amount_original IS
  'Сумма, которую прочитал бот, если фин-админ исправил её во «Входящих» (806); NULL — не исправлялась';

CREATE OR REPLACE FUNCTION public.tg_set_draft_amount(p_id uuid, p_amount numeric)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
DECLARE
  v_d tg_drafts%ROWTYPE;
  v_amount numeric := round(p_amount, 2);
  v_orig numeric;
  v_note text;
BEGIN
  IF NOT fin_is_admin(auth.uid()) THEN RETURN jsonb_build_object('ok', false, 'error', 'forbidden'); END IF;
  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', false, 'error', 'Сумма должна быть больше нуля');
  END IF;

  SELECT * INTO v_d FROM tg_drafts WHERE id = p_id AND status = 'pending' FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'not_found_or_resolved'); END IF;
  IF v_amount = v_d.amount THEN RETURN jsonb_build_object('ok', true); END IF;

  v_orig := COALESCE(v_d.amount_original, v_d.amount);
  -- прежняя отметка об исправлении заменяется, а не копится при повторной правке
  v_note := NULLIF(btrim(regexp_replace(COALESCE(v_d.note, ''), '( · )?сумма исправлена: [^·]*', '', 'g')), '');
  IF v_amount <> v_orig THEN
    v_note := concat_ws(' · ', v_note, format('сумма исправлена: %s → %s',
      fin_fmt_money(v_orig, v_d.currency), fin_fmt_money(v_amount, v_d.currency)));
  END IF;

  UPDATE tg_drafts
     SET amount = v_amount,
         amount_original = CASE WHEN v_amount = v_orig THEN NULL ELSE v_orig END,
         note = v_note
   WHERE id = p_id;

  RETURN jsonb_build_object('ok', true);
END;
$function$;

REVOKE ALL ON FUNCTION tg_set_draft_amount(uuid, numeric) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tg_set_draft_amount(uuid, numeric) TO authenticated, service_role;

-- В представление «Входящих» — первоначальная сумма (колонка в конце, остальные как в 800)
CREATE OR REPLACE VIEW fin_v_chat_drafts AS
 SELECT t.id,
    t.chat_id,
    t.source_message_id,
    t.kind,
    t.amount,
    t.currency,
    t.raw_text,
    t.purpose,
    c.name AS category,
    a.name AS source_account,
    t.created_at,
    COALESCE(d.name, ac.title) AS department,
    td.name AS target_department,
    COALESCE(NULLIF(v.spiritual_name, ''::text), TRIM(BOTH FROM ((COALESCE(v.first_name, ''::text) || ' '::text) || COALESCE(v.last_name, ''::text)))) AS author,
    t.category_id,
    t.department_id,
    t.target_department_id,
    t.source_account_id,
    t.note,
    t.occurred_on,
    t.amount_original
   FROM ((((((tg_drafts t
     LEFT JOIN fin_departments d ON ((d.id = t.department_id)))
     LEFT JOIN tg_account_chats ac ON ((ac.chat_id = t.chat_id)))
     LEFT JOIN fin_departments td ON ((td.id = t.target_department_id)))
     LEFT JOIN fin_categories c ON ((c.id = t.category_id)))
     LEFT JOIN fin_accounts a ON ((a.id = t.source_account_id)))
     LEFT JOIN vaishnavas v ON ((v.id = t.author_vaishnava_id)))
  WHERE ((t.status = 'pending'::text) AND ((d.id IS NOT NULL) OR (ac.chat_id IS NOT NULL)) AND fin_can_read_all(auth.uid()));
