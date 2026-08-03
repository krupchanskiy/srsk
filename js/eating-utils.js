// Утилита подсчёта едоков
// Используется в kitchen-menu.js и stock-requests.js

const EatingUtils = {
    /**
     * Загрузить количество едоков по дням за период
     * @param {string} startDate — 'YYYY-MM-DD'
     * @param {string} endDate   — 'YYYY-MM-DD'
     * @returns {{ [dateStr]: { breakfast: {team,volunteers,vips,guests,groups,expected}, lunch: {...} } }}
     *
     * expected — «ожидаемые»: бронь есть, имя ещё не проставлено. Считаются как
     * едоки: недокормить приехавшего хуже, чем приготовить лишнюю порцию.
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
                .select('id, vaishnava_id, guest_name, retreat_id, check_in, check_out, early_checkin, late_checkout, breakfast, lunch, arrived_at, resident_categories!inner(slug)')
                .eq('status', 'confirmed')
                // У брони питание не заполнено (не «нет», а «пока неизвестно») —
                // раньше такие записи выпадали из расчёта, и порций не хватало.
                // Исключаем только явный отказ от питания.
                .not('has_meals', 'is', false)
                .lte('check_in', endDate)
                .or(`check_out.gte.${startDate},check_out.is.null`),
            retreatIds.length > 0
                ? Layout.db
                    .from('retreat_registrations')
                    .select('id, retreat_id, vaishnava_id, status, arrival_datetime, departure_datetime, guest_transfers(direction, flight_datetime)')
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

        // Хелпер форматирования даты
        const fmt = d => {
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const dd = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${dd}`;
        };

        const BREAKFAST_CUTOFF = 10;
        const LUNCH_CUTOFF = 13;

        // Маппинг (vaishnava_id + retreat_id) → времена из регистрации
        const regTimesMap = new Map();
        for (const reg of guestRegistrations) {
            if (reg.vaishnava_id) {
                const key = `${reg.vaishnava_id}_${reg.retreat_id}`;
                regTimesMap.set(key, {
                    arrival: reg.arrival_datetime,
                    departure: reg.departure_datetime
                });
            }
        }

        const counts = {};
        const firstDay = new Date(startDate + 'T00:00:00');
        const lastDay = new Date(endDate + 'T00:00:00');

        for (let d = new Date(firstDay); d <= lastDay; d.setDate(d.getDate() + 1)) {
            const dateStr = fmt(d);

            let bfTeam = 0, lnTeam = 0;
            let bfVol = 0, lnVol = 0;
            let bfVip = 0, lnVip = 0;
            let bfGuest = 0, lnGuest = 0;
            let bfExpected = 0, lnExpected = 0;

            // Residents — считаем по категориям + собираем vaishnava_id для дедупликации на эту дату
            const residentIdsForDate = new Set();
            for (const r of residentsData) {
                if (r.check_in <= dateStr && (!r.check_out || r.check_out >= dateStr)) {
                    if (r.vaishnava_id) residentIdsForDate.add(r.vaishnava_id);

                    const isFirstDay = (dateStr === r.check_in);
                    const isLastDay = (r.check_out && dateStr === r.check_out);

                    let getsBreakfast = !isFirstDay || r.early_checkin;
                    let getsLunch = !isLastDay || r.late_checkout;

                    // Уточняем по фактическому времени из регистрации на ретрит
                    if (r.vaishnava_id && r.retreat_id) {
                        const regTimes = regTimesMap.get(`${r.vaishnava_id}_${r.retreat_id}`);
                        if (regTimes) {
                            if (isFirstDay && !r.early_checkin && regTimes.arrival) {
                                const hour = new Date(regTimes.arrival.slice(0, 16)).getHours();
                                getsBreakfast = hour < BREAKFAST_CUTOFF;
                            }
                            if (isLastDay && !r.late_checkout && regTimes.departure) {
                                const hour = new Date(regTimes.departure.slice(0, 16)).getHours();
                                getsLunch = hour >= LUNCH_CUTOFF;
                            }
                        }
                    }

                    // Галочки «Завтрак» и «Обед» из брони — основа всего расчёта
                    // (инструкция ВГ, 02.08.2026). Проверяются последними: отказ
                    // человека сильнее любых уточнений по времени рейса.
                    // Не заполнено = участвует: у броней и старых записей поля
                    // пустые, а кормить их надо.
                    if (r.breakfast === false) getsBreakfast = false;
                    if (r.lunch === false) getsLunch = false;

                    const slug = r.resident_categories?.slug;
                    // Ожидаемый — тот, кто ещё не отмечен приехавшим. Раньше
                    // признаком было пустое имя, и бронь с именем считалась
                    // дважды: как место и как участник ретрита.
                    const isExpected = !r.arrived_at;

                    if (getsBreakfast) {
                        if (isExpected) bfExpected++;
                        else if (slug === 'team') bfTeam++;
                        else if (slug === 'volunteer') bfVol++;
                        else if (slug === 'vip') bfVip++;
                        else bfGuest++;
                    }
                    if (getsLunch) {
                        if (isExpected) lnExpected++;
                        else if (slug === 'team') lnTeam++;
                        else if (slug === 'volunteer') lnVol++;
                        else if (slug === 'vip') lnVip++;
                        else lnGuest++;
                    }
                }
            }

            // Незаселённые регистрации ретрита → считаем по реальному статусу (дедупликация по дате)
            for (const retreat of retreatsInPeriod) {
                if (dateStr < retreat.start_date || dateStr > retreat.end_date) continue;
                const regs = guestRegistrations.filter(r => r.retreat_id === retreat.id && !residentIdsForDate.has(r.vaishnava_id));
                for (const reg of regs) {
                    const transfers = reg.guest_transfers || [];
                    const arrivalFlight = transfers.find(t => t.direction === 'arrival')?.flight_datetime;
                    const departureFlight = transfers.find(t => t.direction === 'departure')?.flight_datetime;

                    const arrivalDt = reg.arrival_datetime || arrivalFlight;
                    const departureDt = reg.departure_datetime || departureFlight;
                    // Дата приезда неизвестна — не считаем. Раньше такой человек
                    // числился едоком весь ретрит: на двухмесячном «Ретрите
                    // Художников» это дало 25 лишних порций с первого дня.
                    if (!arrivalDt) continue;
                    const effectiveStart = arrivalDt.slice(0, 10);
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

                    if (getsBreakfast) {
                        if (reg.status === 'team') bfTeam++;
                        else if (reg.status === 'volunteer') bfVol++;
                        else if (reg.status === 'vip') bfVip++;
                        else bfGuest++;
                    }
                    if (getsLunch) {
                        if (reg.status === 'team') lnTeam++;
                        else if (reg.status === 'volunteer') lnVol++;
                        else if (reg.status === 'vip') lnVip++;
                        else lnGuest++;
                    }
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
                breakfast: { team: bfTeam, volunteers: bfVol, vips: bfVip, guests: bfGuest,
                             groups: breakfastGroups, expected: bfExpected },
                lunch:     { team: lnTeam, volunteers: lnVol, vips: lnVip, guests: lnGuest,
                             groups: lunchGroups, expected: lnExpected }
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
        const total = mc.team + mc.volunteers + mc.vips + mc.guests + mc.groups + (mc.expected || 0);
        return total > 0 ? total : 50;
    }
};
