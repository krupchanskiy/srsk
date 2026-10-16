/**
 * Аналитика магазина.
 *
 * Валовая прибыль считается только по чужому товару: у своего выпуска себестоимости
 * нет и быть не может, его экономика собирается в финмодуле на объекте «Мурти Госвами».
 * Поэтому выручка разведена на две строки, а не сложена в одну красивую цифру.
 *
 * Остаток тоже показан двумя строками. Чужой товар лежит на полке, но нам не
 * принадлежит: его стоимость — это будущее обязательство, а не наш актив.
 */
const ShopAnalytics = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const { деньги, штук } = ShopUtils;
    const $ = s => document.querySelector(s);

    let отчёт = null, дней = 30;

    async function загрузить() {
        const { data, error } = await Layout.db.rpc('shop_report', {
            p_from: $('#from').value, p_to: $('#to').value,
        });
        if (error) { Layout.handleError(error, 'Отчёт магазина'); return false; }
        отчёт = data;
        return true;
    }

    function плитка(ключ, значение, подпись = '', цвет = '') {
        return `<div class="tile">
            <div class="k">${e(ключ)}</div>
            <div class="v nums ${цвет}">${значение}</div>
            ${подпись ? `<div class="s">${e(подпись)}</div>` : ''}
        </div>`;
    }

    function рисовать() {
        if (!отчёт) return;
        const о = отчёт;
        const прибыль = Number(о.валовая_прибыль) || 0;
        const маржа = Number(о.перепродажа) > 0
            ? Math.round(прибыль / Number(о.перепродажа) * 100) : 0;

        $('#tiles').innerHTML =
            плитка('Выручка', деньги(о.выручка_товары), `${о.чеков} чеков, средний ${деньги(о.средний_чек)}`) +
            плитка('Перепродажа', деньги(о.перепродажа), 'чужой товар') +
            плитка('Свой выпуск', деньги(о.свой_выпуск), 'мурти и прочее наше') +
            плитка('Себестоимость', деньги(о.себестоимость), 'к оплате владельцам') +
            плитка('Валовая прибыль', деньги(прибыль), `маржа ${маржа}% на перепродаже`,
                   прибыль >= 0 ? 'text-success' : 'text-error') +
            плитка('Пожертвования', деньги(о.пожертвования), 'входят в выручку') +
            плитка('На полке своё', штук(о.остаток.своё_штук) + ' шт', 'себестоимость не ведём') +
            плитка('На полке чужое', штук(о.остаток.чужое_штук) + ' шт',
                   `обязательств на ${деньги(о.остаток.чужое_обязательства)}`) +
            (Number(о.остаток.недостача) ? плитка('Недостача',
                   штук(о.остаток.недостача) + ' шт', 'продано больше, чем приняли', 'text-error') : '') +
            (Number(о.возвращено) ? плитка('Возвращено покупателям',
                   деньги(о.возвращено), 'за период') : '');

        const топ = о.топ || [];
        const максимум = топ.reduce((m, т) => Math.max(m, Number(т.amount)), 0) || 1;
        $('#topTbl').tBodies[0].innerHTML = топ.map(т => `
            <tr>
                <td data-label="">
                    <div class="font-semibold">${e(Layout.getName(т))}
                        ${т.source === 'own' ? '<span class="badge badge-sm badge-secondary">наше</span>' : ''}</div>
                    <div class="bar mt-1" style="width: ${Math.max(4, Math.round(Number(т.amount) / максимум * 100))}%"></div>
                </td>
                <td data-label="Штук" class="text-right nums">${штук(т.qty)}</td>
                <td data-label="Выручка" class="text-right nums font-semibold">${деньги(т.amount)}</td>
                <td data-label="Прибыль" class="text-right nums ${т.source === 'own' ? 'opacity-40' : ''}">
                    ${т.source === 'own' ? 'в проекте' : деньги(т.margin)}</td>
            </tr>`).join('') ||
            '<tr><td colspan="4" class="text-center opacity-60 py-6">За период ничего не продано</td></tr>';

        const цели = о.цели || [];
        $('#goalsCard').hidden = !цели.length;
        $('#goalsTbl').tBodies[0].innerHTML = цели.map(ц => `
            <tr>
                <td data-label="">${e(Layout.getName(ц))}</td>
                <td data-label="Собрано" class="text-right nums font-semibold">${деньги(ц.amount)}</td>
            </tr>`).join('');

        const лежит = о.лежалое || [];
        $('#deadTbl').tBodies[0].innerHTML = лежит.map(т => `
            <tr>
                <td data-label="">${e(Layout.getName(т))}</td>
                <td data-label="На полке" class="text-right nums">${штук(т.qty)}</td>
                <td data-label="Лежит" class="text-right nums">${т.days} дн.</td>
            </tr>`).join('') ||
            '<tr><td colspan="3" class="text-center opacity-60 py-6">Залежалого нет</td></tr>';
    }

    function период(d) {
        дней = d;
        const до = new Date();
        const от = new Date(Date.now() - d * 86400000);
        $('#to').value = DateUtils.toISO(до);
        $('#from').value = DateUtils.toISO(от);
        document.querySelectorAll('#periods button').forEach(b => {
            const свой = Number(b.dataset.days) === d;
            b.classList.toggle('btn-outline', !свой);
            b.style.cssText = свой ? 'background: var(--current-color); color:#fff; border-color: var(--current-color);' : '';
        });
    }

    function слушать() {
        document.addEventListener('click', async ev => {
            const b = ev.target.closest('[data-days]');
            if (!b) return;
            период(Number(b.dataset.days));
            if (await загрузить()) рисовать();
        });
        ['#from', '#to'].forEach(сел => $(сел).addEventListener('change', async () => {
            if (await загрузить()) рисовать();
        }));
    }

    async function init() {
        слушать();
        период(30);
        if (await загрузить()) рисовать();
    }

    return { init };
})();
