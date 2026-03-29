/**
 * CRM утилиты
 * Общие функции для модуля CRM
 */

const CrmUtils = {
    // ═══════════════════════════════════════════════════════════════
    // КОНСТАНТЫ
    // ═══════════════════════════════════════════════════════════════

    // Статусы воронки (порядок важен!)
    STATUSES: ['lead', 'working', 'invoiced', 'booked', 'checklist', 'ready', 'completed', 'cancelled'],

    // Цвета статусов
    STATUS_COLORS: {
        lead:      '#3b82f6',   // синий — новая заявка
        working:   '#8b5cf6',   // фиолетовый — в работе
        invoiced:  '#f59e0b',   // янтарный — выставлен счёт
        booked:    '#f97316',   // оранжевый — оплачена бронь
        checklist: '#06b6d4',   // голубой — чеклист
        ready:     '#10b981',   // зелёный — готов
        completed: '#6366f1',   // индиго — завершён
        cancelled: '#ef4444'    // красный — отказ
    },

    // Иконки статусов (emoji — для обратной совместимости)
    STATUS_ICONS: {
        lead:      '📥',
        working:   '📞',
        invoiced:  '🧾',
        booked:    '💳',
        checklist: '📋',
        ready:     '✅',
        completed: '🎉',
        cancelled: '❌'
    },

    // SVG иконки статусов (Heroicons style)
    STATUS_SVG_ICONS: {
        lead: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 3.75H6.912a2.25 2.25 0 0 0-2.15 1.588L2.35 13.177a2.25 2.25 0 0 0-.1.661V18a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18v-4.162c0-.224-.034-.447-.1-.661L19.24 5.338a2.25 2.25 0 0 0-2.15-1.588H15M2.25 13.5h6.364a2.25 2.25 0 0 1 2.25 2.25v.894c0 .777.63 1.406 1.407 1.406h.426c.777 0 1.406-.63 1.406-1.406v-.894a2.25 2.25 0 0 1 2.25-2.25h6.364M12 3v6m0 0 2.5-2.5M12 9 9.5 6.5" /></svg>`,
        working: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" /></svg>`,
        invoiced: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>`,
        booked: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 8.25h19.5M2.25 9h19.5m-16.5 5.25h6m-6 2.25h3m-3.75 3h15a2.25 2.25 0 0 0 2.25-2.25V6.75A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25v10.5A2.25 2.25 0 0 0 4.5 19.5Z" /></svg>`,
        checklist: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 0 0 2.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 0 0-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75 2.25 2.25 0 0 0-.1-.664m-5.8 0A2.251 2.251 0 0 1 13.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25ZM6.75 12h.008v.008H6.75V12Zm0 3h.008v.008H6.75V15Zm0 3h.008v.008H6.75V18Z" /></svg>`,
        ready: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
        completed: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M11.48 3.499a.562.562 0 0 1 1.04 0l2.125 5.111a.563.563 0 0 0 .475.345l5.518.442c.499.04.701.663.321.988l-4.204 3.602a.563.563 0 0 0-.182.557l1.285 5.385a.562.562 0 0 1-.84.61l-4.725-2.885a.562.562 0 0 0-.586 0L6.982 20.54a.562.562 0 0 1-.84-.61l1.285-5.386a.562.562 0 0 0-.182-.557l-4.204-3.602a.562.562 0 0 1 .321-.988l5.518-.442a.563.563 0 0 0 .475-.345L11.48 3.5Z" /></svg>`,
        cancelled: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="m9.75 9.75 4.5 4.5m0-4.5-4.5 4.5M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`
    },

    // Режимы работы
    WORK_MODES: ['active', 'long_term', 'paused'],

    // Категории услуг
    SERVICE_CATEGORIES: ['accommodation', 'meals', 'transport', 'other'],

    // Типы оплат
    PAYMENT_TYPES: ['org_fee', 'accommodation', 'meals', 'deposit', 'other'],

    // Методы оплаты
    PAYMENT_METHODS: ['cash', 'card', 'transfer'],

    // Типы коммуникаций
    COMMUNICATION_TYPES: ['call', 'whatsapp', 'telegram', 'email', 'note'],

    // Общие SVG иконки UI (как в kitchen/products.html)
    UI_ICONS: {
        edit: `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" /></svg>`,
        trash: `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>`,
        copy: `<svg xmlns="http://www.w3.org/2000/svg" class="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" /></svg>`,
        warning: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126ZM12 15.75h.007v.008H12v-.008Z" /></svg>`,
        check: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg>`,
        checkCircle: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12.75 11.25 15 15 9.75M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z" /></svg>`,
        trophy: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-12 h-12"><path stroke-linecap="round" stroke-linejoin="round" d="M16.5 18.75h-9m9 0a3 3 0 0 1 3 3h-15a3 3 0 0 1 3-3m9 0v-3.375c0-.621-.503-1.125-1.125-1.125h-.871M7.5 18.75v-3.375c0-.621.504-1.125 1.125-1.125h.872m5.007 0H9.497m5.007 0a7.454 7.454 0 0 1-.982-3.172M9.497 14.25a7.454 7.454 0 0 0 .981-3.172M5.25 4.236c-.982.143-1.954.317-2.916.52A6.003 6.003 0 0 0 7.73 9.728M5.25 4.236V4.5c0 2.108.966 3.99 2.48 5.228M5.25 4.236V2.721C7.456 2.41 9.71 2.25 12 2.25c2.291 0 4.545.16 6.75.47v1.516M7.73 9.728a6.726 6.726 0 0 0 2.748 1.35m8.272-6.842V4.5c0 2.108-.966 3.99-2.48 5.228m2.48-5.492a46.32 46.32 0 0 1 2.916.52 6.003 6.003 0 0 1-5.395 4.972m0 0a6.726 6.726 0 0 1-2.749 1.35m0 0a6.772 6.772 0 0 1-2.752 0" /></svg>`,
        calendar: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M6.75 3v2.25M17.25 3v2.25M3 18.75V7.5a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 7.5v11.25m-18 0A2.25 2.25 0 0 0 5.25 21h13.5A2.25 2.25 0 0 0 21 18.75m-18 0v-7.5A2.25 2.25 0 0 1 5.25 9h13.5A2.25 2.25 0 0 1 21 11.25v7.5" /></svg>`,
        pin: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M3.75 9.776c.112-.017.227-.026.344-.026h15.812c.117 0 .232.009.344.026m-16.5 0a2.25 2.25 0 0 0-1.883 2.542l.857 6a2.25 2.25 0 0 0 2.227 1.932H19.05a2.25 2.25 0 0 0 2.227-1.932l.857-6a2.25 2.25 0 0 0-1.883-2.542m-16.5 0V6A2.25 2.25 0 0 1 6 3.75h3.879a1.5 1.5 0 0 1 1.06.44l2.122 2.12a1.5 1.5 0 0 0 1.06.44H18A2.25 2.25 0 0 1 20.25 9v.776" /></svg>`,
        user: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.501 20.118a7.5 7.5 0 0 1 14.998 0A17.933 17.933 0 0 1 12 21.75c-2.676 0-5.216-.584-7.499-1.632Z" /></svg>`,
        document: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>`,
        exclamationCircle: `<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" viewBox="0 0 24 24" class="w-4 h-4"><circle cx="12" cy="12" r="10"/></svg>`,
        users: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M15 19.128a9.38 9.38 0 0 0 2.625.372 9.337 9.337 0 0 0 4.121-.952 4.125 4.125 0 0 0-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 0 1 8.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0 1 11.964-3.07M12 6.375a3.375 3.375 0 1 1-6.75 0 3.375 3.375 0 0 1 6.75 0Zm8.25 2.25a2.625 2.625 0 1 1-5.25 0 2.625 2.625 0 0 1 5.25 0Z" /></svg>`
    },

    // SVG иконки коммуникаций (Heroicons style)
    COMM_SVG_ICONS: {
        call: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 6.75c0 8.284 6.716 15 15 15h2.25a2.25 2.25 0 0 0 2.25-2.25v-1.372c0-.516-.351-.966-.852-1.091l-4.423-1.106c-.44-.11-.902.055-1.173.417l-.97 1.293c-.282.376-.769.542-1.21.38a12.035 12.035 0 0 1-7.143-7.143c-.162-.441.004-.928.38-1.21l1.293-.97c.363-.271.527-.734.417-1.173L6.963 3.102a1.125 1.125 0 0 0-1.091-.852H4.5A2.25 2.25 0 0 0 2.25 4.5v2.25Z" /></svg>`,
        whatsapp: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M8.625 12a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H8.25m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0H12m4.125 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 0 1-2.555-.337A5.972 5.972 0 0 1 5.41 20.97a5.969 5.969 0 0 1-.474-.065 4.48 4.48 0 0 0 .978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25Z" /></svg>`,
        telegram: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M6 12 3.269 3.125A59.769 59.769 0 0 1 21.485 12 59.768 59.768 0 0 1 3.27 20.875L5.999 12Zm0 0h7.5" /></svg>`,
        email: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M21.75 6.75v10.5a2.25 2.25 0 0 1-2.25 2.25h-15a2.25 2.25 0 0 1-2.25-2.25V6.75m19.5 0A2.25 2.25 0 0 0 19.5 4.5h-15a2.25 2.25 0 0 0-2.25 2.25m19.5 0v.243a2.25 2.25 0 0 1-1.07 1.916l-7.5 4.615a2.25 2.25 0 0 1-2.36 0L3.32 8.91a2.25 2.25 0 0 1-1.07-1.916V6.75" /></svg>`,
        note: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor" class="w-5 h-5"><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m0 12.75h7.5m-7.5 3H12M10.5 2.25H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" /></svg>`
    },

    // Направления коммуникаций
    COMMUNICATION_DIRECTIONS: ['inbound', 'outbound', 'internal'],

    // Приоритеты задач
    TASK_PRIORITIES: ['low', 'normal', 'high', 'urgent'],

    // Цвета приоритетов
    PRIORITY_COLORS: {
        low: '#6b7280',
        normal: '#3b82f6',
        high: '#f97316',
        urgent: '#ef4444'
    },

    // ═══════════════════════════════════════════════════════════════
    // ФОРМАТИРОВАНИЕ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Форматирование суммы с валютой
     */
    formatMoney(amount, currency = 'INR') {
        const symbols = { INR: '₹', RUB: '₽', USD: '$', EUR: '€' };
        const symbol = symbols[currency] || currency;
        const formatted = Number(amount || 0).toLocaleString('ru-RU', {
            minimumFractionDigits: 0,
            maximumFractionDigits: 2
        });
        return `${symbol} ${formatted}`;
    },

    /**
     * Форматирование даты (локальное время!)
     */
    formatDate(dateStr) {
        if (!dateStr) return '';
        const date = DateUtils.parseDate(dateStr);
        const d = String(date.getDate()).padStart(2, '0');
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const y = date.getFullYear();
        return `${d}.${m}.${y}`;
    },

    /**
     * Форматирование даты и времени
     */
    formatDateTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const d = String(date.getDate()).padStart(2, '0');
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const y = date.getFullYear();
        const h = String(date.getHours()).padStart(2, '0');
        const min = String(date.getMinutes()).padStart(2, '0');
        return `${d}.${m}.${y} ${h}:${min}`;
    },

    /**
     * Относительное время (5 мин назад, вчера, и т.д.)
     */
    formatRelativeTime(dateStr) {
        if (!dateStr) return '';
        const date = new Date(dateStr);
        const now = new Date();
        const diff = now - date;

        const minutes = Math.floor(diff / 60000);
        const hours = Math.floor(diff / 3600000);
        const days = Math.floor(diff / 86400000);

        if (minutes < 1) return Layout.t('just_now');
        if (minutes < 60) return `${minutes} мин назад`;
        if (hours < 24) return `${hours} ч назад`;
        if (days < 7) return `${days} дн назад`;
        return this.formatDate(dateStr);
    },

    // ═══════════════════════════════════════════════════════════════
    // ПРОВЕРКИ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Проверка: заявка без контакта > 24ч
     */
    isOverdue(deal) {
        if (deal.status !== 'lead') return false;
        if (deal.first_contacted_at) return false;
        const created = new Date(deal.created_at);
        const now = new Date();
        return (now - created) > 24 * 60 * 60 * 1000;
    },

    /**
     * Проверка: задача просрочена
     */
    isTaskOverdue(task) {
        if (task.completed_at) return false;
        if (!task.due_date) return false;
        const now = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const dueDate = DateUtils.parseDate(task.due_date);
        return dueDate < today;
    },

    /**
     * Проверка: сделка активна (не отменена и не завершена)
     */
    isActive(deal) {
        return deal.status !== 'cancelled' && deal.status !== 'completed';
    },

    // ═══════════════════════════════════════════════════════════════
    // РАБОТА С ГОСТЯМИ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Получить имя гостя (spiritual_name приоритет)
     */
    getGuestName(vaishnava) {
        if (!vaishnava) return '';
        const sn = vaishnava.spiritual_name && vaishnava.spiritual_name !== '-' && vaishnava.spiritual_name !== '—' ? vaishnava.spiritual_name : '';
        return sn ||
               `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim() ||
               vaishnava.email ||
               'Без имени';
    },

    /**
     * Получить короткое имя гостя (для карточек)
     */
    getGuestShortName(vaishnava) {
        if (!vaishnava) return '';
        const sn = vaishnava.spiritual_name && vaishnava.spiritual_name !== '-' && vaishnava.spiritual_name !== '—' ? vaishnava.spiritual_name : '';
        if (sn) return sn;
        if (vaishnava.first_name) {
            const lastName = vaishnava.last_name ? ` ${vaishnava.last_name[0]}.` : '';
            return vaishnava.first_name + lastName;
        }
        return vaishnava.email || 'Без имени';
    },

    /**
     * Получить контактную информацию гостя
     */
    getGuestContact(vaishnava) {
        if (!vaishnava) return '';
        return vaishnava.phone || vaishnava.telegram || vaishnava.email || '';
    },

    /**
     * Расчёт заполненности профиля
     */
    getProfileCompleteness(vaishnava) {
        if (!vaishnava) return 0;
        const fields = ['first_name', 'last_name', 'phone', 'email', 'country', 'city'];
        const filled = fields.filter(f => vaishnava[f]).length;
        return Math.round(filled / fields.length * 100);
    },

    // ═══════════════════════════════════════════════════════════════
    // ЦЕНЫ И ФИНАНСЫ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Получить цену услуги для ретрита
     * Сначала проверяет crm_retreat_prices, потом default_price
     */
    async getServicePrice(serviceId, retreatId) {
        // Сначала проверить кастомную цену для ретрита
        const { data: custom } = await Layout.db
            .from('crm_retreat_prices')
            .select('price')
            .eq('service_id', serviceId)
            .eq('retreat_id', retreatId)
            .maybeSingle();

        if (custom) return Number(custom.price);

        // Иначе базовая цена
        const { data: service } = await Layout.db
            .from('crm_services')
            .select('default_price')
            .eq('id', serviceId)
            .maybeSingle();

        return Number(service?.default_price || 0);
    },

    /**
     * Пересчёт суммы в рупии
     */
    async convertToINR(amount, currencyCode) {
        if (currencyCode === 'INR') return Number(amount);

        const { data: currency } = await Layout.db
            .from('crm_currencies')
            .select('rate_to_inr')
            .eq('code', currencyCode)
            .maybeSingle();

        return Number(amount) * Number(currency?.rate_to_inr || 1);
    },

    /**
     * Расчёт баланса сделки
     */
    getBalance(deal) {
        const charged = Number(deal.total_charged || 0);
        const paid = Number(deal.total_paid || 0);
        return paid - charged;
    },

    /**
     * Получить текст баланса с цветом
     */
    getBalanceHtml(deal) {
        const balance = this.getBalance(deal);
        if (balance === 0) {
            return `<span class="text-success">${this.formatMoney(0)}</span>`;
        } else if (balance > 0) {
            return `<span class="text-success">+${this.formatMoney(balance)}</span>`;
        } else {
            return `<span class="text-error">${this.formatMoney(balance)}</span>`;
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // СТАТУСЫ И ПЕРЕХОДЫ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Получить индекс статуса в воронке
     */
    getStatusIndex(status) {
        return this.STATUSES.indexOf(status);
    },

    /**
     * Получить следующий статус
     */
    getNextStatus(currentStatus) {
        const idx = this.getStatusIndex(currentStatus);
        if (idx === -1 || idx >= this.STATUSES.length - 1) return null;
        // Пропускаем cancelled при автопереходе
        const next = this.STATUSES[idx + 1];
        if (next === 'cancelled') return null;
        return next;
    },

    /**
     * Получить допустимые переходы из текущего статуса
     */
    getAllowedTransitions(currentStatus) {
        const idx = this.getStatusIndex(currentStatus);
        if (idx === -1) return [];

        // Можно переходить на следующие статусы или отменить
        const allowed = [];
        for (let i = idx + 1; i < this.STATUSES.length; i++) {
            allowed.push(this.STATUSES[i]);
        }
        // Также можно вернуться назад (кроме cancelled)
        if (currentStatus !== 'cancelled') {
            for (let i = 0; i < idx; i++) {
                if (this.STATUSES[i] !== 'cancelled') {
                    allowed.push(this.STATUSES[i]);
                }
            }
        }
        return allowed;
    },

    /**
     * Получить локализованное название статуса
     */
    getStatusLabel(status) {
        const fallback = { lead: 'Заявка', working: 'В работе', invoiced: 'Выставлен счёт', booked: 'Оплачена бронь', checklist: 'Чек лист', ready: 'Готов', completed: 'Ретрит завершён', cancelled: 'Отказ' };
        const translated = Layout.t(`crm_status_${status}`);
        return (translated && !translated.startsWith('crm_status_')) ? translated : (fallback[status] || status);
    },

    /**
     * Получить badge статуса
     */
    getStatusBadge(status, size = 'md') {
        const color = this.STATUS_COLORS[status] || '#6b7280';
        // Для бейджей используем уменьшенные иконки
        const svg = this.STATUS_SVG_ICONS[status]?.replace('w-5 h-5', size === 'sm' ? 'w-3 h-3' : 'w-4 h-4') || '';
        const label = this.getStatusLabel(status);
        const badgeSize = size === 'sm' ? 'badge-sm' : '';
        return `<span class="badge ${badgeSize} gap-1 items-center" style="background-color: ${color}; color: white;">
            ${svg} ${Layout.escapeHtml(label)}
        </span>`;
    },

    // ═══════════════════════════════════════════════════════════════
    // ШАБЛОНЫ СООБЩЕНИЙ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Заполнить шаблон данными
     */
    fillTemplate(template, data) {
        if (!template) return '';
        let result = template;
        for (const [key, value] of Object.entries(data)) {
            result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), value || '');
        }
        return result;
    },

    /**
     * Копировать текст в буфер обмена
     */
    async copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            Layout.showNotification(Layout.t('copied'), 'success');
            return true;
        } catch (err) {
            console.error('Copy failed:', err);
            Layout.showNotification(Layout.t('copy_failed'), 'error');
            return false;
        }
    },

    // ═══════════════════════════════════════════════════════════════
    // МЕНЕДЖЕРЫ И РАСПРЕДЕЛЕНИЕ
    // ═══════════════════════════════════════════════════════════════

    /**
     * Получить следующего менеджера из очереди (round-robin)
     */
    async getNextManager(retreatId) {
        // Получаем менеджеров ретрита, отсортированных по last_assigned_at
        const { data: managers } = await Layout.db
            .from('crm_retreat_managers')
            .select(`
                manager_id,
                vaishnavas!inner(id, spiritual_name, first_name, last_name),
                crm_manager_queue!inner(last_assigned_at, is_active)
            `)
            .eq('retreat_id', retreatId)
            .eq('is_active', true)
            .eq('crm_manager_queue.is_active', true)
            .order('crm_manager_queue(last_assigned_at)', { ascending: true, nullsFirst: true });

        if (!managers || managers.length === 0) return null;

        // Возвращаем первого (с самым старым last_assigned_at или null)
        return managers[0];
    },

    /**
     * Обновить время последнего назначения менеджера
     */
    async updateManagerLastAssigned(managerId) {
        await Layout.db
            .from('crm_manager_queue')
            .update({ last_assigned_at: new Date().toISOString() })
            .eq('manager_id', managerId);
    },

    // ═══════════════════════════════════════════════════════════════
    // СТАТИСТИКА
    // ═══════════════════════════════════════════════════════════════

    /**
     * Получить статистику по статусам для ретрита
     */
    async getStatusStats(retreatId) {
        const { data } = await Layout.db
            .from('crm_deals')
            .select('status')
            .eq('retreat_id', retreatId);

        if (!data) return {};

        const stats = {};
        for (const status of this.STATUSES) {
            stats[status] = 0;
        }
        for (const deal of data) {
            stats[deal.status] = (stats[deal.status] || 0) + 1;
        }
        return stats;
    },

    /**
     * Рассчитать конверсию воронки
     */
    calculateConversion(stats) {
        const result = [];
        let prev = null;
        for (const status of this.STATUSES) {
            if (status === 'cancelled') continue;
            const count = stats[status] || 0;
            const conversion = prev !== null && prev > 0
                ? Math.round(count / prev * 100)
                : 100;
            result.push({ status, count, conversion });
            prev = count;
        }
        return result;
    },

    /**
     * Загрузить и показать бейдж с количеством активных задач в навигации
     */
    loadTaskBadge: async function() {
        try {
            const userId = window.currentUser?.vaishnava_id;
            if (!userId || !Layout.db) return;

            const { count } = await Layout.db
                .from('crm_tasks')
                .select('*', { count: 'exact', head: true })
                .eq('assignee_id', userId)
                .is('completed_at', null);

            if (!count || count <= 0) return;

            // Ищем ссылку на задачи в меню
            const taskLink = document.querySelector('a[href*="tasks.html"]');
            if (taskLink) {
                const badge = document.createElement('span');
                badge.className = 'badge badge-sm badge-error ml-1';
                badge.textContent = count;
                taskLink.appendChild(badge);
            }
        } catch (e) {
            // Не критично — просто не показываем бейдж
        }
    }
};

// Экспорт в глобальную область
window.CrmUtils = CrmUtils;

// Автозагрузка бейджа задач при загрузке страницы CRM
document.addEventListener('DOMContentLoaded', function() {
    setTimeout(function() { CrmUtils.loadTaskBadge(); }, 1500);
});
