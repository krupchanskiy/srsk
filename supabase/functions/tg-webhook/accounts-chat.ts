// ==================== Чат счетов ИП (мигр. 800, ВГ 18.11.2026) ====================
// Группа «ВГ + Нитья-виласини»: не департамент, а три счёта — ИП, карта ИП,
// карта «Касса кафе». Одно сообщение — одна операция, дата в начале
// («12.09 мурти большой 2 комплекта 30000») — для внесения задним числом.
//   • приход и перевод между счетами проводятся сразу от имени автора;
//   • расход уходит во «Входящие»: там ВГ проводит и связывает с ведомостью;
//   • /баланс — остатки и кнопка «Сверка»; сверку записывает только ВГ.

type Ctx = {
  supa: any;
  tg: (method: string, body: any) => Promise<any>;
  esc: (s: unknown) => string;
  parseMoney: (text: string) => { amount: number | null; raw: string; candidates?: number[] } | null;
  looksLikeList: (text: string) => boolean;
};

// Короткие коды полей в callback_data — у Телеграма лимит 64 байта
const FIELD: Record<string, string> = {
  k: "kind", a: "account", t: "target", c: "category", d: "department", s: "murti_size", n: "murti_count",
};
const CODE: Record<string, string> = Object.fromEntries(Object.entries(FIELD).map(([k, v]) => [v, k]));

const QUESTION: Record<string, string> = {
  kind: "🤔 <b>Что это?</b>",
  account: "🏦 <b>Какой счёт?</b>",
  target: "🔁 <b>Перевод. Куда — на какой счёт?</b>",
  category: "🏷 <b>Какая статья?</b>",
  department: "🏢 <b>За какой департамент?</b>",
  murti_size: "🪷 <b>Какой сет мурти?</b>",
  murti_count: "🔢 <b>Сколько сетов?</b>",
};

const MONEY_HINT = /мурти|кафе|процент|налог|билет|виз[аы]|зарплат|оплат|перев[её]л|перевод|приход|расход|поступ/i;

// Дата операции из сообщения: «12.09», «12.09.26», «12.09.2026», «28/10/2026». Без года —
// текущий; если так выходит будущее (в январе пишут про 28.12) — прошлый год.
function parseDate(text: string): { iso: string; raw: string; invalid?: boolean } | null {
  // разделитель — точка или «/» (Нитья пишет 28/10/2026), один и тот же в дате
  const m = text.match(/(?<![\d.,\/])(\d{1,2})([.\/])(\d{1,2})(?:\2(\d{2}|\d{4}))?(?![\d.,\/])/);
  if (!m) return null;
  const day = +m[1], month = +m[3];
  // похоже на дату, но такой нет (31.02, 12.13) — молча ставить «сегодня» нельзя
  if (day < 1 || day > 31 || month < 1 || month > 12) return { iso: "", raw: m[0], invalid: true };
  const now = new Date(Date.now() + 5.5 * 3600 * 1000); // Индия
  let year = m[4] ? (m[4].length === 2 ? 2000 + +m[4] : +m[4]) : now.getUTCFullYear();
  const pad = (n: number) => String(n).padStart(2, "0");
  const today = `${now.getUTCFullYear()}-${pad(now.getUTCMonth() + 1)}-${pad(now.getUTCDate())}`;
  let iso = `${year}-${pad(month)}-${pad(day)}`;
  if (!m[4] && iso > today) { year -= 1; iso = `${year}-${pad(month)}-${pad(day)}`; }
  // 31.02 и подобное — не дата
  const d = new Date(`${iso}T00:00:00Z`);
  if (d.getUTCMonth() + 1 !== month) return { iso: "", raw: m[0], invalid: true };
  return { iso, raw: m[0] };
}

