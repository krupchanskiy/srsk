-- 743: зачёт прасада спонсору — в целых рупиях (ВГ 23.10.2026: «чтобы не было хвостов»).
-- Себестоимость прасада — расчёт по меню (₹347 513,74), отсюда пайсы на счёте спонсора.
-- Траты — настоящие деньги, их не трогаем; округляется только расчётный прасад.
-- Прежний зачёт с пайсами сторнируется и проводится заново целым.

DO $mig$
DECLARE
  v_def text;
  v_new text;
  r record;
BEGIN
  v_def := pg_get_functiondef('fin_private_sponsor_sync(uuid)'::regprocedure);
  v_new := replace(v_def,
    $s$SELECT round(COALESCE((data->>'included')::numeric, 0), 2) INTO v_target$s$,
    $s$SELECT round(COALESCE((data->>'included')::numeric, 0)) INTO v_target$s$);
  IF v_new = v_def THEN RAISE EXCEPTION 'fin_private_sponsor_sync: шаблон не найден'; END IF;
  EXECUTE v_new;

  PERFORM set_config('tg.suppress_chat_notify', '1', true);
  FOR r IN SELECT offset_operation_id FROM fin_sponsor_offsets
            WHERE kind = 'prasad' AND is_active AND amount <> round(amount) LOOP
    PERFORM fin_private_sponsor_reverse(r.offset_operation_id, 'Прасад спонсору — в целых рупиях');
  END LOOP;
  FOR r IN SELECT retreat_id FROM fin_retreat_sponsors LOOP
    PERFORM fin_private_sponsor_sync(r.retreat_id);
  END LOOP;
END
$mig$;
