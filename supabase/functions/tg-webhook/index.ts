// ==================== tg-webhook ====================
// Бот-департаментов:
//   • /start <токен> — привязка Telegram к профилю;
//   • бота добавили в чат → чат сам регистрируется;
//   • в чатах департаментов — увидел сумму, дозадал вопросы, записал заявку.
//
// Правки ВГ (24.07.2026):
//   • валюту спрашиваем ВСЕГДА, если она не названа явно — «1% ошибок
//     дороже, а вопрос вырабатывает привычку указывать валюту»;
//   • если признаков траты нет, а сумма есть — переспрашиваем, что это.
// Поэтому карточка — мини-диалог: вид → (кому) → валюта → «Записать».
//
// Бот НИКОГДА не пишет в ядро финмодуля — только в свои таблицы заявок.
// Проведение — только fin-админ во «Входящих».
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
    const amountLine = `${st.amount}${sym ? " " + sym : ""} · ${st.raw_text}`;
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
    } else {
      head = st.kind === "transfer"
        ? `🔁 <b>Передать в «${st.target_department}»?</b>`
        : `💸 <b>Записать расход по «${st.department}»?</b>`;
      keyboard = [[
        { text: "✅ Записать", callback_data: `ok:${draftId}` },
        { text: "✖️ Не надо", callback_data: `no:${draftId}` },
      ]];
    }

    const body = {
      chat_id: chatId, parse_mode: "HTML", text: `${head}\n${amountLine}`,
      reply_markup: { inline_keyboard: keyboard },
    };
    if (messageId) await tg("editMessageText", { ...body, message_id: messageId });
    else await tg("sendMessage", { ...body, reply_to_message_id: replyTo });
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
      await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", text: (msg.text || "") + "\n\n👀 <b>Записано, ждёт проведения</b>" });
    } else if (action === "k" || action === "c" || action === "t") {
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
    await supa.rpc("tg_note_chat", {
      p: { chat_id: m.chat.id, title: m.chat.title ?? null, chat_type: m.chat.type,
           bot_status: "member", is_forum: m.chat.is_forum ?? false },
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
      await tg("sendMessage", { chat_id: m.chat.id, text: "Здравствуйте! Чтобы привязать Telegram, откройте свой профиль на in.rupaseva.com и нажмите «Привязать Telegram»." });
    }
    return new Response("ok");
  }

  // ---------- суммы в чатах департаментов ----------
  const { data: chatRows } = await supa.rpc("tg_resolve_chat", { p_chat: m.chat.id });
  const chat = Array.isArray(chatRows) ? chatRows[0] : chatRows;
  if (!chat) return new Response("ok");

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

  const { data: userRows } = await supa.rpc("tg_resolve_user", { p_user: m.from.id });
  const user = Array.isArray(userRows) ? userRows[0] : userRows;
  if (!user) {
    await tg("sendMessage", { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: "Привяжите Telegram к профилю на in.rupaseva.com — тогда смогу записывать расходы от вашего имени." });
    return new Response("ok");
  }

  const { data: draftId } = await supa.rpc("tg_create_draft", {
    p: { chat_id: m.chat.id, source_message_id: m.message_id, tg_user_id: m.from.id,
         kind, amount, currency: parseCurrency(text), target_department_id: targetDept, raw_text: text },
  });
  if (!draftId) return new Response("ok");

  const { data: st } = await supa.rpc("tg_patch_draft", { p_id: draftId, p: {} });
  if (st?.ok) await renderCard(m.chat.id, null, draftId, st, m.message_id);
  return new Response("ok");
});