function hints(text: string) {
  const h: Record<string, string | number> = {};
  if (/мурти/i.test(text)) {
    h.hint_category_code = "murti";
    if (/мал/i.test(text)) h.murti_size = "small";
    else if (/сред/i.test(text)) h.murti_size = "medium";
    else if (/больш/i.test(text)) h.murti_size = "large";
    const c = text.match(/(?<![\d.,])(\d{1,2})\s*(?:компл\p{L}*|сет\p{L}*|шт\p{L}*)|[x×х]\s*(\d{1,2})(?!\d)/iu);
    const n = c ? +(c[1] ?? c[2]) : 0;
    if (n >= 1 && n <= 99) h.murti_count = n;
  } else if (/касс\p{L}*\s+кафе|кафе\p{L}*\s+касс/iu.test(text)) {
    h.hint_category_code = "cafe_cash";
  } else if (/процент/i.test(text)) {
    h.hint_category_code = "interest_received";
  } else if (/налог/i.test(text)) {
    h.hint_category_code = "taxes";
  }
  return h;
}

// Сумма в ответе на вопрос сверки: «1 234 567,89», «1234567.89 ₽», «-500»
function parseBalance(text: string): number | null {
  const s = text.replace(/[\s  -  ₽]|руб\p{L}*|р\.?$/giu, "").replace(",", ".");
  return /^-?\d+(\.\d{1,2})?$/.test(s) ? parseFloat(s) : null;
}

export async function ipChatInfo(supa: any, chatId: number): Promise<any | null> {
  const { data } = await supa.rpc("tg_ip_chat", { p_chat: chatId });
  return data ?? null;
}

// Предупреждение как в чатах департаментов: «✅ Понял» (обработчик "ack" общий
// в index.ts) и самоудаление через 5 минут — чат остаётся чистым.
async function warn(ctx: Ctx, chatId: number, replyTo: number, text: string) {
  const sent = await ctx.tg("sendMessage", {
    chat_id: chatId, reply_to_message_id: replyTo, parse_mode: "HTML", text,
    reply_markup: { inline_keyboard: [[{ text: "✅ Понял", callback_data: "ack" }]] },
  });
  const id = sent?.result?.message_id;
  if (id) await ctx.supa.rpc("tg_schedule_delete", { p_chat: chatId, p_message: id, p_delay_seconds: 300 });
}

async function deleteOrStrip(ctx: Ctx, chatId: number, messageId: number) {
  const r = await ctx.tg("deleteMessage", { chat_id: chatId, message_id: messageId });
  if (!r?.ok) await ctx.tg("editMessageReplyMarkup", { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } });
}

// ---------- карточка черновика ----------
async function renderCard(ctx: Ctx, chatId: number, messageId: number | null, st: any, replyTo?: number) {
  const { esc, tg, supa } = ctx;
  const kindName = st.kind === "income" ? "Приход" : st.kind === "expense" ? "Расход" : st.kind === "move" ? "Перевод" : null;
  const known = [
    `<b>${esc(st.amount_fmt)}</b>`,
    `📅 ${esc(st.occurred_on)}` + (st.days_ago > 3 ? ` (${st.days_ago} дн. назад)` : ""),
    kindName,
    st.account ? (st.kind === "move" ? `${esc(st.account)} → ${st.target ? esc(st.target) : "?"}` : esc(st.account)) : null,
    st.kind === "expense" && st.department ? esc(st.department) : null,
    st.category ? esc(st.category) : null,
    st.kind === "income" && st.murti ? esc(st.murti) : null,
  ].filter(Boolean).join(" · ");

  let head: string;
  let keyboard: any[][] = [];
  if (st.needs) {
    // перевод: оба счёта выбираются явно — сначала «откуда», потом «куда»
    head = st.kind === "move" && st.needs === "account"
      ? "🔁 <b>Перевод. Откуда — с какого счёта?</b>"
      : QUESTION[st.needs] ?? "🤔";
    const btns = (st.options ?? []).map((o: any) => ({
      text: o.t, callback_data: `ip:p:${CODE[st.needs]}:${o.v}:${st.id}`,
    }));
    // вид и счета — по одной в строке (длинные названия), остальное — по две/три
    const per = st.needs === "kind" || st.needs === "account" || st.needs === "target" ? 1
      : st.needs === "murti_count" ? 3 : 2;
    for (let i = 0; i < btns.length; i += per) keyboard.push(btns.slice(i, i + per));
    keyboard.push([{ text: "✖️ Отмена", callback_data: `ip:no:${st.id}` }]);
  } else {
    head = st.kind === "expense"
      ? "📨 <b>Отправить расход во «Входящие»?</b>"
      : st.kind === "move" ? "🔁 <b>Провести перевод?</b>" : "📥 <b>Провести приход?</b>";
    keyboard = [[
      { text: st.kind === "expense" ? "✅ Отправить" : "✅ Записать", callback_data: `ip:ok:${st.id}` },
      { text: "✖️ Отмена", callback_data: `ip:no:${st.id}` },
    ]];
  }
  const body = {
    chat_id: chatId, parse_mode: "HTML",
    text: `${head}\n${known}\n<i>${esc(st.raw_text)}</i>`,
    reply_markup: { inline_keyboard: keyboard },
  };
  if (messageId) {
    await tg("editMessageText", { ...body, message_id: messageId });
  } else {
    const sent = await tg("sendMessage", { ...body, reply_to_message_id: replyTo });
    const cardId = sent?.result?.message_id;
    if (cardId) await supa.rpc("tg_ip_set_card", { p_id: st.id, p_message_id: cardId });
  }
}

