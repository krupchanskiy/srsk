INSERT INTO translations (key, ru, en, hi, context) VALUES
  ('fin_participant_required', 'Укажите участника — иначе платёж не уменьшит его долг',
   'Select the participant — otherwise the payment will not reduce their debt',
   'प्रतिभागी चुनें — अन्यथा भुगतान उनका ऋण कम नहीं करेगा', 'ДДС'),
  ('fin_object_required', 'Укажите мероприятие: платёж привязывается к балансу участника по нему',
   'Select the event: the payment is tied to the participant''s balance for it',
   'कार्यक्रम चुनें: भुगतान उसी के अनुसार प्रतिभागी के शेष से जुड़ता है', 'ДДС')
ON CONFLICT (key) DO UPDATE
  SET ru = EXCLUDED.ru, en = EXCLUDED.en, hi = EXCLUDED.hi, context = EXCLUDED.context;
