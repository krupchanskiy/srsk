-- 687: пояснение проводящего (686) — ещё и в ответе бота в чате (ВГ, 13.10.2026).
-- Человек, написавший «Палатка», видит в чате, как его запись поняли.
-- Правка точечная через replace() по текущему телу функций: тела длинные,
-- меняются 2–3 строки; каждая замена проверяется, иначе миграция падает.

DO $mig$
DECLARE v_def text; v_new text;
BEGIN
  -- 1) Обычное проведение: сообщение шлёт триггер tg_notify_dept_credit
  v_def := pg_get_functiondef('tg_notify_dept_credit'::regproc);
  v_new := replace(v_def, '  v_who text;
BEGIN', '  v_who text;
  v_note text; v_note_who text;
BEGIN');
  v_new := replace(v_new, '         dr.id
    INTO v_purpose, v_reply_to, v_src_chat, v_dr', '         dr.id,
         NULLIF(btrim(dr.note), '''')
    INTO v_purpose, v_reply_to, v_src_chat, v_dr, v_note');
  v_new := replace(v_new, '  IF v_who IS NOT NULL THEN
    v_text := v_text || format(E''\nПровёл: %s'', tg_escape(v_who));', '  -- пояснение пишет тот, кто проводит прямо сейчас (auth.uid())
  IF v_note IS NOT NULL THEN
    SELECT COALESCE(NULLIF(v.spiritual_name, ''''),
                    NULLIF(TRIM(COALESCE(v.first_name,'''') || '' '' || COALESCE(v.last_name,'''')), ''''))
      INTO v_note_who FROM vaishnavas v WHERE v.user_id = auth.uid() LIMIT 1;
    v_text := v_text || format(E''\nПояснение%s: %s'',
                               COALESCE('' ('' || tg_escape(v_note_who) || '')'', ''''), tg_escape(v_note));
  END IF;

  IF v_who IS NOT NULL THEN
    v_text := v_text || format(E''\nПровёл: %s'', tg_escape(v_who));');
  IF v_new = v_def OR (length(v_new) - length(v_def)) < 400 THEN
    RAISE EXCEPTION 'tg_notify_dept_credit: замены не применились';
  END IF;
  EXECUTE v_new;

  -- 2) Разбивка/выдача «уже потрачено»: tg_post_draft шлёт своё сообщение сам
  v_def := pg_get_functiondef('tg_post_draft(uuid,jsonb,uuid,text)'::regprocedure);
  v_new := replace(v_def, '  v_note text; v_note_who text;', '  v_note text; v_note_who text; v_note_tg text := '''';');
  v_new := replace(v_new, '  IF v_suppress THEN
    IF v_has_dept THEN', '  IF v_note IS NOT NULL THEN
    v_note_tg := format(E''\nПояснение%s: %s'',
                        COALESCE('' ('' || tg_escape(v_note_who) || '')'', ''''), tg_escape(v_note));
  END IF;

  IF v_suppress THEN
    IF v_has_dept THEN');
  v_new := replace(v_new, '        || format(E''\nНа руках у', '        || v_note_tg
        || format(E''\nНа руках у');
  IF (length(v_new) - length(v_def)) < 200
     OR (length(v_new) - length(replace(v_new, '|| v_note_tg', ''))) / length('|| v_note_tg') <> 3 THEN
    RAISE EXCEPTION 'tg_post_draft: замены не применились';
  END IF;
  EXECUTE v_new;
END
$mig$;
