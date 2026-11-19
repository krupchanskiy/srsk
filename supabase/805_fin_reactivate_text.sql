-- Кнопка «Вернуть из архива» на странице «Счета» (ВГ, 19.11.2026): замороженную кассу
-- (например «Касса ДДС у ГХ» после передачи) можно вернуть в работу. Сама база это
-- уже позволяла (fin_update_account с is_active = true); архивировать по-прежнему
-- можно только счёт с нулевым остатком (account_balance_not_zero).
INSERT INTO translations (key, ru, en, hi, context)
VALUES ('fin_reactivate', 'Вернуть из архива', 'Restore from archive', 'संग्रह से वापस लाएँ', 'Кнопка')
ON CONFLICT (key) DO NOTHING;
