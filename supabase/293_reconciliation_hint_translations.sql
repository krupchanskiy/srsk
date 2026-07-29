-- Замечание ВГ от 26.07.2026: на чистом бланке сверки сразу горело
-- «Расхождение не устранено» на всю сумму счёта. Человек ничего не вводил,
-- а система уже сообщала о недостаче — отсюда «мне логика не понятна».
INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_recon_enter_hint', 'Введите, сколько денег на руках: по купюрам или общей суммой.',
   'Enter how much cash is on hand: by denomination or as a total.',
   'बताएँ कि हाथ में कितना है: नोटों के हिसाब से या कुल राशि।', 'Сверка'),
  ('fin_recon_matches', 'Сходится с расчётом', 'Matches the expected balance',
   'गणना से मेल खाता है', 'Сверка')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
