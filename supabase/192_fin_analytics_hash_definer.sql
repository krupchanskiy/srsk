-- Фикс Этапа 5: fin_private_analytics_hash вызывается из view с правами
-- вызывающего и внутри обращается к fin_private_hash, закрытому для
-- authenticated → permission denied. SECURITY DEFINER решает, не открывая
-- сам fin_private_hash.

ALTER FUNCTION fin_private_analytics_hash(uuid, uuid, uuid, uuid, fin_participant_balance_kind, uuid)
  SECURITY DEFINER SET search_path = public;
