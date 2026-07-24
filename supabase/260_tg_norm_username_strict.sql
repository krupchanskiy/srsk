-- Строгая нормализация ника: принимаем только настоящий формат Telegram
-- (буква, потом 4–31 из букв/цифр/подчёркиваний). Иначе NULL.
--
-- Зачем строго: в поле telegram у людей лежит что угодно — телефоны, e-mail.
-- Мягкая обрезка превращала «Akshara.das.hariboll@gmail.com» в «akshara»,
-- то есть в чужой возможный ник. Ложная привязка расхода не тому человеку
-- дороже, чем лишнее нажатие кнопки.
CREATE OR REPLACE FUNCTION tg_norm_username(p_raw text)
RETURNS text LANGUAGE sql IMMUTABLE
SET search_path TO 'public'
AS $$
  SELECT CASE
    WHEN u ~ '^[a-z][a-z0-9_]{4,31}$' THEN u
    ELSE NULL
  END
  FROM (
    SELECT lower(trim(regexp_replace(coalesce(p_raw,''), '^\s*(https?://)?((www\.)?t(elegram)?\.me/)?@?', '', 'i'))) AS u
  ) s
$$;
