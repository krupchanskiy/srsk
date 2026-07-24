-- ВГ назвал троих поимённо. Обычный has_permission() пропускает
-- суперпользователей (их в системе много — в т.ч. главы департаментов),
-- поэтому правило «менять могут трое» не соблюдалось бы: цены, из которых
-- вырастают долги гостей, правил бы любой суперюзер.
-- Здесь проверка строгая: только явная поимённая выдача.
CREATE OR REPLACE FUNCTION public.crm_can_edit_retreat_prices(p_user uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM user_permissions up
    JOIN permissions p ON p.id = up.permission_id
    WHERE up.user_id = p_user AND p.code = 'edit_retreat_prices' AND up.is_granted
  );
$$;
REVOKE ALL ON FUNCTION public.crm_can_edit_retreat_prices(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.crm_can_edit_retreat_prices(uuid) TO authenticated;

DROP POLICY IF EXISTS "Price editors write crm_retreat_prices" ON crm_retreat_prices;
DROP POLICY IF EXISTS "Price editors update crm_retreat_prices" ON crm_retreat_prices;
DROP POLICY IF EXISTS "Price editors delete crm_retreat_prices" ON crm_retreat_prices;

CREATE POLICY "Price editors write crm_retreat_prices" ON crm_retreat_prices
  FOR INSERT TO authenticated
  WITH CHECK (crm_can_edit_retreat_prices((SELECT auth.uid())));
CREATE POLICY "Price editors update crm_retreat_prices" ON crm_retreat_prices
  FOR UPDATE TO authenticated
  USING (crm_can_edit_retreat_prices((SELECT auth.uid())))
  WITH CHECK (crm_can_edit_retreat_prices((SELECT auth.uid())));
CREATE POLICY "Price editors delete crm_retreat_prices" ON crm_retreat_prices
  FOR DELETE TO authenticated
  USING (crm_can_edit_retreat_prices((SELECT auth.uid())));
