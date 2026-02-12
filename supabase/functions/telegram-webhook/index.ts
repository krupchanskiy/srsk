import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

// Telegram Bot API базовые методы
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!;

async function sendMessage(chatId: number, text: string, options?: {
  parse_mode?: 'Markdown' | 'HTML',
  reply_markup?: object
}): Promise<Response> {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`;
  const body: any = { chat_id: chatId, text };
  if (options?.parse_mode) body.parse_mode = options.parse_mode;
  if (options?.reply_markup) body.reply_markup = options.reply_markup;

  return await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// Send with retry (exponential backoff)
async function sendWithRetry(
  sendFn: () => Promise<Response>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<{ ok: boolean; blocked?: boolean; error?: string }> {
  let lastError: any = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const resp = await sendFn();

      if (!resp.ok) {
        const error = await resp.json();

        // 403 = бот заблокирован пользователем
        if (error.error_code === 403) {
          console.log('Bot blocked by user');
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
      console.warn(`Send attempt ${attempt + 1}/${maxRetries} failed: ${e.message}. Retry in ${delay}ms`);

      if (attempt < maxRetries - 1) {
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }

  console.error(`All ${maxRetries} attempts failed:`, lastError);
  return { ok: false, error: lastError?.message };
}

Deno.serve(async (req: Request) => {
  // Для webhook от Telegram не проверяем JWT, но для безопасности используем секретный параметр
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Безопасность: проверка секретного параметра
    const url = new URL(req.url);
    const secret = url.searchParams.get('secret');
    const expectedSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');

    if (expectedSecret && secret !== expectedSecret) {
      console.warn('Invalid webhook secret');
      return new Response('Unauthorized', { status: 401 });
    }

    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Парсим webhook update от Telegram
    const update = await req.json();
    console.log('Telegram update:', JSON.stringify(update));

    const message = update.message;
    const callbackQuery = update.callback_query;

    // Роутинг по типу update
    if (message?.text?.startsWith('/start')) {
      // Команда /start TOKEN — привязка бота к пользователю
      return await handleStart(message, supabaseAdmin);
    } else if (message?.text?.startsWith('/stop')) {
      // Команда /stop — отвязка бота
      return await handleStop(message, supabaseAdmin);
    } else if (message?.text?.startsWith('/help')) {
      // Команда /help
      return await handleHelp(message);
    } else if (callbackQuery) {
      // Inline-кнопки (для будущих фич)
      return await handleCallback(callbackQuery, supabaseAdmin);
    } else if (message?.text) {
      // Обычное текстовое сообщение
      return await handleText(message);
    }

    // Неизвестный тип update — игнорируем
    return new Response(JSON.stringify({ ok: true }), {
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error) {
    console.error('Webhook error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
});

// Обработчик /start TOKEN
async function handleStart(message: any, supabase: any) {
  const text = message.text || '';
  const token = text.replace('/start', '').trim();
  const chatId = message.chat.id;

  if (!token) {
    // Welcome message при /start без токена
    await sendWithRetry(() => sendMessage(
      chatId,
      `🙏 *Добро пожаловать в Sri Rupa Seva Kunja Bot!*

Этот бот отправляет уведомления о фотографиях с ваших ретритов:

📸 *Новые фото загружены*
   Узнавайте первыми, когда фотограф добавит новые снимки

🔍 *AI нашёл вас на фотографиях*
   Автоматическое распознавание лиц — больше не нужно искать себя вручную

*Как подключить уведомления:*
1. Откройте Guest Portal
2. Нажмите "Подключить Telegram"
3. Перейдите по ссылке — готово!

_Команды:_
/help — подробная справка
/stop — отключить уведомления`,
      { parse_mode: 'Markdown' }
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  // Валидация токена
  const { data: tokenData, error: tokenError } = await supabase
    .from('telegram_link_tokens')
    .select('*')
    .eq('token', token)
    .single();

  if (tokenError || !tokenData) {
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Неверный токен\n\nПожалуйста, получите новую ссылку в Guest Portal.'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  if (tokenData.used) {
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Токен уже использован\n\nПолучите новую ссылку в Guest Portal.'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  if (new Date(tokenData.expires_at) < new Date()) {
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Токен истёк\n\nПолучите новую ссылку в Guest Portal (токены действительны 15 минут).'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  // Получаем данные пользователя
  const { data: vaishnava, error: vaishError } = await supabase
    .from('vaishnavas')
    .select('spiritual_name, first_name, last_name')
    .eq('id', tokenData.vaishnava_id)
    .single();

  if (vaishError || !vaishnava) {
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Ошибка при привязке\n\nПопробуйте ещё раз или обратитесь в поддержку.'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  // Привязываем chat_id к пользователю
  const { error: updateError } = await supabase
    .from('vaishnavas')
    .update({ telegram_chat_id: chatId })
    .eq('id', tokenData.vaishnava_id);

  if (updateError) {
    console.error('Error updating telegram_chat_id:', updateError);
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Ошибка при привязке\n\nПопробуйте ещё раз или обратитесь в поддержку.'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  // Отмечаем токен как использованный
  await supabase
    .from('telegram_link_tokens')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', tokenData.id);

  // Имя пользователя для приветствия
  const name = vaishnava.spiritual_name ||
               `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim() ||
               'гость';

  await sendWithRetry(() => sendMessage(
    chatId,
    `✅ *Уведомления подключены!*

Привет, ${name}! 🙏

Теперь вы будете получать уведомления:
📸 О новых фото с вашего ретрита
🔍 Когда AI найдёт вас на фотографиях

_Команды:_
/help — справка
/stop — отключить уведомления`,
    { parse_mode: 'Markdown' }
  ));

  return new Response(JSON.stringify({ ok: true }));
}

