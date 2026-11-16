// Form III (FRRO) — регистрация иностранцев. Только суперпользователи.
// Решения ВГ 16.11.2026: иностранец = гражданство не IND; переезд без перерыва = один заезд;
// время приезда неизвестно → спросить; срок подачи — 24 часа с приезда;
// туристическая виза → цель Tourism, иначе спрашивать поименно.
// Номера паспорта/визы — в vaishnava_documents (видят только суперпользователи).
// Портал заполняет закладка, которую нажимает человек; фото и Submit — человек.

const Form3 = (() => {
    const e = s => Layout.escapeHtml(s == null ? '' : String(s));
    const HOUR = 3600 * 1000;

    // Цели визита — как в списке портала (docs/form-iii.md)
    const PURPOSES = ['Accompanying Parents', 'Accompanying Patient', 'Accompanying Spouse', 'Business', 'Diplomatic',
        'Education', 'Employment', 'Internship', 'Joining spouse', 'Journalism', 'Medical Treatment of self',
        'Meeting friends/relatives', 'Minor child', 'Official', 'Others', 'Seminar/conference in India', 'Studies',
        'Surrogacy', 'Tourism'];

    const VISA_TYPES = { tourist: 'Туристическая', business: 'Бизнес', volunteer: 'Волонтёрская', religious: 'Религиозная', other: 'Другая' };

    // ISO3 → название страны на портале (проверяется закладкой по тексту списка; неизвестное — вручную)
    const COUNTRY = {
        RUS: 'RUSSIAN FEDERATION', UKR: 'UKRAINE', BLR: 'BELARUS', KAZ: 'KAZAKHSTAN', LTU: 'LITHUANIA', LVA: 'LATVIA',
        EST: 'ESTONIA', DEU: 'GERMANY', USA: 'UNITED STATES OF AMERICA', GBR: 'UNITED KINGDOM', ISR: 'ISRAEL',
        POL: 'POLAND', NLD: 'NETHERLANDS', CHE: 'SWITZERLAND', SWE: 'SWEDEN', DNK: 'DENMARK', ITA: 'ITALY',
        FRA: 'FRANCE', ESP: 'SPAIN', SVK: 'SLOVAKIA', CZE: 'CZECH REPUBLIC', ARE: 'UNITED ARAB EMIRATES',
        UZB: 'UZBEKISTAN', KGZ: 'KYRGYZSTAN', GEO: 'GEORGIA', ARM: 'ARMENIA', AZE: 'AZERBAIJAN', MDA: 'MOLDOVA',
        CAN: 'CANADA', AUS: 'AUSTRALIA', NZL: 'NEW ZEALAND', NPL: 'NEPAL', BGD: 'BANGLADESH', LKA: 'SRI LANKA', ZAF: 'SOUTH AFRICA'
    };

    let people = [];      // [{ v, doc, entry, stay, issues, deadline, ... }]
    let unknown = [];
    let submitted = [];

    // ==================== ЗАГРУЗКА ====================
    async function load() {
        const today = DateUtils.toISO(new Date());
        const weekAgo = DateUtils.toISO(new Date(Date.now() - 7 * 24 * HOUR));

        const { data: res, error } = await Layout.db.from('residents')
            .select('id, vaishnava_id, check_in, check_out, arrival_time, departure_time, arrived_at, arrived_auto, has_housing, status, rooms(number, buildings(name_ru, name_en, name_hi)), retreats(name_ru, name_en, name_hi)')
            .not('vaishnava_id', 'is', null)
            .neq('status', 'cancelled')
            .lte('check_in', today)
            .gte('check_out', weekAgo)
            .order('check_in');
        if (error) { Layout.handleError(error, 'Проживающие'); return; }

        const rows = (res || []).filter(r => r.has_housing !== false);
        const ids = [...new Set(rows.map(r => r.vaishnava_id))];
        if (!ids.length) { people = []; unknown = []; submitted = []; render(); return; }

        // Все строки этих людей — чтобы склеить заезд, начавшийся раньше недели назад или продолжающийся дальше
        const [allRes, vs, docs, entries] = await Promise.all([
            Layout.db.from('residents')
                .select('id, vaishnava_id, check_in, check_out, arrival_time, departure_time, arrived_at, arrived_auto, has_housing, status, rooms(number, buildings(name_ru, name_en, name_hi)), retreats(name_ru, name_en, name_hi)')
                .in('vaishnava_id', ids).neq('status', 'cancelled').order('check_in'),
            Layout.db.from('vaishnavas')
                .select('id, spiritual_name, first_name, last_name, citizenship, birth_date, gender, visa_type, visa_expiry, indian_phone, phone, email, photo_url')
                .in('id', ids),
            Layout.db.from('vaishnava_documents').select('*').in('vaishnava_id', ids),
            Layout.db.from('form3_entries').select('*').in('vaishnava_id', ids)
        ]);
        for (const r of [allRes, vs, docs, entries]) if (r.error) { Layout.handleError(r.error, 'Form III'); return; }

        const byV = new Map(vs.data.map(v => [v.id, v]));
        const docByV = new Map(docs.data.map(d => [d.vaishnava_id, d]));
        const resByV = new Map();
        allRes.data.filter(r => r.has_housing !== false).forEach(r => {
            if (!resByV.has(r.vaishnava_id)) resByV.set(r.vaishnava_id, []);
            resByV.get(r.vaishnava_id).push(r);
        });

        people = []; unknown = []; submitted = [];
        for (const vid of ids) {
            const v = byV.get(vid);
            if (!v) continue;
            for (const stay of mergeStays(resByV.get(vid) || [])) {
                // берём только заезды, которые уже начались и не закончились больше недели назад
                if (stay.check_in > today || stay.check_out < weekAgo) continue;
                const entry = entries.data.find(en => en.vaishnava_id === vid &&
                    (stay.rows.some(r => r.id === en.resident_id) ||
                     (en.arrival_date && en.arrival_date >= stay.check_in && en.arrival_date <= stay.check_out))) || null;
                const p = { v, doc: docByV.get(vid) || null, entry, stay };
                if (v.citizenship === 'IND') continue;
                if (!v.citizenship) { unknown.push(p); continue; }
                p.arrival = arrivalOf(p);
                p.issues = issuesOf(p);
                if (entry?.submitted_at) submitted.push(p); else people.push(p);
            }
        }
        people.sort((a, b) => a.arrival.at - b.arrival.at);
        submitted.sort((a, b) => (b.entry.submitted_at || '').localeCompare(a.entry.submitted_at || ''));
        unknown.sort((a, b) => nameOf(a.v).localeCompare(nameOf(b.v)));
        render();
    }

    // Переезд в другую комнату без перерыва = один заезд (ВГ 16.11)
    function mergeStays(rows) {
        const sorted = [...rows].sort((a, b) => a.check_in.localeCompare(b.check_in));
        const stays = [];
        for (const r of sorted) {
            const last = stays[stays.length - 1];
            if (last && r.check_in <= last.check_out) {
                last.rows.push(r);
                if (r.check_out > last.check_out) { last.check_out = r.check_out; last.departure_time = r.departure_time; }
            } else {
                stays.push({ check_in: r.check_in, check_out: r.check_out, arrival_time: r.arrival_time,
                    departure_time: r.departure_time, arrived_at: r.arrived_auto ? null : r.arrived_at, rows: [r] });
            }
        }
        return stays;
    }

    // Момент приезда: анкета → отметка «заехал» (не автоматическая) → время в шахматке → начало дня (время неизвестно)
    function arrivalOf(p) {
        const date = p.entry?.arrival_date || p.stay.check_in;
        const time = p.entry?.arrival_time || p.stay.arrival_time;
        if (time) return { date, time: time.slice(0, 5), at: new Date(`${date}T${time.slice(0, 5)}`), known: true };
        if (p.stay.arrived_at && !p.entry?.arrival_date) {
            const at = new Date(p.stay.arrived_at);
            return { date: DateUtils.toISO(at), time: at.toTimeString().slice(0, 5), at, known: true, fromMark: true };
        }
        return { date, time: null, at: DateUtils.parseDate(date), known: false };
    }

    function nameOf(v) {
        return v.spiritual_name || `${v.first_name || ''} ${v.last_name || ''}`.trim() || '—';
    }

    function expectedCheckout(p) { return p.entry?.expected_checkout || p.stay.check_out; }

    function purposeOf(p) {
        if (p.entry?.purpose) return p.entry.purpose;
        return p.v.visa_type === 'tourist' ? 'Tourism' : null;
    }

    // Каждое сомнение — ⚠ с причиной (ВГ). Пока есть — «Готово к подаче» нет.
    function issuesOf(p) {
        const { v, doc, entry } = p;
        const out = [];
        const need = (val, text) => { if (val == null || val === '') out.push(text); };
        need(doc?.passport_number, 'нет номера паспорта');
        need(doc?.passport_surname, 'нет фамилии латиницей');
        need(doc?.passport_given_name, 'нет имени латиницей');
        need(v.birth_date, 'нет даты рождения');
        need(v.gender, 'не указан пол');
        if (v.citizenship && !COUNTRY[v.citizenship]) out.push(`страна ${v.citizenship} — выбрать на портале вручную`);
        need(doc?.visa_number, 'нет номера визы / ETA / OCI');
        need(doc?.portal_visa_type, 'нет типа визы для портала');
        need(doc?.portal_visa_subtype, 'нет подтипа визы для портала');
        need(v.visa_expiry, 'нет срока визы');
        need(v.indian_phone, 'нет индийского телефона');
        need(v.email, 'нет почты');
        need(v.photo_url, 'нет фото');
        const co = expectedCheckout(p);
        if (v.visa_expiry && v.visa_expiry < co) out.push(`виза до ${fmtDate(v.visa_expiry)} — раньше выезда ${fmtDate(co)}`);
        if (doc?.passport_expiry && doc.passport_expiry < co) out.push(`паспорт до ${fmtDate(doc.passport_expiry)} — раньше выезда`);
        if (!p.arrival.known) out.push('время приезда неизвестно — спросить');
        if (!purposeOf(p)) out.push('цель визита — спросить (виза не туристическая)');
        need(entry?.arrived_from, 'откуда прибыл — спросить');
        need(entry?.previous_place, 'где жил до этого — спросить');
        return out;
    }

    // ==================== ФОРМАТ ====================
    function fmtDate(iso) {
        if (!iso) return '—';
        const d = DateUtils.parseDate(iso);
        return d.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' });
    }

    function deadlineBadge(p) {
        const left = p.arrival.at.getTime() + 24 * HOUR - Date.now();
        const h = Math.round(Math.abs(left) / HOUR);
        const approx = p.arrival.known ? '' : ' (время приезда неизвестно, считаю от начала дня)';
        if (left < 0) return `<span class="badge badge-error whitespace-nowrap" title="Срок — 24 ч с приезда${e(approx)}">просрочено на ${h} ч</span>`;
        const cls = left < 6 * HOUR ? 'badge-warning' : 'badge-ghost';
        return `<span class="badge ${cls} whitespace-nowrap" title="Срок — 24 ч с приезда${e(approx)}">осталось ${h} ч</span>`;
    }

    function placeOf(stay) {
        const r = stay.rows[stay.rows.length - 1];
        const b = r.rooms?.buildings ? Layout.getName(r.rooms.buildings) : '';
        return [b, r.rooms?.number].filter(Boolean).join(', ');
    }

    // ==================== ПОИСК ====================
    // По имени (духовное, в карточке, латиница паспорта), гражданству, зданию/комнате, номеру анкеты
    let query = '';
    function matches(p) {
        if (!query) return true;
        const hay = [nameOf(p.v), p.v.spiritual_name, p.v.first_name, p.v.last_name,
            p.doc?.passport_surname, p.doc?.passport_given_name, p.v.citizenship,
            placeOf(p.stay), p.entry?.form3_id].filter(Boolean).join(' ').toLowerCase();
        return query.split(/\s+/).every(w => hay.includes(w));
    }
    const nothingFound = '<div class="opacity-60 p-4">По поиску никого не нашлось.</div>';

    // ==================== РЕНДЕР ====================
    function render() {
        document.getElementById('cntSubmit').textContent = people.length ? `(${people.length})` : '';
        document.getElementById('cntUnknown').textContent = unknown.length ? `(${unknown.length})` : '';
        document.getElementById('cntSubmitted').textContent = submitted.length ? `(${submitted.length})` : '';

        const overdue = people.filter(p => p.arrival.at.getTime() + 24 * HOUR < Date.now()).length;
        const parts = [];
        if (people.length) parts.push(`не подано анкет: <b>${people.length}</b>${overdue ? `, из них просрочено: <b>${overdue}</b>` : ''}`);
        if (unknown.length) parts.push(`гражданство не указано: <b>${unknown.length}</b> — <a class="link" data-goto="unknown">указать</a>`);
        document.getElementById('f3Summary').innerHTML = parts.length
            ? `<div class="alert ${overdue ? 'alert-error' : 'alert-warning'}"><span>⚠ ${parts.join('; ')}</span></div>`
            : `<div class="alert alert-success"><span>Все иностранцы, которые сейчас живут, поданы.</span></div>`;

        const cntQ = list => list.filter(matches).length;
        if (query) {
            document.getElementById('cntSubmit').textContent = `(${cntQ(people)} из ${people.length})`;
            document.getElementById('cntUnknown').textContent = `(${cntQ(unknown)} из ${unknown.length})`;
            document.getElementById('cntSubmitted').textContent = `(${cntQ(submitted)} из ${submitted.length})`;
        }
        const ready = people.filter(p => !p.issues.length).length;
        const queueBar = people.length ? `<div class="flex flex-wrap items-center gap-2 mb-3">
            <button class="btn btn-sm btn-primary" data-act="queue" ${ready ? '' : 'disabled'}>Скопировать всех готовых для портала (${ready})</button>
            <span class="text-sm opacity-70">${ready ? 'На портале закладка «ШРСК → Form III» будет предлагать их по очереди.' : 'Готовых к подаче нет — сначала разберите ⚠.'}</span>
            </div>` : '';
        document.getElementById('listSubmit').innerHTML = queueBar + (people.length ? (cntQ(people) ? table(people, 'submit') : nothingFound)
            : '<div class="opacity-60 p-4">Нет иностранцев без анкеты.</div>');
        document.getElementById('listUnknown').innerHTML = unknown.length ? (cntQ(unknown) ? unknownTable() : nothingFound)
            : '<div class="opacity-60 p-4">У всех живущих гражданство указано.</div>';
        document.getElementById('listSubmitted').innerHTML = submitted.length ? (cntQ(submitted) ? table(submitted, 'submitted') : nothingFound)
            : '<div class="opacity-60 p-4">Пока нет поданных анкет.</div>';
    }

    function table(list, kind) {
        const rows = list.map((p, i) => {
            if (!matches(p)) return '';
            const issues = p.issues;
            const status = kind === 'submit'
                ? (issues.length
                    ? `<span class="text-warning font-medium">⚠ ${issues.length}</span> <span class="text-xs opacity-80">${e(issues.slice(0, 3).join('; '))}${issues.length > 3 ? '…' : ''}</span>`
                    : '<span class="badge badge-success">Готово к подаче</span>')
                : `<span class="font-mono">${e(p.entry.form3_id || '—')}</span> <span class="text-xs opacity-70">${fmtDate(DateUtils.toISO(new Date(p.entry.submitted_at)))}</span>`;
            return `<tr class="f3-row" data-open="${kind}:${i}">
                <td><div class="font-medium">${e(nameOf(p.v))}</div><div class="text-xs opacity-70">${e(p.v.citizenship || '')} · ${e(placeOf(p.stay))}</div></td>
                <td class="whitespace-nowrap">${fmtDate(p.stay.check_in)}${p.arrival.time ? ' ' + e(p.arrival.time) : ''} → ${fmtDate(expectedCheckout(p))}</td>
                <td>${kind === 'submit' ? deadlineBadge(p) : ''}</td>
                ${kind === 'submit' ? `<td><button class="btn btn-xs btn-ghost whitespace-nowrap" data-already="${i}" title="Анкета уже подана на портале раньше — убрать из списка">Уже подана</button></td>` : '<td></td>'}
                <td>${status}</td>
            </tr>`;
        }).join('');
        return `<div class="overflow-x-auto bg-base-100 rounded-lg"><table class="table table-sm">
            <thead><tr><th>Человек</th><th>Заезд → выезд</th><th>${kind === 'submit' ? 'Срок' : ''}</th><th>${kind === 'submit' ? 'Что не хватает' : 'Анкета'}</th><th></th></tr></thead>
            <tbody>${rows}</tbody></table></div>`;
    }

    function unknownTable() {
        const rows = unknown.map((p, i) => !matches(p) ? '' : `<tr>
            <td><a class="link" href="../vaishnavas/person.html?id=${e(p.v.id)}" target="_blank">${e(nameOf(p.v))}</a>
                <div class="text-xs opacity-70">${e(placeOf(p.stay))}</div></td>
            <td class="whitespace-nowrap">${fmtDate(p.stay.check_in)} → ${fmtDate(p.stay.check_out)}</td>
            <td class="whitespace-nowrap">
                <button class="btn btn-xs" data-cit="${i}:IND">Индия</button>
                <button class="btn btn-xs btn-outline" data-cit="${i}:ask">Иностранец…</button>
            </td></tr>`).join('');
        return `<p class="text-sm opacity-70 mb-2">Иностранец — каждый, у кого нет индийского паспорта. Укажите гражданство; у иностранцев оно потом уточнится по паспорту.</p>
            <div class="overflow-x-auto bg-base-100 rounded-lg"><table class="table table-sm">
            <thead><tr><th>Человек</th><th>Заезд → выезд</th><th>Гражданство</th></tr></thead><tbody>${rows}</tbody></table></div>`;
    }

    // ==================== КАРТОЧКА ====================
    let current = null;

    function openPerson(p) {
        current = p;
        const { v, doc } = p;
        const en = p.entry || {};
        const inp = (id, val, type = 'text', extra = '') =>
            `<input id="${id}" type="${type}" class="input input-bordered input-sm w-full" value="${e(val ?? '')}" ${extra}>`;
        const field = (label, html) => `<div><div class="f3-label">${label}</div>${html}</div>`;
        const issues = p.issues;
        const purpose = purposeOf(p);

        document.getElementById('personModalBody').innerHTML = `
            <div class="flex items-start gap-4 mb-3">
                <div id="f3PhotoDrop" data-act="upload" class="w-20 h-24 rounded cursor-pointer border-2 border-dashed border-transparent hover:border-primary" title="Нажмите или перетащите файл, чтобы загрузить фото">
                ${v.photo_url ? `<img src="${e(v.photo_url)}" class="w-20 h-24 object-cover rounded" alt="">` : '<div class="w-full h-full bg-base-200 rounded flex items-center justify-center text-xs text-center opacity-60">нет фото —<br>перетащите</div>'}
                </div>
                <div class="flex-1">
                    <h3 class="text-lg font-bold">${e(nameOf(v))}</h3>
                    <div class="text-sm opacity-70">${e(placeOf(p.stay))} · ${fmtDate(p.stay.check_in)} → ${fmtDate(p.stay.check_out)}</div>
                    <a class="link text-sm" href="../vaishnavas/person.html?id=${e(v.id)}" target="_blank">Карточка контакта</a>
                    ${p.entry?.submitted_at ? `<div class="mt-1 text-sm">Подана: <b class="font-mono">${e(en.form3_id || '')}</b>, ${fmtDate(DateUtils.toISO(new Date(en.submitted_at)))}</div>` : `<div class="mt-1">${deadlineBadge(p)}</div>`}
                </div>
            </div>
            ${issues.length ? `<div class="alert alert-warning mb-3 text-sm"><div><b>⚠ ${issues.length}:</b><ul class="list-disc ml-5">${issues.map(i => `<li>${e(i)}</li>`).join('')}</ul></div></div>` : '<div class="alert alert-success mb-3 text-sm">Всё заполнено — готово к подаче.</div>'}

            <h4 class="font-semibold mt-2 mb-2">Паспорт <span class="text-xs font-normal opacity-60">(видят только суперпользователи)</span></h4>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                ${field('Фамилия латиницей', inp('fSurname', doc?.passport_surname, 'text', 'style="text-transform:uppercase"'))}
                ${field('Имя латиницей', inp('fGiven', doc?.passport_given_name, 'text', 'style="text-transform:uppercase"'))}
                ${field('Номер паспорта', inp('fPassport', doc?.passport_number, 'text', 'style="text-transform:uppercase"'))}
                ${field('Гражданство (ISO3)', inp('fCitizenship', v.citizenship, 'text', 'maxlength="3" style="text-transform:uppercase"'))}
                ${field('Дата рождения', inp('fBirth', v.birth_date, 'date'))}
                ${field('Пол', `<select id="fGender" class="select select-bordered select-sm w-full">
                    <option value="">—</option><option value="male" ${v.gender === 'male' ? 'selected' : ''}>Мужской</option>
                    <option value="female" ${v.gender === 'female' ? 'selected' : ''}>Женский</option></select>`)}
                ${field('Паспорт действует до', inp('fPassExp', doc?.passport_expiry, 'date'))}
            </div>

            <h4 class="font-semibold mt-4 mb-2">Виза</h4>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                ${field('Номер визы / ETA / OCI', inp('fVisaNum', doc?.visa_number, 'text', 'style="text-transform:uppercase"'))}
                ${field('Вид визы', `<select id="fVisaType" class="select select-bordered select-sm w-full"><option value="">—</option>
                    ${Object.entries(VISA_TYPES).map(([k, n]) => `<option value="${k}" ${v.visa_type === k ? 'selected' : ''}>${n}</option>`).join('')}</select>`)}
                ${field('Виза до', inp('fVisaExp', v.visa_expiry, 'date'))}
                ${field('Тип на портале', inp('fPortalType', doc?.portal_visa_type, 'text', 'placeholder="e-VISA" list="dlPortalType"'))}
                ${field('Подтип на портале', inp('fPortalSub', doc?.portal_visa_subtype, 'text', 'placeholder="e-TV" list="dlPortalSub"'))}
            </div>
            <datalist id="dlPortalType"><option value="e-VISA"><option value="OCI"></datalist>
            <datalist id="dlPortalSub"><option value="e-TV"></datalist>

            <h4 class="font-semibold mt-4 mb-2">Контакты</h4>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                ${field('Индийский телефон', inp('fPhone', v.indian_phone, 'tel', 'placeholder="10 цифр"'))}
                ${field('Почта', inp('fEmail', v.email, 'email'))}
            </div>

            <h4 class="font-semibold mt-4 mb-2">Этот заезд</h4>
            <div class="grid grid-cols-2 md:grid-cols-3 gap-3">
                ${field('Дата приезда', inp('fArrDate', p.arrival.date, 'date'))}
                ${field(`Время приезда${p.arrival.fromMark ? ' <span class="opacity-60">(по отметке «заехал»)</span>' : ''}`, inp('fArrTime', p.arrival.time, 'time'))}
                ${field('Ожидаемый выезд', inp('fCheckout', expectedCheckout(p), 'date'))}
                ${field('Откуда прибыл', inp('fFrom', en.arrived_from, 'text', 'placeholder="город"'))}
                ${field('Где жил до этого', inp('fPrev', en.previous_place, 'text'))}
                ${field('Цель визита', `<select id="fPurpose" class="select select-bordered select-sm w-full"><option value="">— спросить —</option>
                    ${PURPOSES.map(x => `<option ${purpose === x ? 'selected' : ''}>${x}</option>`).join('')}</select>`)}
            </div>
            <p class="text-xs opacity-70 mt-1">Дата приезда — фактическая из шахматки. Если по правилу FRRO нужна другая — правьте сами.</p>

            <div class="flex flex-wrap gap-2 mt-5">
                <button class="btn btn-primary btn-sm" data-act="save">Сохранить</button>
                <button class="btn btn-sm" data-act="copy" ${issues.length ? 'disabled title="Сначала разберите все ⚠ и сохраните"' : ''}>Скопировать для портала</button>
                <button class="btn btn-sm btn-ghost" data-act="upload">Загрузить фото</button>
                ${v.photo_url ? '<button class="btn btn-sm btn-ghost" data-act="photo">Скачать фото</button>' : ''}
                ${!p.entry?.submitted_at ? `<button class="btn btn-sm btn-success" data-act="submitted" ${issues.length ? 'disabled' : ''}>Анкета подана…</button>
                <button class="btn btn-sm btn-outline" data-act="already" title="Подана на портале раньше, до раздела — без проверки полей">Уже подана ранее</button>` : ''}
            </div>`;
        document.getElementById('personModal').showModal();
    }

    const val = id => {
        const x = document.getElementById(id).value.trim();
        return x === '' ? null : x;
    };
    const up = id => val(id)?.toUpperCase().replace(/\s+/g, ' ') ?? null;

    async function save() {
        const p = current;
        const vUpd = {
            citizenship: up('fCitizenship'), birth_date: val('fBirth'), gender: val('fGender'),
            visa_type: val('fVisaType'), visa_expiry: val('fVisaExp'),
            indian_phone: val('fPhone'), email: val('fEmail')
        };
        const docRow = {
            vaishnava_id: p.v.id,
            passport_number: up('fPassport')?.replace(/\s/g, '') ?? null,
            passport_surname: up('fSurname'), passport_given_name: up('fGiven'),
            passport_expiry: val('fPassExp'), visa_number: up('fVisaNum')?.replace(/\s/g, '') ?? null,
            portal_visa_type: val('fPortalType'), portal_visa_subtype: val('fPortalSub'),
            updated_at: new Date().toISOString(), updated_by: window.currentUser?.vaishnava_id || null
        };
        const enRow = {
            vaishnava_id: p.v.id, resident_id: p.stay.rows[0].id,
            arrival_date: val('fArrDate'), arrival_time: val('fArrTime'),
            expected_checkout: val('fCheckout'), arrived_from: val('fFrom'),
            previous_place: val('fPrev'), purpose: val('fPurpose'),
            updated_at: new Date().toISOString()
        };

        const r1 = await Layout.db.from('vaishnavas').update(vUpd).eq('id', p.v.id);
        if (r1.error) { Layout.handleError(r1.error, 'Карточка'); return false; }
        const r2 = await Layout.db.from('vaishnava_documents').upsert(docRow);
        if (r2.error) { Layout.handleError(r2.error, 'Документы'); return false; }
        const r3 = p.entry
            ? await Layout.db.from('form3_entries').update(enRow).eq('id', p.entry.id)
            : await Layout.db.from('form3_entries').insert(enRow);
        if (r3.error) { Layout.handleError(r3.error, 'Анкета'); return false; }

        Layout.showNotification('Сохранено', 'success');
        const vid = p.v.id, cin = p.stay.check_in;
        await load();
        const again = [...people, ...submitted].find(x => x.v.id === vid && x.stay.check_in === cin);
        if (again) openPerson(again); else document.getElementById('personModal').close();
        return true;
    }

    // Данные для закладки на портале
    function portalData(p) {
        const { v, doc } = p;
        const arr = p.arrival.date, co = expectedCheckout(p);
        const days = Math.round((DateUtils.parseDate(co) - DateUtils.parseDate(arr)) / (24 * HOUR));
        return {
            srsk_form3: 1,
            vid: v.id,
            who: nameOf(v),
            given_name: doc.passport_given_name, surname: doc.passport_surname,
            gender: v.gender === 'male' ? 'Male' : v.gender === 'female' ? 'Female' : '',
            nationality: COUNTRY[v.citizenship] || '', nationality_iso3: v.citizenship,
            dob: v.birth_date, phone: v.indian_phone, email: v.email, special_category: 'Others',
            passport: doc.passport_number, visa_number: doc.visa_number,
            visa_type: doc.portal_visa_type, visa_subtype: doc.portal_visa_subtype,
            arrived_from: p.entry?.arrived_from, arrival_date: arr, arrival_time: p.arrival.time,
            purpose: purposeOf(p), previous_place: p.entry?.previous_place,
            duration_days: days, expected_checkout: co,
            photo_url: v.photo_url || null,
            room: placeOf(p.stay)
        };
    }

    async function copyForPortal() {
        const json = JSON.stringify(portalData(current));
        try {
            await navigator.clipboard.writeText(json);
            Layout.showNotification('Скопировано. На портале откройте новую анкету и нажмите закладку «ШРСК → Form III».', 'success');
        } catch {
            prompt('Скопируйте вручную (Cmd+C):', json);
        }
    }

    // Очередь: все готовые к подаче одним копированием; на портале закладка предлагает их по одному
    async function copyQueue() {
        const items = people.filter(p => !p.issues.length).map(portalData);
        if (!items.length) return;
        const json = JSON.stringify({ srsk_form3_queue: 1, qid: String(Date.now()), items });
        try {
            await navigator.clipboard.writeText(json);
            Layout.showNotification(`Скопировано: ${items.length} чел. На портале: New Entry → поиск по паспорту → закладка «ШРСК → Form III» — она спросит, кого заполнять.`, 'success');
        } catch {
            prompt('Скопируйте вручную (Cmd+C):', json);
        }
    }

    async function downloadPhoto() {
        const p = current;
        try {
            const blob = await (await fetch(p.v.photo_url)).blob();
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${(p.doc?.passport_surname || nameOf(p.v)).replace(/[^\wА-Яа-яЁё-]+/g, '_')}_photo.jpg`;
            a.click();
            setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        } catch (err) { Layout.handleError(err, 'Фото'); }
    }

    // Фото человека → фото контакта (vaishnava-photos, как аватар в карточке), под входом пользователя.
    // Пропорции сохраняем (для портала нужен портрет), длинная сторона до 1000 px.
    async function uploadPhoto(file) {
        const p = current;
        if (!p || !file) return;
        if (!/^image\//.test(file.type)) { Layout.showNotification('Нужна картинка (JPEG, PNG, HEIC не подходит)', 'error'); return; }
        try {
            const img = await new Promise((resolve, reject) => {
                const i = new Image();
                i.onload = () => resolve(i);
                i.onerror = () => reject(new Error('Не удалось открыть картинку'));
                i.src = URL.createObjectURL(file);
            });
            const k = Math.min(1, 1000 / Math.max(img.width, img.height));
            const canvas = document.createElement('canvas');
            canvas.width = Math.round(img.width * k);
            canvas.height = Math.round(img.height * k);
            canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
            URL.revokeObjectURL(img.src);
            const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.9));

            const fileName = `${p.v.id}_${Date.now()}.jpg`;
            const { error: upErr } = await Layout.db.storage.from('vaishnava-photos')
                .upload(fileName, blob, { contentType: 'image/jpeg', cacheControl: '3600', upsert: true });
            if (upErr) throw upErr;
            const { data: { publicUrl } } = Layout.db.storage.from('vaishnava-photos').getPublicUrl(fileName);
            const { error } = await Layout.db.from('vaishnavas').update({ photo_url: publicUrl }).eq('id', p.v.id);
            if (error) throw error;
            // старое фото из нашего хранилища удаляем, как в карточке контакта
            if (p.v.photo_url && p.v.photo_url.includes('/vaishnava-photos/')) {
                const oldPath = p.v.photo_url.split('/vaishnava-photos/')[1];
                if (oldPath) await Layout.db.storage.from('vaishnava-photos').remove([oldPath]);
            }
            Layout.showNotification('Фото загружено в карточку контакта', 'success');
            const vid = p.v.id, cin = p.stay.check_in;
            await load();
            const again = [...people, ...submitted].find(x => x.v.id === vid && x.stay.check_in === cin);
            if (again) openPerson(again);
        } catch (err) {
            Layout.handleError(err, 'Фото');
        }
    }

    function pickPhoto() {
        let input = document.getElementById('f3PhotoInput');
        if (!input) {
            input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/jpeg,image/png,image/webp';
            input.id = 'f3PhotoInput';
            input.className = 'hidden';
            input.addEventListener('change', () => { uploadPhoto(input.files[0]); input.value = ''; });
            document.body.appendChild(input);
        }
        input.click();
    }

    async function markSubmitted() {
        const id = prompt('Номер анкеты Form III с портала (например 161126HACGQH):');
        if (!id) return;
        const form3Id = id.trim().toUpperCase();
        if (!/^[0-9A-Z]{8,20}$/.test(form3Id)) { Layout.showNotification('Номер анкеты выглядит неверно', 'error'); return; }
        if (!(await save())) return;
        const p = [...people, ...submitted].find(x => x.v.id === current.v.id && x.stay.check_in === current.stay.check_in);
        if (!p?.entry) return;
        const { error } = await Layout.db.from('form3_entries').update({
            form3_id: form3Id, submitted_at: new Date().toISOString(),
            submitted_by: window.currentUser?.vaishnava_id || null, updated_at: new Date().toISOString()
        }).eq('id', p.entry.id);
        if (error) { Layout.handleError(error, 'Анкета'); return; }
        Layout.showNotification('Отмечено как поданное', 'success');
        document.getElementById('personModal').close();
        await load();
    }

    // Анкета подана на портале раньше (до раздела в ШРСК): убрать из «Подать» без проверки полей.
    // Номер — по желанию (пригодится для выписки).
    async function markAlready(p) {
        const raw = prompt(`${nameOf(p.v)}: анкета уже подана на портале.\nНомер анкеты Form III, если знаете (можно оставить пустым):`, p.entry?.form3_id || '');
        if (raw == null) return;
        const form3Id = raw.trim().toUpperCase() || null;
        if (form3Id && !/^[0-9A-Z]{8,20}$/.test(form3Id)) { Layout.showNotification('Номер анкеты выглядит неверно', 'error'); return; }
        if (await setSubmitted(p, form3Id, 'Подана на портале раньше — отмечено кнопкой «Уже подана»'))
            Layout.showNotification('Отмечено: анкета уже подана', 'success');
    }

    // Отметить анкету поданной (создаёт запись заезда, если её нет)
    async function setSubmitted(p, form3Id, note) {
        const row = {
            form3_id: form3Id, submitted_at: new Date().toISOString(),
            submitted_by: window.currentUser?.vaishnava_id || null,
            notes: [p.entry?.notes, note].filter(Boolean).join('\n') || null,
            updated_at: new Date().toISOString()
        };
        const { error } = p.entry
            ? await Layout.db.from('form3_entries').update(row).eq('id', p.entry.id)
            : await Layout.db.from('form3_entries').insert({
                ...row, vaishnava_id: p.v.id, resident_id: p.stay.rows[0].id,
                arrival_date: p.stay.check_in, expected_checkout: p.stay.check_out });
        if (error) { Layout.handleError(error, 'Анкета'); return false; }
        document.getElementById('personModal').close();
        await load();
        return true;
    }

    // Номер анкеты пришёл с портала закладкой «ШРСК ← номер анкеты»: #submitted=ID&v=<id контакта>
    async function takeSubmittedFromHash() {
        const h = new URLSearchParams(location.hash.slice(1));
        const form3Id = (h.get('submitted') || '').toUpperCase();
        const vid = h.get('v');
        if (!form3Id) return;
        history.replaceState(null, '', location.pathname + location.search);
        if (!/^[0-9A-Z]{8,20}$/.test(form3Id)) { Layout.showNotification('С портала пришёл странный номер анкеты: ' + form3Id, 'error'); return; }
        const all = [...people, ...submitted];
        const p = vid ? (people.find(x => x.v.id === vid) || all.find(x => x.v.id === vid)) : null;
        if (!p) {
            Layout.showNotification(`Номер ${form3Id} пришёл с портала, но человек не найден среди живущих. Впишите его в карточке кнопкой «Анкета подана…».`, 'warning');
            return;
        }
        if (p.entry?.form3_id === form3Id) { Layout.showNotification(`${nameOf(p.v)}: анкета ${form3Id} уже отмечена`, 'info'); return; }
        const msg = `${nameOf(p.v)}: отметить анкету ${form3Id} как поданную?` +
            (p.entry?.form3_id ? `\n\nСейчас в ШРСК записан другой номер: ${p.entry.form3_id} — он будет заменён.` : '') +
            '\n\nОтмечайте только после Submit на портале (после Next номер уже есть, но это ещё черновик).';
        if (!confirm(msg)) return;
        if (await setSubmitted(p, form3Id, null)) Layout.showNotification(`${nameOf(p.v)}: анкета ${form3Id} отмечена поданной`, 'success');
    }

    // ==================== НОВЫЙ ИНОСТРАНЕЦ ====================
    // Контакт сразу с паспортными данными; потом его заселяют в шахматке — и он появляется в «Подать».
    const titleCase = s => (s || '').toLowerCase().replace(/(^|[\s-])\S/g, m => m.toUpperCase());

    function openNew() {
        const inp = (id, label, extra = '') => `<div><div class="f3-label">${label}</div>
            <input id="${id}" class="input input-bordered input-sm w-full" ${extra}></div>`;
        document.getElementById('newModalBody').innerHTML = `
            <h3 class="text-lg font-bold mb-1">Новый иностранец</h3>
            <p class="text-sm opacity-70 mb-3">Создаёт контакт с паспортными данными. Потом заселите его в шахматке — и он появится в «Подать».</p>
            <div class="grid grid-cols-2 gap-3">
                ${inp('nSurname', 'Фамилия латиницей, как в паспорте *', 'style="text-transform:uppercase"')}
                ${inp('nGiven', 'Имя латиницей, как в паспорте *', 'style="text-transform:uppercase"')}
                ${inp('nLast', 'Фамилия в карточке', 'placeholder="как в паспорте или по-русски"')}
                ${inp('nFirst', 'Имя в карточке', 'placeholder="как в паспорте или по-русски"')}
                ${inp('nSpiritual', 'Духовное имя (если есть)')}
                ${inp('nCitizenship', 'Гражданство, код из паспорта *', 'maxlength="3" placeholder="RUS" style="text-transform:uppercase"')}
                ${inp('nBirth', 'Дата рождения', 'type="date"')}
                <div><div class="f3-label">Пол</div><select id="nGender" class="select select-bordered select-sm w-full">
                    <option value="">—</option><option value="male">Мужской</option><option value="female">Женский</option></select></div>
                ${inp('nPassport', 'Номер паспорта', 'style="text-transform:uppercase"')}
                ${inp('nPassExp', 'Паспорт действует до', 'type="date"')}
                ${inp('nPhone', 'Телефон')}
                ${inp('nEmail', 'Почта', 'type="email"')}
            </div>
            <div id="nDupes" class="mt-3"></div>
            <div class="flex gap-2 mt-4">
                <button class="btn btn-primary btn-sm" data-act="new-save">Создать контакт</button>
            </div>`;
        // имя в карточке по умолчанию — из латиницы паспорта
        ['Surname', 'Given'].forEach(k => {
            const src = document.getElementById('n' + k), dst = document.getElementById(k === 'Surname' ? 'nLast' : 'nFirst');
            src.addEventListener('input', () => { if (!dst.dataset.touched) dst.value = titleCase(src.value); });
            dst.addEventListener('input', () => { dst.dataset.touched = '1'; });
        });
        document.getElementById('newModal').showModal();
    }

    async function saveNew(force) {
        const nv = id => { const x = document.getElementById(id).value.trim(); return x === '' ? null : x; };
        const surname = nv('nSurname')?.toUpperCase(), given = nv('nGiven')?.toUpperCase();
        const cit = nv('nCitizenship')?.toUpperCase();
        const passport = nv('nPassport')?.toUpperCase().replace(/\s/g, '') || null;
        if (!surname || !given) { Layout.showNotification('Нужны фамилия и имя латиницей', 'warning'); return; }
        if (!cit || !/^[A-Z]{3}$/.test(cit)) { Layout.showNotification('Гражданство — код из трёх латинских букв (RUS, UKR…)', 'warning'); return; }
        if (cit === 'IND') { Layout.showNotification('Гражданин Индии — Form III не нужен', 'warning'); return; }
        const first = nv('nFirst') || titleCase(given), last = nv('nLast') || titleCase(surname);

        // Похожие контакты: тот же паспорт, та же латиница, то же имя в карточке
        if (!force) {
            const found = new Map();
            if (passport) {
                const { data } = await Layout.db.from('vaishnava_documents').select('vaishnava_id').eq('passport_number', passport);
                (data || []).forEach(d => found.set(d.vaishnava_id, 'тот же номер паспорта'));
            }
            const { data: byLatin } = await Layout.db.from('vaishnava_documents').select('vaishnava_id')
                .eq('passport_surname', surname).eq('passport_given_name', given);
            (byLatin || []).forEach(d => found.has(d.vaishnava_id) || found.set(d.vaishnava_id, 'та же фамилия и имя по паспорту'));
            const { data: byName } = await Layout.db.from('vaishnavas').select('id')
                .ilike('last_name', last).ilike('first_name', first).limit(10);
            (byName || []).forEach(d => found.has(d.id) || found.set(d.id, 'то же имя в карточке'));
            if (found.size) {
                const { data: vs } = await Layout.db.from('vaishnavas')
                    .select('id, spiritual_name, first_name, last_name, birth_date').in('id', [...found.keys()]);
                document.getElementById('nDupes').innerHTML = `<div class="alert alert-warning text-sm"><div>
                    <b>⚠ Похоже, такой человек уже есть:</b>
                    <ul class="list-disc ml-5">${(vs || []).map(v => `<li><a class="link" target="_blank" href="../vaishnavas/person.html?id=${e(v.id)}">${e(nameOf(v))}</a>
                        ${v.birth_date ? ', ' + fmtDate(v.birth_date) : ''} — ${e(found.get(v.id))}</li>`).join('')}</ul>
                    <div class="mt-1">Если это он — откройте его карточку и не создавайте новый контакт.</div>
                    <button class="btn btn-xs btn-outline mt-2" data-act="new-force">Это другой человек — создать</button></div></div>`;
                return;
            }
        }

        const { data: created, error } = await Layout.db.from('vaishnavas').insert({
            first_name: first, last_name: last, spiritual_name: nv('nSpiritual'),
            citizenship: cit, birth_date: nv('nBirth'), gender: nv('nGender'),
            phone: nv('nPhone'), email: nv('nEmail')
        }).select('id').single();
        if (error) { Layout.handleError(error, 'Новый контакт'); return; }
        const { error: dErr } = await Layout.db.from('vaishnava_documents').insert({
            vaishnava_id: created.id, passport_number: passport,
            passport_surname: surname, passport_given_name: given, passport_expiry: nv('nPassExp'),
            updated_by: window.currentUser?.vaishnava_id || null
        });
        if (dErr) Layout.handleError(dErr, 'Паспорт');

        document.getElementById('newModalBody').innerHTML = `
            <h3 class="text-lg font-bold mb-2">Контакт создан</h3>
            <p class="mb-3">${e(first)} ${e(last)} (${e(cit)}). Чтобы он появился в «Подать», заселите его в шахматке.</p>
            <div class="flex flex-wrap gap-2">
                <a class="btn btn-primary btn-sm" href="../placement/timeline.html" target="_blank">Открыть шахматку</a>
                <a class="btn btn-sm" href="../vaishnavas/person.html?id=${e(created.id)}" target="_blank">Карточка контакта</a>
            </div>`;
    }

    async function setCitizenship(i, code) {
        const p = unknown[i];
        if (code === 'ask') {
            code = prompt(`Гражданство ${nameOf(p.v)} — трёхбуквенный код как в паспорте (RUS, UKR, DEU…):`);
            if (!code) return;
            code = code.trim().toUpperCase();
            if (!/^[A-Z]{3}$/.test(code)) { Layout.showNotification('Нужен код из трёх латинских букв', 'error'); return; }
        }
        const { error } = await Layout.db.from('vaishnavas').update({ citizenship: code }).eq('id', p.v.id);
        if (error) { Layout.handleError(error, 'Гражданство'); return; }
        await load();
    }

    // ==================== ЗАКЛАДКИ ДЛЯ ПОРТАЛА ====================
    // Исполняются на indianfrro.gov.in по нажатию человека. Номера вписывает закладка, не Claude.
    function bmFill() {
        (async () => {
            const sleep = ms => new Promise(r => setTimeout(r, ms));
            const norm = s => (s || '').replace(/\s+/g, ' ').trim().toUpperCase();
            const lsGet = k => { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch (err) { return null; } };
            const lsSet = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (err) { /* без памяти */ } };
            let txt = '';
            try { txt = await navigator.clipboard.readText(); } catch (err) { /* нет доступа к буферу */ }
            let fresh = null;
            if (txt && txt.indexOf('srsk_form3') >= 0) { try { fresh = JSON.parse(txt); } catch (err) { fresh = null; } }
            // Очередь живёт на портале (localStorage): из буфера берём новую, иначе продолжаем сохранённую
            let queue = lsGet('srsk_form3_queue');
            if (queue && Date.now() - queue.at > 12 * 3600 * 1000) queue = null;
            if (fresh && (fresh.srsk_form3_queue || fresh.srsk_form3)) {
                const fq = fresh.srsk_form3_queue
                    ? { qid: fresh.qid, items: fresh.items }
                    : { qid: 'one-' + fresh.vid + '-' + fresh.arrival_date, items: [fresh] };
                if (!queue || queue.qid !== fq.qid) {
                    queue = { qid: fq.qid, items: fq.items, at: Date.now() };
                    lsSet('srsk_form3_queue', queue);
                    lsSet('srsk_form3_done', []);
                    lsSet('srsk_form3_current', null);
                }
            }
            if (!queue) {
                txt = prompt('Вставьте данные из ШРСК (Cmd+V):') || '';
                try { fresh = JSON.parse(txt); } catch (err) { fresh = null; }
                if (!fresh || !(fresh.srsk_form3 || fresh.srsk_form3_queue)) { alert('Это не данные ШРСК. В ШРСК нажмите «Скопировать для портала» или «Скопировать всех готовых».'); return; }
                queue = { qid: fresh.qid || ('one-' + fresh.vid), items: fresh.items || [fresh], at: Date.now() };
                lsSet('srsk_form3_queue', queue); lsSet('srsk_form3_done', []); lsSet('srsk_form3_current', null);
            }
            const qDone = lsGet('srsk_form3_done') || [];
            const left = queue.items.filter(x => qDone.indexOf(x.vid) < 0);
            if (!left.length) { alert('Все из очереди ШРСК поданы (' + queue.items.length + '). Чтобы начать новую — в ШРСК снова «Скопировать всех готовых».'); return; }
            let d = left[0];
            const cur = lsGet('srsk_form3_current');
            if (left.length > 1) {
                const def = Math.max(0, left.findIndex(x => x.vid === cur)) + 1;
                const ans = prompt('Кого заполнять? Осталось ' + left.length + ' из ' + queue.items.length + ':\n' +
                    left.map((x, i) => (i + 1) + '. ' + x.who + (x.vid === cur ? '  ← сейчас' : '')).join('\n') +
                    '\n\nНомер (Enter — ' + def + '):', String(def));
                if (ans == null) return;
                const n = parseInt(ans, 10);
                if (!(n >= 1 && n <= left.length)) { alert('Нет такого номера'); return; }
                d = left[n - 1];
            }
            lsSet('srsk_form3_current', d.vid);
            // кого заполняли — для закладки «ШРСК ← номер анкеты»
            lsSet('srsk_form3_last', { vid: d.vid, who: d.who, passport: d.passport, at: Date.now() });
            // для печати: комната, срок, дата рождения — по номеру паспорта
            const ppl = lsGet('srsk_form3_people') || {};
            queue.items.forEach(x => { if (x.passport) ppl[x.passport] = { room: x.room, arr: x.arrival_date, co: x.expected_checkout, dob: x.dob }; });
            lsSet('srsk_form3_people', ppl);
            const done = [], manual = [], changed = [];
            const el = n => document.querySelector('[formcontrolname="' + n + '"]');
            const ddmmyyyy = iso => iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : '';
            const setInput = (n, v, label, check) => {
                const x = el(n);
                if (!x || v == null || v === '') return;
                if (x.tagName !== 'INPUT' && x.tagName !== 'TEXTAREA') return;
                const before = x.value;
                if (before === String(v)) { done.push(label); return; }
                const ro = x.readOnly;
                x.readOnly = false;
                const proto = x.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
                Object.getOwnPropertyDescriptor(proto, 'value').set.call(x, String(v));
                x.dispatchEvent(new Event('input', { bubbles: true }));
                x.dispatchEvent(new Event('change', { bubbles: true }));
                x.dispatchEvent(new Event('blur', { bubbles: true }));
                x.readOnly = ro;
                if (before) changed.push(label + ': было «' + before + '»');
                if (check) manual.push('проверьте ' + label + ': ' + check); else done.push(label);
            };
            const pick = async (n, wanted, label) => {
                const x = el(n);
                if (!x || !wanted) return;
                if (norm(x.textContent) === norm(wanted)) { done.push(label); return; }
                const trg = x.querySelector('.mat-select-trigger, .mat-mdc-select-trigger') || x;
                trg.click();
                await sleep(500);
                const opts = Array.from(document.querySelectorAll('mat-option, .mat-option, .mat-mdc-option'));
                let o = opts.find(op => norm(op.textContent) === norm(wanted)) ||
                        opts.find(op => norm(op.textContent).indexOf(norm(wanted)) === 0);
                if (o) { o.click(); done.push(label); await sleep(600); return; }
                document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                const bd = document.querySelector('.cdk-overlay-backdrop');
                if (bd) bd.click();
                manual.push(label + ': выбрать «' + wanted + '»');
                await sleep(400);
            };
            // Шаг 1 — личные данные и документы
            setInput('given_name', d.given_name, 'Given Name');
            if (el('surname')) { setInput('surname', d.surname, 'Surname'); await sleep(2500); }
            await pick('gender', d.gender, 'Gender');
            if (d.nationality) await pick('nationality', d.nationality, 'Nationality');
            else if (el('nationality')) manual.push('Nationality: выбрать вручную (код ' + d.nationality_iso3 + ')');
            setInput('dob', ddmmyyyy(d.dob), 'DOB', ddmmyyyy(d.dob));
            setInput('phnnuminind', d.phone, 'Phone in India');
            setInput('emailId', d.email, 'Email');
            await pick('spl_category_code', d.special_category, 'Special Category');
            setInput('passnum', d.passport, 'Passport Number');
            setInput('visanum', d.visa_number, 'Visa Number');
            if (d.visa_type) { await pick('visatype', d.visa_type, 'Visa Type'); await sleep(800); }
            await pick('visasubtype', d.visa_subtype, 'Visa Subtype');
            // Шаг 2 — приезд
            setInput('arrivedFromPlace', d.arrived_from, 'Arrived From');
            setInput('dateOfArrivalInHotel', ddmmyyyy(d.arrival_date), 'Date Of Arrival', ddmmyyyy(d.arrival_date));
            setInput('timeOfArrivalInHotel', d.arrival_time, 'Time Of Arrival', d.arrival_time);
            await pick('purposeOfVisit', d.purpose, 'Purpose Of Visit');
            setInput('previousPlaceStay', d.previous_place, 'Previous Place Of Stay');
            setInput('durationofstay', d.duration_days, 'Duration Of Stay');
            if (el('expectedCheckoutDate')) manual.push('проверьте Expected Checkout Date: ' + ddmmyyyy(d.expected_checkout));
            // Фото: берём из карточки контакта и кладём в поле загрузки портала
            const photoInput = document.querySelector('#imageUpload, input[type=file]');
            if (photoInput && d.photo_url) {
                try {
                    const blob = await (await fetch(d.photo_url)).blob();
                    const dt = new DataTransfer();
                    dt.items.add(new File([blob], (d.surname || 'photo') + '.jpg', { type: 'image/jpeg' }));
                    photoInput.files = dt.files;
                    photoInput.dispatchEvent(new Event('change', { bubbles: true }));
                    photoInput.dispatchEvent(new Event('input', { bubbles: true }));
                    await sleep(800);
                    manual.push('проверьте, что фото появилось на анкете');
                } catch (err) {
                    manual.push('Photo: загрузите вручную (в ШРСК — «Скачать фото»)');
                }
            } else if (photoInput) {
                manual.push('Photo: в карточке контакта нет фото — загрузите вручную');
            }
            if (!done.length && !manual.length) { alert('На этой странице нет полей анкеты Form III. Откройте New Entry.'); return; }
            alert('ШРСК → Form III: ' + d.who +
                '\n\nЗаполнено: ' + (done.join(', ') || '—') +
                (changed.length ? '\n\nБыло на портале иначе (заменено):\n• ' + changed.join('\n• ') : '') +
                (manual.length ? '\n\nПроверьте / сделайте вручную:\n• ' + manual.join('\n• ') : '') +
                (left.length > 1 ? '\n\nВ очереди ещё ' + (left.length - 1) + '.' : '') +
                '\n\nПосле «Next» нажмите закладку ещё раз — заполнит следующий шаг. Submit — вы.');
        })();
    }

    // На портале после Submit (или в просмотре анкеты): находит номер анкеты и открывает ШРСК, где его отметят.
    function bmTakeId() {
        let last = null;
        try { last = JSON.parse(localStorage.getItem('srsk_form3_last') || 'null'); } catch (err) { last = null; }
        const re = /\b\d{6}(?=[A-Z0-9]{0,5}[A-Z])[A-Z0-9]{6}\b/g;
        const dlg = document.querySelector('mat-dialog-container');
        let ids = Array.from(new Set(((dlg || document.body).innerText.match(re)) || []));
        // в таблице «Pending for checkout» — строка с паспортом того, кого заполняли
        if (ids.length > 1 && last && last.passport) {
            const row = Array.from(document.querySelectorAll('tr, mat-row, .mat-row, .mat-mdc-row'))
                .find(r => r.innerText.indexOf(last.passport) >= 0 && /\b\d{6}(?=[A-Z0-9]{0,5}[A-Z])[A-Z0-9]{6}\b/.test(r.innerText));
            if (row) ids = Array.from(new Set(row.innerText.match(re) || []));
        }
        if (!ids.length) { alert('Номер анкеты на странице не найден. Откройте подтверждение после Submit или просмотр анкеты (значок глаза).'); return; }
        let id = ids[0];
        if (ids.length > 1) {
            id = (prompt('На странице несколько номеров анкет:\n' + ids.join('\n') + '\n\nКакой отметить?', ids[0]) || '').trim().toUpperCase();
            if (!id) return;
        }
        if (!last || !last.vid || Date.now() - last.at > 6 * 3600 * 1000) {
            alert('Номер ' + id + ' найден, но непонятно, чей он: закладкой «ШРСК → Form III» сегодня никого не заполняли. Впишите номер в ШРСК вручную («Анкета подана…»).');
            return;
        }
        if (!confirm('Отметить в ШРСК: ' + last.who + ' — анкета ' + id + '?')) return;
        try {
            const qd = JSON.parse(localStorage.getItem('srsk_form3_done') || '[]');
            if (qd.indexOf(last.vid) < 0) qd.push(last.vid);
            localStorage.setItem('srsk_form3_done', JSON.stringify(qd));
            localStorage.setItem('srsk_form3_current', 'null');
        } catch (err) { /* без очереди */ }
        window.open('__SRSK_ORIGIN__/reception/form3.html#submitted=' + encodeURIComponent(id) + '&v=' + encodeURIComponent(last.vid), '_blank');
    }

    function bmPrint() {
        const dlg = document.querySelector('mat-dialog-container');
        if (!dlg) { alert('Откройте просмотр анкеты (значок глаза) и нажмите закладку ещё раз.'); return; }
        // Данные ШРСК внизу: ищем человека по номеру паспорта в анкете
        let ppl = {};
        try { ppl = JSON.parse(localStorage.getItem('srsk_form3_people') || '{}') || {}; } catch (err) { ppl = {}; }
        const text = dlg.innerText;
        const key = Object.keys(ppl).find(k => k && text.indexOf(k) >= 0);
        let x = key ? ppl[key] : null;
        if (!x) {
            // запасной путь: очередь, сохранённая закладкой заполнения
            try {
                const q = JSON.parse(localStorage.getItem('srsk_form3_queue') || 'null');
                const it = q && (q.items || []).find(i => i.passport && text.indexOf(i.passport) >= 0);
                if (it) x = { room: it.room, arr: it.arrival_date, co: it.expected_checkout, dob: it.dob };
            } catch (err) { x = null; }
        }
        const dmy = iso => iso ? iso.slice(8, 10) + '.' + iso.slice(5, 7) + '.' + iso.slice(0, 4) : '—';
        const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return (m === 1 && h !== 11) ? a : (m >= 2 && m <= 4 && (h < 12 || h > 14)) ? b : c; };
        let foot = '';
        if (x) {
            const lines = [];
            if (x.room) lines.push('Комната: ' + x.room);
            if (x.arr) {
                const days = x.co ? Math.round((new Date(x.co + 'T00:00:00') - new Date(x.arr + 'T00:00:00')) / 864e5) : null;
                lines.push('Срок пребывания по анкете: ' + dmy(x.arr) + ' — ' + dmy(x.co) + (days != null ? ' (' + days + ' ' + plural(days, 'день', 'дня', 'дней') + ')' : ''));
            }
            if (x.dob) {
                const b = new Date(x.dob + 'T00:00:00'), t = new Date();
                let age = t.getFullYear() - b.getFullYear();
                if (t.getMonth() < b.getMonth() || (t.getMonth() === b.getMonth() && t.getDate() < b.getDate())) age--;
                lines.push('Возраст: ' + age + ' ' + plural(age, 'год', 'года', 'лет') + ' (дата рождения ' + dmy(x.dob) + ')');
            }
            foot = '<div style="margin-top:6mm;font-size:10px;line-height:1.5">' + lines.join('<br>') + '</div>';
        } else if (!confirm('Нет данных ШРСК для этой анкеты (комната, срок, возраст) — её заполняли не закладкой. Печатать без них?')) {
            return;
        }
        const w = window.open('', '_blank');
        if (!w) { alert('Браузер заблокировал окно — разрешите всплывающие окна для портала.'); return; }
        w.document.write('<html><head><title>Form III</title><style>' +
            'body{font-family:Arial,sans-serif;font-size:12px;color:#000;margin:12mm}' +
            'button,mat-icon,.mat-dialog-actions,.mat-mdc-dialog-actions{display:none!important}' +
            'table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px;color:#000}' +
            'img{max-width:35mm}*{color:#000!important;opacity:1!important}' +
            '</style></head><body>' + dlg.innerHTML + foot + '</body></html>');
        w.document.close();
        setTimeout(() => w.print(), 600);
    }

    function renderBookmarks() {
        const href = fn => 'javascript:' + encodeURIComponent('(' + fn.toString().replace('__SRSK_ORIGIN__', location.origin) + ')()');
        document.getElementById('bookmarksPane').innerHTML = `
            <div class="bg-base-100 rounded-lg p-4 space-y-4 max-w-3xl">
                <p>Перетащите кнопки на панель закладок браузера (один раз). Нажимаются на портале FRRO после входа.</p>
                <div class="flex flex-wrap gap-3">
                    <a class="btn btn-primary f3-bm" href="${href(bmFill)}" title="Перетащите на панель закладок">ШРСК → Form III</a>
                    <a class="btn f3-bm" href="${href(bmTakeId)}" title="Перетащите на панель закладок">ШРСК ← номер анкеты</a>
                    <a class="btn f3-bm" href="${href(bmPrint)}" title="Перетащите на панель закладок">ШРСК → печать анкеты</a>
                </div>
                <ol class="list-decimal ml-5 text-sm space-y-1">
                    <li>В ШРСК у человека без ⚠ нажмите <b>«Скопировать для портала»</b>.</li>
                    <li>На портале: Form III Details → New Entry → поиск по паспорту → анкета.</li>
                    <li>Нажмите закладку <b>«ШРСК → Form III»</b>. Она заполнит поля, в том числе номера паспорта и визы, и покажет, что проверить вручную (даты и время — всегда).</li>
                    <li>После <b>Next</b> нажмите закладку ещё раз — заполнит следующий шаг.</li>
                    <li>Фото закладка берёт из карточки контакта и сама кладёт в анкету (на шаге, где есть «Upload Photo»). Если не получилось — «Скачать фото» в карточке и загрузить вручную. Submit — вы.</li>
                    <li>После <b>Submit</b> нажмите закладку <b>«ШРСК ← номер анкеты»</b>: она найдёт номер на странице и откроет ШРСК — подтвердите, и анкета отмечена поданной. Не нашла — впишите номер кнопкой <b>«Анкета подана…»</b>.</li>
                    <li>Для печати: на портале откройте просмотр анкеты (значок глаза) → закладка <b>«ШРСК → печать анкеты»</b> → «Сохранить как PDF» в Загрузки.</li>
                </ol>
                <div class="alert text-sm">Первая версия: на портале её ещё не пробовали. Первый раз заполняйте вместе с Claude — поправим, что не сработает.</div>
            </div>`;
    }

    // ==================== СОБЫТИЯ ====================
    function bind() {
        document.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
        document.addEventListener('click', ev => {
            const g = ev.target.closest('[data-goto]');
            if (g) { showTab(g.dataset.goto); return; }
            const al = ev.target.closest('[data-already]');
            if (al) { markAlready(people[+al.dataset.already]); return; }
            const row = ev.target.closest('[data-open]');
            if (row) {
                const [kind, i] = row.dataset.open.split(':');
                openPerson((kind === 'submit' ? people : submitted)[+i]);
                return;
            }
            const c = ev.target.closest('[data-cit]');
            if (c) { const [i, code] = c.dataset.cit.split(':'); setCitizenship(+i, code); return; }
            const a = ev.target.closest('[data-act]');
            if (!a || a.disabled) return;
            switch (a.dataset.act) {
                case 'save': save(); break;
                case 'copy': copyForPortal(); break;
                case 'queue': copyQueue(); break;
                case 'photo': downloadPhoto(); break;
                case 'upload': pickPhoto(); break;
                case 'submitted': markSubmitted(); break;
                case 'already': markAlready(current); break;
                case 'new': openNew(); break;
                case 'new-save': saveNew(false); break;
                case 'new-force': saveNew(true); break;
            }
        });
    }

    // Перетаскивание фото на рамку в карточке
    function bindDrop() {
        const modal = document.getElementById('personModal');
        modal.addEventListener('dragover', ev => {
            if (!ev.target.closest('#f3PhotoDrop')) return;
            ev.preventDefault();
            ev.target.closest('#f3PhotoDrop').classList.add('border-primary');
        });
        modal.addEventListener('dragleave', ev => {
            ev.target.closest('#f3PhotoDrop')?.classList.remove('border-primary');
        });
        modal.addEventListener('drop', ev => {
            const box = ev.target.closest('#f3PhotoDrop');
            if (!box) return;
            ev.preventDefault();
            box.classList.remove('border-primary');
            uploadPhoto(ev.dataTransfer.files[0]);
        });
    }

    function showTab(name) {
        document.querySelectorAll('[data-tab]').forEach(t => t.classList.toggle('tab-active', t.dataset.tab === name));
        document.querySelectorAll('[data-pane]').forEach(p => p.classList.toggle('hidden', p.dataset.pane !== name));
    }

    async function init() {
        bind();
        bindDrop();
        document.getElementById('f3Search').addEventListener('input', Layout.debounce(ev => {
            query = ev.target.value.trim().toLowerCase();
            render();
        }, 200));
        renderBookmarks();
        await load();
        await takeSubmittedFromHash();
        window.addEventListener('hashchange', takeSubmittedFromHash);
    }

    return { init, reload: load };
})();
