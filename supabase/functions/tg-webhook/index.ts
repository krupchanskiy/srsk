// ==================== tg-webhook ====================
// Бот-департаментов:
//   • узнаёт автора по нику из карточки вайшнава (привязка создаётся сама);
//   • /start <токен> — явная привязка Telegram к профилю;
//   • бота добавили в чат → чат сам регистрируется;
//   • в чатах департаментов — увидел сумму, дозадал вопросы, записал заявку.
//
// Три вида сообщений (правила Адриана и ВГ, 24.07.2026):
//   • РАСХОД: слово-признак + сумма → списание с подотчёта департамента;
//   • ПЕРЕДАЧА: слово-признак + сумма → в ДРУГОЙ департамент, получателя
//     называют департаментом или именем ответственного, иначе спросим кнопками;
//     а если пишет казначей — это, наоборот, приход департаменту с настоящего
//     счёта, и бот спрашивает, из какой кассы или с какого счёта выдано;
//   • ПОЛУЧЕНИЕ: заявку не создаём вовсе — тегаем казначея, пусть проверит.
//     Иначе одни и те же деньги попали бы в учёт дважды.
//
// Ещё два правила:
//   • валюту спрашиваем ВСЕГДА, если она не названа явно — «1% ошибок
//     дороже, а вопрос вырабатывает привычку указывать валюту» (ВГ);
//   • «на что потрачено» обязательно, но в диалог не входит: без описания
//     заявка не заводится совсем, бот просит переписать сообщение.
//
// Карточка — мини-диалог: вид → кому → валюта → откуда → статья → «Записать».
//
// Бот НИКОГДА не пишет в ядро финмодуля — только в свои таблицы заявок.
// Проведение — только фин-админ во «Входящих».
import { createClient } from "jsr:@supabase/supabase-js@2";

// Порядок проверки важен: получение → передача → расход. «Взял» есть и в
// расходе («взял продукты»), и в получении («взял деньги у Ашиша»), поэтому
// в получении оно распознаётся только с уточнением: «взял у…», «взял деньги».
const RECEIPT_WORDS =
  /получ|принял|при[её]м касс|забрал|вн[её]с|пришл[оаи]|приход|поступил|взял[аи]?\s+(деньги|у\s)/i;
const TRANSFER_WORDS =
  /выда(л|ла|ли|ть|ю|но)|передал|передач|передать|отдал|отдать|вручил|скинул/i;
const EXPENSE_WORDS =
  /купи|купл|покуп|оплат|заплат|потрат|трат|расход|взял|заказ|закуп|приобре|отоварил|скупил|съездил за|чек|сч[её]т|затрат|издержк|убыток|услуг|продлил|зарплат|плат[её]ж/i;

const CURRENCIES: Record<string, string> = { INR: "₹", RUB: "₽", USD: "$", EUR: "€" };

// Названия валют. Границы слова через \b не годятся: в JS \w — только латиница,
// поэтому «300 руб» раньше не распознавалось как валюта вообще.
const CUR_WORDS = "[₹₽$€]|usd|eur|inr|rub|rs|руб\\p{L}*|рупи\\p{L}*|долл\\p{L}*|евро";
// Только обычный пробел как разделитель тысяч («20 000») — не \s: он матчит и
// перенос строки, из-за чего «...28/09/2026\n12000₽» склеивалось в 202612000
// (дата с новой строки + сумма). Баг ВГ 16.09.2026.
const NUM = "\\d[\\d ]{0,9}\\d|\\d";
const AMT = `(${NUM})(?:[.,](\\d{1,2}))?(?![\\d])`;
const amtValue = (int: string, frac?: string) =>
  parseFloat(int.replace(/\s/g, "") + (frac ? "." + frac : ""));

// Числа, которые описывают не деньги, а количество, вес, объём, время, дату:
// «300шт», «5 кг», «2 л», «14:30», «28/09/2026», «10%». Заменяем их пробелами
// той же длины — позиции остальных чисел не сдвигаются, поэтому «сырой» кусок
// суммы (raw) по-прежнему находится в исходном тексте (решение ВГ 21.09.2026:
// «200 стаканчики для десертов 300шт» — 300 это штуки, а не деньги).
const QTY_UNITS =
  "шт|штук\\p{L}*|кг|килограмм\\p{L}*|гр|грамм\\p{L}*|г|л|литр\\p{L}*|мл|м|см|мм|метр\\p{L}*|"
  + "упак\\p{L}*|пач\\p{L}*|банк\\p{L}*|короб\\p{L}*|бутыл\\p{L}*|мешк\\p{L}*|мешок|пар[аы]?|"
  + "компл\\p{L}*|чел\\p{L}*|person\\p{L}*|pax|дн\\p{L}*|день|раз\\p{L}*|год\\p{L}*|%|процент\\p{L}*|дюжин\\p{L}*";
function maskNonMoney(text: string): string {
  const blank = (m: string) => " ".repeat(m.length);
  return text
    // даты и время: 28/09/2026, 28.09.26, 2026-09-28, 14:30, 14:30:59
    .replace(/\d{1,2}[./]\d{1,2}[./]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}:\d{2}(?::\d{2})?/g, blank)
    // число + единица измерения/счёта (единица не должна быть началом другого слова)
    .replace(new RegExp(`(?:${NUM})(?:[.,]\\d{1,2})?[ \\t]*(?:${QTY_UNITS})(?![\\p{L}])`, "giu"), blank);
}

// «Весомые» числа-кандидаты (>=100) без десятичных долей и множителей —
// то, что вообще может быть суммой, а не количеством («5 кг») или временем
// («14:30», оба конца < 100). Используется и для эвристики «это список трат»
// (looksLikeList), и для карточки «какая из этих цифр сумма?» (needs_amount).
function bigCandidates(text: string): number[] {
  const all = [...maskNonMoney(text).matchAll(new RegExp(AMT, "gu"))]
    .map((m) => amtValue(m[1], m[2]))
    .filter((n) => Number.isFinite(n) && n >= 100);
  return [...new Set(all)];
}