// Обработчик /stop
async function handleStop(message: any, supabase: any) {
  const chatId = message.chat.id;

  // Находим пользователя по chat_id
  const { data: vaishnava, error: findError } = await supabase
    .from('vaishnavas')
    .select('id, spiritual_name, first_name, last_name')
    .eq('telegram_chat_id', chatId)
    .maybeSingle();

  if (findError || !vaishnava) {
    await sendWithRetry(() => sendMessage(
      chatId,
      'ℹ️ Уведомления не были подключены'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  // Отвязываем
  const { error: updateError } = await supabase
    .from('vaishnavas')
    .update({ telegram_chat_id: null })
    .eq('id', vaishnava.id);

  if (updateError) {
    console.error('Error clearing telegram_chat_id:', updateError);
    await sendWithRetry(() => sendMessage(
      chatId,
      '❌ Ошибка при отключении\n\nПопробуйте ещё раз или обратитесь в поддержку.'
    ));
    return new Response(JSON.stringify({ ok: true }));
  }

  const name = vaishnava.spiritual_name ||
               `${vaishnava.first_name || ''} ${vaishnava.last_name || ''}`.trim() ||
               'гость';

  await sendWithRetry(() => sendMessage(
    chatId,
    `✅ *Уведомления отключены*

До свидания, ${name}! 🙏

Вы можете подключить уведомления снова в любой момент:
• Через Guest Portal (кнопка "Подключить Telegram")
• Или отправьте /start с новой ссылкой

_Команда /help — подробная справка_`,
    { parse_mode: 'Markdown' }
  ));

  return new Response(JSON.stringify({ ok: true }));
}

// Обработчик /help
async function handleHelp(message: any) {
  const chatId = message.chat.id;

  await sendWithRetry(() => sendMessage(
    chatId,
    `🙏 *Sri Rupa Seva Kunja Bot*

Бот отправляет уведомления о фотографиях с ваших ретритов:

• Новые фото загружены
Узнавайте первыми, когда фотограф добавит новые снимки

• AI нашёл вас на фото
Получайте уведомление, когда вас найдут на фотографиях через Guest Portal

Команды:
/start TOKEN — подключить уведомления
/stop — отключить уведомления
/help — эта справка

Как подключить:
1. Откройте Guest Portal
2. Войдите через email
3. Нажмите "Подключить Telegram"
4. Готово!

В Guest Portal вы можете:
- Просматривать все фото ретрита
- Нажать "Найти себя" — AI автоматически найдёт все фото, где вы есть
- Скачивать фото по одному или архивом`,
{ parse_mode: 'Markdown' }
  ));

  return new Response(JSON.stringify({ ok: true }));
}

// Обработчик callback_query (inline-кнопки)
async function handleCallback(callbackQuery: any, supabase: any) {
  const { id, data, message, from } = callbackQuery;

  // Обязательно ответить на callback (убрать "часики")
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: id }),
  });

  // Роутинг по паттерну callback_data (для будущих фич)
  console.log('Callback data:', data);

  return new Response(JSON.stringify({ ok: true }));
}

// Обработчик обычных текстовых сообщений
async function handleText(message: any) {
  const chatId = message.chat.id;

  await sendWithRetry(() => sendMessage(
    chatId,
    'ℹ️ Используйте команду /help для справки'
  ));

  return new Response(JSON.stringify({ ok: true }));
}
