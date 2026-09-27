-- Открытие карточки участника сдвигало долги Сева-ретрита (ВГ, 27.09)
--
-- При открытии карточки fin_sync_charges_from_crm пересчитывает авто-начисления
-- из CRM. crm_calc_participation брала даты проживания только у записей
-- residents со статусом active/confirmed; после выезда статус checked_out, и
-- расчёт подставлял даты ретрита. Так у Яшасвини Радхи питание стало 15 дней
-- вместо 9 (долг ₹4 200), у Гаурачандры — 15 вместо 17 (аванс ₹1 400), у Ольги
-- Библис 15.09 — 15 вместо 10 (долг ₹3 500). Сухой прогон: открытие остальных
-- карточек сдвинуло бы ещё 32 человека (от −₹9 800 до +₹10 500).
--
-- 1. Сева-ретрит (старая система расчёта, миграция 553) сведён — авто-пересчёт
--    начислений для него больше не запускается. Ручные правки — как раньше.
-- 2. crm_calc_participation видит и выехавших (checked_out) — для будущих событий
--    и для показа в CRM.

do $$
declare
  v_def text := pg_get_functiondef('public.fin_sync_charges_from_crm(uuid,uuid)'::regprocedure);
  v_anchor text := '    select id into v_deal from crm_deals';
begin
  if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
    raise exception 'anchor not unique in fin_sync_charges_from_crm';
  end if;
  execute replace(v_def, v_anchor,
'    -- Старая система расчёта (Сева-ретрит): событие сведено, начисления заморожены
    if exists (select 1 from fin_accounting_objects
                where retreat_id = p_retreat and legacy_inr_settlement) then
        return jsonb_build_object(''ok'', true, ''result'', jsonb_build_object(
            ''frozen'', true, ''created'', 0, ''updated'', 0, ''kept_manual'', 0), ''warnings'', ''[]''::jsonb);
    end if;

' || v_anchor);
end $$;

do $$
declare
  v_def text := pg_get_functiondef('public.crm_calc_participation(uuid)'::regprocedure);
  v_old text := $a$status in ('active', 'confirmed')$a$;
begin
  if (length(v_def) - length(replace(v_def, v_old, ''))) / length(v_old) <> 1 then
    raise exception 'status filter not unique in crm_calc_participation';
  end if;
  execute replace(v_def, v_old, $a$status in ('active', 'confirmed', 'checked_out')$a$);
end $$;
