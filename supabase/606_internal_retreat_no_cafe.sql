-- 606: внутренний ретрит сам выключает «Участвует в кассе кафе» (ВГ, 01.10.2026)
--
-- Два признака живут в разных местах: «Внутренний ретрит» — в Аналитике
-- (fin_prasad_settings.is_internal), касса кафе — в карточке ретрита
-- (retreats.cafe_eligible). Чтобы не забыть второе, отметка «внутренний»
-- выключает кафе сама. Только в момент отметки: включить кафе обратно
-- вручную можно, снятие «внутренний» кафе не трогает.

create or replace function public.fin_internal_retreat_no_cafe()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
begin
  -- fin_set_prasad_settings пишет is_internal при каждом сохранении —
  -- реагируем только на переход «не внутренний → внутренний»
  if tg_op = 'UPDATE' and old.is_internal then return new; end if;
  update retreats set cafe_eligible = false
   where id = new.retreat_id and cafe_eligible;
  return new;
end;
$function$;

drop trigger if exists trg_fin_internal_retreat_no_cafe on public.fin_prasad_settings;
create trigger trg_fin_internal_retreat_no_cafe
  after insert or update of is_internal on public.fin_prasad_settings
  for each row
  when (new.is_internal)
  execute function fin_internal_retreat_no_cafe();
