-- Ведомость не открывалась: «permission denied for function fin_payroll_tg_enabled».
-- Представление fin_v_payroll_positions вызывает функцию с правами того, кто
-- открыл страницу, а в 684 доступ к ней закрыли. Функция отдаёт только
-- «Телеграм включён да/нет» по человеку — открываем вошедшим.
GRANT EXECUTE ON FUNCTION public.fin_payroll_tg_enabled(uuid) TO authenticated;
