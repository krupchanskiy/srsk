// Утилита подсчёта едоков
// Используется в kitchen-menu.js и stock-requests.js

const EatingUtils = {
    /**
     * Загрузить количество едоков по дням за период
     * @param {string} startDate — 'YYYY-MM-DD'
     * @param {string} endDate   — 'YYYY-MM-DD'
     * @returns {{ [dateStr]: { breakfast: {guests,team,residents}, lunch: {guests,team,residents} } }}
     */
    async loadCounts(startDate, endDate) {
        // Ретриты, попадающие в период
        const { data: allRetreats } = await Layout.db.from('retreats').select('id, start_date, end_date');
        const retreatsInPeriod = (allRetreats || []).filter(r =>
            r.start_date <= endDate && r.end_date >= startDate
        );
        const retreatIds = retreatsInPeriod.map(r => r.id);

        // Staff IDs
        const { data: staffData } = await Layout.db
            .from('vaishnavas')
            .select('id')
            .eq('user_type', 'staff');
        const staffIds = (staffData || []).map(s => s.id);

        // Параллельные запросы
        const [guestRegResult, teamStaysResult, residentsResult] = await Promise.all([
            retreatIds.length > 0
                ? Layout.db
                    .from('retreat_registrations')
                    .select('retreat_id, vaishnava_id, arrival_datetime, departure_datetime')
                    .in('retreat_id', retreatIds)
                    .eq('is_deleted', false)
                    .not('status', 'in', '("cancelled","rejected")')
                    .or('meal_type.eq.prasad,meal_type.is.null')
                : Promise.resolve({ data: [] }),
            staffIds.length > 0
                ? Layout.db
                    .from('vaishnava_stays')
                    .select('vaishnava_id, start_date, end_date, early_checkin, late_checkout')
                    .in('vaishnava_id', staffIds)
                    .lte('start_date', endDate)
                    .gte('end_date', startDate)
                : Promise.resolve({ data: [] }),
            Layout.db
                .from('residents')
                .select('id, vaishnava_id, check_in, check_out, early_checkin, late_checkout')
                .eq('status', 'active')
                .or('meal_type.eq.prasad,meal_type.is.null')
                .lte('check_in', endDate)
                .or(`check_out.gte.${startDate},check_out.is.null`)
        ]);

        const guestRegistrations = guestRegResult.data || [];
        const teamStays = teamStaysResult.data || [];
        const residentsData = residentsResult.data || [];

        // Хелпер форматирования даты
        const fmt = d => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        };

        const BREAKFAST_CUTOFF = 10;
        const LUNCH_CUTOFF = 13;

        const counts = {};
        const firstDay = new Date(startDate + 'T00:00:00');
        const lastDay = new Date(endDate + 'T00:00:00');

        for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
            const dateStr = fmt(d);

            const breakfastGuestIds = new Set();
            const lunchGuestIds = new Set();

            // Гости ретритов
            for (const retreat of retreatsInPeriod) {
                if (dateStr >= retreat.start_date && dateStr <= retreat.end_date) {
                    const regs = guestRegistrations.filter(r => r.retreat_id === retreat.id);
                    for (const reg of regs) {
                        const isFirstDay = (dateStr === retreat.start_date);
                        const isLastDay = (dateStr === retreat.end_date);

                        let getsBreakfast = true;
                        let getsLunch = true;

                        if (isFirstDay) {
                            if (reg.arrival_datetime) {
                                const hour = new Date(reg.arrival_datetime.slice(0, 16)).getHours();
                                getsBreakfast = hour < BREAKFAST_CUTOFF;
                                getsLunch = hour < LUNCH_CUTOFF;
                            } else {
                                getsBreakfast = false;
                            }
                        }

                        if (isLastDay) {
                            if (reg.departure_datetime) {
                                const hour = new Date(reg.departure_datetime.slice(0, 16)).getHours();
                                getsBreakfast = getsBreakfast && hour >= BREAKFAST_CUTOFF;
                                getsLunch = getsLunch && hour >= LUNCH_CUTOFF;
                            } else {
                                getsLunch = false;
                            }
                        }

                        if (getsBreakfast) breakfastGuestIds.add(reg.vaishnava_id);
                        if (getsLunch) lunchGuestIds.add(reg.vaishnava_id);
                    }
                }
            }

            // Команда (staff)
            const teamBreakfast = new Set();
            const teamLunch = new Set();
            for (const stay of teamStays) {
                if (stay.start_date <= dateStr && stay.end_date >= dateStr) {
                    const isFirstDay = (dateStr === stay.start_date);
                    const isLastDay = (dateStr === stay.end_date);
                    if (!isFirstDay || stay.early_checkin) teamBreakfast.add(stay.vaishnava_id);
                    if (!isLastDay || stay.late_checkout) teamLunch.add(stay.vaishnava_id);
                }
            }

            // Резиденты (исключая уже посчитанных)
            let breakfastResidents = 0, lunchResidents = 0;
            for (const r of residentsData) {
                if (r.check_in <= dateStr && (!r.check_out || r.check_out >= dateStr)) {
                    const isFirstDay = (dateStr === r.check_in);
                    const isLastDay = (r.check_out && dateStr === r.check_out);
                    const alreadyBreakfast = breakfastGuestIds.has(r.vaishnava_id) || teamBreakfast.has(r.vaishnava_id);
                    const alreadyLunch = lunchGuestIds.has(r.vaishnava_id) || teamLunch.has(r.vaishnava_id);
                    if (!alreadyBreakfast && (!isFirstDay || r.early_checkin)) breakfastResidents++;
                    if (!alreadyLunch && (!isLastDay || r.late_checkout)) lunchResidents++;
                }
            }

            counts[dateStr] = {
                breakfast: { guests: breakfastGuestIds.size, team: teamBreakfast.size, residents: breakfastResidents },
                lunch:     { guests: lunchGuestIds.size,     team: teamLunch.size,     residents: lunchResidents }
            };
        }

        return counts;
    },

    /**
     * Получить суммарное количество едоков на дату и приём пищи
     * @param {object} counts — результат loadCounts()
     * @param {string} dateStr — 'YYYY-MM-DD'
     * @param {string} mealType — 'breakfast' | 'lunch' | 'dinner' | 'menu'
     * @returns {number}
     */
    getTotal(counts, dateStr, mealType) {
        const dayData = counts[dateStr];
        if (!dayData) return 50;
        const key = (mealType === 'breakfast') ? 'breakfast' : 'lunch';
        const mc = dayData[key];
        if (!mc) return 50;
        const total = mc.guests + mc.team + (mc.residents || 0);
        return total > 0 ? total : 50;
    }
};