// ---------- сверка ----------
async function sendReconPrompt(ctx: Ctx, chatId: number, next: any) {
  const sent = await ctx.tg("sendMessage", {
    chat_id: chatId, parse_mode: "HTML",
    text: `🧮 Сверка ${next.step}/${next.total}. Остаток <b>по банку</b> на счёте <b>${ctx.esc(next.account)}</b>?\n`
        + "Ответьте на это сообщение числом, например: 1 234 567,89",
    reply_markup: { force_reply: true, selective: false, input_field_placeholder: "Остаток по банку, ₽" },
  });
  const id = sent?.result?.message_id;
  if (id) await ctx.supa.rpc("tg_ip_recon_set_prompt", { p_recon: next.recon_id, p_account: next.account_id, p_message_id: id });
}

function reconKeyboard(s: any) {
  const rows: any[][] = [];
  if (s.all_zero) rows.push([{ text: "✅ Одобряю сверку", callback_data: `ip:ra:${s.recon_id}` }]);
  rows.push([
    { text: "🔄 Пересчитать", callback_data: `ip:rr:${s.recon_id}` },
    { text: "📋 Операции", callback_data: `ip:ro:${s.recon_id}` },
  ]);
  rows.push([{ text: "✖️ Отменить сверку", callback_data: `ip:rx:${s.recon_id}` }]);
  return { inline_keyboard: rows };
}

async function sendReconSummary(ctx: Ctx, chatId: number, reconId: string, messageId?: number) {
  const { data: s } = await ctx.supa.rpc("tg_ip_recon_summary", { p_recon: reconId });
  if (!s?.ok) return;
  const body = { chat_id: chatId, parse_mode: "HTML", text: s.text, reply_markup: reconKeyboard(s) };
  if (messageId) {
    await ctx.tg("editMessageText", { ...body, message_id: messageId });
  } else {
    const sent = await ctx.tg("sendMessage", body);
    const id = sent?.result?.message_id;
    if (id) await ctx.supa.rpc("tg_ip_recon_set_card", { p_recon: reconId, p_message_id: id });
  }
}

async function startRecon(ctx: Ctx, chatId: number, tgUser: number): Promise<string | null> {
  const { data } = await ctx.supa.rpc("tg_ip_recon_start", { p_chat: chatId, p_tg_user: tgUser });
  if (!data?.ok) return data?.error === "not_admin" ? "Сверку ведёт администратор финансов." : "Не получилось начать сверку.";
  await sendReconPrompt(ctx, chatId, data);
  return null;
}

