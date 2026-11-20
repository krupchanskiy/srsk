// Калькулятор купюр (ВГ, 18.11.2026): пачку денег считают по номиналам —
// «500 × 100, 200 × 2, 50 × 15» — и итог вставляется в поле суммы.
// Раскладка нигде не хранится: это только помощь при наборе суммы.
//
// Подключение: у поля суммы атрибут data-cash-calc (значение — код валюты, можно пустым).
// Рядом с полем сам появляется значок калькулятора. Валюту по счёту страница может
// подсказать сама: CashCalc.currencyOf = input => 'INR'. В окне валюту можно сменить.
// Номиналы — из справочника fin_denominations (мигр. 796): новая валюта со своими
// купюрами появляется в калькуляторе сама. Без связи — запасной список ниже.
//
// «Оставить на сдачу» (ВГ, 20.11.2026): у поля с атрибутом data-cash-float у каждого
// номинала есть галочка — эти купюры остаются в кассе как сдача. В поле вставляется
// вся пересчитанная сумма, а отмеченная часть — в input.dataset.cashFloatLeft
// (ручная правка поля её сбрасывает). Раскладка такого поля не стирается при вставке.
(function () {
    // ₹2000 Резервный банк изъял — в калькуляторе не показываем (в Сверке остаётся)
    const HIDDEN = { INR: [2000] };
    let DENOMS = {
        INR: [500, 200, 100, 50, 20, 10],
        USD: [100, 50, 20, 10, 5, 2, 1],
        EUR: [500, 200, 100, 50, 20, 10, 5],
        RUB: [5000, 2000, 1000, 500, 200, 100, 50]
    };
    const SIGN = { INR: '₹', USD: '$', EUR: '€', RUB: '₽' };
    const sign = c => SIGN[c] || c;

    let loaded = null;
    function loadDenoms() {
        loaded = loaded || (async () => {
            try {
                const { data, error } = await window.Layout.db.from('fin_v_denominations').select('currency_code, value');
                if (error || !data?.length) return;
                const map = {};
                data.forEach(d => {
                    const v = Number(d.value);
                    if ((HIDDEN[d.currency_code] || []).includes(v)) return;
                    (map[d.currency_code] = map[d.currency_code] || []).push(v);
                });
                Object.values(map).forEach(list => list.sort((a, b) => b - a));
                // рупии первыми, остальные — как в справочнике
                DENOMS = Object.fromEntries(Object.keys(map)
                    .sort((a, b) => (a === 'INR' ? -1 : b === 'INR' ? 1 : 0)).map(c => [c, map[c]]));
            } catch { /* нет связи — запасной список */ }
        })();
        return loaded;
    }

    const TEXTS = {
        ru: { left: 'Остаётся на сдачу', toTill: 'Уносите в кассу', leftHint: 'галочка — купюры этого номинала остаются на сдачу', expected: 'Должно быть', diff: 'Разница', match: 'сходится', title: 'Посчитать по купюрам', total: 'Итого', other: 'Монеты и прочее', insert: 'Вставить сумму', cancel: 'Отмена', clear: 'Очистить', btn: 'Посчитать по купюрам' },
        en: { left: 'Stays as change', toTill: 'Take to the till', leftHint: 'tick — these notes stay as change', expected: 'Expected', diff: 'Difference', match: 'matches', title: 'Count by banknotes', total: 'Total', other: 'Coins and other', insert: 'Insert amount', cancel: 'Cancel', clear: 'Clear', btn: 'Count by banknotes' },
        hi: { left: 'छुट्टे के लिए रहता है', toTill: 'कैश में ले जाएँ', leftHint: 'टिक — ये नोट छुट्टे के लिए रहते हैं', expected: 'होना चाहिए', diff: 'अंतर', match: 'मेल खाता है', title: 'नोटों से गिनें', total: 'कुल', other: 'सिक्के और अन्य', insert: 'राशि डालें', cancel: 'रद्द करें', clear: 'साफ़ करें', btn: 'नोटों से गिनें' }
    };
    const tx = key => {
        let lang = 'ru';
        try { lang = localStorage.getItem('srsk_lang') || 'ru'; } catch { /* приватный режим */ }
        return (TEXTS[lang] || TEXTS.ru)[key];
    };
    const fmt = n => Number(n || 0).toLocaleString('ru-RU', { maximumFractionDigits: 2 });

    const ICON = '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.8" stroke="currentColor" class="w-4 h-4"><path stroke-linecap="round" stroke-linejoin="round" d="M2.25 18.75a60.07 60.07 0 0 1 15.797 2.101c.727.198 1.453-.342 1.453-1.096V18.75M3.75 4.5v.75A.75.75 0 0 1 3 6h-.75m0 0v-.375c0-.621.504-1.125 1.125-1.125H20.25M2.25 6v9m18-10.5v.75c0 .414.336.75.75.75h.75m-1.5-1.5h.375c.621 0 1.125.504 1.125 1.125v9.75c0 .621-.504 1.125-1.125 1.125h-.375m1.5-1.5H21a.75.75 0 0 0-.75.75v.75m0 0H3.75m0 0h-.375a1.125 1.125 0 0 1-1.125-1.125V15m1.5 1.5v-.75A.75.75 0 0 0 3 15h-.75M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Zm3 0h.008v.008H18V10.5Zm-12 0h.008v.008H6V10.5Z"/></svg>';

    // Набранное не теряется, если окно закрыли случайно (пока поле живо на странице)
    const drafts = new WeakMap();
    let target = null, currency = 'INR', dlg = null, inserting = false;
    const floatMode = () => !!target && target.dataset.cashFloat !== undefined;

    function resolveCurrency(input) {
        const own = (input.dataset.cashCalc || '').toUpperCase();
        if (DENOMS[own]) return own;
        try {
            const c = (window.CashCalc.currencyOf?.(input) || '').toUpperCase();
            if (DENOMS[c]) return c;
        } catch { /* подсказка страницы не сработала — берём рупии */ }
        return 'INR';
    }

    function buildDialog() {
        dlg = document.createElement('dialog');
        dlg.className = 'modal';
        dlg.innerHTML = `
        <div class="modal-box max-w-sm">
            <h3 class="font-bold text-lg mb-2">${tx('title')}</h3>
            <div class="rounded-lg bg-base-200 px-3 py-2 mb-3">
                <div class="text-xs opacity-70">${tx('total')}</div>
                <div class="text-2xl font-bold font-mono" data-cc="total">0</div>
            </div>
            <div class="join mb-3" data-cc="currencies">
                ${Object.keys(DENOMS).map(c => `<button type="button" class="btn btn-sm join-item" data-cc-cur="${c}">${sign(c)} ${c}</button>`).join('')}
            </div>
            <div class="text-xs opacity-70 mb-1" data-cc="leftHint" hidden>${tx('leftHint')}</div>
            <div class="flex flex-col gap-1" data-cc="rows"></div>
            <div class="flex items-center gap-2 mt-2">
                <span class="text-sm flex-1">${tx('other')}</span>
                <input type="text" inputmode="decimal" autocomplete="off" class="input input-bordered input-sm w-28 text-right font-mono" data-cc="other">
            </div>
            <div class="rounded-lg border border-base-300 px-3 py-2 mt-3 text-sm" data-cc="leftBox" hidden>
                <div class="flex justify-between"><span>${tx('left')}</span><b class="font-mono" data-cc="leftSum"></b></div>
                <div class="flex justify-between mt-1"><span>${tx('toTill')}</span><b class="font-mono" data-cc="toTill"></b></div>
            </div>
            <div class="rounded-lg border border-base-300 px-3 py-2 mt-3 text-sm" data-cc="check" hidden>
                <div class="flex justify-between"><span>${tx('expected')}</span><b class="font-mono" data-cc="expected"></b></div>
                <div class="flex justify-between mt-1"><span>${tx('diff')}</span><b class="font-mono" data-cc="diff"></b></div>
            </div>
            <div class="modal-action">
                <button type="button" class="btn btn-ghost btn-sm mr-auto" data-cc="clear">${tx('clear')}</button>
                <button type="button" class="btn btn-ghost btn-sm" data-cc="cancel">${tx('cancel')}</button>
                <button type="button" class="btn btn-primary btn-sm" data-cc="insert">${tx('insert')}</button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop"><button>close</button></form>`;
        document.body.appendChild(dlg);

        dlg.addEventListener('input', () => { saveDraft(); recalc(); });
        dlg.addEventListener('change', ev => { if (ev.target.matches('[data-cc-left]')) { saveDraft(); recalc(); } });
        dlg.addEventListener('click', ev => {
            const cur = ev.target.closest('[data-cc-cur]');
            if (cur) { saveDraft(); currency = cur.dataset.ccCur; renderRows(); return; }
            const act = ev.target.closest('[data-cc]')?.dataset.cc;
            if (act === 'cancel') dlg.close();
            if (act === 'insert') insert();
            if (act === 'clear') { drafts.delete(target); renderRows(); }
        });
        // Enter — к следующему полю, на последнем — вставить
        dlg.addEventListener('keydown', ev => {
            if (ev.key !== 'Enter' || ev.target.tagName !== 'INPUT') return;
            ev.preventDefault();
            const fields = [...dlg.querySelectorAll('[data-cc-qty], [data-cc="other"]')];
            const i = fields.indexOf(ev.target);
            if (i >= 0 && i < fields.length - 1) fields[i + 1].focus(); else insert();
        });
    }

    const num = v => Number(String(v || '').replace(',', '.').replace(/[^\d.]/g, '')) || 0;

    function readCounts() {
        const counts = {};
        dlg.querySelectorAll('[data-cc-qty]').forEach(i => { if (i.value !== '') counts[i.dataset.ccQty] = i.value; });
        const marks = [...dlg.querySelectorAll('[data-cc-left]:checked')].map(c => c.dataset.ccLeft);
        return { counts, marks, other: dlg.querySelector('[data-cc="other"]').value };
    }
    function saveDraft() {
        if (!target) return;
        const all = drafts.get(target) || {};
        all[currency] = readCounts();
        all.last = currency;
        drafts.set(target, all);
    }

    function renderRows() {
        const draft = (drafts.get(target) || {})[currency] || { counts: {}, other: '' };
        const marks = draft.marks || [];
        const withLeft = floatMode();
        dlg.querySelector('[data-cc="leftHint"]').hidden = !withLeft;
        dlg.querySelectorAll('[data-cc-cur]').forEach(b => b.classList.toggle('btn-primary', b.dataset.ccCur === currency));
        dlg.querySelector('[data-cc="rows"]').innerHTML = DENOMS[currency].map(d => `
            <div class="flex items-center gap-2">
                ${withLeft ? `<input type="checkbox" class="checkbox checkbox-sm" data-cc-left="${d}" ${marks.includes(String(d)) ? 'checked' : ''}
                       title="${tx('left')}" aria-label="${tx('left')}: ${sign(currency)} ${fmt(d)}">` : ''}
                <span class="font-mono w-20 text-right">${sign(currency)} ${fmt(d)}</span>
                <span class="opacity-60">×</span>
                <input type="text" inputmode="numeric" autocomplete="off" class="input input-bordered input-sm w-20 text-right font-mono"
                       data-cc-qty="${d}" value="${draft.counts[d] ?? ''}">
                <span class="font-mono flex-1 text-right" data-cc-sum="${d}"></span>
            </div>`).join('');
        dlg.querySelector('[data-cc="other"]').value = draft.other || '';
        recalc();
    }

    // сумма отмеченных галочкой номиналов — остаётся на сдачу
    function leftTotal() {
        let s = 0;
        dlg.querySelectorAll('[data-cc-left]:checked').forEach(c => {
            const q = Math.floor(num(dlg.querySelector(`[data-cc-qty="${c.dataset.ccLeft}"]`)?.value));
            s += q * Number(c.dataset.ccLeft);
        });
        return s;
    }

    function total() {
        let s = 0;
        dlg.querySelectorAll('[data-cc-qty]').forEach(i => {
            const q = Math.floor(num(i.value));
            const part = q * Number(i.dataset.ccQty);
            dlg.querySelector(`[data-cc-sum="${i.dataset.ccQty}"]`).textContent = q ? fmt(part) : '';
            s += part;
        });
        return Math.round((s + num(dlg.querySelector('[data-cc="other"]').value)) * 100) / 100;
    }
    // Поле может сказать, сколько должно быть (data-cash-expected): тогда внизу — сверка и разница
    function recalc() {
        const sum = total();
        dlg.querySelector('[data-cc="total"]').textContent = `${sign(currency)} ${fmt(sum)}`;
        const left = floatMode() ? leftTotal() : 0;
        const leftBox = dlg.querySelector('[data-cc="leftBox"]');
        leftBox.hidden = !left;
        if (left) {
            dlg.querySelector('[data-cc="leftSum"]').textContent = `${sign(currency)} ${fmt(left)}`;
            dlg.querySelector('[data-cc="toTill"]').textContent = `${sign(currency)} ${fmt(Math.round((sum - left) * 100) / 100)}`;
        }
        const raw = target?.dataset.cashExpected;
        const box = dlg.querySelector('[data-cc="check"]');
        box.hidden = raw === undefined || raw === '' || currency !== resolveCurrency(target);
        if (box.hidden) return;
        const exp = Number(raw) || 0;
        const d = Math.round((sum - exp) * 100) / 100;
        dlg.querySelector('[data-cc="expected"]').textContent = `${sign(currency)} ${fmt(exp)}`;
        const el = dlg.querySelector('[data-cc="diff"]');
        el.textContent = d === 0 ? tx('match') : `${d > 0 ? '+' : '−'}${sign(currency)} ${fmt(Math.abs(d))}`;
        el.className = `font-mono ${d === 0 ? 'text-success' : 'text-error'}`;
    }

    function insert() {
        const sum = total();
        const keep = floatMode();
        if (target && target.isConnected) {
            if (keep) {
                const left = leftTotal();
                if (left) { target.dataset.cashFloatLeft = String(left); target.dataset.cashFloatCur = currency; }
                else { delete target.dataset.cashFloatLeft; delete target.dataset.cashFloatCur; }
            }
            target.value = sum ? String(sum) : '';
            inserting = true;
            try {
                target.dispatchEvent(new Event('input', { bubbles: true }));
                target.dispatchEvent(new Event('change', { bubbles: true }));
            } finally { inserting = false; }
        }
        // у поля со сдачей раскладку оставляем: открыли снова — видно, что отмечено
        if (!keep) drafts.delete(target);
        dlg.close();
        // поле могли перерисовать по событию input — ищем по тем же признакам
        (target?.isConnected ? target : null)?.focus();
    }

    async function open(input) {
        await loadDenoms();
        if (!dlg) buildDialog();
        target = input;
        const draft = drafts.get(input);
        currency = draft?.last || resolveCurrency(input);
        renderRows();
        dlg.showModal();
        dlg.querySelector('[data-cc-qty]')?.focus();
    }

    // Значок внутри поля справа — разметка вокруг поля (сетки, колонки) не меняется
    function enhance(input) {
        if (input.dataset.cashCalcReady) return;
        input.dataset.cashCalcReady = '1';
        // сумму поправили руками — отметка «на сдачу» из калькулятора больше не верна
        input.addEventListener('input', () => {
            if (inserting || input.dataset.cashFloatLeft === undefined) return;
            delete input.dataset.cashFloatLeft; delete input.dataset.cashFloatCur;
            drafts.delete(input);
        });
        const wrap = document.createElement('span');
        wrap.className = 'relative block min-w-0';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        input.classList.add('w-full');
        input.style.paddingRight = '2rem';
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'absolute right-1 top-1/2 -translate-y-1/2 btn btn-ghost btn-xs px-1 opacity-60 hover:opacity-100';
        btn.title = tx('btn');
        btn.setAttribute('aria-label', tx('btn'));
        btn.innerHTML = ICON;
        btn.addEventListener('click', ev => { ev.preventDefault(); ev.stopPropagation(); open(input); });
        wrap.appendChild(btn);
    }

    function scan(root) {
        if (root.nodeType !== 1) return;
        if (root.matches?.('input[data-cash-calc]')) enhance(root);
        root.querySelectorAll?.('input[data-cash-calc]').forEach(enhance);
    }

    function start() {
        scan(document.body);
        new MutationObserver(list => list.forEach(m => m.addedNodes.forEach(scan)))
            .observe(document.body, { childList: true, subtree: true });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

    // форму открыли заново — забыть раскладку и отметку «на сдачу» этого поля
    function forget(input) {
        if (!input) return;
        drafts.delete(input);
        delete input.dataset.cashFloatLeft; delete input.dataset.cashFloatCur;
    }

    window.CashCalc = Object.assign(window.CashCalc || {}, { open, forget });
})();
