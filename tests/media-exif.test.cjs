// Разбор метки в JPEG: поворот и время съёмки.
//
// Это место, где ошибка не видна в коде, но видна на стене: половина снимков
// с телефона ляжет набок, а набор выстроится в случайном порядке. Поэтому
// собираем настоящий JPEG-заголовок и проверяем разбор на нём.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const исходник = fs.readFileSync(path.join(__dirname, '..', 'js', 'media.js'), 'utf8');

/** Собирает JPEG c блоком Exif: поворот и, если задано, время съёмки. */
function сделатьJPEG({ поворот = 1, снято = null, младшийПервым = true } = {}) {
    const полей = снято ? 2 : 1;
    const размерIFD0 = 2 + полей * 12 + 4;
    const exifIFD = снято ? Buffer.alloc(2 + 1 * 12 + 4) : Buffer.alloc(0);
    const строка = снято ? Buffer.from(снято + '\0', 'ascii') : Buffer.alloc(0);

    const tiff = Buffer.alloc(8 + размерIFD0 + exifIFD.length + строка.length);
    const w16 = (buf, о, v) => младшийПервым ? buf.writeUInt16LE(v, о) : buf.writeUInt16BE(v, о);
    const w32 = (buf, о, v) => младшийПервым ? buf.writeUInt32LE(v, о) : buf.writeUInt32BE(v, о);

    w16(tiff, 0, младшийПервым ? 0x4949 : 0x4D4D);
    w16(tiff, 2, 42);
    w32(tiff, 4, 8);                       // IFD0 сразу за заголовком

    w16(tiff, 8, полей);
    // поворот: тип SHORT, и значение лежит в первых двух байтах поля значения —
    // в обоих порядках байтов, а не как целое четырёхбайтовое
    w16(tiff, 10, 0x0112); w16(tiff, 12, 3); w32(tiff, 14, 1);
    w16(tiff, 18, поворот); w16(tiff, 20, 0);
    if (снято) {
        const началоExif = 8 + размерIFD0;
        // ссылка на блок Exif
        w16(tiff, 22, 0x8769); w16(tiff, 24, 4); w32(tiff, 26, 1); w32(tiff, 30, началоExif);
        w32(tiff, 8 + 2 + полей * 12, 0);   // следующего IFD нет

        w16(tiff, началоExif, 1);
        const местоСтроки = началоExif + exifIFD.length;
        w16(tiff, началоExif + 2, 0x9003);  // снято
        w16(tiff, началоExif + 4, 2);       // ascii
        w32(tiff, началоExif + 6, строка.length);
        w32(tiff, началоExif + 10, местоСтроки);
        w32(tiff, началоExif + 2 + 12, 0);
        строка.copy(tiff, местоСтроки);
    } else {
        w32(tiff, 8 + 2 + полей * 12, 0);
    }

    const exif = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
    const app1 = Buffer.alloc(4);
    app1.writeUInt16BE(0xFFE1, 0);
    app1.writeUInt16BE(exif.length + 2, 2);

    return Buffer.concat([Buffer.from([0xFF, 0xD8]), app1, exif, Buffer.from([0xFF, 0xD9])]);
}

/** Минимальный File: модулю нужны только type, slice и arrayBuffer. */
function файлИз(буфер, type = 'image/jpeg') {
    return {
        type,
        slice: () => ({ arrayBuffer: async () => буфер.buffer.slice(
            буфер.byteOffset, буфер.byteOffset + буфер.byteLength) }),
    };
}

const песочница = vm.createContext({ document: undefined, FileReader: undefined, Image: undefined });
const Media = vm.runInContext(исходник + '\n;Media', песочница);

test('поворот читается из файла', async () => {
    for (const поворот of [1, 3, 6, 8]) {
        const м = await Media.метка(файлИз(сделатьJPEG({ поворот })));
        assert.equal(м.поворот, поворот, `поворот ${поворот}`);
    }
});

test('порядок байтов не важен', async () => {
    const м = await Media.метка(файлИз(сделатьJPEG({ поворот: 6, младшийПервым: false })));
    assert.equal(м.поворот, 6);
});

test('время съёмки приводится к пригодному для разбора виду', async () => {
    const м = await Media.метка(файлИз(сделатьJPEG({ поворот: 1, снято: '2026:03:14 04:35:12' })));
    assert.equal(м.снято, '2026-03-14T04:35:12');
    assert.equal(new Date(м.снято).getFullYear(), 2026);
});

test('файл без разметки не ломает загрузку', async () => {
    // объекты приходят из другого контекста, поэтому сравниваем поля
    const пусто = async (буфер, type) => {
        const м = await Media.метка(файлИз(буфер, type));
        assert.equal(м.поворот, 1);
        assert.equal(м.снято, null);
    };
    await пусто(Buffer.from([0xFF, 0xD8, 0xFF, 0xD9]));
    await пусто(Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), 'image/png');

    const мусор = Buffer.from([0xFF, 0xD8, 0xFF, 0xE1, 0x00, 0x08, 0x00, 0x00]);
    const м = await Media.метка(файлИз(мусор));
    assert.equal(м.поворот, 1);
});
