/**
 * Галерея: наборы снимков по темам.
 *
 * Набор держится на дате события, а не на дате загрузки: через три года
 * по тегу «Гаура-пурнима» будет десять наборов, и без года они перестанут
 * отвечать на вопрос, ради которого галерею и заводили.
 *
 * Закрытый набор («только для отдела») виден лишь пуджари: снимки процесса
 * одевания показывать всему ашраму неуместно.
 */
const WorshipGallery = (() => {
    const $ = s => document.querySelector(s);
    const e = str => Layout.escapeHtml(str ?? '');
    const можноПисать = () => !!window.hasPermission?.('worship_write');

    let наборы = [], обложки = {};
    let фильтр = { поиск: '', год: '', архив: false };

    async function загрузить() {
        const { data, error } = await Layout.db.from('worship_albums')
            .select('id, title, description, event_date, is_private, is_guide, is_archived, cover_image_id, created_by')
            .order('event_date', { ascending: false });
        if (error) { Layout.handleError(error, 'Загрузка галереи'); return false; }
        наборы = data || [];

        // обложка: выбранная руками либо первый снимок набора
        if (наборы.length) {
            const { data: снимки } = await Layout.db.from('worship_images')
                .select('id, album_id, storage_path, sort_order, shot_at')
                .in('album_id', наборы.map(н => н.id))
                .order('sort_order').order('shot_at');
            const первый = {};
            (снимки || []).forEach(с => { if (!первый[с.album_id]) первый[с.album_id] = с; });

            const пути = наборы.map(н => {
                const выбрана = (снимки || []).find(с => с.id === н.cover_image_id);
                return (выбрана || первый[н.id])?.storage_path;
            }).filter(Boolean);

            обложки = {};
            if (пути.length) {
                const { data: ссылки } = await Layout.db.storage.from('worship')
                    .createSignedUrls(пути, 3600);
                const карта = Object.fromEntries((ссылки || [])
                    .filter(з => з.signedUrl).map(з => [з.path, з.signedUrl]));
                наборы.forEach(н => {
                    const выбрана = (снимки || []).find(с => с.id === н.cover_image_id);
                    const путь = (выбрана || первый[н.id])?.storage_path;
                    if (путь && карта[путь]) обложки[н.id] = карта[путь];
                });
            }
            наборы.forEach(н => {
                н.снимков = (снимки || []).filter(с => с.album_id === н.id).length;
            });
        }
        return true;
    }

    function подходит(н) {
        if (!фильтр.архив && н.is_archived) return false;
        if (фильтр.год && String(new Date(н.event_date + 'T00:00:00').getFullYear()) !== фильтр.год) return false;
        const q = фильтр.поиск.trim().toLowerCase();
        return !q || (н.title || '').toLowerCase().includes(q)
                  || (н.description || '').toLowerCase().includes(q);
    }

    function карточка(н) {
        const обложка = обложки[н.id];
        return `
        <a href="album.html?id=${н.id}" class="card bg-base-100 shadow hover:shadow-md transition-shadow">
            <figure class="aspect-[4/3] bg-base-200 overflow-hidden">
                ${обложка
                    ? `<img src="${обложка}" alt="" loading="lazy" class="w-full h-full object-cover">`
                    : '<span class="text-sm opacity-50">пока без снимков</span>'}
            </figure>
            <div class="card-body p-4">
                <h2 class="font-semibold leading-tight">${e(н.title)}</h2>
                <div class="text-sm opacity-60">
                    ${DateUtils.formatShort(DateUtils.parseDate(н.event_date))}
                    ${н.снимков ? ' · ' + Layout.pluralize(н.снимков, {
                        ru: ['снимок', 'снимка', 'снимков'], en: ['photo', 'photos'], hi: 'चित्र' }) : ''}
                </div>
                <div class="flex flex-wrap gap-1 mt-1">
                    ${н.is_private ? '<span class="badge badge-sm badge-warning">только для отдела</span>' : ''}
                    ${н.is_guide ? '<span class="badge badge-sm badge-ghost">инструкция</span>' : ''}
                    ${н.is_archived ? '<span class="badge badge-sm">архив</span>' : ''}
                </div>
                ${н.description ? `<p class="text-sm opacity-70 mt-1">${e(н.description)}</p>` : ''}
            </div>
        </a>`;
    }

    function рисовать() {
        const видимые = наборы.filter(подходит);
        const тело = $('#list');

        if (!наборы.length) {
            тело.className = '';
            тело.innerHTML = `
                <div class="card bg-base-100 shadow"><div class="card-body items-start">
                    <h2 class="card-title text-lg">Наборов пока нет</h2>
                    <p class="text-sm opacity-70 max-w-lg">Набор — это снимки одного события:
                        как наряжали на Гаура-пурниму, как уложена ткань, как выглядел алтарь.
                        У набора обязательна дата события — по ней их потом и находят.</p>
                    ${можноПисать()
                        ? '<button class="btn btn-sm mt-2" id="newAlbumEmpty" style="background: var(--current-color); color:#fff;">Создать первый набор</button>'
                        : ''}
                </div></div>`;
            return;
        }

        тело.className = 'grid grid-cols-1 desktop:grid-cols-3 gap-4';
        тело.innerHTML = видимые.map(карточка).join('') ||
            `<div class="card bg-base-100 shadow desktop:col-span-3"><div class="card-body text-center opacity-60">${
                фильтр.поиск || фильтр.год ? 'Ничего не нашлось' : 'Наборов пока нет'}</div></div>`;
    }

    function рисоватьГоды() {
        const годы = [...new Set(наборы.map(н =>
            new Date(н.event_date + 'T00:00:00').getFullYear()))].sort((a, b) => b - a);
        $('#год').innerHTML = '<option value="">Любой год</option>' +
            годы.map(г => `<option value="${г}">${г}</option>`).join('');
    }

    async function создатьНабор() {
        const название = $('#названиеНабора').value.trim();
        const дата = $('#датаНабора').value;
        if (!название) {
            Layout.showNotification('Без названия набор не найти', 'warning');
            return $('#названиеНабора').focus();
        }
        if (!дата) {
            Layout.showNotification('Поставьте дату события — когда наряжали', 'warning');
            return $('#датаНабора').focus();
        }

        const { data, error } = await Layout.db.from('worship_albums').insert({
            title: название,
            event_date: дата,
            description: $('#описаниеНабора').value.trim() || null,
            is_private: $('#закрытыйНабор').checked,
            is_guide: $('#инструкцияНабор').checked,
            created_by: window.currentUser?.id || null,
        }).select('id').maybeSingle();
        if (error) return Layout.handleError(error, 'Создание набора');

        $('#albumModal').close();
        location.href = `album.html?id=${data.id}`;
    }

    function слушать() {
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисовать(); });
        $('#год').addEventListener('change', ev => { фильтр.год = ev.target.value; рисовать(); });
        $('#showArchive').addEventListener('change', ev => { фильтр.архив = ev.target.checked; рисовать(); });

        document.addEventListener('click', ev => {
            if (ev.target.closest('#newAlbum') || ev.target.closest('#newAlbumEmpty')) {
                $('#датаНабора').value = DateUtils.toISO(new Date());
                $('#albumModal').showModal();
                return;
            }
            if (ev.target.closest('#создатьНабор')) return создатьНабор();
        });
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисоватьГоды();
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