// ---------- сообщения ----------
export async function ipHandleMessage(ctx: Ctx, update: any, m: any, text: string): Promise<void> {
  const { supa, tg, esc } = ctx;
  // Правки не трогаем: принятое сообщение не правится (правило ВГ), а Телеграм
  // присылает «правку» и на реакцию бота.
  if (update.edited_message && !update.message) return;
  if (m.from.is_bot) return;
  const chatId = m.chat.id;

  // ответ на вопрос сверки
  const replyTo = m.reply_to_message?.message_id;
  if (replyTo && m.reply_to_message?.from?.is_bot) {
    const amount = parseBalance(text);
    if (amount !== null) {
      const { data: next } = await supa.rpc("tg_ip_recon_answer", {
        p_chat: chatId, p_reply_to: replyTo, p_tg_user: m.from.id, p_amount: amount,
      });
      if (next) {
        if (!next.ok) return;
        // вопрос своё отработал — убираем, на ответе 👍 (число видно в сводке)
        await deleteOrStrip(ctx, chatId, replyTo);
        await tg("setMessageReaction", { chat_id: chatId, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👍" }] });
        if (next.done) await sendReconSummary(ctx, chatId, next.recon_id);
        else await sendReconPrompt(ctx, chatId, next);
        return;
      }
    }
  }

  if (/^\/(balance|баланс|остаток)/i.test(text)) {
    const { data: txt } = await supa.rpc("tg_ip_balances_text", { p_chat: chatId });
    await tg("sendMessage", {
      chat_id: chatId, reply_to_message_id: m.message_id, parse_mode: "HTML", text: txt ?? "—",
      reply_markup: { inline_keyboard: [[{ text: "🧮 Сверка с банком", callback_data: "ip:rs" }]] },
    });
    return;
  }
  if (/^\/(сверка|recon)/i.test(text)) {
    const err = await startRecon(ctx, chatId, m.from.id);
    if (err) await warn(ctx, chatId, m.message_id, esc(err));
    return;
  }
  if (text.startsWith("/")) return;

  // операция: дата (если есть) не должна читаться как сумма
  const date = parseDate(text);
  if (date?.invalid) {
    if (ctx.parseMoney(text)) {
      await warn(ctx, chatId, m.message_id,
        `⚠️ Даты «${esc(date.raw)}» не бывает — операцию не завёл. Напишите сообщение заново с правильной датой.`);
      await tg("setMessageReaction", { chat_id: chatId, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "🤔" }] });
    }
    return;
  }
  // дата и «×3»/«2 сета» у мурти — не сумма: иначе «×3 69000» читалось как 369000
  const forMoney = (date ? text.replace(date.raw, " ") : text)
    .replace(/[x×х]\s*\d{1,2}(?!\d)/giu, " ")
    .replace(/(?<![\d.,])\d{1,2}\s*сет\p{L}*/giu, " ");
  const money = ctx.parseMoney(forMoney);
  if (!money || ctx.looksLikeList(forMoney) || money.amount === null) {
    if (MONEY_HINT.test(text) || money) {
      await warn(ctx, chatId, m.message_id,
        money?.amount === null || (money && ctx.looksLikeList(forMoney))
          ? "⚠️ Вижу несколько чисел и не понимаю, какое из них сумма. Напишите одну операцию одним сообщением, сумму — со знаком ₽: «12.09 мурти большой 2 комплекта 30000 ₽»."
          : "⚠️ Не нашёл сумму, операцию не завёл. Пример: «12.09 мурти большой 2 комплекта 30000 ₽».");
      await tg("setMessageReaction", { chat_id: chatId, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "🤔" }] });
    }
    return;
  }

  const { data: st } = await supa.rpc("tg_ip_create_draft", {
    p: {
      chat_id: chatId, tg_user_id: m.from.id, source_message_id: m.message_id,
      amount: money.amount, occurred_on: date?.iso ?? null, raw_text: text.trim().slice(0, 1000),
      ...hints(text),
    },
  });
  if (!st?.ok) {
    const msg: Record<string, string> = {
      not_admin: "Операции в этом чате записывает администратор финансов — вас я не нахожу среди них.",
      future_date: `Дата ${esc(st?.date)} ещё не наступила — проверьте дату в начале сообщения.`,
      too_old: `Дата ${esc(st?.date)} старше года — проверьте дату в начале сообщения.`,
      duplicate: "Такую же операцию от вас я уже принял несколько минут назад — вторую не завожу. Если это правда вторая, допишите отличие и отправьте снова.",
    };
    if (msg[st?.error]) {
      await warn(ctx, chatId, m.message_id, `⚠️ ${msg[st.error]}`);
      await tg("setMessageReaction", { chat_id: chatId, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "🤔" }] });
    }
    return;
  }
  await renderCard(ctx, chatId, null, st, m.message_id);
}

