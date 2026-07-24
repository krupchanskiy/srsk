-- Самопривязка Telegram: кнопка в профиле генерит одноразовый токен,
-- человек жмёт Start в боте → бот связывает его Telegram с вайшнавом.
CREATE TABLE IF NOT EXISTS tg_link_tokens (
  token text PRIMARY KEY,
  vaishnava_id uuid NOT NULL REFERENCES vaishnavas(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now() + interval '30 minutes',
  used_at timestamptz,
  used_by_tg bigint
);
ALTER TABLE tg_link_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON tg_link_tokens FROM PUBLIC, anon, authenticated;

-- Сгенерировать токен. Право: свой профиль ИЛИ edit_vaishnava.
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
  v_token := encode(gen_random_bytes(9), 'hex');
  INSERT INTO tg_link_tokens (token, vaishnava_id) VALUES (v_token, p_vaishnava);
  RETURN v_token;
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_gen_link_token(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_gen_link_token(uuid) TO authenticated;

-- Применить токен (из вебхука на /start <token>)
CREATE OR REPLACE FUNCTION public.tg_use_link_token(p_token text, p_tg_user bigint, p_username text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $function$
DECLARE v_tok tg_link_tokens%ROWTYPE; v_name text;
BEGIN
  SELECT * INTO v_tok FROM tg_link_tokens WHERE token = p_token FOR UPDATE;
  IF NOT FOUND THEN RETURN jsonb_build_object('ok', false, 'error', 'bad_token'); END IF;
  IF v_tok.used_at IS NOT NULL THEN RETURN jsonb_build_object('ok', false, 'error', 'used'); END IF;
  IF v_tok.expires_at < now() THEN RETURN jsonb_build_object('ok', false, 'error', 'expired'); END IF;
  INSERT INTO tg_user_links (tg_user_id, vaishnava_id, tg_username)
  VALUES (p_tg_user, v_tok.vaishnava_id, p_username)
  ON CONFLICT (tg_user_id) DO UPDATE SET vaishnava_id = EXCLUDED.vaishnava_id, tg_username = EXCLUDED.tg_username;
  UPDATE tg_link_tokens SET used_at = now(), used_by_tg = p_tg_user WHERE token = p_token;
  SELECT COALESCE(NULLIF(spiritual_name,''), trim(COALESCE(first_name,'')||' '||COALESCE(last_name,'')))
    INTO v_name FROM vaishnavas WHERE id = v_tok.vaishnava_id;
  RETURN jsonb_build_object('ok', true, 'name', v_name);
END;
$function$;
REVOKE ALL ON FUNCTION public.tg_use_link_token(text, bigint, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.tg_use_link_token(text, bigint, text) TO service_role;

CREATE OR REPLACE FUNCTION public.tg_is_linked(p_vaishnava uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT EXISTS (SELECT 1 FROM tg_user_links WHERE vaishnava_id = p_vaishnava) $$;
REVOKE ALL ON FUNCTION public.tg_is_linked(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.tg_is_linked(uuid) TO authenticated;

INSERT INTO translations (key, ru, en, hi) VALUES
  ('tg_link_btn', 'Привязать Telegram', 'Link Telegram', 'टेलीग्राम जोड़ें'),
  ('tg_linked', 'Telegram привязан', 'Telegram linked', 'टेलीग्राम जुड़ा है'),
  ('tg_link_open', 'Откройте бота и нажмите «Start» — привязка завершится сама', 'Open the bot and press Start — linking completes automatically', 'बॉट खोलें और Start दबाएँ — जुड़ाव अपने आप पूरा होगा')
ON CONFLICT (key) DO UPDATE SET ru=EXCLUDED.ru, en=EXCLUDED.en, hi=EXCLUDED.hi;
