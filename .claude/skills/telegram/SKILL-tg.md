---
name: telegram-bot
description: |
  Паттерны разработки мультимодального Telegram-бота с LLM-интеграцией.
  Webhook mode, send_with_retry, broadcast, deep link, мультимодальность (фото/голос/документы),
  универсальная LLM-абстракция (OpenAI/Groq/OpenRouter), session store, error handling.
  Use when:
  - Создание Telegram-бота (webhook или polling)
  - Интеграция Telegram с Supabase Edge Functions
  - Отправка уведомлений через Telegram Bot API
  - Работа с мультимодальным вводом (фото, голос, документы)
  - Подключение LLM к Telegram-боту
  - Broadcast/рассылка через Telegram
  - Привязка Telegram к пользователю (deep link)
user-invocable: true
allowed-tools: Read, Grep, Glob, Bash, Edit, Write
version: 1.0.0
---

# Telegram Bot Development Patterns

Паттерны разработки мультимодального Telegram-бота с LLM-интеграцией.
Извлечены из production-бота (python-telegram-bot, webhook mode, FastAPI/Supabase Edge Functions).

## Когда активируется

- Создание или модификация Telegram-бота
- Работа с Telegram Bot API (sendMessage, setWebhook, etc.)
- Интеграция Telegram с Supabase Edge Functions или FastAPI
- Push-уведомления / рассылка через Telegram
- Привязка Telegram аккаунта к пользователю системы
- Мультимодальный ввод: фото, голос, документы в боте
- Подключение LLM (OpenAI, Groq, OpenRouter) к боту
- Любая работа со словами "telegram", "бот", "webhook", "уведомления telegram"

## Принципы

1. **Webhook > Polling** — для production всегда webhook
2. **send_with_retry** — КАЖДАЯ отправка через retry с exponential backoff
3. **403 = blocked** — бот заблокирован → обнулить chat_id
4. **Rate limit** — broadcast < 30 msg/sec батчами по 25
5. **Transparent Flow** — голос/фото → текст → единый handler
6. **LLM-агностик** — абстракция провайдера, не привязка к одному

---

## 1. Архитектура: Webhook Mode

Webhook стабильнее polling для production. Telegram отправляет HTTP POST на endpoint, сервер обрабатывает update и отвечает.

### Supabase Edge Function (Deno/TypeScript)

```typescript
// supabase/functions/telegram-webhook/index.ts
import { serve } from 'https://deno.land/std/http/server.ts'

serve(async (req) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 })
  }

  const update = await req.json()
  const message = update.message
  const callbackQuery = update.callback_query

  // Роутинг по типу update
  if (message?.text?.startsWith('/start')) {
    return await handleStart(message)
  } else if (callbackQuery) {
    return await handleCallback(callbackQuery)
  } else if (message?.photo) {
    return await handlePhoto(message)
  } else if (message?.voice) {
    return await handleVoice(message)
  } else if (message?.document) {
    return await handleDocument(message)
  } else if (message?.text) {
    return await handleText(message)
  }

  return new Response(JSON.stringify({ ok: true }))
})
```

### Python (FastAPI + python-telegram-bot)

```python
# Модульная структура handlers
telegram_bot/
├── bot.py              # TelegramBot class, регистрация handlers
├── handlers.py         # Re-export module (точка входа)
├── core_handlers.py    # /start, /help, send_with_retry, auth
├── photo_handlers.py   # Фото: OCR, face recognition
├── voice_handlers.py   # Голос: Whisper transcription → text flow
├── notification_*.py   # Push-уведомления (birthday, digest, alerts)
└── session_store.py    # TTL-кеш для webhook mode
```

**Ключевой паттерн:** `handlers.py` — re-export module, не содержит логики:

```python
# handlers.py — точка входа, только реэкспорт
from .core_handlers import start_command, send_with_retry
from .photo_handlers import handle_photo_message
from .voice_handlers import handle_voice_message
```

---

## 2. send_with_retry — Отправка с exponential backoff

Критически важный паттерн. Telegram API нестабилен, сетевые ошибки — норма.

### TypeScript (для Edge Functions)

```typescript
async function sendWithRetry(
  sendFn: () => Promise<Response>,
  maxRetries = 3,
  baseDelay = 1000
): Promise<Response | null> {
  let lastError: Error | null = null

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await sendFn()
    } catch (e) {
      lastError = e as Error
      const delay = baseDelay * Math.pow(2, attempt) // 1s, 2s, 4s
      console.warn(`Send attempt ${attempt + 1}/${maxRetries} failed: ${e}. Retry in ${delay}ms`)
      await new Promise(r => setTimeout(r, delay))
    }
  }

  console.error(`All ${maxRetries} attempts failed:`, lastError)
  return null
}
```

