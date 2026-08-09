-- Колонка «Куда пришло» и метка платежей, принятых до переезда
insert into translations (key, ru, en, hi) values
  ('fin_where_paid', 'Куда пришло', 'Received to', 'कहाँ आया'),
  ('fin_before_cutover', 'до переезда', 'before cutover', 'स्थानांतरण से पहले')
on conflict (key) do update
   set ru = excluded.ru, en = excluded.en, hi = excluded.hi;
