// supabase/functions/daily-photo-notifications/index.ts
// Ежедневная рассылка уведомлений о новых фото в 19:00 IST
// Cron: 0 13 * * * (13:30 UTC = 19:00 IST)

import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN")!;

type RetreatWithPhotos = {
  retreat_id: string;
  retreat_name: string;
  photos_count: number;
};

type UserNotification = {
  vaishnava_id: string;
  telegram_chat_id: number;
  name: string;
  retreats: RetreatWithPhotos[];
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Отправка Telegram сообщения с retry
async function sendTelegramMessage(
  chatId: number,
  text: string,
  options?: { parse_mode?: "Markdown" | "HTML" }
): Promise<{ ok: boolean; blocked?: boolean }> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body: any = { chat_id: chatId, text };
  if (options?.parse_mode) body.parse_mode = options.parse_mode;

  const maxRetries = 3;
  let lastError: any;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });

      const result = await response.json();

      if (!result.ok) {
        const errorCode = result.error_code;
        const description = result.description || "";

        // Бот заблокирован пользователем
        if (errorCode === 403 && description.includes("blocked")) {
          console.warn(`Bot blocked by user ${chatId}`);
          return { ok: false, blocked: true };
        }

        throw new Error(`Telegram API error: ${JSON.stringify(result)}`);
      }

      return { ok: true };
    } catch (e: any) {
      lastError = e;
      if (attempt < maxRetries - 1) {
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(`Failed to send message after ${maxRetries} attempts:`, lastError);
  return { ok: false };
}

// Плюрализация для русского языка
function pluralizePhotos(count: number): string {
  const lastDigit = count % 10;
  const lastTwoDigits = count % 100;

  if (lastTwoDigits >= 11 && lastTwoDigits <= 14) {
    return "фотографий";
  }

  if (lastDigit === 1) {
    return "фотография";
  } else if (lastDigit >= 2 && lastDigit <= 4) {
    return "фотографии";
  } else {
    return "фотографий";
  }
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  console.log("🕐 Starting daily photo notifications...");

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

  // Определяем начало сегодняшнего дня (Indian Standard Time)
  const now = new Date();
  const istOffset = 5.5 * 60 * 60 * 1000; // UTC+5:30
  const istNow = new Date(now.getTime() + istOffset);
  const todayStart = new Date(istNow.getFullYear(), istNow.getMonth(), istNow.getDate());
  const todayStartUTC = new Date(todayStart.getTime() - istOffset);

  console.log(`Today start (IST): ${todayStart.toISOString()}`);
  console.log(`Today start (UTC): ${todayStartUTC.toISOString()}`);

  try {
    // 1. Получить всех пользователей с подключенным Telegram
    const { data: users, error: usersError } = await supabase
      .from("vaishnavas")
      .select("id, telegram_chat_id, spiritual_name, first_name, last_name")
      .not("telegram_chat_id", "is", null);

    if (usersError) {
      console.error("Error fetching users:", usersError);
      return new Response(JSON.stringify({ error: "Failed to fetch users" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!users || users.length === 0) {
      console.log("No users with Telegram connected");
      return new Response(JSON.stringify({ ok: true, sent: 0, message: "No users" }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    console.log(`Found ${users.length} users with Telegram`);

    // 2. Для каждого пользователя собрать его ретриты с новыми фото
    const notifications: UserNotification[] = [];

    for (const user of users) {
      // Найти активные регистрации пользователя
      const { data: registrations, error: regError } = await supabase
        .from("retreat_registrations")
        .select("retreat_id, retreats(id, name_ru, name_en, name_hi)")
        .eq("vaishnava_id", user.id)
        .in("status", ["guest", "team", "volunteer", "vip"]);

      if (regError || !registrations || registrations.length === 0) {
        continue;
      }

      const retreatsWithPhotos: RetreatWithPhotos[] = [];

      for (const reg of registrations) {
        const retreat = (reg as any).retreats;
        if (!retreat) continue;

        // Подсчитать новые фото за сегодня
        const { data: photos, error: photosError } = await supabase
          .from("retreat_photos")
          .select("id")
          .eq("retreat_id", retreat.id)
          .gte("uploaded_at", todayStartUTC.toISOString());

        if (photosError || !photos || photos.length === 0) {
          continue;
        }

        retreatsWithPhotos.push({
          retreat_id: retreat.id,
          retreat_name: retreat.name_ru || retreat.name_en || retreat.name_hi || "Ретрит",
          photos_count: photos.length,
        });
      }

      if (retreatsWithPhotos.length > 0) {
        notifications.push({
          vaishnava_id: user.id,
          telegram_chat_id: user.telegram_chat_id,
          name: user.spiritual_name || `${user.first_name || ""} ${user.last_name || ""}`.trim(),
          retreats: retreatsWithPhotos,
        });
      }
    }

    console.log(`Prepared ${notifications.length} notifications`);

    // 3. Отправить уведомления
    let sent = 0;
    let failed = 0;
    let blocked = 0;

    // Определяем base URL
    const baseUrl = SUPABASE_URL.includes("vzuiwpeovnzfokekdetq")
      ? "https://dev.rupaseva.com"
      : "https://in.rupaseva.com";

    for (const notif of notifications) {
      // Формируем сообщение
      let message = "📸 *Новые фото за сегодня!*\n\n";

      for (const retreat of notif.retreats) {
        message += `${retreat.retreat_name}: ${retreat.photos_count} ${pluralizePhotos(retreat.photos_count)}\n`;
      }

      message += `\n[Посмотреть фотографии](${baseUrl}/guest-portal/photos.html)`;

      // Отправляем
      const result = await sendTelegramMessage(notif.telegram_chat_id, message, {
        parse_mode: "Markdown",
      });

      if (result.blocked) {
        blocked++;
        // Обнулить telegram_chat_id
        await supabase.from("vaishnavas").update({ telegram_chat_id: null }).eq("id", notif.vaishnava_id);
        console.log(`Cleared blocked chat_id for ${notif.vaishnava_id}`);
      } else if (result.ok) {
        sent++;
      } else {
        failed++;
      }

      // Rate limiting: 25 msg/sec
      await new Promise((resolve) => setTimeout(resolve, 40));
    }

    console.log(`✅ Daily notifications complete: ${sent} sent, ${failed} failed, ${blocked} blocked`);

    return new Response(
      JSON.stringify({
        ok: true,
        sent,
        failed,
        blocked,
        total: notifications.length,
      }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error: any) {
    console.error("Error in daily-photo-notifications:", error);
    return new Response(
      JSON.stringify({ error: error.message || String(error) }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