### Python

```python
async def send_with_retry(send_func, max_retries=3, base_delay=1.0, fallback_func=None):
    last_error = None
    for attempt in range(max_retries):
        try:
            return await send_func()
        except (NetworkError, TimedOut, httpx.RemoteProtocolError) as e:
            last_error = e
            delay = base_delay * (2 ** attempt)
            await asyncio.sleep(delay)
        except TelegramError as e:
            # Не-сетевые ошибки — не ретраим
            raise

    # Fallback если все retry провалились
    if fallback_func:
        try:
            return await fallback_func()
        except Exception:
            pass
    return None
```

**Использование:**
```python
await send_with_retry(
    lambda: message.reply_text("Hello!"),
    fallback_func=lambda: message.reply_text("Hello (fallback)")
)
```

---

## 3. Telegram Bot API — Ключевые методы

### sendMessage

```typescript
async function sendMessage(chatId: number, text: string, options?: {
  parse_mode?: 'Markdown' | 'MarkdownV2' | 'HTML',
  reply_markup?: object
}) {
  const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN')!
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`

  const body: any = { chat_id: chatId, text }
  if (options?.parse_mode) body.parse_mode = options.parse_mode
  if (options?.reply_markup) body.reply_markup = options.reply_markup

  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!resp.ok) {
    const error = await resp.json()
    // Обработка специфичных ошибок
    if (error.error_code === 403) {
      // Пользователь заблокировал бота → пометить chat_id = null
      return { blocked: true }
    }
    throw new Error(`Telegram API error: ${JSON.stringify(error)}`)
  }

  return await resp.json()
}
```

### Inline Keyboard

```typescript
function buildKeyboard(buttons: Array<{text: string, callback_data: string}[]>) {
  return { inline_keyboard: buttons }
}

// Пример: кнопки подтверждения
const confirmKeyboard = buildKeyboard([
  [
    { text: 'Подтвердить', callback_data: 'confirm:abc123' },
    { text: 'Отмена', callback_data: 'cancel:abc123' },
  ]
])
```

### Обработка callback_query

```typescript
// Callback query: пользователь нажал inline-кнопку
if (update.callback_query) {
  const { id, data, message, from } = update.callback_query

  // ОБЯЗАТЕЛЬНО: ответить на callback (убрать "часики")
  await answerCallbackQuery(id)

  // Роутинг по паттерну callback_data
  if (data.startsWith('confirm:')) {
    const key = data.split(':')[1]
    await handleConfirm(key, message, from)
  } else if (data.startsWith('cancel:')) {
    await handleCancel(message)
  }
}

async function answerCallbackQuery(callbackQueryId: string) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId }),
  })
}
```

---

## 4. Привязка Telegram → Пользователь (Deep Link Token)

Безопасная привязка через одноразовый токен с TTL.

### Flow

```
Guest Portal                    Telegram Bot
    │                               │
    ├─ Генерирует UUID токен ──────→│
    │  (TTL 15 мин, одноразовый)    │
    │                               │
    ├─ Показывает ссылку:           │
    │  t.me/bot?start=TOKEN         │
    │                               │
    ├─ Гость кликает ──────────────→│
    │                               ├─ /start TOKEN
    │                               ├─ Валидация: exists? expired? used?
    │                               ├─ UPDATE user SET telegram_chat_id
    │                               ├─ UPDATE token SET used=true
    │                               └─ Ответ: «Уведомления подключены!»
```

### Реализация

```typescript
// Генерация токена (Guest Portal)
const token = crypto.randomUUID()
await supabase.from('telegram_link_tokens').insert({
  token,
  vaishnava_id: userId,
  expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
  used: false,
})
const deepLink = `https://t.me/rupaseva_bot?start=${token}`

