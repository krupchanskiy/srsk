// ==================== tg-webhook ====================
// Бот-департаментов:
//   • узнаёт автора по нику из карточки вайшнава (привязка создаётся сама);
//   • /start <токен> — явная привязка Telegram к профилю;
//   • бота добавили в чат → чат сам регистрируется;
//   • в чатах департаментов — увидел сумму, дозадал вопросы, записал заявку.
//
// Правки ВГ (24.07.2026):
//   • валюту спрашиваем ВСЕГДА, если она не названа явно — «1% ошибок
//     дороже, а вопрос вырабатывает привычку указывать валюту»;
//   • если признаков траты нет, а сумма есть — переспрашиваем, что это;
//   • «на что потрачено» обязательно — иначе в отчёте суммы без смысла.
// Поэтому карточка — мини-диалог:
//   вид → (кому) → валюта → статья → на что → «Записать».
//
// Бот НИКОГДА не пишет в ядро финмодуля — только в свои таблицы заявок.
// Проведение — только фин-админ во «Входящих».
import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPENSE_WORDS = /(купил|купила|купили|куплю|оплатил|оплатила|оплатили|заплатил|потратил|потрачено|потратили|расход|зарплат|платёж)/i;
const TRANSFER_WORDS = /(выдал|выдала|выдать|выдаю|выдано|выдали)/i;
const CURRENCIES: Record<string, string> = { INR: "₹", RUB: "₽", USD: "$", EUR: "€" };

