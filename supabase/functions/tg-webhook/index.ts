// ==================== tg-webhook ====================
// Приёмник обновлений Telegram для бота-департаментов.
// День 1: сверяет секрет, складывает входящие сообщения в разведочный
// лог (tg_incoming) — чтобы увидеть chat_id чатов и tg_user_id людей и
// заполнить привязки. Разбор трат и карточки — день 2.
//
// Безопасность: verify_jwt=false (Telegram не шлёт JWT), вместо этого
// сверяем заголовок X-Telegram-Bot-Api-Secret-Token с секретом в vault.
// Функция НИКОГДА не пишет в ядро финмодуля — только в свои таблицы.
import { createClient } from "jsr:@supabase/supabase-js@2";

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
  try {
    update = await req.json();
  } catch {
    return new Response("ok");
  }

  const msg = update.message ?? update.edited_message ?? update.channel_post;
  if (msg && (msg.text || msg.caption)) {
    const from = msg.from ?? {};
    const chat = msg.chat ?? {};
    const fullName = [from.first_name, from.last_name].filter(Boolean).join(" ");
    await supa.rpc("tg_log_incoming", {
      p: {
        chat_id: chat.id ?? null,
        chat_title: chat.title ?? null,
        chat_type: chat.type ?? null,
        tg_user_id: from.id ?? null,
        username: from.username ?? null,
        full_name: fullName || null,
        message_id: msg.message_id ?? null,
        topic_id: msg.message_thread_id ?? null,
        text: msg.text ?? msg.caption ?? null,
      },
    });
  }

  return new Response("ok");
});
