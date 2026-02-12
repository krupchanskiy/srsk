// Утилиты для работы с датами
// Общие функции форматирования дат для всего проекта

window.DateUtils = {
    // Безопасный парсинг даты — 'YYYY-MM-DD' без времени парсится как локальное время
    parseDate(val) {
        if (val instanceof Date) return val;
        if (typeof val === 'string') {
            if (/^\d{4}-\d{2}-\d{2}$/.test(val)) {
                return new Date(val + 'T00:00:00');
            }
            return new Date(val);
        }
        return new Date(val);
    },

    // Названия месяцев по языкам
    monthNames: {
        ru: ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
             'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'],
        en: ['January', 'February', 'March', 'April', 'May', 'June',
             'July', 'August', 'September', 'October', 'November', 'December'],
        hi: ['जनवरी', 'फ़रवरी', 'मार्च', 'अप्रैल', 'मई', 'जून',
             'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर']
    },

    // Короткие названия месяцев
    monthNamesShort: {
        ru: ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'],
        en: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        hi: ['जन', 'फ़र', 'मार्च', 'अप्रै', 'मई', 'जून', 'जुल', 'अग', 'सित', 'अक्टू', 'नव', 'दिस']
    },

    // Названия дней недели
    dayNames: {
        ru: ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'],
        en: ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'],
        hi: ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार']
    },

    // Короткие названия дней недели
    dayNamesShort: {
        ru: ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'],
        en: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        hi: ['रवि', 'सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि']
    },

    // Получить текущий язык
    getLang() {
        return (typeof Layout !== 'undefined' && Layout.currentLang) || 'ru';
    },

    // Форматирование даты в ISO (YYYY-MM-DD)
    toISO(date) {
        date = this.parseDate(date);
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    },

    // Форматирование для input[type="date"]
    toInputFormat(date) {
        return this.toISO(date);
    },

    // Форматирование для отображения: "5 января 2026"
    formatDisplay(date, lang = null) {
        date = this.parseDate(date);
        lang = lang || this.getLang();
        const day = date.getDate();
        const month = this.monthNames[lang]?.[date.getMonth()] || this.monthNames.ru[date.getMonth()];
        const year = date.getFullYear();
        return `${day} ${month} ${year}`;
    },

    // Короткий формат: "5 янв 2026"
    formatShort(date, lang = null) {
        date = this.parseDate(date);
        lang = lang || this.getLang();
        const day = date.getDate();
        const month = this.monthNamesShort[lang]?.[date.getMonth()] || this.monthNamesShort.ru[date.getMonth()];
        const year = date.getFullYear();
        return `${day} ${month} ${year}`;
    },

    // Формат с днём недели: "5 января 2026, Пн"
    formatWithWeekday(date, lang = null) {
        date = this.parseDate(date);
        lang = lang || this.getLang();
        const display = this.formatDisplay(date, lang);
        const weekday = this.dayNamesShort[lang]?.[date.getDay()] || this.dayNamesShort.ru[date.getDay()];
        return `${display}, ${weekday}`;
    },

    // Диапазон дат: "5 - 10 января 2026" или "28 декабря 2025 - 5 января 2026"
    formatRange(startDate, endDate, lang = null) {
        startDate = this.parseDate(startDate);
        endDate = this.parseDate(endDate);
        lang = lang || this.getLang();

        const sameYear = startDate.getFullYear() === endDate.getFullYear();
        const sameMonth = sameYear && startDate.getMonth() === endDate.getMonth();

        if (sameMonth) {
            // "5 - 10 января 2026"
            const month = this.monthNames[lang]?.[startDate.getMonth()] || this.monthNames.ru[startDate.getMonth()];
            return `${startDate.getDate()} - ${endDate.getDate()} ${month} ${endDate.getFullYear()}`;
        } else if (sameYear) {
            // "28 ноября - 5 декабря 2026"
            const startMonth = this.monthNames[lang]?.[startDate.getMonth()] || this.monthNames.ru[startDate.getMonth()];
            const endMonth = this.monthNames[lang]?.[endDate.getMonth()] || this.monthNames.ru[endDate.getMonth()];
            return `${startDate.getDate()} ${startMonth} - ${endDate.getDate()} ${endMonth} ${endDate.getFullYear()}`;
        } else {
            // "28 декабря 2025 - 5 января 2026"
            return `${this.formatDisplay(startDate, lang)} - ${this.formatDisplay(endDate, lang)}`;
        }
    },

    // Форматирование времени: "14:30"
    formatTime(date) {
        date = this.parseDate(date);
        const hours = String(date.getHours()).padStart(2, '0');
        const minutes = String(date.getMinutes()).padStart(2, '0');
        return `${hours}:${minutes}`;
    },

    // Форматирование даты и времени: "5 янв 2026, 14:30"
    formatDateTime(date, lang = null) {
        date = this.parseDate(date);
        return `${this.formatShort(date, lang)}, ${this.formatTime(date)}`;
    },

    // Вычисление возраста
    calculateAge(birthDate, referenceDate = null) {
        birthDate = this.parseDate(birthDate);
        const today = referenceDate ? this.parseDate(referenceDate) : new Date();

        let age = today.getFullYear() - birthDate.getFullYear();
        const monthDiff = today.getMonth() - birthDate.getMonth();

        if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
            age--;
        }

        return age;
    },

    // Проверка на сегодня
    isToday(date) {
        date = this.parseDate(date);
        const today = new Date();
        return date.getDate() === today.getDate() &&
               date.getMonth() === today.getMonth() &&
               date.getFullYear() === today.getFullYear();
    },

    // Проверка на завтра
    isTomorrow(date) {
        date = this.parseDate(date);
        const tomorrow = new Date();
        tomorrow.setDate(tomorrow.getDate() + 1);
        return date.getDate() === tomorrow.getDate() &&
               date.getMonth() === tomorrow.getMonth() &&
               date.getFullYear() === tomorrow.getFullYear();
    },

    // Проверка на вчера
    isYesterday(date) {
        date = this.parseDate(date);
        const yesterday = new Date();
        yesterday.setDate(yesterday.getDate() - 1);
        return date.getDate() === yesterday.getDate() &&
               date.getMonth() === yesterday.getMonth() &&
               date.getFullYear() === yesterday.getFullYear();
    },

    // Получить строку "сегодня", "завтра" или дату
    formatRelative(date, lang = null) {
        lang = lang || this.getLang();
        const labels = {
            ru: { today: 'Сегодня', tomorrow: 'Завтра', yesterday: 'Вчера' },
            en: { today: 'Today', tomorrow: 'Tomorrow', yesterday: 'Yesterday' },
            hi: { today: 'आज', tomorrow: 'कल', yesterday: 'कल' }
        };
        const l = labels[lang] || labels.ru;

        if (this.isToday(date)) return l.today;
        if (this.isTomorrow(date)) return l.tomorrow;
        if (this.isYesterday(date)) return l.yesterday;
        return this.formatShort(date, lang);
    },

    // Проверка выходного дня
    isWeekend(date) {
        date = this.parseDate(date);
        const day = date.getDay();
        return day === 0 || day === 6;
    },

    // Добавить дни к дате
    addDays(date, days) {
        date = this.parseDate(date);
        const result = new Date(date);
        result.setDate(result.getDate() + days);
        return result;
    },

    // Разница в днях между датами
    diffInDays(startDate, endDate) {
        startDate = this.parseDate(startDate);
        endDate = this.parseDate(endDate);
        const diff = endDate - startDate;
        return Math.floor(diff / (1000 * 60 * 60 * 24));
    }
};
