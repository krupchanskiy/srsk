/**
 * Плашки «Магазин ждёт казначея» на главной Финансов и в ДДС (ВГ 15.11, мигр. 783).
 * Подключается после fin-utils.js: ShopTreasurerBanner.show('<id контейнера>').
 */
const ShopTreasurerBanner = (() => {
    // Плашки «Магазин ждёт казначея» (ВГ 15.11): выручку и размен ведут на странице смены магазина,
    // а смотрит казначей ДДС — здесь видно, что пакет сдан, смена закрыта и не сдана или кассир
    // не принял размен, и одной кнопкой попасть куда нужно
    async function show(id) {
        const box = document.getElementById(id);
        if (!box) return;
        if (!window.hasPermission?.('fin_admin')) return;
        const [{ data: пакеты }, { count: несданных }, { data: ждёт }, { data: акты }] = await Promise.all([
            Layout.db.from('shop_handovers').select('id, float_amount, shop_handover_lines(currency_code, goods_amount, murti_amount, donation_amount, discrepancy)')
                .eq('status', 'pending'),
            Layout.db.from('shop_shifts').select('id', { count: 'exact', head: true })
                .eq('status', 'closed').is('handover_id', null),
            Layout.db.rpc('shop_float_pending'),
            Layout.db.from('shop_float_receipts').select('issued, counted, accepted, reason')
                .order('created_at', { ascending: false }).limit(1),
        ]);
        const плашки = [];
        const пакет = (пакеты || [])[0];
        if (пакет) {
            const суммы = пакет.shop_handover_lines.map(л => {
                const всего = Number(л.goods_amount) + Number(л.murti_amount) + Number(л.donation_amount);
                const р = Number(л.discrepancy) || 0;
                return FinUtils.fmtMoney(всего, л.currency_code)
                    + (р ? ` (${р < 0 ? 'недостача' : 'излишек'} ${FinUtils.fmtMoney(Math.abs(р), л.currency_code)})` : '');
            });
            if (Number(пакет.float_amount) > 0) суммы.push(`размен ${FinUtils.fmtMoney(пакет.float_amount, 'INR')}`);
            плашки.push([`Магазин сдал кассу: ${суммы.join(' · ')}. Пересчитайте деньги и примите.`, 'Принять выручку', 'handoverBody']);
        } else if (несданных) {
            плашки.push(['Смена магазина закрыта, а выручка ещё не сдана.', 'Открыть смену магазина', 'handoverBody']);
        }
        const акт = (акты || [])[0];
        const выдано = Number(ждёт) || 0;
        if (акт && !акт.accepted && выдано > 0 && Number(акт.issued) === выдано) {
            плашки.push([`Кассир не принял размен: выдано ${FinUtils.fmtMoney(акт.issued, 'INR')}, насчитал ${
                FinUtils.fmtMoney(акт.counted, 'INR')} — ${акт.reason}. Исправьте выдачу.`, 'Открыть размен', 'floatBody']);
        }
        if (!плашки.length) return;
        box.innerHTML = плашки.map(([текст, кнопка, якорь]) => `
            <div role="alert" class="alert alert-warning flex flex-wrap justify-between gap-2 mb-2">
                <span class="flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor" class="w-5 h-5 shrink-0"><path stroke-linecap="round" stroke-linejoin="round" d="M13.5 21v-7.5a.75.75 0 0 1 .75-.75h3a.75.75 0 0 1 .75.75V21m-4.5 0H2.36m11.14 0H18m0 0h3.64m-1.39 0V9.349M3.75 21V9.349m0 0a3.001 3.001 0 0 0 3.75-.615A2.993 2.993 0 0 0 9.75 9.75c.896 0 1.7-.393 2.25-1.016a2.993 2.993 0 0 0 2.25 1.016c.896 0 1.7-.393 2.25-1.015a3.001 3.001 0 0 0 3.75.614m-16.5 0a3.004 3.004 0 0 1-.621-4.72l1.189-1.19A1.5 1.5 0 0 1 5.378 3h13.243a1.5 1.5 0 0 1 1.06.44l1.19 1.189a3 3 0 0 1-.621 4.72M6.75 18h3.75a.75.75 0 0 0 .75-.75V13.5a.75.75 0 0 0-.75-.75H6.75a.75.75 0 0 0-.75.75v3.75c0 .414.336.75.75.75Z"/></svg>
                    ${Layout.escapeHtml(текст)}
                </span>
                <a class="btn btn-sm" href="../shop/shift.html#${якорь}">${Layout.escapeHtml(кнопка)}</a>
            </div>`).join('');
        box.classList.remove('hidden');
    }

    return { show };
})();
