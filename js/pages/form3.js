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
        CAN: 'CANADA', AUS: 'AUSTRALIA', NZL: 'NEW ZEALAND', NPL: 'NEPAL', BGD: 'BANGLADESH', LKA: 'SRI LANKA'
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

        document.getElementById('listSubmit').innerHTML = people.length ? table(people, 'submit')
            : '<div class="opacity-60 p-4">Нет иностранцев без анкеты.</div>';
        document.getElementById('listUnknown').innerHTML = unknown.length ? unknownTable()
            : '<div class="opacity-60 p-4">У всех живущих гражданство указано.</div>';
        document.getElementById('listSubmitted').innerHTML = submitted.length ? table(submitted, 'submitted')
            : '<div class="opacity-60 p-4">Пока нет поданных анкет.</div>';
    }

    function table(list, kind) {
        const rows = list.map((p, i) => {
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
                <td>${status}</td>
            </tr>`;
        }).join('');
        return `<div class="overflow-x-auto bg-base-100 rounded-lg"><table class="table table-sm">
            <thead><tr><th>Человек</th><th>Заезд → выезд</th><th>${kind === 'submit' ? 'Срок' : ''}</th><th>${kind === 'submit' ? 'Что не хватает' : 'Анкета'}</th></tr></thead>
            <tbody>${rows}</tbody></table></div>`;
    }

    function unknownTable() {
        const rows = unknown.map((p, i) => `<tr>
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
                ${!p.entry?.submitted_at ? `<button class="btn btn-sm btn-success" data-act="submitted" ${issues.length ? 'disabled' : ''}>Анкета подана…</button>` : ''}
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
            photo_url: v.photo_url || null
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
            let txt = '';
            try { txt = await navigator.clipboard.readText(); } catch (err) { /* нет доступа к буферу */ }
            if (!txt || txt.indexOf('srsk_form3') < 0) txt = prompt('Вставьте данные из ШРСК (Cmd+V):') || '';
            let d;
            try { d = JSON.parse(txt); } catch (err) { d = null; }
            if (!d || !d.srsk_form3) { alert('Это не данные ШРСК. В ШРСК нажмите «Скопировать для портала».'); return; }
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
                '\n\nПосле «Next» нажмите закладку ещё раз — заполнит следующий шаг. Submit — вы.');
        })();
    }

    function bmPrint() {
        const dlg = document.querySelector('mat-dialog-container');
        if (!dlg) { alert('Откройте просмотр анкеты (значок глаза) и нажмите закладку ещё раз.'); return; }
        const w = window.open('', '_blank');
        if (!w) { alert('Браузер заблокировал окно — разрешите всплывающие окна для портала.'); return; }
        w.document.write('<html><head><title>Form III</title><style>' +
            'body{font-family:Arial,sans-serif;font-size:12px;color:#000;margin:12mm}' +
            'button,mat-icon,.mat-dialog-actions,.mat-mdc-dialog-actions{display:none!important}' +
            'table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:4px;color:#000}' +
            'img{max-width:35mm}*{color:#000!important;opacity:1!important}' +
            '</style></head><body>' + dlg.innerHTML + '</body></html>');
        w.document.close();
        setTimeout(() => w.print(), 600);
    }

    function renderBookmarks() {
        const href = fn => 'javascript:' + encodeURIComponent('(' + fn.toString() + ')()');
        document.getElementById('bookmarksPane').innerHTML = `
            <div class="bg-base-100 rounded-lg p-4 space-y-4 max-w-3xl">
                <p>Перетащите кнопки на панель закладок браузера (один раз). Нажимаются на портале FRRO после входа.</p>
                <div class="flex flex-wrap gap-3">
                    <a class="btn btn-primary f3-bm" href="${href(bmFill)}" title="Перетащите на панель закладок">ШРСК → Form III</a>
                    <a class="btn f3-bm" href="${href(bmPrint)}" title="Перетащите на панель закладок">ШРСК → печать анкеты</a>
                </div>
                <ol class="list-decimal ml-5 text-sm space-y-1">
                    <li>В ШРСК у человека без ⚠ нажмите <b>«Скопировать для портала»</b>.</li>
                    <li>На портале: Form III Details → New Entry → поиск по паспорту → анкета.</li>
                    <li>Нажмите закладку <b>«ШРСК → Form III»</b>. Она заполнит поля, в том числе номера паспорта и визы, и покажет, что проверить вручную (даты и время — всегда).</li>
                    <li>После <b>Next</b> нажмите закладку ещё раз — заполнит следующий шаг.</li>
                    <li>Фото закладка берёт из карточки контакта и сама кладёт в анкету (на шаге, где есть «Upload Photo»). Если не получилось — «Скачать фото» в карточке и загрузить вручную. Submit — вы.</li>
                    <li>Номер анкеты впишите в ШРСК кнопкой <b>«Анкета подана…»</b>.</li>
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
                case 'photo': downloadPhoto(); break;
                case 'upload': pickPhoto(); break;
                case 'submitted': markSubmitted(); break;
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
        renderBookmarks();
        await load();
    }

    return { init, reload: load };
})();