// Обработка /start TOKEN (Edge Function webhook)
async function handleStart(message: TelegramMessage) {
  const text = message.text || ''
  const token = text.replace('/start ', '').trim()
  const chatId = message.chat.id

  if (!token) {
    return sendMessage(chatId, 'Для подключения перейдите в Guest Portal')
  }

  // Валидация
  const { data: tokenData } = await supabase
    .from('telegram_link_tokens')
    .select('*')
    .eq('token', token)
    .single()

  if (!tokenData) {
    return sendMessage(chatId, 'Неверный токен')
  }
  if (tokenData.used) {
    return sendMessage(chatId, 'Токен уже использован. Получите новый в портале')
  }
  if (new Date(tokenData.expires_at) < new Date()) {
    return sendMessage(chatId, 'Токен истёк. Получите новый в портале')
  }

  // Привязка
  await supabase
    .from('vaishnavas')
    .update({ telegram_chat_id: chatId })
    .eq('id', tokenData.vaishnava_id)

  await supabase
    .from('telegram_link_tokens')
    .update({ used: true, used_at: new Date().toISOString() })
    .eq('id', tokenData.id)

  return sendMessage(chatId, 'Уведомления подключены!')
}
```

---

## 5. Push-уведомления (Broadcast)

### Rate limiting (30 msg/sec — лимит Telegram)

```typescript
async function broadcastToSubscribers(
  retreatId: string,
  messageText: string,
  options?: { parse_mode?: string }
) {
  // Получить всех подписчиков
  const { data: subscribers } = await supabase
    .from('retreat_registrations')
    .select('vaishnavas!inner(telegram_chat_id)')
    .eq('retreat_id', retreatId)
    .not('vaishnavas.telegram_chat_id', 'is', null)

  if (!subscribers?.length) return { sent: 0, failed: 0 }

  let sent = 0, failed = 0
  const BATCH_SIZE = 25  // < 30 msg/sec лимит Telegram
  const BATCH_DELAY = 1000  // 1 секунда между батчами

  for (let i = 0; i < subscribers.length; i += BATCH_SIZE) {
    const batch = subscribers.slice(i, i + BATCH_SIZE)

    const results = await Promise.allSettled(
      batch.map(sub => sendWithRetry(
        () => sendMessage(sub.vaishnavas.telegram_chat_id, messageText, options),
        2  // меньше retry для broadcast
      ))
    )

    for (const [idx, result] of results.entries()) {
      if (result.status === 'fulfilled' && result.value?.blocked) {
        // Бот заблокирован — убираем chat_id
        await supabase
          .from('vaishnavas')
          .update({ telegram_chat_id: null })
          .eq('telegram_chat_id', batch[idx].vaishnavas.telegram_chat_id)
        failed++
      } else if (result.status === 'fulfilled') {
        sent++
      } else {
        failed++
      }
    }

    // Пауза между батчами
    if (i + BATCH_SIZE < subscribers.length) {
      await new Promise(r => setTimeout(r, BATCH_DELAY))
    }
  }

  return { sent, failed, total: subscribers.length }
}
```

---

## 6. Мультимодальность: Фото, Голос, Документы

### Получение файлов из Telegram

```typescript
async function getTelegramFile(fileId: string): Promise<Uint8Array> {
  // 1. Получить file_path
  const fileResp = await fetch(
    `https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`
  )
  const { result } = await fileResp.json()

  // 2. Скачать файл
  const downloadResp = await fetch(
    `https://api.telegram.org/file/bot${BOT_TOKEN}/${result.file_path}`
  )
  return new Uint8Array(await downloadResp.arrayBuffer())
}

// Фото: Telegram отправляет в нескольких размерах — берём последний (самый большой)
const photoSizes = message.photo // Array<PhotoSize>
const bestPhoto = photoSizes[photoSizes.length - 1]
const photoBytes = await getTelegramFile(bestPhoto.file_id)

// Голос: .ogg формат
const voiceBytes = await getTelegramFile(message.voice.file_id)

// Документ: любой файл
const docBytes = await getTelegramFile(message.document.file_id)
```

### LLM-провайдер: абстракция для OpenAI-совместимых API

Все популярные LLM-провайдеры (OpenAI, Groq, OpenRouter, Together, etc.) используют
одинаковый формат API. Абстрагируем провайдер через конфиг:

```typescript
// Конфиг провайдеров — OpenAI-compatible API
const LLM_PROVIDERS = {
  openai: {
    baseUrl: 'https://api.openai.com/v1',
    whisperModel: 'whisper-1',
    chatModel: 'gpt-4o',
    visionModel: 'gpt-4o',
  },
  groq: {
    baseUrl: 'https://api.groq.com/openai/v1',
    whisperModel: 'whisper-large-v3-turbo',
    chatModel: 'llama-3.3-70b-versatile',
    visionModel: null, // нет vision
  },
  openrouter: {
    baseUrl: 'https://openrouter.ai/api/v1',
    whisperModel: null, // нет Whisper
    chatModel: 'anthropic/claude-sonnet-4',
    visionModel: 'anthropic/claude-sonnet-4',
  },
} as const

