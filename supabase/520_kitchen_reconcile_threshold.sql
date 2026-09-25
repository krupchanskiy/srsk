-- Себестоимость: порог подсветки расхождений в сверке с ДДС — настраиваемый.
-- Хранится в fin_settings (ключ kitchen_reconcile_threshold_pct), по умолчанию 15%.
-- Читать может любой вошедший, менять — только суперпользователь.
create or replace function public.kitchen_reconcile_threshold()
returns numeric language sql stable security definer set search_path = public as $$
  select coalesce((select value::numeric from fin_settings where key = 'kitchen_reconcile_threshold_pct'), 15);
$$;

create or replace function public.kitchen_set_reconcile_threshold(p_pct numeric)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not is_superuser(auth.uid()) then
    raise exception 'forbidden' using detail = 'Порог сверки меняет только суперпользователь';
  end if;
  if p_pct is null or p_pct < 1 or p_pct > 100 then
    raise exception 'invalid_payload' using detail = 'Порог — от 1 до 100%';
  end if;
  insert into fin_settings (key, value, updated_at) values ('kitchen_reconcile_threshold_pct', p_pct::text, now())
  on conflict (key) do update set value = excluded.value, updated_at = now();
end;
$$;

revoke all on function public.kitchen_reconcile_threshold() from public, anon;
revoke all on function public.kitchen_set_reconcile_threshold(numeric) from public, anon;
grant execute on function public.kitchen_reconcile_threshold() to authenticated;
grant execute on function public.kitchen_set_reconcile_threshold(numeric) to authenticated;

insert into translations (key, ru, en, hi, context) values
('cost_threshold_title', 'Порог сверки с ДДС', 'Cash-flow reconciliation threshold', 'नकदी प्रवाह मिलान सीमा', 'Себестоимость'),
('cost_threshold_hint', 'В сверке с ДДС разница подсвечивается, если расчёт и факт расходятся больше чем на этот процент. Менять может только суперпользователь.', 'In the reconciliation the difference is highlighted when calculation and actual differ by more than this percent. Only a superuser can change it.', 'मिलान में अंतर तब हाइलाइट होता है जब गणना और वास्तविक इस प्रतिशत से अधिक भिन्न हों। केवल सुपरयूज़र बदल सकता है।', 'Себестоимость')
on conflict (key) do update set ru = excluded.ru, en = excluded.en, hi = excluded.hi, context = excluded.context;
