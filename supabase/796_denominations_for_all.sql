-- 796: справочник номиналов купюр читают все вошедшие (ВГ, 18.11.2026).
-- Калькулятор купюр стоит и у кассира магазина, а раньше номиналы видели
-- только финансисты (fin_can_read_all). Номиналы — не секрет.
CREATE OR REPLACE VIEW fin_v_denominations AS
SELECT currency_code, value
FROM fin_denominations
ORDER BY currency_code, value DESC;

GRANT SELECT ON fin_v_denominations TO authenticated;
