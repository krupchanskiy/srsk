-- Тот же паттерн, что у tg_outbox: читать очередь реакций (для диагностики) может только фин-админ.
CREATE POLICY tg_reactions_read_admin ON public.tg_reactions
  FOR SELECT TO authenticated
  USING (fin_is_admin(auth.uid()));
