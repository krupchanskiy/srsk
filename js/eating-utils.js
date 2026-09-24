// Утилита подсчёта едоков
// Используется в kitchen-menu.js и stock-requests.js

const EatingUtils = {
    /**
     * Загрузить количество едоков по дням за период
     * @param {string} startDate — 'YYYY-MM-DD'
     * @param {string} endDate   — 'YYYY-MM-DD'
     * @returns {{ [dateStr]: { breakfast: {team,volunteers,vips,guests,groups,expected}, lunch: {...}, byEvent } }}
     *
     * expected — «ожидаемые»: бронь есть, приезд ещё не отмечен. Считаются как
     * едоки: недокормить приехавшего хуже, чем приготовить лишнюю порцию.
     *
     * Сам расчёт — в базе (eating_detail, миграция 508): тот же, по которому
     * считает бот. Раньше здесь жила своя копия, и бот с сайтом расходились
     * (24.09.2026). Правила — в комментарии к миграции.
     */
    async loadCounts(startDate, endDate) {
        const rows = [];
        for (let from = 0; ; from += 1000) {
            const { data, error } = await Layout.db
                .rpc('eating_by_event', { p_from: startDate, p_to: endDate })
                .order('d').order('meal').order('retreat_id')
                .range(from, from + 999);
            // Ошибку показываем, а не глотаем: иначе getTotal молча подставит 50
            if (error) { Layout.handleError(error, 'Вкушающие'); break; }
            rows.push(...(data || []));
            if (!data || data.length < 1000) break;
        }

        const empty = () => ({ team: 0, volunteers: 0, vips: 0, guests: 0, groups: 0, expected: 0 });
        const counts = {};
        const lastDay = DateUtils.parseDate(endDate);
        for (let d = DateUtils.parseDate(startDate); d <= lastDay; d.setDate(d.getDate() + 1)) {
            counts[DateUtils.toISO(d)] = {
                breakfast: empty(), lunch: empty(),
                // Разбивка по событию (ретрит / без события) — те же числа, что
                // и в итогах, но раздельно; сумма по событиям равна итогу.
                byEvent: { breakfast: {}, lunch: {} }
            };
        }

        for (const r of rows) {
            const day = counts[r.d];
            if (!day) continue;
            const evKey = r.retreat_id ? `retreat:${r.retreat_id}` : 'none';
            const ev = day.byEvent[r.meal][evKey] || (day.byEvent[r.meal][evKey] = empty());
            for (const k of ['team', 'volunteers', 'vips', 'guests', 'groups', 'expected']) {
                day[r.meal][k] += r[k];
                ev[k] += r[k];
            }
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
    },

    /**
     * Вкушающие на дату и приём пищи по событиям.
     * @param {object} counts — результат loadCounts()
     * @param {string} dateStr — 'YYYY-MM-DD'
     * @param {string} mealType — 'breakfast' | 'lunch' (остальные считаются как обед)
     * @returns {{ [eventKey]: {team,volunteers,vips,guests,groups,expected} }}
     *   eventKey: 'retreat:<id>' | 'none' (самостоятельные гости, команда и группы без ретрита)
     */
    getByEvent(counts, dateStr, mealType) {
        const key = (mealType === 'breakfast') ? 'breakfast' : 'lunch';
        return counts[dateStr]?.byEvent?.[key] || {};
    }
};
