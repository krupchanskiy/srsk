// ==================== tg-webhook ====================
// Бот-департаментов:
//   • /start <токен> — привязка Telegram к профилю;
//   • бота добавили в чат → чат сам регистрируется (для привязки к департаменту);
//   • в чатах департаментов — распознаёт траты и передачи, показывает карточку;
//   • кнопка «Записать» → заявка + 👀; проведение — только fin-админ во «Входящих».
// Бот НИКОГДА не пишет в ядро финмодуля — только в свои таблицы заявок.
//
// Безопасность: verify_jwt=false (Telegram не шлёт JWT), вместо этого
// сверяем заголовок X-Telegram-Bot-Api-Secret-Token с секретом в vault.
import { createClient } from "jsr:@supabase/supabase-js@2";

const EXPENSE_WORDS = /(купил|купила|купили|куплю|оплатил|оплатила|оплатили|заплатил|потратил|потрачено|потратили|расход|зарплат|платёж)/i;
const TRANSFER_WORDS = /(выдал|выдала|выдать|выдаю|выдано|выдали)/i;

function parseAmount(text: string): number | null {
  const m = text.match(/(\d[\d\s]{0,9}\d|\d)/);
  if (!m) return null;
  const n = parseInt(m[0].replace(/\s/g, ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}
function parseCurrency(text: string): string {
  if (/[$]|usd|долл/i.test(text)) return "USD";
  if (/[€]|eur|евро/i.test(text)) return "EUR";
  if (/[₽]|руб|rub|\d\s*р\b/i.test(text)) return "RUB";
  return "INR";
}
function symbolOf(cur: string): string {
  return cur === "INR" ? "₹" : cur === "RUB" ? "₽" : cur === "USD" ? "$" : cur === "EUR" ? "€" : cur;
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

  // ---------- бота добавили/убрали из чата ----------
  if (update.my_chat_member) {
    const cm = update.my_chat_member;
    await supa.rpc("tg_note_chat", {
      p: {
        chat_id: cm.chat?.id ?? null,
        title: cm.chat?.title ?? null,
        chat_type: cm.chat?.type ?? null,
        bot_status: cm.new_chat_member?.status ?? null,
        is_forum: cm.chat?.is_forum ?? false,
      },
    });
    return new Response("ok");
  }

  // ---------- кнопка на карточке ----------
  if (update.callback_query) {
    const cq = update.callback_query;
    const [action, id] = (cq.data || "").split(":");
    const msg = cq.message;
    if (action === "ok") {
      const { data } = await supa.rpc("tg_set_draft_status", { p_id: id, p_status: "pending", p_card_message_id: msg?.message_id });
      const row = Array.isArray(data) ? data[0] : data;
      if (row) await tg("setMessageReaction", { chat_id: row.chat_id, message_id: row.source_message_id, reaction: [{ type: "emoji", emoji: "👀" }] });
      await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, parse_mode: "HTML", text: (msg.text || "") + "\n\n👀 <b>Записано, ждёт проведения</b>" });
    } else if (action === "no") {
      await supa.rpc("tg_set_draft_status", { p_id: id, p_status: "dismissed", p_card_message_id: msg?.message_id });
      await tg("editMessageText", { chat_id: msg.chat.id, message_id: msg.message_id, text: "✖️ Отменено" });
    }
    await tg("answerCallbackQuery", { callback_query_id: cq.id });
    return new Response("ok");
  }

  const m = update.message ?? update.edited_message;
  const text: string | undefined = m?.text ?? m?.caption;
  if (!m || !text) return new Response("ok");

  // запоминаем чат — чтобы привязать его к департаменту без ручного поиска id
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

  // ---------- траты/передачи в чатах департаментов ----------
  const { data: chatRows } = await supa.rpc("tg_resolve_chat", { p_chat: m.chat.id });
  const chat = Array.isArray(chatRows) ? chatRows[0] : chatRows;
  if (!chat) return new Response("ok");

  const amount = parseAmount(text);
  if (!amount) return new Response("ok");
  const isTransfer = TRANSFER_WORDS.test(text);
  const isExpense = EXPENSE_WORDS.test(text);
  if (!isTransfer && !isExpense) return new Response("ok");

  let kind = "expense";
  let targetDept: string | null = null;
  let targetName = "";
  if (isTransfer) {
    const { data: tgt } = await supa.rpc("tg_match_department", { p_text: text, p_exclude: chat.department_id });
    if (tgt) {
      kind = "transfer"; targetDept = tgt;
      const { data: tn } = await supa.from("fin_departments").select("name").eq("id", tgt).maybeSingle();
      targetName = tn?.name ?? "";
    }
  }

  const { data: userRows } = await supa.rpc("tg_resolve_user", { p_user: m.from.id });
  const user = Array.isArray(userRows) ? userRows[0] : userRows;
  if (!user) {
    await tg("sendMessage", { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: "Привяжите Telegram к профилю на in.rupaseva.com — тогда смогу записывать расходы от вашего имени." });
    return new Response("ok");
  }

  const cur = parseCurrency(text);
  const { data: draftId } = await supa.rpc("tg_create_draft", {
    p: { chat_id: m.chat.id, source_message_id: m.message_id, tg_user_id: m.from.id,
         kind, amount, currency: cur, target_department_id: targetDept, raw_text: text },
  });
  if (!draftId) return new Response("ok");

  const head = kind === "transfer"
    ? `🔁 <b>Передать в «${targetName}»?</b>`
    : `💸 <b>Записать расход по «${chat.department_name}»?</b>`;
  await tg("sendMessage", {
    chat_id: m.chat.id, reply_to_message_id: m.message_id, parse_mode: "HTML",
    text: `${head}\n${amount} ${symbolOf(cur)} · ${text}`,
    reply_markup: { inline_keyboard: [[
      { text: "✅ Записать", callback_data: `ok:${draftId}` },
      { text: "✖️ Не надо", callback_data: `no:${draftId}` },
    ]] },
  });
  return new Response("ok");
});
