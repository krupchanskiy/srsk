-- 689: Выдача департаменту с несколькими держателями — кому именно (ВГ, 14.10.2026).
-- Ашиш выдал 25 000 «Васудев Датте», а у Зелёных два держателя — приход лёг
-- «не привязано», и в /баланс эти деньги ни у кого. Имя из текста не угадываем
-- (опечатка → деньги не у того), держателя выбирает проводящий во «Входящих».
--
-- tg_post_draft получает p_target_holder:
--  • у получателя один держатель — ставим его сам;
--  • два и больше — без выбора выдача не проводится;
--  • «Выдано и сразу потрачено» (p_rows) — не трогаем: приход и расход
--    взаимно гасятся, в остатке у держателя ничего не остаётся.
-- Попутно: пустое пояснение писало в комментарий выдачи хвост « · Пояснение:»
-- (format() с NULL даёт пустую строку, а не NULL — COALESCE не срабатывал).

DO $do$
DECLARE
  def text; new text;
  procedure_step text;
BEGIN
  def := pg_get_functiondef('public.tg_post_draft(uuid, jsonb, uuid, text)'::regprocedure);
  new := def;

  procedure_step := 'заголовок';
  new := replace(new, 'p_note text DEFAULT NULL::text)',
                      'p_note text DEFAULT NULL::text, p_target_holder uuid DEFAULT NULL::uuid)');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'переменные';
  new := replace(new, 'v_note text; v_note_who text;',
                      'v_note text; v_note_who text;
  v_tgt_holder uuid; v_tgt_holders int;');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'выбор держателя';
  new := replace(new, 'v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);',
                      $$v_tgt := fin_dept_account(v_d.target_department_id, v_d.currency);

      -- кому из держателей получателя легли деньги (689)
      IF p_rows IS NULL THEN
        SELECT count(*) INTO v_tgt_holders FROM fin_department_holders
         WHERE department_id = v_d.target_department_id AND is_active;
        IF p_target_holder IS NOT NULL THEN
          IF NOT EXISTS (SELECT 1 FROM fin_department_holders
                          WHERE department_id = v_d.target_department_id
                            AND vaishnava_id = p_target_holder AND is_active) THEN
            RAISE EXCEPTION 'chat_post_failed'
              USING DETAIL = 'Выбранный человек не держит наличные департамента-получателя';
          END IF;
          v_tgt_holder := p_target_holder;
        ELSIF v_tgt_holders = 1 THEN
          SELECT vaishnava_id INTO v_tgt_holder FROM fin_department_holders
           WHERE department_id = v_d.target_department_id AND is_active;
        ELSIF v_tgt_holders > 1 THEN
          RAISE EXCEPTION 'chat_post_failed'
            USING DETAIL = 'У получателя несколько держателей — выберите, кому отданы деньги';
        END IF;
      END IF;$$);
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'метка держателя на приходе';
  new := replace(new, E'WHERE id = v_d.id AND account_id = v_acc;\n      END IF;',
                      E'WHERE id = v_d.id AND account_id = v_acc;\n      END IF;\n\n'
                   || E'      IF v_tgt_holder IS NOT NULL THEN\n'
                   || E'        UPDATE fin_postings SET holder_person_id = v_tgt_holder\n'
                   || E'         WHERE operation_id = v_main AND account_id = v_tgt AND direction = ''in'';\n'
                   || E'      END IF;');
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;
  def := new;

  procedure_step := 'пустое пояснение';
  new := replace(new, $$|| COALESCE(format(' · Пояснение%s: %s',
                                      COALESCE(' (' || v_note_who || ')', ''), v_note), '')));$$,
                      $$|| CASE WHEN v_note IS NULL THEN '' ELSE format(' · Пояснение%s: %s',
                                      COALESCE(' (' || v_note_who || ')', ''), v_note) END));$$);
  IF new = def THEN RAISE EXCEPTION 'tg_post_draft: замена «%» не сработала', procedure_step; END IF;

  DROP FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text);
  EXECUTE new;
END
$do$;

REVOKE ALL ON FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text, uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_post_draft(uuid, jsonb, uuid, text, uuid) TO authenticated, service_role;