function parseAmount(text: string): number | null {
  const m = text.match(/(\d[\d\s]{0,9}\d|\d)/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/\s/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
// Валюта только если названа ЯВНО. Иначе null — бот спросит (решение ВГ).
function parseCurrency(text: string): string | null {
  if (/[$]|usd|долл/i.test(text)) return "USD";
  if (/[€]|eur|евро/i.test(text)) return "EUR";
  if (/[₽]|руб|rub/i.test(text)) return "RUB";
  if (/[₹]|рупи|inr|\brs\b/i.test(text)) return "INR";
  return null;
}
// «На что» вытаскиваем из самого сообщения: убираем сумму и валюту, остальное
// и есть описание. «Купил овощи 500 рупий» → «Купил овощи». Если после чистки
// букв почти не осталось (написали голое «500») — вернём null, бот спросит.
function parsePurpose(text: string, amountRaw: string): string | null {
  const s = text
    .replace(amountRaw, " ")
    .replace(/[₹₽$€]|\b(usd|eur|inr|rub|rs|руб\w*|рупи\w*|долл\w*|евро)\b/gi, " ")
    .replace(/\s+/g, " ")
    .replace(/^[\s\-–—:,.;]+|[\s\-–—:,.;]+$/g, "")
    .slice(0, 200);
  return /\p{L}{3,}/u.test(s) ? s : null;
}

// Сообщения шлём с parse_mode HTML, а внутрь попадает текст людей. Без этого
// «купил 5 < 10» или «R&D» ломают разметку — Telegram отклоняет всё сообщение.
const esc = (s: unknown) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

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
  const tg = (method: string, body: unknown) =>
    fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    }).then((r) => r.json()).catch(() => null);

  // Карточка-диалог: показывает, что уже понято, и спрашивает недостающее
  async function renderCard(chatId: number, messageId: number | null, draftId: string, st: any, replyTo?: number) {
    const sym = st.currency ? CURRENCIES[st.currency] ?? st.currency : "";
    // Строка «что уже известно»: сумма, статья, на что. Растёт по ходу диалога,
    // чтобы человек видел, что именно он подтверждает.
    const known = [
      `${st.amount}${sym ? " " + sym : ""}`,
      st.category ? esc(st.category) : null,
      st.purpose ? `на что: ${esc(st.purpose)}` : null,
    ].filter(Boolean).join(" · ");
    const amountLine = `${known}\n<i>${esc(st.raw_text)}</i>`;
    let head: string;
    let keyboard: any[][];

    if (st.needs_kind) {
      head = `🤔 <b>Что это за сумма?</b>`;
      keyboard = [[
        { text: "💸 Расход", callback_data: `k:expense:${draftId}` },
        { text: "🔁 Передача", callback_data: `k:transfer:${draftId}` },
      ], [{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]];
    } else if (st.needs_target) {
      const { data: depts } = await supa.rpc("tg_list_departments", { p_exclude: null });
      head = `🔁 <b>Кому передаём?</b>`;
      const btns = (depts ?? []).map((d: any) => ({ text: d.name, callback_data: `t:${d.id.slice(0, 8)}:${draftId}` }));
      keyboard = [];
      for (let i = 0; i < btns.length; i += 2) keyboard.push(btns.slice(i, i + 2));
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
    } else if (st.needs_category) {
      const { data: cats } = await supa.rpc("tg_list_expense_categories");
      head = `🏷 <b>Какая это статья расходов?</b>`;
      const btns = (cats ?? []).map((c: any) => ({ text: c.name, callback_data: `s:${c.id.slice(0, 8)}:${draftId}` }));
      keyboard = [];
      for (let i = 0; i < btns.length; i += 2) keyboard.push(btns.slice(i, i + 2));
      keyboard.push([{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]);
    } else if (st.needs_purpose) {
      // Единственный шаг, где нужен текст: статью можно выбрать кнопкой,
      // а «на что» кнопками не перечислишь. Просим ответить на сообщение.
      head = `✍️ <b>На что потрачено?</b>\nОтветьте на это сообщение — напишите пару слов.`;
      keyboard = [[{ text: "✖️ Не про деньги", callback_data: `no:${draftId}` }]];
    } else {
      head = st.kind === "transfer"
        ? `🔁 <b>Передать в «${esc(st.target_department)}»?</b>`
        : `💸 <b>Записать расход по «${esc(st.department)}»?</b>`;
      keyboard = [[
        { text: "✅ Записать", callback_data: `ok:${draftId}` },
        { text: "✖️ Не надо", callback_data: `no:${draftId}` },
      ], [{ text: "✍️ Исправить описание", callback_data: `e:${draftId}` }]];
    }

    const body = {
      chat_id: chatId, parse_mode: "HTML", text: `${head}\n${amountLine}`,
      reply_markup: { inline_keyboard: keyboard },
    };
    if (messageId) {
      await tg("editMessageText", { ...body, message_id: messageId });
    } else {
      const sent = await tg("sendMessage", { ...body, reply_to_message_id: replyTo });
      // Запоминаем карточку: по ней узнаём заявку, когда человек ответит текстом
      const mid = sent?.result?.message_id;
      if (mid) await supa.rpc("tg_set_card_message", { p_id: draftId, p_msg: mid });
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
      await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: "✖️ Отменено" });
    } else if (action === "ok") {
      const { data } = await supa.rpc("tg_set_draft_status", { p_id: parts[1], p_status: "pending", p_card_message_id: msg?.message_id });
      const row = Array.isArray(data) ? data[0] : data;
      if (row) await tg("setMessageReaction", { chat_id: row.chat_id, message_id: row.source_message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
      await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", text: esc(msg.text || "") + "\n\n👀 <b>Записано, ждёт проведения</b>" });
    } else if (action === "e") {
      // «Исправить описание» — стираем «на что», карточка снова спросит текстом
      const { data: st } = await supa.rpc("tg_patch_draft", { p_id: parts[1], p: { clear: "purpose" } });
      if (st?.ok) await renderCard(msg.chat.id, msg.message_id, parts[1], st);
    } else if (action === "k" || action === "c" || action === "t" || action === "s") {
      const value = parts[1];
      const draftId = parts[2];
      const patch: Record<string, string> = {};
      if (action === "k") patch.kind = value;
      if (action === "c") patch.currency = value;
      if (action === "t") {
        const { data: depts } = await supa.rpc("tg_list_departments", { p_exclude: null });
        const found = (depts ?? []).find((d: any) => d.id.startsWith(value));
        if (found) patch.target_department_id = found.id;
      }
      if (action === "s") {
        const { data: cats } = await supa.rpc("tg_list_expense_categories");
        const found = (cats ?? []).find((c: any) => c.id.startsWith(value));
        if (found) patch.category_id = found.id;
      }
      const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: patch });
      if (st?.ok) await renderCard(msg.chat.id, msg.message_id, draftId, st);
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  const m = update.message ?? update.edited_message;
  const text: string | undefined = m?.text ?? m?.caption;
  if (!m || !text) return new Response("ok");

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

  // ---------- ответ на карточку — это «на что потрачено» ----------
  // Проверяем ДО разбора суммы: в ответе может быть число («овощи 3 кг»),
  // и без этой ветки бот завёл бы вторую заявку на 3.
  if (m.reply_to_message?.message_id) {
    const { data: draftId } = await supa.rpc("tg_find_card_draft", {
      p_chat: m.chat.id, p_msg: m.reply_to_message.message_id,
    });
    if (draftId) {
      const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: { purpose: text } });
      if (st?.ok) {
        await renderCard(m.chat.id, m.reply_to_message.message_id, draftId, st);
        await tg("setMessageReaction", { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
      }
      return new Response("ok");
    }
  }

  // ---------- суммы в чатах департаментов ----------
  const { data: chatRows } = await supa.rpc("tg_resolve_chat", { p_chat: m.chat.id });
  const chat = Array.isArray(chatRows) ? chatRows[0] : chatRows;
  if (!chat) return new Response("ok");

  const amountMatch = text.match(/(\d[\d\s]{0,9}\d|\d)/);
  const amount = parseAmount(text);
  if (!amount) return new Response("ok");

  // Вид определяем по словам; если слов нет — спросим (решение ВГ)
  let kind: string | null = null;
  let targetDept: string | null = null;
  if (TRANSFER_WORDS.test(text)) {
    kind = "transfer";
    const { data: tgt } = await supa.rpc("tg_match_department", { p_text: text, p_exclude: chat.department_id });
    if (tgt) targetDept = tgt;
  } else if (EXPENSE_WORDS.test(text)) {
    kind = "expense";
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

  const { data: draftId } = await supa.rpc("tg_create_draft", {
    p: { chat_id: m.chat.id, source_message_id: m.message_id, tg_user_id: m.from.id,
         kind, amount, currency: parseCurrency(text), target_department_id: targetDept,
         purpose: parsePurpose(text, amountMatch?.[0] ?? ""), raw_text: text },
  });
  if (!draftId) return new Response("ok");

  const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: {} });
  if (st?.ok) await renderCard(m.chat.id, null, draftId, st, m.message_id);
  return new Response("ok");
});
