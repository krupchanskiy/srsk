// Form III — выписка иностранцев на портале FRRO (Mark Checkout). Вкладка «Выписка» в reception/form3.html.
// Решения ВГ 17.11.2026:
//   • очередь строится из шахматки: каждый иностранец, чьё проживание закончилось (выселили кнопкой, ночной
//     автоматикой или просто прошла дата выезда — тогда пометка «в шахматке не выселен»);
//     переезд в другую комнату без перерыва — не выезд (Form3.mergeStays);
//   • время отъезда — residents.departure_time, «куда едет» — residents.next_destination (мигр. 788),
//     вписывает ресепшен при выселении; без них закладка человека не берёт;
//   • срок — сутки от выезда; меньше 4 часов или просрочено — красная плашка сверху;
//   • закладка «ШРСК → выписка» на портале открывает это окно, обмен через postMessage (без буфера обмена):
//     портал присылает список PENDING FOR CHECKOUT → здесь сверка (связать анкеты без номера, убрать уже
//     выписанных) → очередь уходит на портал → после одного «Выписать всех» портал выписывает подряд,
//     на любом расхождении останавливается и шлёт сюда результат по каждому → form3_entries.checkout_marked_at.
// Выписать можно только после фактического отъезда: портал не даёт поставить будущее время.

