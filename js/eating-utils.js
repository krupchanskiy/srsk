// Утилита подсчёта едоков
// Используется в kitchen-menu.js и stock-requests.js

const EatingUtils = {
    /**
     * Загрузить количество едоков по дням за период
     * @param {string} startDate — 'YYYY-MM-DD'
     * @param {string} endDate   — 'YYYY-MM-DD'
     * @returns {{ [dateStr]: { breakfast: {team,volunteers,vips,guests,groups}, lunch: {team,volunteers,vips,guests,groups} } }}
     */
    async loadCounts(startDate, endDate) {
        // Ретриты, попадающие в период
        const { data: allRetreats } = await Layout.db.from('retreats').select('id, start_date, end_date');
        const retreatsInPeriod = (allRetreats || []).filter(r =>
            r.start_date <= endDate && r.end_date >= startDate
        );
        const retreatIds = retreatsInPeriod.map(r => r.id);

        // Параллельные запросы: residents (основной источник) + незаселённые гости ретрита + группы
        const [residentsResult, guestRegResult, mealGroupsResult] = await Promise.all([
            Layout.db
                .from('residents')
                .select('id, vaishnava_id, check_in, check_out, early_checkin, late_checkout, resident_categories!inner(slug)')
                .eq('status', 'confirmed')
                .eq('has_meals', true)
                .lte('check_in', endDate)
                .or(`check_out.gte.${startDate},check_out.is.null`),
            retreatIds.length > 0
                ? Layout.db
                    .from('retreat_registrations')
                    .select('id, retreat_id, vaishnava_id, arrival_datetime, departure_datetime, guest_transfers(direction, flight_datetime)')
                    .in('retreat_id', retreatIds)
                    .eq('is_deleted', false)
                    .not('status', 'in', '("cancelled","rejected")')
                    .or('meal_type.eq.prasad,meal_type.is.null')
                : Promise.resolve({ data: [] }),
            Layout.db
                .from('meal_groups')
                .select('id, start_date, end_date, people_count, breakfast, lunch')
                .lte('start_date', endDate)
                .gte('end_date', startDate)
        ]);

        const residentsData = residentsResult.data || [];
        const guestRegistrations = guestRegResult.data || [];
        const mealGroups = mealGroupsResult.data || [];

        // Множество vaishnava_id из residents для дедупликации с retreat_registrations
        const residentVaishnavaIds = new Set(residentsData.filter(r => r.vaishnava_id).map(r => r.vaishnava_id));

        // Незаселённые гости ретрита (есть в retreat_registrations но НЕТ в residents)
        const unhoustedGuests = guestRegistrations.filter(r => !residentVaishnavaIds.has(r.vaishnava_id));

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

            let bfTeam = 0, lnTeam = 0;
            let bfVol = 0, lnVol = 0;
            let bfVip = 0, lnVip = 0;
            let bfGuest = 0, lnGuest = 0;

            // Residents — считаем по категориям
            for (const r of residentsData) {
                if (r.check_in <= dateStr && (!r.check_out || r.check_out >= dateStr)) {
                    const isFirstDay = (dateStr === r.check_in);
                    const isLastDay = (r.check_out && dateStr === r.check_out);

                    const getsBreakfast = !isFirstDay || r.early_checkin;
                    const getsLunch = !isLastDay || r.late_checkout;

                    const slug = r.resident_categories?.slug;

                    if (getsBreakfast) {
                        if (slug === 'team') bfTeam++;
                        else if (slug === 'volunteer') bfVol++;
                        else if (slug === 'vip') bfVip++;
                        else bfGuest++;
                    }
                    if (getsLunch) {
                        if (slug === 'team') lnTeam++;
                        else if (slug === 'volunteer') lnVol++;
                        else if (slug === 'vip') lnVip++;
                        else lnGuest++;
                    }
                }
            }

            // Незаселённые гости ретрита → считаем как guests
            for (const retreat of retreatsInPeriod) {
                if (dateStr < retreat.start_date || dateStr > retreat.end_date) continue;
                const regs = unhoustedGuests.filter(r => r.retreat_id === retreat.id);
                for (const reg of regs) {
                    const transfers = reg.guest_transfers || [];
                    const arrivalFlight = transfers.find(t => t.direction === 'arrival')?.flight_datetime;
                    const departureFlight = transfers.find(t => t.direction === 'departure')?.flight_datetime;

                    const arrivalDt = reg.arrival_datetime || arrivalFlight;
                    const departureDt = reg.departure_datetime || departureFlight;
                    const effectiveStart = arrivalDt ? arrivalDt.slice(0, 10) : retreat.start_date;
                    const effectiveEnd = departureDt ? departureDt.slice(0, 10) : retreat.end_date;

                    if (dateStr < effectiveStart || dateStr > effectiveEnd) continue;

                    const isFirstDay = (dateStr === effectiveStart);
                    const isLastDay = (dateStr === effectiveEnd);

                    let getsBreakfast = true;
                    let getsLunch = true;

                    if (isFirstDay) {
                        if (arrivalDt) {
                            const hour = new Date(arrivalDt.slice(0, 16)).getHours();
                            getsBreakfast = hour < BREAKFAST_CUTOFF;
                            getsLunch = hour < LUNCH_CUTOFF;
                        } else {
                            getsBreakfast = false;
                        }
                    }

                    if (isLastDay) {
                        if (departureDt) {
                            const hour = new Date(departureDt.slice(0, 16)).getHours();
                            getsBreakfast = getsBreakfast && hour >= BREAKFAST_CUTOFF;
                            getsLunch = getsLunch && hour >= LUNCH_CUTOFF;
                        } else {
                            getsLunch = false;
                        }
                    }

                    if (getsBreakfast) bfGuest++;
                    if (getsLunch) lnGuest++;
                }
            }

            // Группы (meal_groups)
            let breakfastGroups = 0, lunchGroups = 0;
            for (const mg of mealGroups) {
                if (mg.start_date <= dateStr && mg.end_date >= dateStr) {
                    if (mg.breakfast) breakfastGroups += mg.people_count;
                    if (mg.lunch) lunchGroups += mg.people_count;
                }
            }

            counts[dateStr] = {
                breakfast: { team: bfTeam, volunteers: bfVol, vips: bfVip, guests: bfGuest, groups: breakfastGroups },
                lunch:     { team: lnTeam, volunteers: lnVol, vips: lnVip, guests: lnGuest, groups: lunchGroups }
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
        const total = mc.team + mc.volunteers + mc.vips + mc.guests + mc.groups;
        return total > 0 ? total : 50;
    }
};
