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

/**
 * Централизованный debug-логгер.
 *
 * Включается, только если:
 *   - window.__SRSK_DEBUG === true (в prod выключено)
 *   - hostname === 'localhost' (dev сам включает)
 *   - в localStorage есть ключ srsk_debug='1' (для прод-диагностики у админа)
 *
 * Пишет в console.log с префиксом [DEBUG]. Для ошибок — console.error напрямую,
 * а не через debug().
 */
function debug(...args) {
    const on = typeof window !== 'undefined' && (
        window.__SRSK_DEBUG === true ||
        (window.location && window.location.hostname === 'localhost') ||
        (() => { try { return localStorage.getItem('srsk_debug') === '1'; } catch { return false; } })()
    );
    if (on) console.log('[DEBUG]', ...args);
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
 * Безопасный цвет для вставки в style/CSS. Возвращает исходный цвет, если он
 * проходит isValidColor, иначе fallback (серый по умолчанию).
 * Используется в template literals: style="color: ${Utils.safeColor(x.color)}"
 */
function safeColor(color, fallback = '#6b7280') {
    return isValidColor(color) ? color : fallback;
}

/**
 * Цвет букв поверх цветной плашки: белый, если он читается (контраст ≥ 4.5),
 * иначе почти чёрный. Белый на зелёном #10b981 — 2.5:1, на синем #3b82f6 —
 * 3.7:1: подписи статусов и ретритов на таких плашках не читались.
 */
function textOn(bg) {
    const цвет = safeColor(bg);
    const канал = i => {
        const c = parseInt(цвет.slice(1 + i * 2, 3 + i * 2), 16) / 255;
        return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    };
    const L = 0.2126 * канал(0) + 0.7152 * канал(1) + 0.0722 * канал(2);
    // берём тот цвет букв, у которого контраст выше (почти чёрный #111827 — L≈0.0089)
    const сБелым = 1.05 / (L + 0.05);
    const сТёмным = (L + 0.05) / (0.0089 + 0.05);
    return сБелым >= сТёмным ? '#ffffff' : '#111827';
}

/** style для цветной плашки: проверенный фон и читаемые буквы. */
function badgeStyle(bg, fallback = '#6b7280') {
    const цвет = safeColor(bg, fallback);
    return `background-color: ${цвет}; color: ${textOn(цвет)};`;
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
async function checkAndMoveDatesAcrossRetreats({ db, registrationId, vaishnavId, retreat, arrivalDatetime, departureDatetime, originalArrival, originalDeparture }) {
    const result = { moved: false, warnings: [], notifications: [], blocked: null };
    if (!retreat || !vaishnavId) return result;

    const depDate = departureDatetime ? departureDatetime.slice(0, 10) : null;
    const arrDate = arrivalDatetime ? arrivalDatetime.slice(0, 10) : null;

    // Невозможные даты (ВГ 02.10.2026, js/date-guard.js) — до любых переносов: вызывающий
    // код показывает blocked и не сохраняет. Предупреждения — с запасом 3 дня и числом дней.
    const guard = window.DateGuard;
    const r = guard && retreat.id ? (await guard.retreat(retreat.id)) || retreat : retreat;
    if (guard) {
        const block = [guard.checkOrder(arrivalDatetime, departureDatetime, 'Регистрация'),
                       guard.check(arrivalDatetime, 'arrival', r, 'Приезд'),
                       guard.check(departureDatetime, 'departure', r, 'Выезд')]
            .find(x => x?.level === 'block');
        if (block) { result.blocked = block.text; return result; }
    }
    // Переспрашиваем только про изменённую дату (если вызывающий код передал прежние)
    const unchanged = (value, orig) => orig !== undefined && guard && !guard.changed(value, orig);
    const warnText = (value, kind, old) => {
        if (!guard) return old;
        if (unchanged(value, kind === 'arrival' ? originalArrival : originalDeparture)) return null;
        const w = guard.check(value, kind, r, kind === 'arrival' ? 'Приезд' : 'Выезд');
        return w?.level === 'warn' ? w.text : null;
    };

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
            const w = warnText(departureDatetime, 'departure', `Выезд (${depDate}) позже окончания ретрита (${retreat.end_date}). Возможно, вылет относится к другому ретриту?`);
            if (w) result.warnings.push(w);
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
            const w = warnText(arrivalDatetime, 'arrival', `Прибытие (${arrDate}) раньше начала ретрита (${retreat.start_date})`);
            if (w) result.warnings.push(w);
        }
    }

    return result;
}