const Form3Checkout = (() => {
    const e = s => Layout.escapeHtml(s == null ? '' : String(s));
    const PORTAL = 'https://indianfrro.gov.in';
    const HOUR = 3600 * 1000, DAY = 24 * HOUR;
    const LOOKBACK_DAYS = 30;   // выезды за последний месяц; раньше — выписаны по учётной книге (17.11)
    const BY_NAME_FROM = '2026-11-27'; // брони «на имя» — с этого выезда (ВГ 27.11); прежние выписаны по книге

    let items = [];     // все заезды иностранцев, пересекающие [сегодня − 30 дней, сегодня]
    let query = '';
    let portal = null;  // { source, rows, total, at } — список PENDING FOR CHECKOUT с портала
    let links = [], stale = [], notFound = [];
    let log = [];
    let loaded = null;

    // ==================== ЗАГРУЗКА ====================
    async function load() {
        const today = DateUtils.toISO(new Date());
        const from = DateUtils.toISO(new Date(Date.now() - LOOKBACK_DAYS * DAY));
        const cols = 'id, vaishnava_id, check_in, check_out, arrival_time, departure_time, next_destination, arrived_at, arrived_auto, has_housing, status, rooms(number, buildings(name_ru, name_en, name_hi))';

        const { data: res, error } = await Layout.db.from('residents').select('vaishnava_id')
            .not('vaishnava_id', 'is', null).neq('status', 'cancelled')
            .lte('check_in', today).gte('check_out', from);
        if (error) { Layout.handleError(error, 'Выписка'); return; }
        const ids = [...new Set((res || []).map(r => r.vaishnava_id))];

        // Брони «на имя» (без карточки): гражданства нет, ищем на портале по имени из брони
        const nameFrom = from > BY_NAME_FROM ? from : BY_NAME_FROM;
        const { data: byName, error: bnErr } = await Layout.db.from('residents').select(cols + ', guest_name')
            .is('vaishnava_id', null).not('guest_name', 'is', null).neq('status', 'cancelled')
            .lte('check_in', today).gte('check_out', nameFrom);
        if (bnErr) { Layout.handleError(bnErr, 'Выписка'); return; }
        const bnRows = (byName || []).filter(r => r.has_housing !== false && r.guest_name.trim());
        let bnEntries = [];
        if (bnRows.length) {
            const { data, error: enErr } = await Layout.db.from('form3_entries').select('*').in('resident_id', bnRows.map(r => r.id));
            if (enErr) { Layout.handleError(enErr, 'Выписка'); return; }
            bnEntries = data || [];
        }

        const none = { data: [], error: null };
        const [vs, allRes, docs, entries] = !ids.length ? [none, none, none, none] : await Promise.all([
            Layout.db.from('vaishnavas').select('id, spiritual_name, first_name, last_name, citizenship').in('id', ids)
                .or('citizenship.is.null,citizenship.neq.IND'),   // без гражданства — только для сверки с порталом
            Layout.db.from('residents').select(cols).in('vaishnava_id', ids).neq('status', 'cancelled').order('check_in'),
            Layout.db.from('vaishnava_documents').select('vaishnava_id, passport_number, passport_surname, passport_given_name').in('vaishnava_id', ids),
            Layout.db.from('form3_entries').select('*').in('vaishnava_id', ids)
        ]);
        for (const r of [vs, allRes, docs, entries]) if (r.error) { Layout.handleError(r.error, 'Выписка'); return; }

        const docByV = new Map(docs.data.map(d => [d.vaishnava_id, d]));
        const resByV = new Map();
        allRes.data.filter(r => r.has_housing !== false).forEach(r => {
            if (!resByV.has(r.vaishnava_id)) resByV.set(r.vaishnava_id, []);
            resByV.get(r.vaishnava_id).push(r);
        });

        items = [];
        for (const v of vs.data) {
            for (const stay of Form3.mergeStays(resByV.get(v.id) || [])) {
                if (stay.check_in > today || stay.check_out < from) continue;
                const last = [...stay.rows].sort((a, b) => a.check_out.localeCompare(b.check_out)).pop();
                const entry = entries.data.find(en => en.vaishnava_id === v.id &&
                    (stay.rows.some(r => r.id === en.resident_id) ||
                     (en.arrival_date && en.arrival_date >= stay.check_in && en.arrival_date <= stay.check_out))) ||
                    bnEntries.find(en => stay.rows.some(r => r.id === en.resident_id)) || null;
                const time = last.departure_time ? last.departure_time.slice(0, 5) : null;
                const moment = time ? new Date(`${stay.check_out}T${time}`) : DateUtils.parseDate(stay.check_out);
                items.push({
                    known: !!v.citizenship, v, doc: docByV.get(v.id) || null, entry, stay, last,
                    date: stay.check_out, time, dest: last.next_destination || null,
                    ended: stay.check_out <= today, notOut: last.status !== 'checked_out',
                    moment, deadline: new Date(moment.getTime() + DAY)
                });
            }
        }
        for (const r of bnRows) {
            const time = r.departure_time ? r.departure_time.slice(0, 5) : null;
            const moment = time ? new Date(`${r.check_out}T${time}`) : DateUtils.parseDate(r.check_out);
            items.push({
                known: false, byName: true, v: { id: null, spiritual_name: r.guest_name.trim(), citizenship: null },
                doc: null, entry: bnEntries.find(en => en.resident_id === r.id) || null,
                stay: { check_in: r.check_in, check_out: r.check_out, rows: [r] }, last: r,
                date: r.check_out, time, dest: r.next_destination || null,
                ended: r.check_out <= today, notOut: r.status !== 'checked_out',
                moment, deadline: new Date(moment.getTime() + DAY)
            });
        }
        items.sort((a, b) => a.moment - b.moment || nameOf(a.v).localeCompare(nameOf(b.v)));
        if (portal) analyze();
        render();
    }

    // ==================== ПРАВИЛА ====================
    const nameOf = v => v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || '—';
    const latinOf = it => [it.doc?.passport_given_name, it.doc?.passport_surname].filter(Boolean).join(' ');
    const marked = it => !!it.entry?.checkout_marked_at;
    // В очереди — иностранцы (гражданство не IND) и все, у кого есть анкета; без гражданства и анкеты — только сверка
    // Брони «на имя» — тоже в очереди: гражданство неизвестно, сверка с порталом по имени из брони
    const inQueue = it => it.ended && !marked(it) && (it.known || it.byName || !!it.entry?.form3_id);
    // Минуты на циферблате портала — шаг 5, округляем вниз (не позже фактического отъезда)
    const portalTime = t => { const [h, m] = t.split(':').map(Number); return `${String(h).padStart(2, '0')}:${String(m - m % 5).padStart(2, '0')}`; };

    function issuesOf(it) {
        const out = [];
        if (!it.time) out.push('впишите время отъезда');
        if (!it.dest) out.push('впишите, куда едет');
        if (!it.entry?.form3_id) out.push('нет номера анкеты — сверит закладка');
        return out;
    }
    const ready = it => inQueue(it) && !issuesOf(it).length && it.moment.getTime() <= Date.now();
    const urgent = it => inQueue(it) && it.deadline.getTime() - Date.now() < 4 * HOUR;

    function placeOf(it) {
        const r = it.last;
        const b = r.rooms?.buildings ? Layout.getName(r.rooms.buildings) : '';
        return [b, r.rooms?.number].filter(Boolean).join(', ');
    }

    function fmtDate(iso) {
        if (!iso) return '—';
        return DateUtils.parseDate(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }
    const fmtDay = iso => DateUtils.parseDate(iso).toLocaleDateString('ru-RU', { weekday: 'short', day: 'numeric', month: 'long' });
    const fmtAt = d => d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

    function deadlineBadge(it) {
        if (marked(it)) return `<span class="badge badge-success whitespace-nowrap">выписан ${fmtAt(new Date(it.entry.checkout_marked_at))}</span>`;
        if (it.moment.getTime() > Date.now()) return `<span class="badge badge-ghost whitespace-nowrap" title="Портал не даёт отметить выезд заранее">выписать после ${it.time || 'отъезда'}</span>`;
        const left = it.deadline.getTime() - Date.now();
        const h = Math.max(0, Math.round(Math.abs(left) / HOUR));
        const approx = it.time ? '' : ' (время отъезда неизвестно, считаю от начала дня)';
        const title = `Выписать до ${fmtAt(it.deadline)}${approx}`;
        if (left < 0) return `<span class="badge badge-error whitespace-nowrap" title="${e(title)}">просрочено на ${h} ч</span>`;
        return `<span class="badge ${left < 4 * HOUR ? 'badge-error' : 'badge-ghost'} whitespace-nowrap" title="${e(title)}">до ${fmtAt(it.deadline)}</span>`;
    }

    // ==================== ПОИСК ====================
    function matches(it) {
        if (!query) return true;
        const hay = [nameOf(it.v), it.v.first_name, it.v.last_name, latinOf(it), it.v.citizenship,
            placeOf(it), it.entry?.form3_id, it.dest].filter(Boolean).join(' ').toLowerCase();
        return query.split(/\s+/).every(w => hay.includes(w));
    }

    // ==================== РЕНДЕР ====================
    function render() {
        const box = document.getElementById('checkout-tab');
        if (!box) return;
        const queue = items.filter(inQueue);
        const urg = queue.filter(urgent);
        const nReady = queue.filter(ready).length;

        // счётчик на вкладке
        const tab = document.querySelector('[data-tab="checkout"]');
        let cnt = document.getElementById('cntCheckout');
        if (tab && !cnt) { cnt = document.createElement('span'); cnt.id = 'cntCheckout'; cnt.className = 'ml-1'; tab.appendChild(cnt); }
        if (cnt) cnt.textContent = queue.length ? `(${queue.length})` : '';

        // красная плашка над вкладками — видна на любой вкладке
        let alertBox = document.getElementById('f3CheckoutAlert');
        if (!alertBox) {
            alertBox = document.createElement('div');
            alertBox.id = 'f3CheckoutAlert';
            document.getElementById('f3Summary')?.before(alertBox);
        }
        alertBox.innerHTML = urg.length ? `<div class="alert alert-error mb-3"><div>
            <b>⚠ Выписка FRRO: ${urg.length} чел. — срок меньше 4 часов или просрочен.</b>
            <div class="text-sm">${urg.map(it => `${e(nameOf(it.v))} — ${it.deadline < new Date() ? 'просрочено' : 'до ' + fmtAt(it.deadline)}`).join('; ')}</div>
            <a class="link text-sm" data-co="goto">Открыть «Выписку»</a></div></div>` : '';

        const shown = items.filter(it => inQueue(it) && matches(it));
        const done = items.filter(it => marked(it) && matches(it));

        // по дням выезда
        const days = new Map();
        shown.forEach(it => { if (!days.has(it.date)) days.set(it.date, []); days.get(it.date).push(it); });
        const body = [...days.entries()].map(([d, list]) => `
            <tr class="bg-base-200"><td colspan="5" class="font-semibold">${e(fmtDay(d))} <span class="opacity-60 font-normal">· ${list.length} чел.</span></td></tr>
            ${list.map(row).join('')}`).join('');

        box.innerHTML = `
            ${portalPanel(nReady)}
            <div class="flex flex-wrap items-center gap-2 mb-3">
                <span class="text-sm opacity-80">В очереди: <b>${queue.length}</b>, готовы к выписке: <b>${nReady}</b>.</span>
            </div>
            ${queue.length ? (shown.length ? `<div class="overflow-x-auto bg-base-100 rounded-lg"><table class="table table-sm">
                <thead><tr><th>Человек</th><th>Заезд → выезд</th><th>Время и куда едет</th><th>Срок</th><th>Что не хватает</th></tr></thead>
                <tbody>${body}</tbody></table></div>` : '<div class="opacity-60 p-4">По поиску никого не нашлось.</div>')
                : '<div class="opacity-60 p-4">Выписывать некого: все уехавшие иностранцы выписаны.</div>'}
            ${done.length ? `<details class="mt-4"><summary class="cursor-pointer text-sm opacity-70">Выписаны за последний месяц (${done.length})</summary>
                <div class="overflow-x-auto bg-base-100 rounded-lg mt-2"><table class="table table-sm"><tbody>
                ${done.map(it => `<tr><td>${e(nameOf(it.v))} <span class="text-xs opacity-60">${e(latinOf(it))}</span></td>
                    <td class="font-mono text-xs">${e(it.entry.form3_id || '—')}</td>
                    <td class="whitespace-nowrap">${fmtDate(it.date)} ${e(it.time || '')}</td><td>${e(it.entry.next_destination || it.dest || '')}</td>
                    <td>${deadlineBadge(it)}</td></tr>`).join('')}
                </tbody></table></div></details>` : ''}`;
    }

    function row(it) {
        const i = items.indexOf(it);
        const iss = issuesOf(it);
        if (it.notOut) iss.push('в шахматке не выселен');
        return `<tr>
            <td>${it.byName ? `<span class="font-medium">${e(nameOf(it.v))}</span>`
                : `<a class="link font-medium" href="../vaishnavas/person.html?id=${e(it.v.id)}" target="_blank">${e(nameOf(it.v))}</a>`}
                <div class="text-xs opacity-70">${it.byName ? 'бронь на имя, без карточки' : `${e(latinOf(it))}${latinOf(it) ? ' · ' : ''}${e(it.v.citizenship)}`} · ${e(placeOf(it))}</div>
                ${it.entry?.form3_id ? `<div class="text-xs font-mono opacity-70">${e(it.entry.form3_id)}</div>` : ''}</td>
            <td class="whitespace-nowrap">${fmtDate(it.stay.check_in)} → ${fmtDate(it.date)}</td>
            <td><div class="flex flex-wrap items-center gap-1">
                <input type="time" step="300" class="input input-bordered input-xs w-24 ${it.time ? '' : 'input-warning'}" data-co-time="${i}" value="${e(it.time || '')}">
                <input type="text" class="input input-bordered input-xs w-36 ${it.dest ? '' : 'input-warning'}" data-co-dest="${i}" value="${e(it.dest || '')}" placeholder="куда едет">
                <button class="btn btn-xs" data-co="save" data-i="${i}">Сохранить</button></div></td>
            <td>${deadlineBadge(it)}</td>
            <td>${iss.length ? `<span class="text-warning">⚠</span> <span class="text-xs">${e(iss.join('; '))}</span>` : '<span class="badge badge-success badge-sm">готов</span>'}
                <div><button class="btn btn-ghost btn-xs mt-1" data-co="manual" data-i="${i}" title="Выписан на портале вручную — убрать из очереди">Выписан вручную</button></div></td>
        </tr>`;
    }

    // ==================== СВЯЗЬ С ПОРТАЛОМ ====================
    function portalPanel(nReady) {
        if (!portal) {
            if (location.hash === '#frro-checkout')
                return '<div class="alert mb-3 text-sm"><span class="loading loading-spinner loading-sm"></span> Жду список PENDING FOR CHECKOUT с портала…</div>';
            // До закладки кнопки выписки нет — показываем, как до неё дойти
            return `<div class="bg-base-100 rounded-lg p-4 mb-4 border border-primary space-y-2">
                <div class="font-semibold">Как выписать${nReady ? ` (готовы: ${nReady})` : ''}</div>
                <ol class="list-decimal ml-5 text-sm space-y-1">
                    <li>Откройте портал FRRO, войдите → Form III Details → вкладка <b>PENDING FOR CHECKOUT</b>.
                        <a class="btn btn-xs btn-primary ml-1" href="${PORTAL}/formIII/" target="_blank" rel="noopener">Открыть портал</a></li>
                    <li>На портале нажмите закладку <b>«ШРСК → выписка»</b> на панели закладок браузера.
                        Её ещё нет — <a class="link" data-co="bookmarks">возьмите на вкладке «Закладки»</a> (перетащить на панель).</li>
                    <li>Откроется это окно со сверкой и кнопкой <b>«Выписать на портале»</b>. Нажмите её, вернитесь на портал и нажмите <b>«Выписать всех»</b>.</li>
                </ol>
                <div class="text-xs opacity-70">Выписали на портале руками — нажмите «Выписан вручную» у человека, он уйдёт из очереди.</div>
            </div>`;
        }
        const full = portal.total == null || portal.rows.length >= portal.total;
        const linkRows = links.map((l, k) => `<tr>
            <td><input type="checkbox" class="checkbox checkbox-sm" data-co-link="${k}" ${l.sure ? 'checked' : ''}></td>
            <td>${e(nameOf(l.it.v))}<div class="text-xs opacity-70">${e(latinOf(l.it))} · заезд ${fmtDate(l.it.stay.check_in)}</div></td>
            <td><span class="font-mono">${e(l.row.id)}</span><div class="text-xs opacity-70">${e(l.row.name)} · ${e(l.row.nationality || '')} · заезд ${fmtDate(l.row.arrival)}</div>
                ${l.it.known || l.it.byName ? '' : `<div class="text-xs">гражданство в ШРСК не указано → ${e(isoOf(l.row.nationality) || 'выбрать вручную')}</div>`}</td>
            <td class="text-xs">${e(l.why)}${l.sure ? '' : ' <span class="text-warning">⚠ проверьте</span>'}</td></tr>`).join('');
        return `<div class="bg-base-100 rounded-lg p-4 mb-4 space-y-3 border border-primary">
            <div class="font-semibold">Портал FRRO: невыписанных ${portal.rows.length}${portal.total != null ? ` из ${portal.total}` : ''} (список на ${fmtAt(new Date(portal.at))})</div>
            ${full ? '' : '<div class="alert alert-warning text-sm">⚠ С портала пришёл неполный список — «уже выписаны» не проверяю. Нажмите закладку ещё раз.</div>'}
            ${links.length ? `<div><div class="font-medium mb-1">Анкеты без номера в ШРСК — нашлись на портале по имени и дате заезда (±1 день):</div>
                <div class="overflow-x-auto"><table class="table table-sm"><thead><tr><th></th><th>В ШРСК</th><th>На портале</th><th>Почему</th></tr></thead>
                <tbody>${linkRows}</tbody></table></div>
                <button class="btn btn-sm btn-primary mt-1" data-co="link">Связать отмеченные</button></div>` : ''}
            ${stale.length ? `<div><div class="font-medium mb-1">Уже не в PENDING FOR CHECKOUT — значит, выписаны на портале раньше (${stale.length}):</div>
                <div class="text-sm">${stale.map(it => `${e(nameOf(it.v))} <span class="font-mono text-xs">${e(it.entry.form3_id)}</span>`).join('; ')}</div>
                <button class="btn btn-sm mt-1" data-co="stale">Отметить выписанными</button></div>` : ''}
            ${notFound.length ? `<div><div class="font-medium mb-1">Уехали, номера анкеты нет, и среди невыписанных на портале не нашлись (${notFound.length}):</div>
                <div class="text-sm">${notFound.map(it => `${e(nameOf(it.v))} (${fmtDate(it.stay.check_in)} → ${fmtDate(it.date)})`).join('; ')}</div>
                <div class="text-xs opacity-70">Скорее всего, уже выписаны по учётной книге или анкету не подавали. Проверьте на портале и уберите из очереди.</div>
                <button class="btn btn-sm mt-1" data-co="notfound">Убрать из очереди</button></div>` : ''}
            <div class="flex flex-wrap items-center gap-2">
                <button class="btn btn-sm btn-primary" data-co="send" ${nReady ? '' : 'disabled'}>Выписать на портале (${nReady})</button>
                <span class="text-sm opacity-70">${nReady ? 'Список уйдёт на вкладку портала — там проверьте и нажмите «Выписать всех».' : 'Готовых к выписке нет: у каждого должны быть номер анкеты, время и «куда едет», и он уже уехал.'}</span>
            </div>
            ${log.length ? `<div class="text-sm space-y-0.5">${log.map(l => `<div class="${l.ok ? '' : 'text-error'}">${e(l.text)}</div>`).join('')}</div>` : ''}
        </div>`;
    }

    // Латиница для сверки имён: паспорт → иначе транслит карточки
    const TR = { а: 'A', б: 'B', в: 'V', г: 'G', д: 'D', е: 'E', ё: 'E', ж: 'ZH', з: 'Z', и: 'I', й: 'I', к: 'K', л: 'L', м: 'M', н: 'N', о: 'O', п: 'P', р: 'R', с: 'S', т: 'T', у: 'U', ф: 'F', х: 'KH', ц: 'TS', ч: 'CH', ш: 'SH', щ: 'SHCH', ъ: '', ы: 'Y', ь: '', э: 'E', ю: 'IU', я: 'IA' };
    const tokens = s => (s || '').toLowerCase().split('').map(c => TR[c] ?? c).join('').toUpperCase()
        .split(/[^A-Z]+/).filter(t => t.length > 1);
    function lev(a, b) {
        const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
        for (let j = 1; j <= b.length; j++) d[0][j] = j;
        for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++)
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
        return d[a.length][b.length];
    }
    const near = (a, b) => a === b || lev(a, b) <= (Math.max(a.length, b.length) >= 6 ? 2 : 1);
    // Страна портала → ISO3 (обратный словарь Form3.COUNTRY)
    const isoOf = name => Object.keys(Form3.COUNTRY).find(k => Form3.COUNTRY[k] === (name || '').trim().toUpperCase()) || null;
    const dayDiff = (a, b) => Math.abs(DateUtils.parseDate(a) - DateUtils.parseDate(b)) / DAY;

    function analyze() {
        const rows = portal.rows;
        const pendingIds = new Set(rows.map(r => r.id));
        const usedIds = new Set(items.map(it => it.entry?.form3_id).filter(Boolean));
        const full = portal.total == null || rows.length >= portal.total;

        links = [];
        for (const it of items.filter(x => !x.entry?.form3_id && !marked(x))) {
            const our = latinOf(it) ? tokens(latinOf(it))
                : tokens(it.byName ? it.v.spiritual_name : `${it.v.first_name || ''} ${it.v.last_name || ''}`);
            const pass = (it.doc?.passport_number || '').replace(/\s/g, '').toUpperCase();
            const cands = rows.filter(r => !usedIds.has(r.id) && r.arrival && dayDiff(r.arrival, it.stay.check_in) <= 1).map(r => {
                const their = tokens(r.name);
                const hit = our.filter(t => their.some(x => near(t, x))).length;
                const passOk = !!pass && !!r.passport && r.passport.replace(/\s/g, '').toUpperCase() === pass;
                return { r, hit, passOk, score: (passOk ? 10 : 0) + hit };
            }).filter(c => c.passOk || (our.length && c.hit >= Math.min(2, our.length)))
              .sort((a, b) => b.score - a.score);
            if (!cands.length) continue;
            const best = cands[0];
            const tie = cands.length > 1 && cands[1].score === best.score;
            links.push({
                it, row: best.r,
                sure: !tie && (best.passOk || best.hit >= 2) && dayDiff(best.r.arrival, it.stay.check_in) === 0,
                why: [best.passOk ? 'паспорт совпал' : `имя совпало (${best.hit} из ${our.length})`,
                    dayDiff(best.r.arrival, it.stay.check_in) ? 'заезд ±1 день' : 'заезд тот же',
                    tie ? `ещё ${cands.length - 1} похожих` : ''].filter(Boolean).join(', ')
            });
            usedIds.add(best.r.id);
        }
        const linked = new Set(links.map(l => l.it));
        stale = full ? items.filter(it => inQueue(it) && it.entry?.form3_id && !pendingIds.has(it.entry.form3_id)) : [];
        notFound = full ? items.filter(it => inQueue(it) && (it.known || it.byName) && !it.entry?.form3_id && !linked.has(it)) : [];
    }

    function onMessage(ev) {
        if (ev.origin !== PORTAL || !ev.data || !ev.data.srskFrro) return;
        const m = ev.data;
        if (m.type === 'pending') {
            ev.source.postMessage({ srskFrro: 1, type: 'got', at: m.at }, PORTAL);
            if (portal && portal.at === m.at) return;
            portal = { source: ev.source, rows: m.rows || [], total: m.total, at: m.at };
            log = [];
            showTab();
            Promise.resolve(loaded).then(() => { analyze(); render(); });
        } else if (m.type === 'result') {
            onResult(m);
        }
    }

    function sendQueue() {
        if (!portal?.source || portal.source.closed) {
            Layout.showNotification('Вкладка портала закрыта — нажмите закладку «ШРСК → выписка» на портале ещё раз', 'error');
            return;
        }
        const list = items.filter(ready).map(it => ({
            form3_id: it.entry.form3_id, who: latinOf(it) || nameOf(it.v), srsk_name: nameOf(it.v),
            arrival: it.stay.check_in, date: it.date, time: portalTime(it.time), dest: it.dest
        }));
        if (!list.length) return;
        portal.source.postMessage({ srskFrro: 1, type: 'queue', items: list }, PORTAL);
        log = [{ ok: true, text: `Отправлено на портал: ${list.length} чел. Перейдите на вкладку портала и нажмите «Выписать всех».` }];
        render();
    }

    async function onResult(m) {
        const it = items.find(x => x.entry?.form3_id === m.form3_id);
        if (!m.ok) {
            log.push({ ok: false, text: `✗ ${it ? nameOf(it.v) : m.form3_id}: ${m.error}` });
            render();
            return;
        }
        if (!it) { log.push({ ok: false, text: `✓ ${m.form3_id} выписан на портале, но в ШРСК его нет в очереди — отметьте вручную` }); render(); return; }
        const { error } = await Layout.db.from('form3_entries').update({
            checkout_marked_at: new Date().toISOString(), checkout_marked_by: window.currentUser?.vaishnava_id || null,
            checkout_at: `${m.date}T${m.time}`, next_destination: m.dest, updated_at: new Date().toISOString()
        }).eq('id', it.entry.id);
        if (error) { log.push({ ok: false, text: `✓ ${nameOf(it.v)} выписан на портале, но в ШРСК не записалось: ${error.message}` }); render(); return; }
        it.entry.checkout_marked_at = new Date().toISOString();
        it.entry.next_destination = m.dest;
        log.push({ ok: true, text: `✓ ${nameOf(it.v)} — ${m.form3_id}, ${fmtDate(m.date)} ${m.time}, ${m.dest}` });
        render();
    }

    // ==================== ЗАПИСЬ ====================
    async function saveRow(i) {
        const it = items[i];
        const time = document.querySelector(`[data-co-time="${i}"]`).value || null;
        const dest = document.querySelector(`[data-co-dest="${i}"]`).value.trim() || null;
        const { error } = await Layout.db.from('residents').update({ departure_time: time, next_destination: dest }).eq('id', it.last.id);
        if (error) { Layout.handleError(error, 'Выписка'); return; }
        Layout.showNotification(`${nameOf(it.v)}: сохранено`, 'success');
        await load();
    }

    // Отметить «выписан» без закладки (вручную / уже выписан / убрать из очереди)
    async function markDone(list, note) {
        for (const it of list) {
            const row = {
                checkout_marked_at: new Date().toISOString(), checkout_marked_by: window.currentUser?.vaishnava_id || null,
                checkout_at: it.time ? `${it.date}T${it.time}` : null, next_destination: it.dest,
                notes: [it.entry?.notes, note].filter(Boolean).join('\n'), updated_at: new Date().toISOString()
            };
            const { error } = it.entry
                ? await Layout.db.from('form3_entries').update(row).eq('id', it.entry.id)
                : await Layout.db.from('form3_entries').insert({ ...row, vaishnava_id: it.v.id, resident_id: it.stay.rows[0].id,
                    arrival_date: it.stay.check_in, expected_checkout: it.stay.check_out });
            if (error) { Layout.handleError(error, nameOf(it.v)); return; }
        }
        Layout.showNotification(`Отмечено: ${list.length}`, 'success');
        await load();
    }

    async function linkChosen() {
        const chosen = links.filter((l, k) => document.querySelector(`[data-co-link="${k}"]`)?.checked);
        if (!chosen.length) return;
        const stamp = new Date().toLocaleDateString('ru-RU');
        for (const l of chosen) {
            const it = l.it;
            const row = {
                form3_id: l.row.id,
                submitted_at: l.row.submitted ? `${l.row.submitted}T12:00:00` : new Date().toISOString(),
                notes: [it.entry?.notes, `Связано с анкетой портала закладкой выписки ${stamp} (${l.why})`].filter(Boolean).join('\n'),
                updated_at: new Date().toISOString()
            };
            const { error } = it.entry
                ? await Layout.db.from('form3_entries').update(row).eq('id', it.entry.id)
                : await Layout.db.from('form3_entries').insert({ ...row, vaishnava_id: it.v.id, resident_id: it.stay.rows[0].id,
                    arrival_date: it.stay.check_in, expected_checkout: it.stay.check_out });
            if (error) { Layout.handleError(error, nameOf(it.v)); return; }
            // гражданство не было указано — берём с портала
            const iso = !it.known && it.v.id && isoOf(l.row.nationality);
            if (iso) {
                const { error: cErr } = await Layout.db.from('vaishnavas').update({ citizenship: iso }).eq('id', it.v.id).is('citizenship', null);
                if (cErr) Layout.handleError(cErr, nameOf(it.v));
            }
        }
        Layout.showNotification(`Связано анкет: ${chosen.length}`, 'success');
        await load();
        Form3.reload();
    }

    // ==================== ЗАКЛАДКА (исполняется на indianfrro.gov.in) ====================
    // Техника заполнения — docs/form-iii.md, «Как выписывать скриптом». eval на портале запрещён CSP.
    function bmCheckout() {
        (async () => {
            const SRSK = '__SRSK_ORIGIN__';
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const norm = s => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
            const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
            const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            const RE_ID = /\b\d{6}(?=[A-Z0-9]{0,5}[A-Z])[A-Z0-9]{6}\b/;
            if (window.__srskCo && window.__srskCo.busy) { alert('Выписка уже идёт — дождитесь конца.'); return; }
            const w = window.open(SRSK + '/reception/form3.html#frro-checkout', 'srsk_frro');
            if (!w) { alert('Браузер не дал открыть ШРСК — разрешите всплывающие окна для портала и нажмите закладку ещё раз.'); return; }
            const st = window.__srskCo = { busy: false, w: w };

            // Панель поверх портала
            let panel = document.getElementById('srskCoPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'srskCoPanel';
                panel.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483000;width:480px;max-height:85vh;overflow:auto;background:#fff;color:#000;border:2px solid #8b5cf6;border-radius:10px;padding:12px;font:13px/1.45 Arial,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.25)';
                document.body.appendChild(panel);
            }
            const say = html => {
                panel.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>ШРСК → выписка</b>' +
                    '<button id="srskCoX" style="border:0;background:none;font-size:18px;cursor:pointer">×</button></div>' + html;
                panel.querySelector('#srskCoX').onclick = () => { if (!st.busy) panel.remove(); };
            };
            const btnStyle = 'padding:6px 12px;border-radius:6px;border:1px solid #8b5cf6;cursor:pointer;margin-right:6px';

            const body = () => document.querySelector('.mat-tab-body-active') || document;
            const extend = () => {
                const b = Array.from(document.querySelectorAll('button')).find(x => norm(x.textContent).indexOf('EXTEND SESSION') >= 0);
                if (b) b.click();
                document.querySelectorAll('.swal2-container.swal2-backdrop-hide').forEach(x => x.remove());
            };
            const waitFor = async (fn, ms) => { for (let t = 0; t < (ms || 10000); t += 250) { const r = fn(); if (r) return r; await sleep(250); } return null; };
            const setVal = (x, v) => {
                Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(x, v);
                x.dispatchEvent(new Event('input', { bubbles: true }));
                x.dispatchEvent(new Event('change', { bubbles: true }));
            };
            const enter = x => ['keydown', 'keypress', 'keyup'].forEach(t =>
                x.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })));
            const fire = (x, y) => {
                const t = document.elementFromPoint(x, y);
                if (!t) return;
                ['mousedown', 'mouseup', 'click'].forEach(type =>
                    t.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window })));
            };
            const visible = x => { const r = x.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

            async function openPending() {
                extend();
                const lbl = Array.from(document.querySelectorAll('.mat-tab-label, [role="tab"]')).find(x => norm(x.textContent).indexOf('PENDING FOR CHECKOUT') >= 0);
                if (!lbl) throw new Error('не вижу вкладку PENDING FOR CHECKOUT — откройте Form III Details');
                if (lbl.getAttribute('aria-selected') !== 'true') { lbl.click(); await sleep(1500); }
            }
            const searchBox = () => body().querySelector('input[placeholder*="earch"], input[matinput], input');

            // ---- Список PENDING FOR CHECKOUT целиком ----
            async function readPending() {
                await openPending();
                const s = searchBox();
                if (s && s.value) { setVal(s, ''); enter(s); await sleep(1500); }
                const ps = body().querySelector('mat-paginator mat-select');
                if (ps && norm(ps.textContent) !== '15') {
                    (ps.querySelector('.mat-select-trigger') || ps).click(); await sleep(500);
                    const o = Array.from(document.querySelectorAll('mat-option')).find(x => norm(x.textContent) === '15');
                    if (o) { o.click(); await sleep(1500); }
                }
                const first = body().querySelector('button.mat-paginator-navigation-first');
                if (first && !first.disabled) { first.click(); await sleep(1500); }
                const heads = Array.from(body().querySelectorAll('thead th')).map(th => norm(th.textContent));
                const col = re => heads.findIndex(h => re.test(h));
                const ci = { name: col(/NAME/), nat: col(/NATIONALITY/), pass: col(/PASSPORT/), arr: col(/ARRIVAL/), sub: col(/SUBMISSION/) };
                const iso = s => { const m = (s || '').match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{4})/); return m ? m[3] + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0') : null; };
                const rows = [], seen = {};
                for (let page = 0; page < 300; page++) {
                    const trs = Array.from(body().querySelectorAll('tbody tr'));
                    trs.forEach(tr => {
                        const td = Array.from(tr.querySelectorAll('td')).map(x => x.innerText.trim());
                        const m = tr.innerText.match(RE_ID);
                        if (!m || seen[m[0]]) return;
                        seen[m[0]] = 1;
                        rows.push({ id: m[0], name: ci.name >= 0 ? td[ci.name] : '', nationality: ci.nat >= 0 ? td[ci.nat] : '', passport: ci.pass >= 0 ? td[ci.pass] : '',
                            arrival: ci.arr >= 0 ? iso(td[ci.arr]) : null, submitted: ci.sub >= 0 ? iso(td[ci.sub]) : null });
                    });
                    say('Читаю список невыписанных на портале… ' + rows.length);
                    const next = body().querySelector('button.mat-paginator-navigation-next');
                    if (!next || next.disabled) break;
                    const firstId = (trs[0] && (trs[0].innerText.match(RE_ID) || [])[0]) || '';
                    next.click();
                    await waitFor(() => { const r = body().querySelector('tbody tr'); return r && (r.innerText.match(RE_ID) || [])[0] !== firstId; }, 10000);
                    await sleep(300);
                }
                const lab = body().querySelector('.mat-paginator-range-label');
                const tm = lab && lab.textContent.match(/of\s+(\d+)/i);
                return { rows: rows, total: tm ? +tm[1] : null };
            }

            // ---- Выписка одного ----
            async function setDate(dlg, iso) {
                const p = iso.split('-').map(Number), y = p[0], m = p[1], d = p[2];
                const inp = dlg.querySelector('[formcontrolname="date_of_departure"]');
                // пока окно раскрывается, нажатие на календарь теряется (проверено 17.11) — пауза и повтор
                let cal = null;
                for (let k = 0; k < 3 && !cal; k++) {
                    await sleep(800);
                    (dlg.querySelector('mat-datepicker-toggle button') || inp).click();
                    cal = await waitFor(() => document.querySelector('mat-calendar'), 2000);
                }
                if (!cal) throw new Error('не открылся календарь');
                cal.querySelector('.mat-calendar-period-button').click(); await sleep(500);
                for (const label of [String(y), MONTHS[m - 1] + ' ' + y, MONTHS[m - 1] + ' ' + d + ', ' + y]) {
                    const c = document.querySelector('mat-calendar [aria-label="' + label + '"]');
                    if (!c || c.getAttribute('aria-disabled') === 'true') throw new Error('в календаре нельзя выбрать «' + label + '» (раньше заезда или в будущем?)');
                    (c.querySelector('.mat-calendar-body-cell-content') || c).click();
                    await sleep(500);
                }
                const t = (inp.value.match(/\d+|[A-Za-z]{3,}/g) || []);
                const ok = t.indexOf(String(y)) >= 0 && t.some(x => +x === d) &&
                    (t.some(x => +x === m) || t.some(x => MONTHS[m - 1].toUpperCase().indexOf(x.toUpperCase()) === 0));
                if (!ok) throw new Error('дата встала «' + inp.value + '», нужно ' + iso);
            }
            async function dial(num, isHour) {
                const els = Array.from(document.querySelectorAll('.clock-face__number')).filter(visible)
                    .filter(x => x.innerText.trim() !== '' && +x.innerText.trim() === num);
                const el = els[isHour && num === 0 ? els.length - 1 : 0];
                if (!el) throw new Error('на циферблате нет ' + num);
                const face = el.closest('.clock-face') || el.parentElement;
                const fr = face.getBoundingClientRect(), cx = fr.left + fr.width / 2, cy = fr.top + fr.height / 2;
                const r = (el.querySelector('span') || el).getBoundingClientRect();
                let x = r.left + r.width / 2, y = r.top + r.height / 2;
                if (isHour && (num === 9 || num === 21)) { // баг портала: «девять часов» по центру не ставится
                    const a = Math.atan2(y - cy, x - cx) + 0.05, R = Math.hypot(x - cx, y - cy);
                    x = cx + R * Math.cos(a); y = cy + R * Math.sin(a);
                }
                fire(x, y);
                await sleep(500);
            }
            const ctrl = k => document.querySelectorAll('.timepicker-dial__control')[k];
            const ctrlVal = k => { const c = ctrl(k); return c ? +((c.value != null && c.value !== '' ? c.value : c.textContent) || '').trim() : NaN; };
            async function setTime(dlg, hhmm) {
                const H = +hhmm.slice(0, 2), M = +hhmm.slice(3, 5);
                const inp = dlg.querySelector('[formcontrolname="time_of_departure"]');
                inp.click();
                if (!(await waitFor(() => ctrl(0), 5000))) throw new Error('не открылись часы');
                await sleep(500);
                ctrl(0).dispatchEvent(new FocusEvent('focus')); await sleep(400);
                await dial(H, true);
                if (ctrlVal(0) !== H && !(H === 0 && ctrlVal(0) === 24)) throw new Error('час встал ' + ctrlVal(0) + ', нужно ' + H);
                ctrl(1).dispatchEvent(new FocusEvent('focus')); await sleep(400);
                await dial(M, false);
                if (ctrlVal(1) !== M) throw new Error('минуты встали ' + ctrlVal(1) + ', нужно ' + M);
                const ok = Array.from(document.querySelectorAll('button')).filter(visible).find(b => norm(b.textContent) === 'OK');
                if (!ok) throw new Error('нет кнопки OK у часов');
                ok.click();
                await sleep(1300);
                const t = (inp.value.match(/\d+|AM|PM/gi) || []);
                let h = +t[0];
                const pm = t.some(x => /PM/i.test(x)), am = t.some(x => /AM/i.test(x));
                if (pm && h < 12) h += 12;
                if (am && h === 12) h = 0;
                if (h !== H || +t[1] !== M) throw new Error('время встало «' + inp.value + '», нужно ' + hhmm);
            }
            async function markOne(it) {
                extend();
                await openPending();
                const s = searchBox();
                if (!s) throw new Error('нет поля поиска');
                let row = null;
                for (let k = 0; k < 2 && !row; k++) {
                    setVal(s, it.form3_id); enter(s);
                    row = await waitFor(() => {
                        const trs = Array.from(body().querySelectorAll('tbody tr'));
                        return trs.length === 1 && trs[0].innerText.indexOf(it.form3_id) >= 0 ? trs[0] : null;
                    }, 8000);
                }
                if (!row) throw new Error('анкеты нет в PENDING FOR CHECKOUT (уже выписан?)');
                const b = row.querySelector('[mattooltip="Mark Checkout"], [ng-reflect-message="Mark Checkout"]');
                if (!b) throw new Error('нет кнопки Mark Checkout');
                b.click();
                const dlg = await waitFor(() => { const d = document.querySelector('mat-dialog-container'); return d && d.querySelector('[formcontrolname="date_of_departure"]') ? d : null; }, 8000);
                if (!dlg) throw new Error('не открылось окно Checkout Entry');
                if (dlg.innerText.indexOf(it.form3_id) < 0) throw new Error('в окне выписки другой номер анкеты');
                await setDate(dlg, it.date);
                await setTime(dlg, it.time);
                const nd = dlg.querySelector('[formcontrolname="next_destination"]');
                setVal(nd, it.dest); nd.dispatchEvent(new Event('blur', { bubbles: true }));
                await sleep(300);
                if (norm(nd.value) !== norm(it.dest)) throw new Error('«куда едет» встало «' + nd.value + '»');
                const form = dlg.querySelector('form');
                if (form && form.classList.contains('ng-invalid')) throw new Error('портал считает форму незаполненной');
                const sub = Array.from(dlg.querySelectorAll('button')).find(x => norm(x.textContent) === 'SUBMIT');
                if (!sub || sub.disabled) throw new Error('кнопка Submit недоступна');
                sub.click();
                const pop = await waitFor(() => { const p = document.querySelector('.swal2-popup'); return p && visible(p) ? p : null; }, 15000);
                if (!pop) throw new Error('после Submit нет ответа портала — проверьте вручную во вкладке CHECKED OUT');
                const txt = norm(pop.innerText);
                const conf = pop.querySelector('.swal2-confirm');
                if (txt.indexOf('SUCCESS') < 0) throw new Error('портал ответил: ' + pop.innerText.trim());
                if (conf) conf.click();
                await sleep(1500);
            }

            // ---- Обмен с окном ШРСК ----
            if (st.onMsg) window.removeEventListener('message', st.onMsg);
            let got = false;
            st.onMsg = ev => {
                if (ev.origin !== SRSK || !ev.data || !ev.data.srskFrro) return;
                if (ev.data.type === 'got') got = true;
                if (ev.data.type === 'queue') showQueue(ev.data.items || [], ev.source);
            };
            window.addEventListener('message', st.onMsg);

            function showQueue(list, src) {
                if (st.busy) return;
                const today = new Date();
                const bad = list.filter(x => !x.form3_id || !x.time || !x.dest || new Date(x.date + 'T' + x.time) > today);
                say('<div>Выписать на портале (' + list.length + '):</div>' +
                    '<table style="width:100%;border-collapse:collapse;margin:6px 0">' + list.map(x =>
                        '<tr style="border-top:1px solid #ddd"><td style="padding:3px 4px">' + esc(x.who) + '<div style="font-size:11px;color:#555">' + esc(x.form3_id) + '</div></td>' +
                        '<td style="padding:3px 4px;white-space:nowrap">' + esc(x.date.split('-').reverse().join('.')) + ' ' + esc(x.time) + '</td>' +
                        '<td style="padding:3px 4px">' + esc(x.dest) + '</td></tr>').join('') + '</table>' +
                    (bad.length ? '<div style="color:#b91c1c">⚠ Есть строки без данных или с будущим временем — не выписываю.</div>'
                        : '<div style="margin:6px 0">Проверьте список. Submit необратим. Остановлюсь на первом расхождении.</div>' +
                          '<button id="srskCoGo" style="' + btnStyle + ';background:#8b5cf6;color:#fff">Выписать всех</button>') +
                    '<button id="srskCoNo" style="' + btnStyle + ';background:#fff">Отмена</button>');
                panel.querySelector('#srskCoNo').onclick = () => panel.remove();
                const go = panel.querySelector('#srskCoGo');
                if (go) go.onclick = () => runQueue(list, src);
            }

            async function runQueue(list, src) {
                st.busy = true;
                const lines = [];
                const show = cur => say(lines.join('') + (cur ? '<div>… ' + esc(cur) + '</div>' : ''));
                let stop = null;
                for (const x of list) {
                    show(x.who);
                    try {
                        await markOne(x);
                        lines.push('<div>✓ ' + esc(x.who) + '</div>');
                        src.postMessage({ srskFrro: 1, type: 'result', ok: true, form3_id: x.form3_id, date: x.date, time: x.time, dest: x.dest }, SRSK);
                    } catch (err) {
                        stop = (err && err.message) || String(err);
                        lines.push('<div style="color:#b91c1c">✗ ' + esc(x.who) + ': ' + esc(stop) + '</div>');
                        src.postMessage({ srskFrro: 1, type: 'result', ok: false, form3_id: x.form3_id, error: stop }, SRSK);
                        break;
                    }
                }
                st.busy = false;
                say(lines.join('') + (stop
                    ? '<div style="margin-top:6px;color:#b91c1c"><b>Остановился.</b> Окно выписки оставлено как есть — проверьте и закройте (X), не Submit.</div>'
                    : '<div style="margin-top:6px"><b>Готово.</b> В ШРСК отмечено автоматически.</div>'));
            }

            try {
                say('Читаю список невыписанных на портале…');
                const p = await readPending();
                say('На портале невыписанных: ' + p.rows.length + (p.total != null ? ' из ' + p.total : '') + '. Отправляю в ШРСК…');
                const at = Date.now();
                for (let k = 0; k < 90 && !got; k++) {
                    if (w.closed) { say('Окно ШРСК закрыто — нажмите закладку ещё раз.'); return; }
                    w.postMessage({ srskFrro: 1, type: 'pending', rows: p.rows, total: p.total, at: at }, SRSK);
                    await sleep(1000);
                }
                say(got ? 'Список у ШРСК. Перейдите в окно ШРСК: там сверка и кнопка «Выписать на портале».'
                    : 'ШРСК не ответил за 90 секунд. Войдите в ШРСК в открывшемся окне и нажмите закладку ещё раз.');
            } catch (err) {
                say('<div style="color:#b91c1c">✗ ' + esc((err && err.message) || err) + '</div>');
            }
        })();
    }

    function bookmarkHref() {
        return 'javascript:' + encodeURIComponent('(' + bmCheckout.toString().replace('__SRSK_ORIGIN__', location.origin) + ')()');
    }

    function renderBookmark() {
        const pane = document.getElementById('bookmarksPane');
        if (!pane || document.getElementById('f3CoBookmark')) return;
        const div = document.createElement('div');
        div.id = 'f3CoBookmark';
        div.className = 'bg-base-100 rounded-lg p-4 space-y-3 max-w-3xl mt-4';
        div.innerHTML = `
            <div class="font-semibold">Выписка (Mark Checkout)</div>
            <div><a class="btn btn-primary f3-bm" href="${bookmarkHref()}" title="Перетащите на панель закладок">ШРСК → выписка</a></div>
            <ol class="list-decimal ml-5 text-sm space-y-1">
                <li>На портале: войдите → Form III Details (вкладки DRAFT / PENDING FOR CHECKOUT).</li>
                <li>Нажмите закладку <b>«ШРСК → выписка»</b>. Она откроет окно ШРСК и передаст туда список невыписанных с портала.</li>
                <li>В окне ШРСК, вкладка «Выписка»: подтвердите связки анкет без номера, отметьте уже выписанных, нажмите <b>«Выписать на портале»</b>.</li>
                <li>Вернитесь на вкладку портала: справа сверху список «кто / дата / время / куда». Проверьте и нажмите <b>«Выписать всех»</b> — закладка выпишет подряд и остановится на первом расхождении. В ШРСК отметится само.</li>
            </ol>
            <div class="text-sm opacity-70">Выписать можно только после отъезда: портал не даёт поставить будущее время. Без времени отъезда и «куда едет» человек в очередь на портал не попадает.</div>
            <div class="alert text-sm">Первая версия: на портале её ещё не пробовали. Первый раз — вместе с Claude.</div>`;
        pane.appendChild(div);
    }

    // ==================== СОБЫТИЯ ====================
    function showTab() { document.querySelector('[data-tab="checkout"]')?.click(); }

    function bind() {
        document.addEventListener('click', ev => {
            const b = ev.target.closest('[data-co]');
            if (!b || b.disabled) return;
            const i = +b.dataset.i;
            switch (b.dataset.co) {
                case 'goto': showTab(); break;
                case 'bookmarks': document.querySelector('[data-tab="bookmarks"]')?.click(); break;
                case 'save': saveRow(i); break;
                case 'manual':
                    if (confirm(`${nameOf(items[i].v)}: выезд уже отмечен на портале вручную? Человек уйдёт из очереди.`))
                        markDone([items[i]], `Выписан на портале вручную — отмечено ${new Date().toLocaleString('ru-RU')}`);
                    break;
                case 'link': linkChosen(); break;
                case 'stale':
                    if (confirm(`Отметить выписанными ${stale.length} чел.? На портале их уже нет среди невыписанных.`))
                        markDone(stale, `На портале уже не в PENDING FOR CHECKOUT — выписан раньше (сверка ${new Date().toLocaleDateString('ru-RU')})`);
                    break;
                case 'notfound':
                    if (confirm(`Убрать из очереди ${notFound.length} чел.? Их нет среди невыписанных на портале.`))
                        markDone(notFound, `Нет среди невыписанных на портале (сверка ${new Date().toLocaleDateString('ru-RU')}) — убран из очереди`);
                    break;
                case 'send': sendQueue(); break;
            }
        });
    }

    function init() {
        bind();
        renderBookmark();
        window.addEventListener('message', onMessage);
        document.getElementById('f3Search')?.addEventListener('input', Layout.debounce(ev => {
            query = ev.target.value.trim().toLowerCase();
            render();
        }, 200));
        const onHash = () => { if (location.hash === '#frro-checkout') { showTab(); render(); } };
        window.addEventListener('hashchange', onHash);
        onHash();
        loaded = load();
        setInterval(render, 5 * 60 * 1000); // сроки и «уже уехал» обновляются сами
    }

    return { init, reload: load };
})();
