import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;

// Send message с retry (exponential backoff)
async function sendMessage(chatId: number, text: string, options?: {
  parse_mode?: 'Markdown' | 'HTML',
  reply_markup?: object
}): Promise<{ ok: boolean; blocked?: boolean; error?: string }> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body: any = { chat_id: chatId, text };
  if (options?.parse_mode) body.parse_mode = options.parse_mode;
  if (options?.reply_markup) body.reply_markup = options.reply_markup;

  const maxRetries = 3;
  const baseDelay = 1000;
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const error = await resp.json();

        // 403 = бот заблокирован пользователем
        if (error.error_code === 403) {
          console.log(`Bot blocked by chat_id ${chatId}`);
          return { ok: false, blocked: true };
        }

        // 429 = rate limit, retry
        if (error.error_code === 429) {
          const retryAfter = error.parameters?.retry_after || 1;
          await new Promise(r => setTimeout(r, retryAfter * 1000));
          continue;
        }

        throw new Error(`Telegram API error: ${JSON.stringify(error)}`);
      }

      return { ok: true };
    } catch (e: any) {
      lastError = e;
      const delay = baseDelay * Math.pow(2, attempt);
      console.warn(`Send attempt ${attempt + 1}/${maxRetries} to chat ${chatId} failed: ${e.message}`);

      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error(`All ${maxRetries} attempts to chat ${chatId} failed:`, lastError);
  return { ok: false, error: lastError?.message };
}

// Broadcast с rate limiting (25 msg/sec, лимит Telegram <30)
async function broadcastToSubscribers(
  supabase: any,
  retreatId: string,
  messageText: string,
  options?: { parse_mode?: 'Markdown' | 'HTML' }
): Promise<{ sent: number; failed: number; blocked: number; total: number }> {
  // Получить всех подписчиков ретрита
  const { data: subscribers, error: subError } = await supabase
    .from('retreat_registrations')
    .select('vaishnavas!inner(id, telegram_chat_id, spiritual_name, first_name, last_name)')
    .eq('retreat_id', retreatId)
    .in('status', ['guest', 'team'])
    .not('vaishnavas.telegram_chat_id', 'is', null);

  if (subError) {
    console.error('Error fetching subscribers:', subError);
    return { sent: 0, failed: 0, blocked: 0, total: 0 };
  }

  if (!subscribers || subscribers.length === 0) {
    console.log('No subscribers found for retreat:', retreatId);
    return { sent: 0, failed: 0, blocked: 0, total: 0 };
  }

  console.log(`Broadcasting to ${subscribers.length} subscribers...`);

  let sent = 0, failed = 0, blocked = 0;
  const BATCH_SIZE = 25; // < 30 msg/sec лимит Telegram
  const BATCH_DELAY = 1000; // 1 секунда между батчами

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE);

    const results = await Promise.allSettled(
      batch.map(sub => sendMessage(
        sub.vaishnavas.telegram_chat_id,
        messageText,
        options
      ))
    );

    for (const [idx, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        if (result.value.blocked) {
          // Бот заблокирован — убираем chat_id
          blocked++;
          const vaishnavId = batch[idx].vaishnavas.id;
          await supabase
            .from('vaishnavas')
            .update({ telegram_chat_id: null })
            .eq('id', vaishnavId);
          console.log(`Cleared blocked chat_id for vaishnava ${vaishnavId}`);
        } else if (result.value.ok) {
          sent++;
        } else {
          failed++;
        }
      } else {
        failed++;
      }
    }

    // Пауза между батчами
    if (i + BATCH_SIZE < subscribers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY));
    }
  }

  console.log(`Broadcast complete: ${sent} sent, ${failed} failed, ${blocked} blocked, ${subscribers.length} total`);
  return { sent, failed, blocked, total: subscribers.length };
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Проверяем авторизацию
    const authHeader = req.headers.get('Authorization');
    const isServiceRole = authHeader?.includes(Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || 'NEVER_MATCH');

    let currentUserId = null;

    if (!isServiceRole) {
      // Вызов из фронтенда — проверяем авторизацию
      if (!authHeader) {
        return new Response(
          JSON.stringify({ error: 'No authorization header' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const supabase = createClient(
        Deno.env.get('SUPABASE_URL') ?? '',
        Deno.env.get('SUPABASE_ANON_KEY') ?? '',
        { global: { headers: { Authorization: authHeader } } }
      );

      const { data: { user }, error: authError } = await supabase.auth.getUser();
      if (authError || !user) {
        return new Response(
          JSON.stringify({ error: 'Unauthorized' }),
          { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      currentUserId = user.id;
    }

    const { type, retreatId, vaishnavId, message, parseMode } = await req.json();

    // Проверка прав в зависимости от типа уведомления
    if (type === 'broadcast' && !isServiceRole && currentUserId) {
      // Для broadcast нужно право upload_photos (фотографы)
      console.log('Checking permissions for user:', currentUserId);

      const { data: hasPermission, error: permError } = await supabaseAdmin.rpc('has_permission', {
        user_uuid: currentUserId,
        perm_code: 'upload_photos'
      });

      console.log('Permission check result:', { hasPermission, permError });

      if (!hasPermission) {
        console.warn('User does not have upload_photos permission');
        return new Response(
          JSON.stringify({ error: 'Insufficient permissions for broadcast' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    if (!type || !message) {
      return new Response(
        JSON.stringify({ error: 'Missing required fields: type, message' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Роутинг по типу уведомления
    if (type === 'broadcast' && retreatId) {
      // Broadcast всем участникам ретрита
      const result = await broadcastToSubscribers(
        supabaseAdmin,
        retreatId,
        message,
        { parse_mode: parseMode }
      );

      return new Response(
        JSON.stringify({
          success: true,
          ...result
        }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else if (type === 'single' && vaishnavId) {
      // Отправка одному пользователю
      const { data: vaishnava, error: vaishError } = await supabaseAdmin
        .from('vaishnavas')
        .select('telegram_chat_id')
        .eq('id', vaishnavId)
        .single();

      if (vaishError || !vaishnava || !vaishnava.telegram_chat_id) {
        return new Response(
          JSON.stringify({
            success: false,
            error: 'User not found or Telegram not connected'
          }),
          { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const result = await sendMessage(
        vaishnava.telegram_chat_id,
        message,
        { parse_mode: parseMode }
      );

      // Если бот заблокирован — обнуляем chat_id
      if (result.blocked) {
        await supabaseAdmin
          .from('vaishnavas')
          .update({ telegram_chat_id: null })
          .eq('id', vaishnavId);
      }

      return new Response(
        JSON.stringify({
          success: result.ok,
          blocked: result.blocked,
          error: result.error
        }),
        { status: result.ok ? 200 : 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    } else {
      return new Response(
        JSON.stringify({ error: 'Invalid notification type or missing parameters' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

  } catch (error) {
    console.error('Notification error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
