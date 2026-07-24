-- ВГ: цены ретрита меняют трое. В интерфейсе кнопки скрыты правом, но RLS
-- пускала на запись любого сотрудника — правка мимо интерфейса прошла бы.
-- Разделяем: смотреть может вся команда, менять — только по праву.
DROP POLICY IF EXISTS "Staff manage crm_retreat_prices" ON crm_retreat_prices;

CREATE POLICY "Staff read crm_retreat_prices" ON crm_retreat_prices
  FOR SELECT TO authenticated
  USING (is_staff((SELECT auth.uid())));
