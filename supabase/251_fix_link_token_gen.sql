-- gen_random_bytes живёт в extensions, а функция закреплена на search_path=public
-- и его не видит. Берём встроенный gen_random_uuid — токен той же стойкости.
CREATE OR REPLACE FUNCTION public.tg_gen_link_token(p_vaishnava uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_uid uuid; v_own uuid; v_token text;
BEGIN
  v_uid := auth.uid();
  IF v_uid IS NULL THEN RAISE EXCEPTION 'unauthorized'; END IF;
  SELECT id INTO v_own FROM vaishnavas WHERE user_id = v_uid;
  IF v_own IS DISTINCT FROM p_vaishnava AND NOT has_permission(v_uid, 'edit_vaishnava') THEN
    RAISE EXCEPTION 'forbidden' USING DETAIL = 'Привязать можно только свой Telegram или при праве edit_vaishnava';
  END IF;
  v_token := replace(gen_random_uuid()::text, '-', '');
  INSERT INTO tg_link_tokens (token, vaishnava_id) VALUES (v_token, p_vaishnava);
  RETURN v_token;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_gen_link_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_gen_link_token(uuid) TO authenticated;