/**
 * Итеративная загрузка всех записей из Supabase (обход лимита 1000)
 * @param {function} queryBuilder - функция (from, to) => query с .range(from, to)
 * @param {number} pageSize - размер страницы (по умолчанию 1000)
 * @returns {Promise<{data: array, error: object|null}>}
 */
async function fetchAll(queryBuilder, pageSize = 1000) {
    const all = [];
    let from = 0;
    while (true) {
        const { data, error } = await queryBuilder(from, from + pageSize - 1);
        if (error) return { data: null, error };
        if (!data || data.length === 0) break;
        all.push(...data);
        if (data.length < pageSize) break;
        from += pageSize;
    }
    return { data: all, error: null };
}

/** Получить отображаемое имя вайшнава: духовное или гражданское */
function getVaishnavName(v, fallback) {
    if (!v) return fallback || '—';
    return v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || fallback || '—';
}

/** Полное имя: "Духовное (Имя Фамилия)" или просто гражданское */
function getVaishnavFullName(v, fallback) {
    if (!v) return fallback || '—';
    const civil = `${v.first_name || ''} ${v.last_name || ''}`.trim();
    return v.spiritual_name ? `${v.spiritual_name} (${civil})` : civil || fallback || '—';
}

/**
 * Выбрать актуальное размещение из нескольких.
 * У человека может быть несколько подтверждённых записей — прошлый визит и
 * нынешний. Без выбора по датам списки показывали ту, что пришла из БД последней:
 * Чандра-рекха жила в гостевом доме, а трансферы звали её в коттедж (ВГ, 11.08).
 *
 * @param {object} было - текущий кандидат (может быть undefined)
 * @param {object} стало - новый кандидат
 * @param {object} [опции]
 * @param {string} [опции.retreatId] - ретрит, к которому относится список
 * @param {string} [опции.date] - опорная дата (YYYY-MM-DD), по умолчанию сегодня
 * @returns {object} тот из двух, который уместнее показать
 */
function pickResident(было, стало, { retreatId, date } = {}) {
    if (!было) return стало;
    if (!стало) return было;

    const день = date || DateUtils.toISO(new Date());
    const вес = r => {
        if (retreatId && r.retreat_id === retreatId) return 4;      // тот самый ретрит
        if (r.check_in <= день && (!r.check_out || r.check_out >= день)) return 3;  // живёт сейчас
        if (r.check_in > день) return 2;                            // заедет позже
        return 1;                                                    // уже выехал
    };

    const вЕсть = вес(было), вНово = вес(стало);
    if (вНово !== вЕсть) return вНово > вЕсть ? стало : было;
    // При равном весе — та запись, что начинается позже: она свежее
    return (стало.check_in || '') > (было.check_in || '') ? стало : было;
}

window.getVaishnavName = getVaishnavName;
window.getVaishnavFullName = getVaishnavFullName;

/**
 * Спросить «да или нет» своей модалкой.
 *
 * confirm() во встроенных браузерах не показывается вовсе, поэтому вопрос
 * задаётся разметкой страницы. Тонкость, на которой уже обожглись: showModal()
 * у открытого диалога ничего не делает и не бросает исключения — значит два
 * быстрых вопроса подряд показали бы один диалог с двумя обработчиками,
 * и одно «Да» выполнило бы оба действия. Поэтому второй вопрос ждёт,
 * пока ответят на первый.
 */
let вопросВРаботе = null;

function спросить(заголовок, текст) {
    const окно = document.querySelector('#подтверждение');
    const да = document.querySelector('#пдДа');
    if (!окно || !да) return Promise.resolve(false);

    const задать = () => new Promise(готово => {
        document.querySelector('#пдЗаголовок').textContent = заголовок;
        document.querySelector('#пдТекст').textContent = текст || '';

        let ответил = false;
        const ответить = значение => {
            if (ответил) return;
            ответил = true;
            да.removeEventListener('click', наДа);
            окно.removeEventListener('close', наЗакрытие);
            готово(значение);
        };
        const наДа = () => { окно.close(); ответить(true); };
        const наЗакрытие = () => ответить(false);

        да.addEventListener('click', наДа);
        окно.addEventListener('close', наЗакрытие);
        окно.showModal();
        // если диалог почему-то не открылся (его уже открыли из другого места),
        // отвечаем «нет» сразу: иначе очередь вопросов повиснет навсегда
        if (!окно.open) ответить(false);
    });

    // очередь: пока предыдущий вопрос не закрыт, новый не показываем
    вопросВРаботе = (вопросВРаботе || Promise.resolve()).then(задать, задать);
    return вопросВРаботе;
}

