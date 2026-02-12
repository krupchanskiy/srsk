-- Разрешить пользователям обновлять свой telegram_chat_id
-- Это нужно для кнопки "Отключить Telegram" в Guest Portal

-- Создаём политику UPDATE для telegram_chat_id
-- Пользователь может обновлять только свой telegram_chat_id
CREATE POLICY "vaishnavas_update_own_telegram_chat_id"
ON public.vaishnavas
FOR UPDATE
TO authenticated
USING (
  user_id = auth.uid()
)
WITH CHECK (
  user_id = auth.uid()
);

-- Комментарий
COMMENT ON POLICY "vaishnavas_update_own_telegram_chat_id" ON public.vaishnavas IS
'Пользователи могут обновлять свой telegram_chat_id (подключение/отключение Telegram бота)';
