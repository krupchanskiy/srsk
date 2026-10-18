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
    let фильтр = { поиск: '', архив: false };

    async function загрузить() {
        const { data, error } = await Layout.db.from('worship_albums')
            .select('id, title, description, is_private, is_guide, is_archived, cover_image_id, created_by, created_at')
            .order('title');
        if (error) { Layout.handleError(error, 'Загрузка галереи'); return false; }
        наборы = data || [];

        // обложка: выбранная руками либо первый снимок набора
        if (наборы.length) {
            // порциями: PostgREST отдаёт не больше тысячи строк за раз, и после
            // тысячного снимка у наборов пропали бы обложки и счётчик
            const { data: снимки } = await Utils.fetchAll((от, до) =>
                Layout.db.from('worship_images')
                    .select('id, album_id, storage_path, sort_order, shot_at')
                    .in('album_id', наборы.map(н => н.id))
                    .order('sort_order').order('shot_at').range(от, до));
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
        const q = фильтр.поиск.trim().toLowerCase();
        return !q || (н.title || '').toLowerCase().includes(q)
                  || (н.description || '').toLowerCase().includes(q);
    }

    function карточка(н) {
        const обложка = обложки[н.id];
        return `
        <a href="album.html?id=${н.id}" class="group block">
            <div class="aspect-[4/3] rounded-xl bg-base-300 overflow-hidden flex items-center
                        justify-center shadow-sm group-hover:shadow-md transition-shadow">
                ${обложка
                    ? `<img src="${обложка}" alt="" loading="lazy"
                           class="w-full h-full object-cover">`
                    : `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" stroke="currentColor"
                            stroke-width="1.5" class="opacity-40" aria-hidden="true">
                           <rect x="3" y="5" width="18" height="14" rx="2"></rect>
                           <circle cx="8.5" cy="10" r="1.5"></circle>
                           <path d="M21 16l-5-5-4 4-2-2-4 4"></path>
                       </svg>`}
            </div>
            <div class="px-0.5 pt-2">
                <div class="font-semibold leading-tight group-hover:text-[color:var(--current-color)]
                            transition-colors">${e(н.title)}</div>
                <div class="text-sm opacity-70 mt-0.5">
                    ${Layout.pluralize(н.снимков || 0, {
                        ru: ['снимок', 'снимка', 'снимков'], en: ['photo', 'photos'], hi: 'चित्र' })}
                    ${н.is_private ? ' · только для отдела' : ''}
                    ${н.is_guide ? ' · инструкция' : ''}
                    ${н.is_archived ? ' · архив' : ''}
                </div>
            </div>
        </a>`;
    }

    function рисовать() {
        const видимые = наборы.filter(подходит);
        const тело = $('#list');

        if (!наборы.length) {
            тело.className = '';
            тело.innerHTML = `
                <div class="bg-base-100 rounded-xl shadow-sm p-8 text-center">
                    <div class="font-semibold mb-1">Папок пока нет</div>
                    <p class="text-sm opacity-70 max-w-md mx-auto">Папка — это снимки на одну тему:
                        как наряжали на Гаура-пурниму, как уложена ткань, как выглядел алтарь.</p>
                    ${можноПисать()
                        ? '<button class="btn btn-sm mt-3" id="newAlbumEmpty" style="background: var(--current-color); color:#fff;">Создать первую папку</button>'
                        : ''}
                </div>`;
            return;
        }

        // плитки одного размера и столько в ряд, сколько влезает: при трёх
        // жёстких колонках одна папка растягивалась на весь экран
        тело.className = 'grid gap-x-4 gap-y-5';
        тело.style.gridTemplateColumns = 'repeat(auto-fill, minmax(160px, 1fr))';
        тело.innerHTML = видимые.map(карточка).join('') ||
            `<div class="bg-base-100 rounded-xl shadow-sm p-8 text-center opacity-70"
                  style="grid-column: 1 / -1;">${
                фильтр.поиск ? 'Ничего не нашлось' : 'Папок пока нет'}</div>`;
    }

    async function создатьНабор() {
        const название = $('#названиеНабора').value.trim();
        if (!название) {
            Layout.showNotification('Без названия папку не найти', 'warning');
            return $('#названиеНабора').focus();
        }

        const { data, error } = await Layout.db.from('worship_albums').insert({
            title: название,
            description: $('#описаниеНабора').value.trim() || null,
            is_private: $('#закрытыйНабор').checked,
            is_guide: $('#инструкцияНабор').checked,
            created_by: window.currentUser?.id || null,
        }).select('id').maybeSingle();
        if (error) return Layout.handleError(error, 'Создание папки');
        if (!data) return Layout.showNotification('Не сохранилось: папки заводит пуджари', 'error');

        $('#albumModal').close();
        location.href = `album.html?id=${data.id}`;
    }

    function слушать() {
        $('#q').addEventListener('input', ev => { фильтр.поиск = ev.target.value; рисовать(); });
        $('#showArchive').addEventListener('change', ev => { фильтр.архив = ev.target.checked; рисовать(); });

        document.addEventListener('click', ev => {
            if (ev.target.closest('#newAlbum') || ev.target.closest('#newAlbumEmpty')) {
                // поля сбрасываем целиком: иначе вторая папка заводится
                // с чужим названием и галками, оставшимися от закрытого окна
                $('#названиеНабора').value = '';
                $('#описаниеНабора').value = '';
                const закрытый = $('#закрытыйНабор'); if (закрытый) закрытый.checked = false;
                const инструкция = $('#инструкцияНабор'); if (инструкция) инструкция.checked = false;
                $('#albumModal').showModal();
                return;
            }
            if (ev.target.closest('#создатьНабор')) return создатьНабор();
        });
    }

    async function init() {
        слушать();
        if (!await загрузить()) return;
        рисовать();
        window.applyPermissions?.();
    }

    return { init };
})();
