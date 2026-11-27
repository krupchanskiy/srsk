/**
 * Карточка поставщика — общая для страниц «Поставщики» и «Приём».
 *
 * Поставщик — тот, у кого ШРСК закупает товар (ВГ 19.11). Магазин ему ничего
 * не должен: закупка уже оплачена, это картотека — кто, где, как связаться.
 * Окно встраивается в страницу при первом открытии, чтобы не дублировать
 * разметку в двух HTML.
 *
 *   const сохранён = await SupplierCard.open(поставщик | null);  // строка shop_suppliers или null
 *
 * Тексты — через поЯзыку(): ключи переводов кэшируются, а новые нужны сразу.
 */
const SupplierCard = (() => {
    const по = (ru, en, hi) => поЯзыку({ ru, en, hi });
    const $ = s => document.querySelector(s);
    let правка = null, исход = null, занято = false;

    /** Подписи вида data-l="ru|en|hi" и подсказки data-lp — на текущем языке. */
    function перевести(корень = document) {
        корень.querySelectorAll('[data-l]').forEach(el => { el.textContent = по(...el.dataset.l.split('|')); });
        корень.querySelectorAll('[data-lp]').forEach(el => { el.placeholder = по(...el.dataset.lp.split('|')); });
    }

    /** Ссылку на карту показываем, только если это http(s): иначе в href пролезет javascript:. */
    const безопаснаяСсылка = url => /^https?:\/\//i.test(String(url || '').trim()) ? String(url).trim() : '';
    const телефонДляЗвонка = тел => String(тел || '').replace(/[^\d+]/g, '');

    function встроить() {
        if ($('#supModal')) return;
        const d = document.createElement('div');
        d.innerHTML = `
    <dialog id="supModal" class="modal">
        <div class="modal-box">
            <h3 class="font-bold text-lg mb-3" id="supTitle"></h3>
            <div class="flex flex-col gap-3">
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Имя или название|Name|नाम"></span></div>
                    <input type="text" class="input input-bordered" id="sName">
                </label>
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Телефон|Phone|फ़ोन"></span></div>
                    <input type="tel" class="input input-bordered" id="sPhone" placeholder="+91 …">
                </label>
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Другая связь: WhatsApp, Telegram, почта|Other contacts: WhatsApp, Telegram, email|अन्य संपर्क: WhatsApp, Telegram, ईमेल"></span></div>
                    <input type="text" class="input input-bordered" id="sContacts">
                </label>
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Что у него берём|What we buy from them|उनसे क्या खरीदते हैं"></span></div>
                    <input type="text" class="input input-bordered" id="sGoods" data-lp="например, чётки туласи|e.g. tulasi beads|जैसे, तुलसी माला">
                </label>
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Где находится|Where|कहाँ"></span></div>
                    <input type="text" class="input input-bordered" id="sAddress" data-lp="рынок, улица, ориентир|market, street, landmark|बाज़ार, गली, पहचान">
                </label>
                <div class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Место на карте|Map location|नक्शे पर जगह"></span></div>
                    <div class="flex gap-2">
                        <input type="url" class="input input-bordered flex-1 min-w-0" id="sMap" placeholder="https://maps.google.com/…">
                        <button type="button" class="btn btn-outline gap-1" id="sHere">
                            <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M15 10.5a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z"/><path stroke-linecap="round" stroke-linejoin="round" d="M19.5 10.5c0 7.142-7.5 11.25-7.5 11.25S4.5 17.642 4.5 10.5a7.5 7.5 0 1 1 15 0Z"/></svg>
                            <span data-l="Моё место|My location|मेरी जगह"></span></button>
                    </div>
                    <span class="text-xs opacity-60 mt-1" data-l="Стоите у его лавки — нажмите «Моё место». Или вставьте ссылку из карт.|Standing at the shop? Tap «My location». Or paste a maps link.|दुकान पर हैं — «मेरी जगह» दबाएँ। या नक्शे का लिंक डालें।"></span>
                </div>
                <label class="form-control">
                    <div class="label py-1"><span class="label-text text-sm" data-l="Заметка|Note|टिप्पणी"></span></div>
                    <input type="text" class="input input-bordered" id="sNote">
                </label>
                <label class="label cursor-pointer justify-start gap-2">
                    <input type="checkbox" class="checkbox checkbox-sm" id="sActive" checked>
                    <span class="label-text text-sm" data-l="Закупаем у него|We buy from them|उनसे खरीदते हैं"></span>
                </label>
            </div>
            <div class="modal-action">
                <button class="btn btn-ghost" id="supCancel" data-l="Отмена|Cancel|रद्द करें"></button>
                <button class="btn" id="supGo" style="background: var(--current-color); color: #fff;" data-l="Сохранить|Save|सहेजें"></button>
            </div>
        </div>
        <form method="dialog" class="modal-backdrop"><button>×</button></form>
    </dialog>`;
        document.body.appendChild(d.firstElementChild);
        перевести($('#supModal'));

        $('#supCancel').addEventListener('click', () => $('#supModal').close());
        $('#supGo').addEventListener('click', сохранить);
        $('#sHere').addEventListener('click', моёМесто);
        // закрыли любым способом, не сохранив, — открывшему возвращаем null
        $('#supModal').addEventListener('close', () => { if (исход) { исход(null); исход = null; } });
    }

    function моёМесто() {
        if (!navigator.geolocation) {
            return Layout.showNotification(по('Телефон не даёт место', 'Location is not available', 'स्थान उपलब्ध नहीं'), 'warning');
        }
        $('#sHere').disabled = true;
        navigator.geolocation.getCurrentPosition(p => {
            $('#sHere').disabled = false;
            $('#sMap').value = `https://www.google.com/maps?q=${p.coords.latitude.toFixed(6)},${p.coords.longitude.toFixed(6)}`;
        }, () => {
            $('#sHere').disabled = false;
            Layout.showNotification(по('Не удалось взять место — разрешите доступ к геопозиции',
                'Could not get location — allow location access', 'स्थान नहीं मिला — अनुमति दें'), 'warning');
        }, { enableHighAccuracy: true, timeout: 15000 });
    }

    function open(поставщик = null) {
        встроить();
        правка = поставщик;
        $('#supTitle').textContent = поставщик ? по('Поставщик', 'Supplier', 'आपूर्तिकर्ता')
                                               : по('Новый поставщик', 'New supplier', 'नया आपूर्तिकर्ता');
        $('#sName').value = поставщик?.name || '';
        $('#sPhone').value = поставщик?.phone || '';
        $('#sContacts').value = поставщик?.contacts || '';
        $('#sGoods').value = поставщик?.goods_note || '';
        $('#sAddress').value = поставщик?.address || '';
        $('#sMap').value = поставщик?.map_url || '';
        $('#sNote').value = поставщик?.note || '';
        $('#sActive').checked = поставщик ? поставщик.is_active : true;
        $('#supModal').showModal();
        $('#sName').focus();
        return new Promise(готово => { исход = готово; });
    }

    async function сохранить() {
        const имя = $('#sName').value.trim();
        if (!имя) return Layout.showNotification(по('Укажите имя поставщика', 'Enter the supplier name', 'आपूर्तिकर्ता का नाम लिखें'), 'warning');
        const карта = $('#sMap').value.trim();
        if (карта && !безопаснаяСсылка(карта)) {
            return Layout.showNotification(по('Ссылка на карту должна начинаться с https://', 'The map link must start with https://', 'नक्शे का लिंक https:// से शुरू हो'), 'warning');
        }
        if (занято) return;
        занято = true;
        $('#supGo').disabled = true;
        try {
            const поля = {
                name: имя,
                phone: $('#sPhone').value.trim() || null,
                contacts: $('#sContacts').value.trim() || null,
                goods_note: $('#sGoods').value.trim() || null,
                address: $('#sAddress').value.trim() || null,
                map_url: карта || null,
                note: $('#sNote').value.trim() || null,
                is_active: $('#sActive').checked,
                updated_at: new Date().toISOString(),
            };
            const запрос = правка
                ? Layout.db.from('shop_suppliers').update(поля).eq('id', правка.id)
                : Layout.db.from('shop_suppliers').insert(поля);
            const { data, error } = await запрос.select('*').single();
            if (error) return Layout.handleError(error, по('Карточка поставщика', 'Supplier card', 'आपूर्तिकर्ता कार्ड'));
            Layout.showNotification(по('Поставщик сохранён', 'Supplier saved', 'आपूर्तिकर्ता सहेजा गया'), 'success');
            const готово = исход;
            исход = null;
            $('#supModal').close();
            готово?.(data);
        } finally {
            занято = false;
            $('#supGo').disabled = false;
        }
    }

    return { open, перевести, безопаснаяСсылка, телефонДляЗвонка };
})();