type ProviderName = keyof typeof LLM_PROVIDERS

// Текущий провайдер из env
const PROVIDER = (Deno.env.get('LLM_PROVIDER') || 'openai') as ProviderName
const API_KEY = Deno.env.get('LLM_API_KEY')!
const config = LLM_PROVIDERS[PROVIDER]
```

### Голос → Текст (Whisper, любой OpenAI-compatible провайдер)

```typescript
async function transcribeVoice(fileId: string): Promise<string> {
  const audioBytes = await getTelegramFile(fileId)

  // Whisper API (OpenAI / Groq / другой провайдер)
  const formData = new FormData()
  formData.append('file', new Blob([audioBytes], { type: 'audio/ogg' }), 'voice.ogg')
  formData.append('model', config.whisperModel!)
  formData.append('language', 'ru')

  const resp = await fetch(`${config.baseUrl}/audio/transcriptions`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${API_KEY}` },
    body: formData,
  })

  if (!resp.ok) throw new Error(`Whisper error: ${resp.status}`)
  const { text } = await resp.json()
  return text
}
```

### Фото → Текст (Vision / Мультимодальный LLM)

```typescript
async function analyzeImage(
  imageBytes: Uint8Array,
  prompt: string,
  mimeType = 'image/jpeg'
): Promise<string> {
  const base64 = btoa(String.fromCharCode(...imageBytes))

  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.visionModel,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: {
            url: `data:${mimeType};base64,${base64}`
          }},
        ],
      }],
      max_tokens: 4096,
    }),
  })

  if (!resp.ok) throw new Error(`Vision error: ${resp.status}`)
  const { choices } = await resp.json()
  return choices[0].message.content
}
```

### Текст → Текст (Chat Completions)

```typescript
async function chatCompletion(
  systemPrompt: string,
  userMessage: string,
  options?: { maxTokens?: number }
): Promise<string> {
  const resp = await fetch(`${config.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: config.chatModel,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      max_tokens: options?.maxTokens ?? 8192,
    }),
  })

  if (!resp.ok) throw new Error(`Chat error: ${resp.status}`)
  const { choices } = await resp.json()
  return choices[0].message.content
}
```

### Паттерн «Transparent Flow» — голос/фото как текст

Мультимодальные входы (голос, фото) конвертируются в текст и обрабатываются единым flow.
Пользователь видит: `"Распознано: текст..."` + те же кнопки действий что и для текста.

```
Голос → Whisper → текст ─┐
Фото  → Vision → текст ──┼─→ Единый text handler → кнопки действий
Текст ────────────────────┘
```

---

## 7. Состояние в Webhook Mode (Session Store)

В webhook mode `context.user_data` не сохраняется между запросами.
Решение: TTL-кеш на стороне сервера.

### TypeScript (Map + setTimeout)

```typescript
class SessionStore<T> {
  private store = new Map<string, { data: T; timer: ReturnType<typeof setTimeout> }>()
  private ttl: number

  constructor(ttlMs = 15 * 60 * 1000) { // 15 минут
    this.ttl = ttlMs
  }

  set(key: string, data: T): void {
    const existing = this.store.get(key)
    if (existing) clearTimeout(existing.timer)

    const timer = setTimeout(() => this.store.delete(key), this.ttl)
    this.store.set(key, { data, timer })
  }

  get(key: string): T | undefined {
    return this.store.get(key)?.data
  }

  delete(key: string): void {
    const existing = this.store.get(key)
    if (existing) {
      clearTimeout(existing.timer)
      this.store.delete(key)
    }
  }
}

// Использование
const pendingTokens = new SessionStore<{ vaishnavaId: string }>(15 * 60 * 1000)
```

### Python (cachetools TTLCache, thread-safe)

```python
from cachetools import TTLCache
from threading import Lock

class SessionStore:
    def __init__(self, maxsize=10000, ttl=3600):
        self._cache = TTLCache(maxsize=maxsize, ttl=ttl)
        self._lock = Lock()

    def get(self, user_id): ...
    def set(self, user_id, data): ...
    def delete(self, user_id): ...