// ---------- кнопки ----------
export async function ipHandleCallback(ctx: Ctx, cq: any, parts: string[]): Promise<void> {
  const { supa, tg } = ctx;
  const msg = cq.message;
  const chatId = msg?.chat?.id;
  const action = parts[1];
  const alert = (text: string) => tg("answerCallbackQuery", { callback_query_id: cq.id, show_alert: true, text });
  const drop = async () => {
    const r = await tg("deleteMessage", { chat_id: chatId, message_id: msg.message_id });
    if (!r?.ok) await tg("editMessageReplyMarkup", { chat_id: chatId, message_id: msg.message_id, reply_markup: { inline_keyboard: [] } });
  };

  if (action === "p") {
    const field = FIELD[parts[2]];
    const { data: st } = await supa.rpc("tg_ip_pick", { p_id: parts[4], p_field: field, p_value: parts[3] });
    if (st?.ok) await renderCard(ctx, chatId, msg.message_id, st);
    else if (st?.error === "closed") await drop();
  } else if (action === "no") {
    await supa.rpc("tg_ip_dismiss", { p_id: parts[2] });
    await drop();
  } else if (action === "ok") {
    const { data } = await supa.rpc("tg_ip_confirm", { p_id: parts[2], p_tg_user: cq.from.id });
    if (data?.ok) {
      // карточка превращается в итог: видно, что и куда записано, и остатки
      await tg("editMessageText", {
        chat_id: chatId, message_id: msg.message_id, parse_mode: "HTML", text: data.text,
        reply_markup: { inline_keyboard: [] },
      });
    } else if (data?.error === "not_author") {
      await alert("Подтвердить может только автор сообщения.");
      return;
    } else if (data?.error === "post_failed") {
      await alert(`Не провелось: ${data.message}`.slice(0, 190));
      return;
    } else if (data?.error === "closed") {
      await drop();
    }
  } else if (action === "rs") {
    const err = await startRecon(ctx, chatId, cq.from.id);
    if (err) { await alert(err); return; }
  } else if (action === "rr") {
    await sendReconSummary(ctx, chatId, parts[2], msg.message_id);
  } else if (action === "ro") {
    const { data: txt } = await supa.rpc("tg_ip_recon_ops", { p_recon: parts[2] });
    if (txt) await tg("sendMessage", { chat_id: chatId, parse_mode: "HTML", text: txt, reply_to_message_id: msg.message_id });
  } else if (action === "rx") {
    await supa.rpc("tg_ip_recon_cancel", { p_recon: parts[2] });
    await drop();
  } else if (action === "ra") {
    const { data } = await supa.rpc("tg_ip_recon_approve", { p_recon: parts[2], p_tg_user: cq.from.id });
    if (data?.ok) {
      await tg("editMessageText", {
        chat_id: chatId, message_id: msg.message_id, parse_mode: "HTML", text: data.text,
        reply_markup: { inline_keyboard: [] },
      });
    } else {
      const text: Record<string, string> = {
        not_approver: "Сверку одобряет Ванамали Гопал.",
        has_difference: "Есть расхождение — сначала внесите недостающее и нажмите «Пересчитать».",
        closed: "Эта сверка уже закрыта.",
      };
      await alert((text[data?.error] ?? `Не записалось: ${data?.message ?? "ошибка"}`).slice(0, 190));
      return;
    }
  }
  await tg("answerCallbackQuery", { callback_query_id: cq.id });
}