window.спросить = спросить;

/**
 * Спросить строку. Замена prompt(), который во встроенных браузерах
 * возвращает пусто и молча отменяет действие.
 *
 * `многострочно: true` — для связок между пунктами и причин, где нужен
 * перенос строки; в системном окне его набрать нельзя было вовсе.
 */
function спроситьСтроку({ заголовок, подсказка = '', значение = '',
                          кнопка = 'Готово', многострочно = false, обязательно = true }) {
    const окно = document.querySelector('#вводМодал');
    if (!окно) return Promise.resolve(null);

    const задать = () => new Promise(готово => {
        const поле = окно.querySelector(многострочно ? '#ввПолеДлинное' : '#ввПоле');
        const другое = окно.querySelector(многострочно ? '#ввПоле' : '#ввПолеДлинное');
        const кнопкаГотово = окно.querySelector('#ввГотово');

        окно.querySelector('#ввЗаголовок').textContent = заголовок;
        окно.querySelector('#ввПодсказка').textContent = подсказка;
        окно.querySelector('#ввПодсказка').hidden = !подсказка;
        кнопкаГотово.textContent = кнопка;
        поле.hidden = false;
        другое.hidden = true;
        поле.value = значение || '';

        let ответил = false;
        const ответить = значение2 => {
            if (ответил) return;
            ответил = true;
            кнопкаГотово.removeEventListener('click', наГотово);
            поле.removeEventListener('keydown', наEnter);
            окно.removeEventListener('close', наЗакрытие);
            готово(значение2);
        };
        const наГотово = () => {
            const текст = поле.value.trim();
            if (обязательно && !текст) { поле.focus(); return; }
            окно.close();
            ответить(текст);
        };
        const наEnter = ev => {
            if (ev.key === 'Enter' && !многострочно) { ev.preventDefault(); наГотово(); }
        };
        const наЗакрытие = () => ответить(null);

        кнопкаГотово.addEventListener('click', наГотово);
        поле.addEventListener('keydown', наEnter);
        окно.addEventListener('close', наЗакрытие);
        окно.showModal();
        if (!окно.open) return ответить(null);
        setTimeout(() => поле.focus(), 50);
    });

    вопросВРаботе = (вопросВРаботе || Promise.resolve()).then(задать, задать);
    return вопросВРаботе;
}

window.спроситьСтроку = спроситьСтроку;

/**
 * День по-человечески: «сегодня», «завтра», иначе «пн, 20 окт».
 * Человеку, который смотрит свои службы на неделю вперёд, год не нужен,
 * а «18 окт 2026» в узкой колонке ещё и ломалось на две строки.
 */
function деньПоЧеловечески(датаISO) {
    const д = DateUtils.parseDate(датаISO);
    // «сегодня» — по часам ашрама, а не устройства (см. DateUtils.nowAshram)
    const сегодня = window.DateUtils?.nowAshram?.() || new Date(); сегодня.setHours(0, 0, 0, 0);
    const разница = Math.round((д - сегодня) / 86400000);
    if (разница === 0) return 'сегодня';
    if (разница === 1) return 'завтра';
    if (разница === 2) return 'послезавтра';
    const дни = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
    const месяцы = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн',
                    'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
    const свой = разница > 0 && разница < 7 ? дни[д.getDay()] + ', ' : '';
    return `${свой}${д.getDate()} ${месяцы[д.getMonth()]}`;
}

window.деньПоЧеловечески = деньПоЧеловечески;


// Глобальный debug-логгер доступен без префикса — используется часто, как console.log.
window.debug = debug;
window.Utils = { pluralize, debounce, debug, escapeHtml, isValidColor, safeColor, textOn, badgeStyle, checkAndMoveDatesAcrossRetreats, fetchAll, getVaishnavName, getVaishnavFullName, pickResident };

})();