```

---

## 8. Длинные сообщения (> 4096 символов)

Telegram лимит: 4096 символов на сообщение.

```typescript
function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text]

  const parts: string[] = []
  let current = ''

  for (const paragraph of text.split('\n\n')) {
    const candidate = current + paragraph + '\n\n'
    if (candidate.length > limit) {
      if (current) parts.push(current.trim())
      current = paragraph + '\n\n'
    } else {
      current = candidate
    }
  }

  if (current.trim()) parts.push(current.trim())
  return parts
}

// Отправка частями
const parts = splitMessage(longText)
for (const part of parts) {
  await sendWithRetry(() => sendMessage(chatId, part, { parse_mode: 'Markdown' }))
}
```

---

## 9. Обработка ошибок Telegram API

| Код | Причина | Действие |
|-----|---------|----------|
| 400 | Bad Request (невалидный Markdown, пустой текст) | Отправить без parse_mode |
| 403 | Forbidden (бот заблокирован) | SET telegram_chat_id = NULL |
| 429 | Too Many Requests (rate limit) | Retry через `retry_after` секунд |
| 502/504 | Telegram server error | Retry с backoff |

```typescript
async function safeSendMessage(chatId: number, text: string, parseMode?: string) {
  try {
    return await sendMessage(chatId, text, { parse_mode: parseMode })
  } catch (e: any) {
    if (e.message?.includes('400') && parseMode) {
      // Fallback: отправить без форматирования
      return await sendMessage(chatId, text)
    }
    if (e.message?.includes('403')) {
      // Бот заблокирован — пометить
      await markBotBlocked(chatId)
      return null
    }
    throw e
  }
}
```

---

## 10. Регистрация webhook

```bash
# Установить webhook (один раз при деплое)
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://<project>.supabase.co/functions/v1/telegram-webhook"}'

# Проверить текущий webhook
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"

# Удалить webhook (для перехода на polling)
curl -X POST "https://api.telegram.org/bot<TOKEN>/deleteWebhook"
```

### Для Supabase Edge Functions

```bash
supabase functions deploy telegram-webhook \
  --project-ref <PROJECT_ID> \
  --no-verify-jwt  # webhook от Telegram не содержит JWT
```

---

## 11. Безопасность webhook

Telegram не подписывает webhook запросы. Защита:

1. **Секретный путь**: `telegram-webhook?secret=RANDOM_STRING`
2. **IP whitelist** (если инфра позволяет): Telegram отправляет с IP 149.154.160.0/20, 91.108.4.0/22
3. **Проверка bot token** в URL: `/bot<TOKEN>/webhook` (непрактично для Edge Functions)

Рекомендация для MVP: секретный query-параметр.

```typescript
serve(async (req) => {
  const url = new URL(req.url)
  const secret = url.searchParams.get('secret')
  if (secret !== Deno.env.get('TELEGRAM_WEBHOOK_SECRET')) {
    return new Response('Unauthorized', { status: 401 })
  }
  // ... обработка
})
```

---

## 12. Чеклист при создании Telegram-бота

- [ ] Зарегистрировать бота через @BotFather (`/newbot`)
- [ ] Настроить команды (`/setcommands`)
- [ ] Сохранить BOT_TOKEN в секреты (Edge Function Secrets / .env)
- [ ] Создать Edge Function / API endpoint для webhook
- [ ] Установить webhook (`setWebhook`)
- [ ] Реализовать `/start TOKEN` (привязка)
- [ ] Реализовать `/stop` (отвязка)
- [ ] `send_with_retry` для всех отправок
- [ ] Обработка 403 (blocked bot → NULL chat_id)
- [ ] Rate limiting при broadcast (< 30 msg/sec)
- [ ] Splitting длинных сообщений (> 4096)
- [ ] Тестирование: отправить себе, проверить edge cases

---

## 13. Автообучение

**Правило:** При работе с Telegram-ботом в любом проекте — фиксируй новые паттерны, баги и решения.

### Когда записывать

- Обнаружен баг Telegram API, не описанный выше
- Найден workaround для ограничения провайдера (Groq, OpenRouter)
- Новый паттерн взаимодействия (inline mode, payments, etc.)
- Полезная утилита/хелпер, переиспользуемая между проектами
- Ошибка в существующем паттерне — исправить прямо здесь

### Как записывать

Добавь в секцию «Learned Patterns» ниже:

```
### [ДАТА] — Краткое описание
**Проект:** название
**Проблема:** что случилось
**Решение:** что сделали
**Код (если есть):**
```

### Learned Patterns

_Здесь будут накапливаться новые паттерны по мере работы с Telegram-ботами._
