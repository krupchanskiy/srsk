/**
 * Каталог товаров магазина: цены, остатки, фото, сигнал «заканчивается».
 *
 * Цена живёт здесь и только здесь — одна на все партии, как договорились в ТЗ.
 * Меняете цену — она сразу действует на кассе, в том числе для товара, который
 * уже лежит на полке из старой поставки.
 */
const ShopItems = (() => {
    const e = str => Layout.escapeHtml(str ?? '');
    const t = key => Layout.t(key);
    const { деньги, штук } = ShopUtils;

    let товары = [], категории = [], правка = null, фильтр = { поиск: '', кат: '', мало: false };
    let занято = false;
    const $ = s => document.querySelector(s);
    const можноМенять = () => !!window.hasPermission?.('shop_receive');

    async function загрузить() {
        const ответы = await Promise.all([
            Layout.db.from('shop_items')
                .select('id, name_ru, name_en, name_hi, price, min_qty, source, photo_url, category_id, is_active')
                .order('name_ru'),
            Layout.db.from('shop_categories').select('id, name_ru, name_en, name_hi')
                .eq('is_active', true).order('sort_order'),
            Layout.db.from('shop_v_stock').select('item_id, qty'),
        ]);
        if (ShopUtils.ошибка(ответы, t('shop_err_load_items'))) return false;

        const [{ data: ит }, { data: кат }, { data: ост }] = ответы;
        категории = кат || [];
        const остатки = Object.fromEntries((ост || []).map(с => [с.item_id, Number(с.qty)]));
        товары = (ит || []).map(и => ({ ...и, остаток: остатки[и.id] ?? 0 }));
        return true;
    }

    function видимые() {
        const q = фильтр.поиск.trim().toLowerCase();
        return товары.filter(и => {
            if (фильтр.кат && и.category_id !== фильтр.кат) return false;
            if (фильтр.мало && !(и.остаток <= Number(и.min_qty || 0))) return false;
            if (!q) return true;
            return [и.name_ru, и.name_en, и.name_hi].some(н => (н || '').toLowerCase().includes(q));
        });
    }

    function рисовать() {
        $('#catFilter').innerHTML = `<option value="">${t('shop_all_categories')}</option>` +
            категории.map(к => `<option value="${к.id}" ${к.id === фильтр.кат ? 'selected' : ''}>
                ${e(Layout.getName(к))}</option>`).join('');

        const имяКат = Object.fromEntries(категории.map(к => [к.id, Layout.getName(к)]));

        $('#itemsTbl').tBodies[0].innerHTML = видимые().map(и => {
            const мало = и.остаток <= Number(и.min_qty || 0);
            return `
            <tr class="${и.is_active ? '' : 'opacity-50'}">
                <td class="head" data-label="">
                    <div class="flex items-center gap-3">
                        ${и.photo_url
                            ? `<img class="thumb" src="${e(и.photo_url)}" alt="" loading="lazy">`
                            : '<span class="thumb-empty bg-base-200 text-xs opacity-40">—</span>'}
                        <span>${e(Layout.getName(и))}
                            ${и.is_active ? '' : `<span class="badge badge-sm ml-1">${t('shop_withdrawn')}</span>`}</span>
                    </div>
                </td>
                <td data-label="${t('shop_category')}" class="opacity-70">${e(имяКат[и.category_id] || '—')}</td>
                <td data-label="${t('price')}" class="text-right nums font-semibold">${деньги(и.price)}</td>
                <td data-label="${t('shop_stock_col')}" class="text-right nums ${мало ? 'text-warning font-semibold' : ''}">
                    ${штук(и.остаток)}${мало ? ' ⚠' : ''}</td>
                <td data-label="${t('shop_min_qty_col')}" class="text-right nums opacity-60">${штук(и.min_qty)}</td>
                <td data-label="${t('shop_source')}">
                    <span class="badge badge-sm ${и.source === 'own' ? 'badge-secondary' : 'badge-ghost'}">
                        ${и.source === 'own' ? t('shop_ours') : t('shop_consignment')}</span></td>
                <td data-label="" class="text-right">
                    ${можноМенять() ? `<button class="btn btn-ghost btn-xs" data-edit="${и.id}">${t('shop_edit')}</button>` : ''}
                </td>
            </tr>`;
        }).join('') || `<tr><td colspan="7" class="text-center opacity-60 py-6">${t('shop_nothing_found')}</td></tr>`;
    }

    // ---------- фото ----------
    let новоеФото = null;          // правленый снимок, ждёт «Сохранить»
    let адресНового = null;

    function рисоватьФото() {
        if (адресНового) { URL.revokeObjectURL(адресНового); адресНового = null; }
        const адрес = новоеФото ? (адресНового = URL.createObjectURL(новоеФото)) : правка?.photo_url;
        $('#fPhotoPrev').innerHTML = адрес
            ? `<img src="${e(адрес)}" alt="">`
            : `<svg xmlns="http://www.w3.org/2000/svg" class="h-8 w-8 opacity-30" fill="none" viewBox="0 0 24 24" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                   <path stroke-linecap="round" stroke-linejoin="round" d="m2.25 15.75 5.159-5.159a2.25 2.25 0 0 1 3.182 0l5.159 5.159m-1.5-1.5 1.409-1.409a2.25 2.25 0 0 1 3.182 0l2.909 2.909M3.75 21h16.5A1.5 1.5 0 0 0 21.75 19.5V4.5A1.5 1.5 0 0 0 20.25 3H3.75A1.5 1.5 0 0 0 2.25 4.5v15A1.5 1.5 0 0 0 3.75 21Zm9-12.75h.008v.008h-.008V8.25Z" /></svg>`;
        $('#fPhotoPick').textContent = адрес
            ? поЯзыку({ ru: 'Заменить фото', en: 'Replace photo', hi: 'चित्र बदलें' })
            : поЯзыку({ ru: 'Выбрать фото', en: 'Choose photo', hi: 'चित्र चुनें' });
        $('#fPhotoEditLabel').textContent = поЯзыку({ ru: 'Править', en: 'Edit', hi: 'संपादित करें' });
        $('#fPhotoEdit').hidden = !адрес;
        // само превью тоже открывает правку, а пустое — выбор снимка
        $('#fPhotoPrev').title = адрес ? поЯзыку({ ru: 'Повернуть, обрезать, поправить свет',
            en: 'Rotate, crop, adjust light', hi: 'घुमाएँ, काटें, रोशनी ठीक करें' }) : '';
    }

    /** Правка: нового снимка, если он уже выбран, иначе того, что лежит в каталоге. */
    async function править(источник) {
        const снимок = await PhotoEditor.open(источник, { соотношение: 1.5 });
        if (!снимок) return;
        новоеФото = снимок;
        рисоватьФото();
    }

    function открыть(id) {
        правка = id ? товары.find(и => и.id === id) : null;
        $('#modalTitle').textContent = правка ? t('shop_item') : t('shop_new_item');
        $('#fName').value = правка?.name_ru || '';
        $('#fPrice').value = правка?.price ?? '';
        $('#fMin').value = правка?.min_qty ?? 0;
        $('#fSource').value = правка?.source || 'consignment';
        $('#fActive').checked = правка ? правка.is_active : true;
        $('#fPhoto').value = '';
        новоеФото = null;
        рисоватьФото();
        $('#fCat').innerHTML = категории.map(к =>
            `<option value="${к.id}" ${к.id === правка?.category_id ? 'selected' : ''}>
                ${e(Layout.getName(к))}</option>`).join('');
        itemModal.showModal();
    }

    async function сохранить() {
        if (занято) return;
        const имя = $('#fName').value.trim();
        if (!имя) return Layout.showNotification(t('shop_enter_name'), 'warning');
        const цена = Number($('#fPrice').value);
        if (!(цена >= 0)) return Layout.showNotification(t('shop_enter_price'), 'warning');

        const поля = {
            name_ru: имя,
            category_id: $('#fCat').value || null,
            price: цена,
            min_qty: Number($('#fMin').value) || 0,
            source: $('#fSource').value,
            is_active: $('#fActive').checked,
            translit: window.Translit ? Translit.ru(имя).toLowerCase() : (правка?.translit ?? null),
            updated_at: new Date().toISOString(),
        };

        занято = true;                       // второй клик — второй товар в каталоге
        $('#saveItem').setAttribute('disabled', 'disabled');
        try {
            await записать(поля);
        } finally {
            занято = false;
            $('#saveItem').removeAttribute('disabled');
        }
    }

    async function записать(поля) {
        let id = правка?.id;
        if (id) {
            const { error } = await Layout.db.from('shop_items').update(поля).eq('id', id);
            if (error) return Layout.handleError(error, t('shop_err_save_item'));
        } else {
            const { data, error } = await Layout.db.from('shop_items').insert(поля).select('id').single();
            if (error) return Layout.handleError(error, t('shop_err_create_item'));
            id = data.id;
        }

        const файл = новоеФото;
        if (файл) {
            const имяФайла = `${id}_${Date.now()}.${файл.type === 'image/jpeg' ? 'jpg'
                : (файл.name?.split('.').pop() || 'jpg').toLowerCase()}`;
            const { error: ош } = await Layout.db.storage.from('shop-photos')
                .upload(имяФайла, файл, { contentType: файл.type, cacheControl: '3600' });
            if (ош) {
                // фото не критично для торговли, но молчать нельзя — на рецептах это стоило полугода
                Layout.showNotification(t('shop_photo_failed') + ' ' + ош.message, 'warning');
            } else {
                const { data: { publicUrl } } = Layout.db.storage.from('shop-photos').getPublicUrl(имяФайла);
                await Layout.db.from('shop_items').update({ photo_url: publicUrl }).eq('id', id);
            }
        }

        itemModal.close();
        Layout.showNotification(t('shop_saved'), 'success');
        if (await загрузить()) рисовать();
    }

    function слушать() {
        document.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.dataset.edit) return открыть(b.dataset.edit);
            if (b.id === 'newItem') return открыть(null);
            if (b.id === 'saveItem') return сохранить();
            if (b.id === 'fPhotoEdit') return править(новоеФото || правка?.photo_url);
            if (b.id === 'fPhotoPrev') {
                if (новоеФото || правка?.photo_url) return править(новоеФото || правка.photo_url);
                return $('#fPhoto').click();
            }
        });
        // выбрали снимок — сразу в редактор: повернуть и обрезать удобнее до сохранения
        $('#fPhoto').addEventListener('change', async ev => {
            const файл = ev.target.files?.[0];
            ev.target.value = '';            // тот же файл можно выбрать ещё раз
            if (файл) await править(файл);
        });
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисовать(); });
        $('#catFilter').addEventListener('change', ev => { фильтр.кат = ev.target.value; рисовать(); });
        $('#onlyLow').addEventListener('change', ev => { фильтр.мало = ev.target.checked; рисовать(); });
    }

    async function init() {
        слушать();
        if (await загрузить()) рисовать();
    }

    return { init };
})();
