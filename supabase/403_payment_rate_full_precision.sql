-- 403: Курс «по прайсу CRM» храним без округления, базу считаем от него же —
-- иначе каждый такой платёж падал бы в сторож amount_base_wrong
-- (24 000 × округлённого 1.041667 = 25 000.01 ≠ базы 25 000.00).
do $$
declare
  src text := pg_get_functiondef('fin_create_payment(jsonb)'::regprocedure);
  anchor text := 'v_rate := round(v_price.price_inr / v_price.price_cur, 6);
        v_base := round(((r->>''amount'')::numeric) * v_price.price_inr / v_price.price_cur, 2);';
begin
  if position(anchor in src) = 0 then
    raise exception 'fin_create_payment: якорь для патча не найден';
  end if;
  src := replace(src, anchor,
    'v_rate := v_price.price_inr / v_price.price_cur;
        v_base := round(((r->>''amount'')::numeric) * v_rate, 2);');
  execute src;
end $$;
