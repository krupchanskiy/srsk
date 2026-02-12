// ==================== UTILS.JS ====================
// Общие утилиты: pluralize, debounce, escapeHtml

(function() {
'use strict';

/**
 * Склонение слов для разных языков
 * @param {number} n - число
 * @param {Object} forms - формы слова { ru: ['рецепт', 'рецепта', 'рецептов'], en: ['recipe', 'recipes'], hi: 'व्यंजन' }
 * @param {string} lang - язык (ru, en, hi)
 * @returns {string} - "5 рецептов"
 */
function pluralize(n, forms, lang) {
    const langForms = forms[lang] || forms.ru;

    // Хинди: не склоняется
    if (typeof langForms === 'string') {
        return `${n} ${langForms}`;
    }

    // Английский: singular/plural
    if (lang === 'en' || langForms.length === 2) {
        return `${n} ${n === 1 ? langForms[0] : langForms[1]}`;
    }

    // Русский: one/few/many
    const mod10 = n % 10;
    const mod100 = n % 100;

    if (mod10 === 1 && mod100 !== 11) {
        return `${n} ${langForms[0]}`;
    }
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 10 || mod100 >= 20)) {
        return `${n} ${langForms[1]}`;
    }
    return `${n} ${langForms[2]}`;
}

/** Debounce функция для оптимизации частых вызовов */
function debounce(fn, delay = 300) {
    let timer;
    return (...args) => {
        clearTimeout(timer);
        timer = setTimeout(() => fn(...args), delay);
    };
}

/** Экранирование HTML для защиты от XSS */
function escapeHtml(str) {
    if (str == null) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

/** Валидация цвета в формате HEX (#RRGGBB) для защиты от CSS injection */
function isValidColor(color) {
    if (!color) return false;
    return /^#[0-9A-Fa-f]{6}$/.test(color);
}

/**
 * Проверка и автоперенос departure/arrival в правильный ретрит.
 * Если departure_datetime позже окончания ретрита и у человека есть регистрация
 * на более поздний ретрит — переносит departure_datetime и трансфер вылета туда.
 * Аналогично для arrival_datetime раньше начала ретрита.
 *
 * @param {object} params
 * @param {object} params.db - Supabase client
 * @param {string} params.registrationId - текущая регистрация
 * @param {string} params.vaishnavId - ID вайшнава
 * @param {object} params.retreat - { start_date, end_date } текущего ретрита
 * @param {string|null} params.arrivalDatetime - arrival_datetime (ISO)
 * @param {string|null} params.departureDatetime - departure_datetime (ISO)
 * @returns {Promise<{moved: boolean, warnings: string[]}>}
 */
async function checkAndMoveDatesAcrossRetreats({ db, registrationId, vaishnavId, retreat, arrivalDatetime, departureDatetime }) {
    const result = { moved: false, warnings: [], notifications: [] };
    if (!retreat || !vaishnavId) return result;

    const depDate = departureDatetime ? departureDatetime.slice(0, 10) : null;
    const arrDate = arrivalDatetime ? arrivalDatetime.slice(0, 10) : null;

    // Вылет позже окончания ретрита — ищем более поздний ретрит
    if (depDate && depDate > retreat.end_date) {
        const { data: otherRegs } = await db
            .from('retreat_registrations')
            .select('id, retreat_id, retreats(name_ru, name_en, start_date, end_date)')
            .eq('vaishnava_id', vaishnavId)
            .neq('id', registrationId)
            .neq('status', 'cancelled');

        const laterReg = otherRegs?.find(r => r.retreats && r.retreats.end_date >= depDate && r.retreats.start_date > retreat.end_date);
        if (laterReg) {
            // Переносим departure_datetime
            await db.from('retreat_registrations').update({ departure_datetime: departureDatetime }).eq('id', laterReg.id);
            // Переносим трансфер вылета
            const { data: depTransfers } = await db
                .from('guest_transfers')
                .select('id')
                .eq('registration_id', registrationId)
                .eq('direction', 'departure');
            if (depTransfers?.length) {
                await db.from('guest_transfers').update({ registration_id: laterReg.id }).eq('id', depTransfers[0].id);
            }
            const retreatName = laterReg.retreats.name_ru || laterReg.retreats.name_en;
            result.notifications.push(`Вылет автоматически перенесён в «${retreatName}»`);
            result.moved = true;
            // Обнуляем departure_datetime в текущей регистрации (вызывающий код должен это учесть)
            result.clearedDeparture = true;
        } else {
            result.warnings.push(`Выезд (${depDate}) позже окончания ретрита (${retreat.end_date}). Возможно, вылет относится к другому ретриту?`);
        }
    }

    // Прибытие раньше начала ретрита — ищем более ранний ретрит
    if (arrDate && arrDate < retreat.start_date) {
        const { data: otherRegs } = await db
            .from('retreat_registrations')
            .select('id, retreat_id, retreats(name_ru, name_en, start_date, end_date)')
            .eq('vaishnava_id', vaishnavId)
            .neq('id', registrationId)
            .neq('status', 'cancelled');

        const earlierReg = otherRegs?.find(r => r.retreats && r.retreats.start_date <= arrDate && r.retreats.end_date < retreat.start_date);
        if (earlierReg) {
            await db.from('retreat_registrations').update({ arrival_datetime: arrivalDatetime }).eq('id', earlierReg.id);
            const { data: arrTransfers } = await db
                .from('guest_transfers')
                .select('id')
                .eq('registration_id', registrationId)
                .eq('direction', 'arrival');
            if (arrTransfers?.length) {
                await db.from('guest_transfers').update({ registration_id: earlierReg.id }).eq('id', arrTransfers[0].id);
            }
            const retreatName = earlierReg.retreats.name_ru || earlierReg.retreats.name_en;
            result.notifications.push(`Прибытие автоматически перенесено в «${retreatName}»`);
            result.moved = true;
            result.clearedArrival = true;
        } else {
            result.warnings.push(`Прибытие (${arrDate}) раньше начала ретрита (${retreat.start_date})`);
        }
    }

    return result;
}

window.Utils = { pluralize, debounce, escapeHtml, isValidColor, checkAndMoveDatesAcrossRetreats };

})();
