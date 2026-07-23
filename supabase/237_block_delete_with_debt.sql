-- =============================================================
-- Решение ВГ (вопрос 7, 23.07.2026): «да, это будет не лишним».
-- Запрет помечать человека удалённым, пока за ним числится
-- непогашенный долг в финмодуле. Сценарий — склейка дублей:
-- удаление записи спрятало бы реальный долг из списков должников
-- и семейных финансов. Сначала долг переносят на основную запись
-- (или гасят), потом удаляют.
-- =============================================================

-- Суммарный долг человека по всем ретритам. Внутренняя функция для
-- триггера: собирает ретриты, где у человека есть финансовая жизнь
-- (начисления, входящие остатки, проводки), и складывает total_debt
-- по каждому — той же формулой, что видят участники и портал.
CREATE OR REPLACE FUNCTION public.fin_private_participant_total_debt(p_participant uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  r record;
  v_total numeric := 0;
BEGIN
  FOR r IN
    SELECT DISTINCT retreat_id FROM (
      SELECT retreat_id FROM fin_charges
      WHERE participant_id = p_participant AND NOT is_cancelled
      UNION
      SELECT retreat_id FROM fin_participant_opening_balances
      WHERE participant_id = p_participant
      UNION
      SELECT o.retreat_id FROM fin_postings p
      JOIN fin_accounting_objects o ON o.id = p.object_id
      WHERE p.participant_id = p_participant
        AND p.participant_balance_kind IS NOT NULL
        AND p.participant_balance_kind <> 'none'
    ) x
    WHERE retreat_id IS NOT NULL
  LOOP
    v_total := v_total + COALESCE(
      (fin_private_participant_balance(p_participant, r.retreat_id)->>'total_debt')::numeric, 0);
  END LOOP;
  RETURN v_total;
END;
$function$;
REVOKE ALL ON FUNCTION public.fin_private_participant_total_debt(uuid) FROM PUBLIC, anon, authenticated;

-- Сторож удаления: и мягкого (is_deleted), и жёсткого (DELETE).
-- Служебный путь (auth.uid() IS NULL — миграции, обслуживание) не проверяется.
CREATE OR REPLACE FUNCTION public.vaishnavas_block_delete_with_debt()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $function$
DECLARE
  v_id uuid := COALESCE(OLD.id, NEW.id);
  v_debt numeric;
BEGIN
  IF auth.uid() IS NULL THEN
    RETURN COALESCE(NEW, OLD);
  END IF;
  v_debt := fin_private_participant_total_debt(v_id);
  IF v_debt > 0 THEN
    RAISE EXCEPTION 'has_unpaid_debt'
      USING DETAIL = format('За человеком числится непогашенный долг ₹%s. Перенесите долг на основную запись или погасите его, затем удаляйте.', v_debt);
  END IF;
  RETURN COALESCE(NEW, OLD);
END;
$function$;

DROP TRIGGER IF EXISTS trg_vaishnavas_block_softdelete_with_debt ON vaishnavas;
CREATE TRIGGER trg_vaishnavas_block_softdelete_with_debt
  BEFORE UPDATE OF is_deleted ON vaishnavas
  FOR EACH ROW
  WHEN (NEW.is_deleted AND NOT OLD.is_deleted)
  EXECUTE FUNCTION vaishnavas_block_delete_with_debt();

DROP TRIGGER IF EXISTS trg_vaishnavas_block_harddelete_with_debt ON vaishnavas;
CREATE TRIGGER trg_vaishnavas_block_harddelete_with_debt
  BEFORE DELETE ON vaishnavas
  FOR EACH ROW
  EXECUTE FUNCTION vaishnavas_block_delete_with_debt();

-- Понятное сообщение в интерфейсе
INSERT INTO translations (key, ru, en, hi) VALUES
  ('person_delete_has_debt',
   'Нельзя удалить: за человеком числится непогашенный долг. Сначала перенесите долг на основную запись или погасите его.',
   'Cannot delete: this person has an unpaid debt. Transfer the debt to the main record or settle it first.',
   'हटाया नहीं जा सकता: इस व्यक्ति पर बकाया है। पहले बकाया मुख्य रिकॉर्ड में स्थानांतरित करें या चुकाएँ।')
ON CONFLICT (key) DO UPDATE SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi;
