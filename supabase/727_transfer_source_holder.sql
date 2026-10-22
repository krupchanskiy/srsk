-- 727: Перевод — с кого из держателей источника списаны деньги (ВГ, 22.10.2026).
-- Из Кафе в Зелёные было видно только «Кому из держателей», а списание с Кафе
-- ложилось ни на кого (holder_person_id NULL) — путаница, у кого сколько.
-- fin_create_transfer принимает source_holder_person_id (как бот: автор-держатель
-- во «Входящих»); без него — как раньше, ни на кого (сдача Кафе/Магазина).

DO $do$
DECLARE
  def text; new text; procedure_step text;
BEGIN
  def := pg_get_functiondef('public.fin_create_transfer(jsonb)'::regprocedure);
  new := def;

  procedure_step := 'ключи';
  new := replace(new, $$'source_amount', 'target_amount', 'comment', 'target_holder_person_id'$$,
                      $$'source_amount', 'target_amount', 'comment', 'target_holder_person_id', 'source_holder_person_id'$$);
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'переменная';
  new := replace(new, E'  v_target_holder uuid;\n', E'  v_target_holder uuid;\n  v_source_holder uuid;\n');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'чтение';
  new := replace(new, $$  v_target_holder := fin_private_get_uuid(payload, 'target_holder_person_id', false);$$,
                      $$  v_target_holder := fin_private_get_uuid(payload, 'target_holder_person_id', false);
  v_source_holder := fin_private_get_uuid(payload, 'source_holder_person_id', false);$$);
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'хэш';
  new := replace(new, E'  v_hash := fin_private_hash(v_canonical);',
                      $$  IF v_source_holder IS NOT NULL THEN
    v_canonical := v_canonical || jsonb_build_object('source_holder_person_id', lower(v_source_holder::text));
  END IF;
  v_hash := fin_private_hash(v_canonical);$$);
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'проверка';
  new := replace(new, E'  IF NOT v_is_admin THEN\n    IF NOT EXISTS (SELECT 1 FROM fin_account_access',
                      $$  IF v_source_holder IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM fin_department_holders
        WHERE department_id = v_source.department_id
          AND vaishnava_id = v_source_holder AND is_active) THEN
    RAISE EXCEPTION 'invalid_payload'
      USING DETAIL = 'Выбранный человек не держит наличные департамента-источника';
  END IF;

$$ || E'  IF NOT v_is_admin THEN\n    IF NOT EXISTS (SELECT 1 FROM fin_account_access');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'проводка';
  new := replace(new, 'v_source_amount, v_source.currency_code, v_source_base, v_source_rate, NULL)',
                      'v_source_amount, v_source.currency_code, v_source_base, v_source_rate, v_source_holder)');
  IF new = def THEN RAISE EXCEPTION 'fin_create_transfer: замена «%» не сработала', procedure_step; END IF;

  EXECUTE new;
END
$do$;
