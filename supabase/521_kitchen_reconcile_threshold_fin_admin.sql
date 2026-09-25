-- Порог сверки меняет финансовый администратор (fin_admin), а не суперпользователь:
-- суперпользователь — это полный доступ к модулям, но не к финансам.
create or replace function public.kitchen_set_reconcile_threshold(p_pct numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not fin_is_admin(auth.uid()) then
    raise exception 'forbidden' using detail = 'Порог сверки меняет только финансовый администратор';
  end if;
  if p_pct is null or p_pct < 1 or p_pct > 100 then
    raise exception 'invalid_payload' using detail = 'Порог — от 1 до 100%';
  end if;
  insert into fin_settings (key, value, updated_at) values ('kitchen_reconcile_threshold_pct', p_pct::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

update translations set
  ru = 'В сверке с ДДС разница подсвечивается, если расчёт и факт расходятся больше чем на этот процент. Менять может только финансовый администратор.',
  en = 'In the reconciliation the difference is highlighted when calculation and actual differ by more than this percent. Only a finance administrator can change it.',
  hi = 'मिलान में अंतर तब हाइलाइट होता है जब गणना और वास्तविक इस प्रतिशत से अधिक भिन्न हों। केवल वित्त प्रशासक बदल सकता है।'
where key = 'cost_threshold_hint';
