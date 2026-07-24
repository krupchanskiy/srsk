-- Узнавание автора сообщения по нику Telegram из профиля.
--
-- Раньше бот знал человека только после явной привязки кнопкой. Но ник уже
-- заполнен в карточке у 208 человек, и ВГ справедливо считает, что «профиль
-- прописан» = бот должен его знать. Теперь так и есть: если ник из Telegram
-- совпал ровно с одной карточкой — привязка создаётся сама, молча и один раз.
--
-- Осторожность: привязываем ТОЛЬКО при однозначном совпадении. Два человека с
-- одним ником, пустой ник, номер телефона в поле — привязки не будет, бот
-- попросит нажать кнопку.

-- Ник в поле telegram хранится вразнобой: «@ник», «ник», «https://t.me/ник».
-- Приводим к единому виду; телефоны (только цифры) отбрасываем.
CREATE OR REPLACE FUNCTION tg_norm_username(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT NULLIF(
    regexp_replace(
      lower(regexp_replace(coalesce(p_raw,''), '^\s*(https?://)?((www\.)?t(elegram)?\.me/)?@?', '', 'i')),
      '[^a-z0-9_].*$', ''
    ), '')
$$;

DROP FUNCTION IF EXISTS tg_resolve_user(bigint);

CREATE FUNCTION tg_resolve_user(p_user bigint, p_username text DEFAULT NULL)
RETURNS TABLE(vaishnava_id uuid, person_name text, auto_linked boolean)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE v_id uuid; v_name text; v_norm text; v_cnt int;
BEGIN
  -- 1. Явная привязка — всегда главнее ника: ник можно сменить, привязку нет.
  SELECT u.vaishnava_id INTO v_id FROM tg_user_links u WHERE u.tg_user_id = p_user;

  -- 2. Иначе ищем по нику из профиля — строго однозначное совпадение
  IF v_id IS NULL THEN
    v_norm := tg_norm_username(p_username);
    IF v_norm IS NOT NULL AND v_norm !~ '^[0-9]+$' THEN
      SELECT count(*) INTO v_cnt FROM vaishnavas v WHERE tg_norm_username(v.telegram) = v_norm;
      IF v_cnt = 1 THEN
        SELECT v.id INTO v_id FROM vaishnavas v WHERE tg_norm_username(v.telegram) = v_norm;
        INSERT INTO tg_user_links (tg_user_id, vaishnava_id, tg_username)
        VALUES (p_user, v_id, v_norm)
        ON CONFLICT (tg_user_id) DO NOTHING;
        SELECT COALESCE(NULLIF(v.spiritual_name,''), trim(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
          INTO v_name FROM vaishnavas v WHERE v.id = v_id;
        RETURN QUERY SELECT v_id, v_name, true;
        RETURN;
      END IF;
    END IF;
  END IF;

  IF v_id IS NULL THEN RETURN; END IF;

  SELECT COALESCE(NULLIF(v.spiritual_name,''), trim(COALESCE(v.first_name,'')||' '||COALESCE(v.last_name,'')))
    INTO v_name FROM vaishnavas v WHERE v.id = v_id;
  RETURN QUERY SELECT v_id, v_name, false;
END;
$$;

REVOKE ALL ON FUNCTION tg_resolve_user(bigint, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION tg_norm_username(text) FROM PUBLIC, anon;