// В сообщении обычно несколько чисел: «5 кг риса 340», «в 14:30 купил на 500».
// Порядок разбора — от самого надёжного признака к самому слабому:
//   1) «20к», «20 тыс» — множитель тысяч («20 кг» не считается: после «к» буква);
//   2) число рядом с названной валютой — «340 ₹»;
//   3) ровно одно «весомое» число во всём сообщении — берём его;
//   4) несколько «весомых» чисел и ни одно не привязано к валюте — не гадаем,
//      спрашиваем в карточке (решение ВГ 16.09.2026: раньше молча бралось
//      последнее число, и «...28/09/2026\n12000₽» без правки (450) могло
//      увести дату вместо суммы).
function parseMoney(rawText: string): { amount: number | null; raw: string; candidates?: number[] } | null {
  const text = maskNonMoney(rawText);
  const k = text.match(new RegExp(`${AMT}\\s*(?:к|тыс\\p{L}*)(?![\\p{L}])`, "iu"));
  if (k) {
    const n = amtValue(k[1], k[2]) * 1000;
    return n > 0 ? { amount: n, raw: k[0] } : null;
  }
  const c = text.match(new RegExp(`${AMT}\\s*(?:${CUR_WORDS})(?![\\p{L}])`, "iu"));
  if (c) {
    const n = amtValue(c[1], c[2]);
    return n > 0 ? { amount: n, raw: c[0] } : null;
  }

  const all = [...text.matchAll(new RegExp(AMT, "gu"))];
  if (!all.length) return null;

  const big = bigCandidates(text);
  if (big.length >= 2) return { amount: null, raw: "", candidates: big.slice(0, 4) };

  // Проверка «сумма положительная» — раньше стояла только в этой ветке, и
  // «купил овощи 0 ₹» доходило до заявки: там ограничение БД (amount > 0)
  // роняло вставку, и бот молча не отвечал вообще.
  // Ровно одно «весомое» число — сумма именно оно, а не последнее в тексте:
  // «Расход 720, спрей от ос, 2 шт.» брало «2» из «2 шт.» (баг 20.09.2026).
  // Если весомых нет вовсе («2 кг риса 90») — по-прежнему берём последнее.
  const m = big.length === 1
    ? all.find((x) => amtValue(x[1], x[2]) === big[0]) ?? all[all.length - 1]
    : all[all.length - 1];
  const n = amtValue(m[1], m[2]);
  return n > 0 ? { amount: n, raw: m[0] } : null;
}
// Валюта только если названа ЯВНО. Иначе null — бот спросит (решение ВГ).
function parseCurrency(text: string): string | null {
  if (/[$]|usd|долл/i.test(text)) return "USD";
  if (/[€]|eur|евро/i.test(text)) return "EUR";
  if (/[₽]|руб|rub/i.test(text)) return "RUB";
  if (/[₹]|рупи|inr|\brs\b/i.test(text)) return "INR";
  return null;
}
// Наличные или безналичные — чтобы сузить список счетов казначею.
// null — в сообщении не сказано, покажем все счета этой валюты.
function detectCash(text: string): boolean | null {
  if (/налич|кэш|\bcash\b|из кассы/i.test(text)) return true;
  if (/перевод|безнал|на карт|картой|по сч[её]ту|банк/i.test(text)) return false;
  return null;
}
// «На что» вытаскиваем из самого сообщения: убираем сумму и валюту, остальное
// и есть описание. «Купил овощи 500 рупий» → «Купил овощи». Если после чистки
// букв почти не осталось («500», «300 руб») — вернём null, и заявки не будет.
function parsePurpose(text: string, amountRaw: string): string | null {
  const s = text
    .replace(amountRaw, " ")
    .replace(new RegExp(`(?<![\\p{L}])(?:${CUR_WORDS})(?![\\p{L}])`, "giu"), " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,.;]+|[\s\-–—:,.;]+$/g, "")
    .slice(0, 200);
  return /\p{L}{3,}/u.test(s) ? s : null;
}

// Сообщения шлём с parse_mode HTML, а внутрь попадает текст людей. Без этого
// «купил 5 < 10» или «R&D» ломают разметку — Telegram отклоняет всё сообщение.
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Перечень трат одним сообщением: «За навоз 1400р, удобрения 580р, топливо 200р».
// Сумму мы берём последнюю (по-русски её обычно пишут в конце), и для такого
// перечня это неверно — в учёт уйдёт 200 вместо 2180. Угадывать итог нельзя:
// «5 кг риса 340» — тоже два числа, но сумма одна. Поэтому не меняем выбор, а
// честно предупреждаем в карточке, чтобы человек проверил до подтверждения.
// Найдено при сквозной проверке 29.07.2026 на реальном сообщении из чата.
function looksLikeList(rawText: string): boolean {
  const text = maskNonMoney(rawText);
  // NUM содержит альтернативу, поэтому его обязательно брать в группу: иначе `|`
  // разрывает весь шаблон и в счёт попадают числа вообще, включая «14:30».
  const withCurrency = [...text.matchAll(
    new RegExp(`(?:${NUM})(?:[.,]\\d{1,2})?\\s*(?:${CUR_WORDS})(?![\\p{L}])`, "giu"))].length;
  if (withCurrency > 1) return true;
  // Либо три и более «денежных» числа: мелочь вроде «5 кг» и время «14:30» не считаются
  const bigNumbers = [...text.matchAll(new RegExp(`(?<![\\d:.,])(?:${NUM})(?![\\d:.,])`, "gu"))]
    .map((m) => parseFloat(m[0].replace(/\s/g, "")))
    .filter((n) => Number.isFinite(n) && n >= 100);
  return bigNumbers.length >= 3;
}

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data: secret } = await supa.rpc("tg_webhook_secret");
  if (!secret || req.headers.get("x-telegram-bot-api-secret-token") !== secret) {
    return new Response("forbidden", { status: 403 });
  }
  let update: any;
  try { update = await req.json(); } catch { return new Response("ok"); }

  const { data: token } = await supa.rpc("tg_bot_token");
  // Если сообщение пришло из темы, отвечаем в неё же: иначе ответ бота падает
  // в общий раздел чата и разговор рвётся пополам.
  let replyThread: number | undefined;
  const tg = (method: string, body: any) => {
    if (method === "sendMessage" && replyThread !== undefined && body?.message_thread_id === undefined) {
      body = { ...body, message_thread_id: replyThread };
    }
    return fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);
  };

  async function treasurer() {
    const { data } = await supa.rpc("tg_treasurer");
    return Array.isArray(data) ? data[0] : data;
  }

  // Карточка-диалог: показывает, что уже понято, и спрашивает недостающее
  async function renderCard(chatId: number, messageId: number | null, draftId: string, st: any, replyTo?: number): Promise<void> {
    const sym = st.currency ? CURRENCIES[st.currency] ?? st.currency : "";
    // Строка «что уже известно» растёт по ходу диалога, чтобы человек видел,
    // что именно он подтверждает. Сумма ещё не выбрана (needs_amount) — её
    // просто нет в строке, а не "null".
    const known = [
      st.amount != null ? `${st.amount}${sym ? " " + sym : ""}` : null,
      st.category ? esc(st.category) : null,
      st.source_account ? `откуда: ${esc(st.source_account)}` : null,
    ].filter(Boolean).join(" · ");
    const amountLine = `${known}\n<i>${esc(st.raw_text)}</i>`;
    let head: string;
    let keyboard: any[][];
    // Подсказка «как писать в следующий раз, чтобы я не переспрашивал» —
    // только там, где есть конкретный рецепт (просьба ВГ 16.09.2026).
    let hint: string | null = null;
    const rows = (btns: any[]) => {
      const out: any[][] = [];
      for (let i = 0; i < btns.length; i += 2) out.push(btns.slice(i, i + 2));
      return out;
    };

    if (st.needs_amount) {
      // Несколько «весомых» чисел и ни одно не рядом с валютой — не гадаем,
      // спрашиваем. Сумма — ПЕРВЫЙ вопрос: валюта рядом с неверно угаданным
      // числом только путает (решение ВГ 16.09.2026).
      const candidates = bigCandidates(st.raw_text).slice(0, 4);
      head = `🤔 <b>Какая сумма?</b>`;
      hint = "💡 В следующий раз пишите сумму рядом со значком или словом валюты (12000₹ или 12000 рублей) — так я не перепутаю её с датой или другим числом.";
      keyboard = rows(candidates.map((n) => ({
        text: n.toLocaleString("ru-RU"),
        callback_data: `m:${n}:${draftId}`,
      })));
      keyboard.push([{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]);
    } else if (st.needs_kind) {
      head = `🤔 <b>Что это за сумма?</b>`;
      keyboard = [[
        { text: "💸 Расход", callback_data: `k:expense:${draftId}` },
        { text: "🔁 Передача", callback_data: `k:transfer:${draftId}` },
      ], [{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]];
    } else if (st.needs_target) {
      const { data: depts } = await supa.rpc("tg_list_departments", { p_exclude: null });
      head = `🔁 <b>Кому передаём?</b>`;
      keyboard = rows((depts ?? []).map((d: any) => ({ text: d.name, callback_data: `t:${d.id.slice(0, 8)}:${draftId}` })));
      keyboard.push([{ text: "✖️ Отмена", callback_data: `no:${draftId}` }]);
    } else if (st.needs_currency) {
      head = `💱 <b>В какой валюте?</b>`;
      keyboard = [[
        { text: "₹ Рупии", callback_data: `c:INR:${draftId}` },
        { text: "₽ Рубли", callback_data: `c:RUB:${draftId}` },
      ], [
        { text: "$ Доллары", callback_data: `c:USD:${draftId}` },
        { text: "€ Евро", callback_data: `c:EUR:${draftId}` },
      ], [{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]];
    } else if (st.needs_source) {
      // Казначей выдаёт с настоящего счёта. Если в сообщении сказано «наличкой»
      // или «переводом» — показываем только подходящие; если таких нет, лучше
      // показать все, чем упереться в пустой список.
      // Свой подотчёт департамента идёт первым: перевод из чата завода
      // списывается со счёта завода, а не с общей кассы (просьба ВГ 03.08.2026).
      const cash = detectCash(st.raw_text);
      const src = { p_currency: st.currency, p_department: st.department_id ?? null };
      let { data: accs } = await supa.rpc("tg_list_source_accounts", { ...src, p_cash: cash });
      if (!accs?.length && cash !== null) {
        ({ data: accs } = await supa.rpc("tg_list_source_accounts", { ...src, p_cash: null }));
      }
      // Счёт в этой валюте один — выбирать не из чего, ставим сами и показываем
      // его в карточке: подтверждение всё равно за человеком.
      if (accs?.length === 1) {
        const { data: st2 } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: { source_account_id: accs[0].id } });
        if (st2?.ok) return await renderCard(chatId, messageId, draftId, st2, replyTo);
      }
      head = accs?.length
        ? `🏦 <b>Откуда выдаём?</b>`
        : `🏦 <b>Нет активного счёта в этой валюте</b> — заведите счёт в системе.`;
      keyboard = rows((accs ?? []).map((a: any) => ({ text: a.name, callback_data: `a:${a.id.slice(0, 8)}:${draftId}` })));
      keyboard.push([{ text: "✖️ Отмена", callback_data: `no:${draftId}` }]);
    } else if (st.needs_category) {
      // Набор статей зависит от департамента чата: у кого он свой — тот и
      // видит свой, у остальных общий (просьба ВГ, 26.07.2026).
      const { data: cats } = await supa.rpc("tg_list_expense_categories", { p_chat: chatId });
      head = `🏷 <b>Какая это статья расходов?</b>`;
      keyboard = rows((cats ?? []).map((c: any) => ({ text: c.name, callback_data: `s:${c.id.slice(0, 8)}:${draftId}` })));
      keyboard.push([{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]);
    } else {
      head = st.kind === "transfer"
        ? `🔁 <b>Передать в «${esc(st.target_department)}»?</b>`
        : `💸 <b>Записать расход по «${esc(st.department)}»?</b>`;
      keyboard = [[
        { text: "✅ Записать", callback_data: `ok:${draftId}` },
        { text: "✖️ Не надо", callback_data: `no:${draftId}` },
      ]];
    }

    const body = {
      chat_id: chatId, parse_mode: "HTML",
      text: `${head}\n${amountLine}${hint ? `\n\n${hint}` : ""}`,
      reply_markup: { inline_keyboard: keyboard },
    };
    if (messageId) {
      await tg("editMessageText", { ...body, message_id: messageId });
    } else {
      // Запоминаем карточку сразу: раньше её id сохранялся только при нажатии
      // кнопки, и у «молчаливых» заявок — тех самых, кому потом идут напоминания —
      // ссылки на кнопки не было (замечание Адриана, 30.07.2026).
      const sent = await tg("sendMessage", { ...body, reply_to_message_id: replyTo });
      const cardId = sent?.result?.message_id;
      if (cardId) await supa.rpc("tg_set_card_message", { p_id: draftId, p_message_id: cardId });
    }
  }

  // ---------- бота добавили/убрали из чата ----------
  if (update.my_chat_member) {
    const cm = update.my_chat_member;
    await supa.rpc("tg_note_chat", {
      p: {
        chat_id: cm.chat?.id ?? null, title: cm.chat?.title ?? null,
        chat_type: cm.chat?.type ?? null, bot_status: cm.new_chat_member?.status ?? null,
        is_forum: cm.chat?.is_forum ?? false,
      },
    });
    return new Response("ok");
  }

  // ---------- нажатия на карточке ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const parts = (cq.data || "").split(":");
    const action = parts[0];
    const msg = cq.message;

    if (action === "no") {
      await supa.rpc("tg_set_draft_status", { p_id: parts[1], p_status: "dismissed", p_card_message_id: msg?.message_id });
      // Карточка своё отработала — статус и так виден по реакции на исходном
      // сообщении (см. ветку ok ниже), а сама карточка после решения только
      // занимает место (замечание ВГ 16.09.2026). Бот админ во всех чатах —
      // удаление всегда доступно.
      await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    } else if (action === "ack") {
      // «Понял» под предупреждением «не нашёл сумму» — убираем его из чата
      await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    } else if (action === "ok") {
      const { data } = await supa.rpc("tg_set_draft_status", { p_id: parts[1], p_status: "pending", p_card_message_id: msg?.message_id });
      const row = Array.isArray(data) ? data[0] : data;
      if (row) await tg("setMessageReaction", { chat_id: row.chat_id, message_id: row.source_message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
      await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
    } else if (action === "k" || action === "c" || action === "t" || action === "s" || action === "a" || action === "m") {
      const value = parts[1];
      const draftId = parts[2];
      const patch: Record<string, string> = {};
      if (action === "k") patch.kind = value;
      if (action === "c") patch.currency = value;
      if (action === "m") patch.amount = value;
      if (action === "t") {
        const { data: depts } = await supa.rpc("tg_list_departments", { p_exclude: null });
        const found = (depts ?? []).find((d: any) => d.id.startsWith(value));
        if (found) patch.target_department_id = found.id;
      }
      if (action === "s") {
        const { data: cats } = await supa.rpc("tg_list_expense_categories", { p_chat: msg.chat.id });
        const found = (cats ?? []).find((c: any) => c.id.startsWith(value));
        if (found) patch.category_id = found.id;
      }
      if (action === "a") {
        const { data: st0 } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: {} });
        // тот же список, что показывали кнопками, — иначе выбранный счёт не найдётся
        const { data: accs } = await supa.rpc("tg_list_source_accounts", {
          p_currency: st0?.currency, p_cash: null, p_department: st0?.department_id ?? null });
        const found = (accs ?? []).find((a: any) => a.id.startsWith(value));
        if (found) patch.source_account_id = found.id;
      }
      const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: patch });
      if (st?.ok) await renderCard(msg.chat.id, msg.message_id, draftId, st);
    } else if (action === "hy" || action === "hn") {
      // Передача между держателями: подтвердить может только получатель —
      // по его Telegram-id, а не по имени в тексте. Карточка видна всем в чате,
      // но кнопка срабатывает только для адресата.
      const { data } = await supa.rpc("tg_handoff_confirm", {
        p_id: parts[1], p_tg_user: cq.from.id, p_accept: action === "hy",
      });
      if (data?.ok) {
        await tg("deleteMessage", { chat_id: msg.chat.id, message_id: msg.message_id });
      } else if (data?.error === "not_recipient") {
        await tg("answerCallbackQuery", {
          callback_query_id: cq.id, show_alert: true,
          text: `Подтвердить может только ${data.recipient_name ?? "получатель"}.`,
        });
        return new Response("ok");
      }
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  const m = update.message ?? update.edited_message;
  const text: string | undefined = m?.text ?? m?.caption;
  // from нет у сообщений «от имени группы» и у автопересылок из канала —
  // автора там установить не выйдет, а без автора заявка бессмысленна.
  if (!m || !text || !m.from) return new Response("ok");
  replyThread = m.message_thread_id;

  // Правка сообщения, по которому заявка уже создана. Дубля не будет и так
  // (уникальный индекс по chat_id+source_message_id), но раньше бот просто
  // молчал — человек был уверен, что заявка обновилась. Правило ВГ: принятое
  // сообщение не правим и не удаляем, ошибку исправляет фин-администратор при
  // проведении, при необходимости минусует и вносит заново.
  if (update.edited_message && !update.message) {
    const { data: prev } = await supa.rpc("tg_draft_for_message", {
      p_chat: m.chat.id, p_message_id: m.message_id,
    });
    const draft = Array.isArray(prev) ? prev[0] : prev;
    if (draft) {
      await tg("sendMessage", {
        chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: "⚠️ Это сообщение я уже принял в работу — правка на заявку не влияет.\n"
            + "Если в сумме или в описании ошибка, напишите Ванамали Гопалу, что и на что поправить: "
            + "он исправит при проведении либо проведёт заново.",
      });
      return new Response("ok");
    }
    // заявки не было (например, дописали сумму к старому сообщению) —
    // обрабатываем правку как обычное сообщение
  }

  if (m.chat?.type !== "private") {
    // bot_status НЕ передаём: из обычного сообщения он неизвестен, а раньше
    // «member» затирал настоящий «administrator». Статус — только из my_chat_member.
    await supa.rpc("tg_note_chat", {
      p: { chat_id: m.chat.id, title: m.chat.title ?? null, chat_type: m.chat.type,
           bot_status: null, is_forum: m.chat.is_forum ?? false },
    });
  }

  // ---------- /start <токен> — привязка ----------
  if (text.startsWith("/start")) {
    const parts = text.split(/\s+/);
    if (parts.length > 1 && parts[1]) {
      const { data } = await supa.rpc("tg_use_link_token", { p_token: parts[1], p_tg_user: m.from.id, p_username: m.from.username ?? null });
      if (data?.ok) {
        await tg("sendMessage", { chat_id: m.chat.id, text: `✅ Telegram привязан к профилю: ${data.name}. Теперь могу записывать расходы от вашего имени.` });
      } else {
        const why = data?.error === "expired" ? "ссылка устарела" : data?.error === "used" ? "ссылка уже использована" : "ссылка неверная";
        await tg("sendMessage", { chat_id: m.chat.id, text: `⚠️ Не получилось привязать: ${why}. Откройте профиль на in.rupaseva.com и нажмите «Привязать Telegram» ещё раз.` });
      }
    } else {
      // Без токена — пробуем узнать по нику из профиля, чтобы не гонять
      // человека за ссылкой, если он и так уже прописан в системе.
      const { data: rows } = await supa.rpc("tg_resolve_user", {
        p_user: m.from.id, p_username: m.from.username ?? null,
      });
      const who = Array.isArray(rows) ? rows[0] : rows;
      await tg("sendMessage", {
        chat_id: m.chat.id,
        text: who
          ? `✅ Вы уже привязаны: ${who.person_name}. Пишите траты в чат своего департамента — я оформлю заявку.`
          : "Здравствуйте! Чтобы привязать Telegram, откройте свой профиль на in.rupaseva.com и нажмите «Привязать Telegram».",
      });
    }
    return new Response("ok");
  }

  // ---------- /тема — привязать тему чата ----------
  // У темы в Telegram нет имени в API, только номер, и узнать его можно лишь
  // из сообщения, написанного прямо в ней. Поэтому привязка — командой.
  // \b здесь не годится: в JS граница слова считается по латинице, и после
  // кириллического «тема» она не срабатывает — команда молча не распознавалась.
  if (/^\/(тема|topic)(\s|$)/i.test(text)) {
    const arg = text.replace(/^\/\S+\s*/, "").trim().toLowerCase();
    const kind = /финанс|счёт|счет|деньг|трат/.test(arg) ? "finance"
               : /ресепшен|ресепшн|оповещ|информ|заезд/.test(arg) ? "notify"
               : null;
    if (!kind) {
      await tg("sendMessage", {
        chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: "Напишите, какая это тема:\n/тема финансы — сюда пойдут траты и выдачи\n/тема ресепшен — сюда заезды, отъезды и долги",
      });
      return new Response("ok");
    }
    const { data } = await supa.rpc("tg_set_topic", {
      p_chat: m.chat.id, p_thread: m.message_thread_id ?? null, p_kind: kind,
    });
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
      text: data?.ok
        ? `✅ Запомнил: сюда буду писать ${kind === "finance" ? "про деньги" : "оповещения ресепшена"} для «${esc(data.department)}».`
        : `⚠️ ${esc(data?.error ?? "не получилось")}`,
    });
    return new Response("ok");
  }

  // ---------- /продолжить — вернуться к незавершённой заявке ----------
  // Вопрос ВГ: у заявки нет срока годности, но бот раньше просил прислать
  // трату заново, если не помнил, где карточка. Человек уже всё написал —
  // достаём заявку сами и присылаем свежую карточку.
  if (/^\/(продолжить|continue)(\s|$)/i.test(text)) {
    const { data: draftId } = await supa.rpc("tg_my_unfinished_draft", {
      p_chat: m.chat.id, p_tg_user: m.from.id,
    });
    if (!draftId) {
      await tg("sendMessage", {
        chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: "Незавершённых заявок за вами нет — всё в порядке.",
      });
      return new Response("ok");
    }
    const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: {} });
    if (st?.ok) await renderCard(m.chat.id, null, draftId, st, m.message_id);
    return new Response("ok");
  }

  // Разбор даты в команде: «завтра», «5.08», «5.08.2026», «2026-08-05».
  // Без аргумента — сегодня.
  const askedDate = (arg: string): string => {
    const today = new Date();
    const date = new Date(today);
    if (/послезавтра/.test(arg)) date.setDate(date.getDate() + 2);
    else if (/завтра/.test(arg)) date.setDate(date.getDate() + 1);
    else if (/вчера/.test(arg)) date.setDate(date.getDate() - 1);
    else if (arg) {
      const iso = arg.match(/(\d{4})-(\d{2})-(\d{2})/);
      const dot = arg.match(/(\d{1,2})[.\/](\d{1,2})(?:[.\/](\d{2,4}))?/);
      if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
      if (dot) {
        const y = dot[3] ? (dot[3].length === 2 ? 2000 + +dot[3] : +dot[3]) : today.getFullYear();
        date.setFullYear(y, +dot[2] - 1, +dot[1]);
      }
    }
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  };

  // ---------- /сколько — питающиеся на дату (ТЗ, п. 6) ----------
  // Считает та же функция, что и меню на сайте, — расхождения быть не может.
  if (/^\/(сколько|вкушающие|питание|eaters)(\s|$)/i.test(text)) {
    const iso = askedDate(text.replace(/^\/\S+\s*/, "").trim().toLowerCase());
    const { data: txt } = await supa.rpc("tg_eating_text", { p_date: iso });
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
      text: txt ?? "На эту дату данных нет. Напишите «/сколько завтра» или «/сколько 5.08».",
    });
    return new Response("ok");
  }

  // ---------- /приезд и /выезд — списки ресепшена (ТЗ, п. 7) ----------
  if (/^\/(приезд|заезд|выезд|отъезд|arrivals|departures)(\s|$)/i.test(text)) {
    const dir = /выезд|отъезд|departures/i.test(text) ? "out" : "in";
    const iso = askedDate(text.replace(/^\/\S+\s*/, "").trim().toLowerCase());
    const { data: txt } = await supa.rpc("tg_arrivals_text", { p_date: iso, p_direction: dir });
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
      text: txt ?? "Не получилось собрать список.",
    });
    return new Response("ok");
  }

  // ---------- /balance — остаток департамента (запрос ВГ, 25.07.2026) ----------
  // Пишут по-русски, поэтому кроме латинской команды (её понимает меню
  // Telegram) принимаем «/баланс» и «/остаток».
  if (/^\/(balance|баланс|остаток)/i.test(text)) {
    const { data: rows } = await supa.rpc("tg_department_balance", { p_chat: m.chat.id });
    // У департамента счёт в каждой валюте — раньше брали только первый и
    // прятали остальные: у «Кафе» показывались 0 ₹ при 13 022 ₽ на руках (ВГ, 12.08).
    const счета = (Array.isArray(rows) ? rows : rows ? [rows] : [])
      .sort((a, b) =>
        (a.currency_code === "INR" ? -1 : b.currency_code === "INR" ? 1 : 0)
        || String(a.currency_code).localeCompare(String(b.currency_code)));
    const первый = счета[0];
    let текст: string;
    if (!первый) {
      текст = "Этот чат не привязан к департаменту, поэтому остаток показать не могу.";
    } else {
      // holders_line уже экранирован в SQL (tg_escape по каждому имени) — re-esc не нужен.
      текст = счета.length === 1
        ? `💰 <b>${esc(первый.department_name)}: ${esc(первый.formatted)}</b>`
          + (первый.holders_line ? `\n${первый.holders_line}` : "")
        : `💰 <b>${esc(первый.department_name)}</b>\n`
          + счета.map((s) => `• <b>${esc(s.formatted)}</b>` + (s.holders_line ? `\n${s.holders_line}` : "")).join("\n");
      if (первый.pending_drafts > 0) {
        текст += `\nЖдут проведения: ${первый.pending_drafts} — остаток изменится, когда их проведут.`;
      }
    }
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML", text: текст,
    });
    return new Response("ok");
  }

  // ---------- суммы в чатах департаментов ----------
  const { data: chatRows } = await supa.rpc("tg_resolve_chat", { p_chat: m.chat.id });
  const chat = Array.isArray(chatRows) ? chatRows[0] : chatRows;
  if (!chat) return new Response("ok");

  const money = parseMoney(text);
  if (!money) {
    // Похоже на трату, но суммы нет (забыли написать либо было только количество
    // вроде «300шт») — молчать нельзя: человек будет думать, что заявка принята
    // (решение ВГ 21.09.2026). Только в финансовой теме и только со словом-признаком
    // траты/выдачи, иначе бот отвечал бы на любую переписку. Предупреждение
    // убирается кнопкой «Понял», чтобы не копиться в чате.
    if (!m.from.is_bot && (EXPENSE_WORDS.test(text) || TRANSFER_WORDS.test(text)) && !RECEIPT_WORDS.test(text)) {
      const { data: guard } = await supa.rpc("tg_finance_topic_check", {
        p_chat: m.chat.id, p_thread: m.message_thread_id ?? null,
      });
      // hint = в форуме не назначена финансовая тема: это не «Счёт», не шумим
      if (guard && guard.allowed !== false && !guard.hint) {
        await tg("sendMessage", {
          chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
          text: "⚠️ <b>Не нашёл в сообщении сумму</b>, поэтому заявку не создал.\n"
              + "Напишите трату <b>новым сообщением</b> — с описанием и суммой, например: «Купил овощи 500 ₹». "
              + "Это сообщение править не нужно.\n"
              + "Количество (шт, кг, л), даты и время я за сумму не считаю.",
          reply_markup: { inline_keyboard: [[{ text: "✅ Понял", callback_data: "ack" }]] },
        });
        // Метка на самом сообщении переживёт удаление предупреждения: в чате видно,
        // что заявка НЕ создана. Не 👎 — он у нас значит «отклонено/отменено», а тут
        // ничего не принималось. Telegram даёт ботам только фиксированный набор реакций.
        await tg("setMessageReaction", {
          chat_id: m.chat.id, message_id: m.message_id,
          reaction: [{ type: "emoji", emoji: "🤔" }],
        });
      }
    }
    return new Response("ok");
  }

  // Правило ВГ (30.07.2026): одна трата — одно сообщение. Перечень сумм в одном
  // сообщении заявкой не становится вовсе: складывать за человека нельзя («5 кг
  // риса 340» — тоже два числа, а сумма одна), а брать последнюю неверно — так
  // «навоз 1400р, удобрения 580р, топливо 200р» уходило в учёт как 200.
  if (looksLikeList(text)) {
    // Уточнение ВГ 24.09.2026: предупреждение приходило на любой текст с числами, даже в общем
    // чате переписки (приветствие с «1000», «300»). Теперь — только в финансовой теме «Счёт»,
    // с кнопкой «Понял» и самоудалением через 5 минут; в остальных темах бот молчит.
    const { data: gl } = await supa.rpc("tg_finance_topic_check", {
      p_chat: m.chat.id, p_thread: m.message_thread_id ?? null,
    });
    if (gl && gl.allowed !== false && !gl.hint) {
      const sent = await tg("sendMessage", {
        chat_id: m.chat.id, reply_to_message_id: m.message_id,
        text: "⚠️ Вижу в сообщении несколько сумм — такую заявку я не завожу, чтобы"
            + " не записать не ту сумму.\nПришлите каждую трату отдельным сообщением:"
            + " «Навоз 1400 ₹», «Удобрения 580 ₹», «Топливо 200 ₹».",
        reply_markup: { inline_keyboard: [[{ text: "✅ Понял, перепишу", callback_data: "ack" }]] },
      });
      const warnId = sent?.result?.message_id;
      if (warnId) await supa.rpc("tg_schedule_delete", { p_chat: m.chat.id, p_message: warnId, p_delay_seconds: 300 });
    }
    return new Response("ok");
  }

  // ---------- получение: не проводим, тегаем казначея ----------
  // Так пишет тот, КОМУ передали. Передачу заявляет сторона, которая выдала;
  // если реагировать на обе, одни и те же деньги попадут в учёт дважды.
  if (RECEIPT_WORDS.test(text)) {
    const tre = await treasurer();
    const tag = tre?.username ? `@${tre.username}` : "Казначей";
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id,
      text: `${tag} — здесь про получение денег. Заявку не создаю: передачу записывает тот, кто выдал. Проверьте, пожалуйста.`,
    });
    return new Response("ok");
  }

  // Узнаём автора: по явной привязке, а если её нет — по нику из профиля
  // (тогда привязка создаётся сама, и человек об этом узнаёт один раз).
  const { data: userRows } = await supa.rpc("tg_resolve_user", {
    p_user: m.from.id, p_username: m.from.username ?? null,
  });
  const user = Array.isArray(userRows) ? userRows[0] : userRows;
  if (!user) {
    const uname = m.from.username ? `@${m.from.username}` : null;
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
      text: uname
        ? `Не нахожу вас в системе: в профилях нет ника <b>${esc(uname)}</b> (или он указан у двоих).\nОткройте свой профиль на in.rupaseva.com → впишите ${esc(uname)} в поле Telegram либо нажмите «Привязать Telegram».`
        : "У вашего Telegram нет ника, поэтому не могу вас узнать. Откройте свой профиль на in.rupaseva.com и нажмите «Привязать Telegram».",
    });
    return new Response("ok");
  }
  if (user.auto_linked) {
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id,
      text: `👋 Узнал вас по нику из профиля: ${user.person_name}. Записываю расходы от вашего имени.`,
    });
  }

  const tre = await treasurer();
  const isTreasurer = !!tre && user.vaishnava_id === tre.vaishnava_id;
  const currency = parseCurrency(text);

  // ---------- передача внутри департамента, между держателями (правило ВГ, 22.09.2026) ----------
  // «Передал Жене 500» в чате департамента — это НЕ передача другому
  // департаменту (та ищется через tg_match_department), а перекладывание уже
  // выданных денег между двумя держателями ОДНОГО департамента. Отличаем по
  // тому, совпадает ли названное имя с зарегистрированным держателем именно
  // этого департамента. Казначея не проверяем: у него «выдал» значит настоящую
  // выдачу с реального счёта, это другой сценарий.
  // Проводится сразу по подтверждению получателя, без фин-админа: общий
  // остаток департамента не меняется, риска для денег нет (решение ВГ).
  if (TRANSFER_WORDS.test(text) && !isTreasurer) {
    const { data: holderId } = await supa.rpc("tg_match_department_holder", {
      p_department: chat.department_id, p_text: text, p_exclude: user.vaishnava_id,
    });
    if (holderId) {
      const { data: h } = await supa.rpc("tg_create_handoff", {
        p: { chat_id: m.chat.id, source_message_id: m.message_id, tg_user_id: m.from.id,
             amount: money.amount, currency, raw_text: text, recipient_vaishnava_id: holderId },
      });
      if (h?.ok) {
        const sym = h.currency ? (CURRENCIES[h.currency] ?? h.currency) : "";
        const sent = await tg("sendMessage", {
          chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
          text: `🤝 <b>Передача внутри «${esc(h.department_name)}»: ${money.amount}${sym ? " " + sym : ""}</b>\n`
              + `От: ${esc(h.sender_name)}\n`
              + `${esc(h.recipient_name)}, подтвердите получение`,
          reply_markup: { inline_keyboard: [[
            { text: "✅ Получил(а)", callback_data: `hy:${h.id}` },
            { text: "✖️ Не получал(а)", callback_data: `hn:${h.id}` },
          ]] },
        });
        const cardId = sent?.result?.message_id;
        if (cardId) await supa.rpc("tg_set_handoff_card", { p_id: h.id, p_message_id: cardId });
        return new Response("ok");
      }
      // валюта неоднозначна / не держатель / уже обработано — тихо продолжаем обычной веткой ниже
    }
  }

  // Вид определяем по словам; если слов нет — спросим (решение ВГ)
  let kind: string | null = null;
  let targetDept: string | null = null;
  if (TRANSFER_WORDS.test(text)) {
    kind = "transfer";
    // Департамент-получателя ищем по названию или по имени ответственного.
    // Департаменты передают ДРУГИМ, поэтому свой исключаем; у казначея это
    // приход department'у, в чьём чате он пишет, — значит не исключаем ничего
    // и при отсутствии явного упоминания берём департамент чата.
    const p_exclude = isTreasurer ? null : chat.department_id;
    const { data: tgt } = await supa.rpc("tg_match_department", { p_text: text, p_exclude });
    targetDept = tgt ?? null;
    if (!targetDept && isTreasurer) {
      // Подставляем департамент чата, только если получатель вообще не назван.
      // Названо, но неоднозначно («выдал Олегу» — у него два департамента) —
      // спрашиваем каждый раз, иначе деньги молча ушли бы не туда.
      const { data: hits } = await supa.rpc("tg_department_hits", { p_text: text, p_exclude });
      if (!hits) targetDept = chat.department_id;
    }
  } else if (EXPENSE_WORDS.test(text)) {
    kind = "expense";
  }
  // Голое число без слова-признака траты/передачи и без названной валюты —
  // скорее не отчёт о деньгах, а дата, количество или обсуждение. Раньше на
  // такое всё равно реагировали (например, ругались «не та тема»), и это
  // цепляло сообщения вроде «Зп ... 12000 Проверить» в общем чате.
  // Решение ВГ 16.09.2026: без обоих сигналов — молчим совсем.
  // Уточнение ВГ 24.09.2026 («Зеленым на корм рыбам 1500» молча игнорировалось):
  // в финансовой теме «Счёт» весомое число почти всегда про деньги — не молчим, а
  // спрашиваем карточкой «Расход / Передача / Не про деньги». Порога по сумме нет
  // («купили за 20 рупий» тоже нельзя терять); молчание — только в остальных
  // чатах и темах. Даты, время и количества («2 кг») суммой и раньше не считаются.
  if (!kind && !currency) {
    const { data: g } = await supa.rpc("tg_finance_topic_check", {
      p_chat: m.chat.id, p_thread: m.message_thread_id ?? null,
    });
    const inFinanceTopic = !!g && g.allowed !== false && !g.hint;
    if (!inFinanceTopic) return new Response("ok");
    // название департамента в тексте — заранее подставляем получателя, если выберут «Передача»
    const { data: tgt } = await supa.rpc("tg_match_department", { p_text: text, p_exclude: chat.department_id });
    targetDept = tgt ?? null;
  }

  // Нет описания — заявку не заводим вовсе. Валюту, счёт и статью можно
  // доспросить кнопками, а «на что» знает только автор: доспрашивать текстом
  // долго, и висящие полузаявки хуже, чем просьба переписать сообщение.
  // Описание — ровно то, что написал человек, без вырезания суммы и валюты
  // (просьба ВГ 20.09.2026): иначе проведённую операцию не с чем сверить.
  // parsePurpose остаётся только проверкой «в сообщении есть слова, а не одни цифры».
  if (!parsePurpose(text, money.raw)) {
    await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id,
      text: "⚠️ Не могу принять заявку: не написано, на что потрачено.\n"
          + "Напишите сумму вместе с описанием одним сообщением — например: «Купил овощи 500 ₹».",
    });
    return new Response("ok");
  }
  const purpose = text.trim().slice(0, 1000);

  // ---------- финансы принимаются только из финансовой темы (ТЗ, п. 4–5) ----------
  // Иначе трата, написанная в «Информации», молча уехала бы в учёт, а найти её
  // потом было бы нечем.
  const { data: guard } = await supa.rpc("tg_finance_topic_check", {
    p_chat: m.chat.id, p_thread: m.message_thread_id ?? null,
  });
  if (guard && guard.allowed === false) {
    const sent = await tg("sendMessage", {
      chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
      text: "⚠️ Это не финансовая тема, поэтому трату я не записал.\n"
          + `Напишите её в теме «Счёт ${esc(guard.department ?? "департамента")}» — оттуда она попадёт в учёт.`,
    });
    // Предупреждение не по адресу — не должно висеть в общем чате вечно,
    // самоудаляется через минуту (просьба ВГ 16.09.2026).
    const warnId = sent?.result?.message_id;
    if (warnId) await supa.rpc("tg_schedule_delete", { p_chat: m.chat.id, p_message: warnId, p_delay_seconds: 60 });
    return new Response("ok");
  }

  const { data: draftId } = await supa.rpc("tg_create_draft", {
    p: { chat_id: m.chat.id, source_message_id: m.message_id, tg_user_id: m.from.id,
         kind, amount: money.amount, currency,
         target_department_id: targetDept, purpose, raw_text: text },
  });
  if (!draftId) return new Response("ok");

  const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: {} });
  if (st?.ok) await renderCard(m.chat.id, null, draftId, st, m.message_id);
  return new Response("ok");
});
