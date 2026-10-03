-- 630: аванс группы → общий платёж на карточке организатора (ВГ, 03.10.2026).
-- Раньше аванс («Предоплата/Аванс» на событие без человека) только вычитался в окне
-- группы и в сводке, а карточка организатора его не видела: долг на всю сумму.
-- Теперь «Начислить» переносит его на организатора: сторно прихода + платёж
-- участника в блок «Общий» (тот же счёт, дата, комментарий). Общий платёж гасит
-- блоки по приоритету (оргвзнос → проживание → питание), как у всех участников.
-- Сменился организатор — перенесённый аванс переходит к новому.
-- fin_group_get отдаёт и перенесённый аванс (moved = true), чтобы окно и сводка
-- его показывали, но не вычитали второй раз.

do $mig$
declare
    v_def text;
    v_anchor text := $a$    if not v_legacy then
        select o_currency into v_cur from fin_private_settlement_currency(v_payer, v_ret.id);$a$;
    v_new text := $n$    -- аванс события → общий платёж организатора (630)
    declare
        c_adv constant text := 'Аванс группы: перенесён на карточку организатора';
        a record; v_r jsonb;
    begin
        for a in
            select o.id, o.type, o.occurred_on, o.comment, p.account_id, p.amount, p.payment_channel
              from fin_operations o
              join fin_postings p on p.operation_id = o.id
             where p.object_id = v_obj and p.direction = 'in' and not o.is_reversed
               and ((o.type = 'income' and o.original_operation_id is null and p.participant_id is null
                     and p.category_id = '659c37b8-54dd-4bc1-a4be-ce2a771b6829')
                 or (o.type = 'payment' and o.reason = c_adv and p.participant_id <> v_payer))
               and (select count(*) from fin_postings x where x.operation_id = o.id) = 1
             order by o.occurred_on, o.created_at
        loop
            v_r := fin_create_reversal(jsonb_build_object(
                'request_id', md5(a.id::text || ':' || v_payer::text || ':adv-rev')::uuid,
                'original_operation_id', a.id,
                'occurred_on_policy', 'same_as_original',
                'reason', case when a.type = 'payment'
                               then 'Перераспределение платежа: аванс группы — другой организатор'
                               else c_adv end));
            if not coalesce((v_r->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_r->'error'->>'code', 'internal_error')
                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось сторнировать');
            end if;
            v_r := fin_create_payment(jsonb_build_object(
                'request_id', md5(a.id::text || ':' || v_payer::text || ':adv-pay')::uuid,
                'occurred_on', a.occurred_on,
                'payer_contact_id', v_payer,
                'comment', a.comment,
                'reason', c_adv,
                'rows', jsonb_build_array(jsonb_build_object(
                    'id', md5(a.id::text || ':' || v_payer::text || ':adv-row')::uuid,
                    'account_id', a.account_id, 'amount', a.amount,
                    'participant_id', v_payer, 'object_id', v_obj,
                    'participant_balance_kind', 'general',
                    'payment_channel', a.payment_channel))));
            if not coalesce((v_r->>'ok')::boolean, false) then
                raise exception '%', coalesce(v_r->'error'->>'code', 'internal_error')
                    using detail = 'Аванс группы: ' || coalesce(v_r->'error'->>'message', 'не удалось провести платёж');
            end if;
        end loop;
    end;

$n$;
    v_get_old text := $g$             where ao.retreat_id = p_retreat
               and p.category_id = '659c37b8-54dd-4bc1-a4be-ce2a771b6829'
               and p.participant_id is null and p.direction = 'in'
               and not o.is_reversed and o.original_operation_id is null), '[]'::jsonb)$g$;
    v_get_new text := $g$             where ao.retreat_id = p_retreat
               and ((p.category_id = '659c37b8-54dd-4bc1-a4be-ce2a771b6829' and p.participant_id is null)
                 or (o.type = 'payment' and o.reason = 'Аванс группы: перенесён на карточку организатора'))
               and p.direction = 'in'
               and not o.is_reversed and o.original_operation_id is null), '[]'::jsonb)$g$;
begin
    v_def := pg_get_functiondef('public.fin_group_save(jsonb)'::regprocedure);
    if (length(v_def) - length(replace(v_def, v_anchor, ''))) / length(v_anchor) <> 1 then
        raise exception 'fin_group_save: место вставки не найдено';
    end if;
    execute replace(v_def, v_anchor, v_new || v_anchor);

    v_def := pg_get_functiondef('public.fin_group_get(uuid)'::regprocedure);
    if position(v_get_old in v_def) = 0 then
        raise exception 'fin_group_get: условие аванса не найдено';
    end if;
    v_def := replace(v_def, v_get_old, v_get_new);
    v_def := replace(v_def, $o$'amount_inr', p.amount_base, 'comment', o.comment, 'account', a.name$o$,
                            $o$'amount_inr', p.amount_base, 'comment', o.comment, 'account', a.name,
                'moved', p.participant_id is not null$o$);
    execute v_def;
end;
$mig$;
