import { serve } from 'https://deno.land/std@0.177.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

serve(async (req) => {
    try {
        const { record } = await req.json()

        // record — новая строка из crm_deals (INSERT trigger)
        const dealId = record.id
        const retreatId = record.retreat_id
        const vaishnavaId = record.vaishnava_id
        const source = record.source || 'form'

        const supabaseUrl = Deno.env.get('SUPABASE_URL')!
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        const botToken = Deno.env.get('CRM_TELEGRAM_BOT_TOKEN')!
        const chatId = Deno.env.get('CRM_TELEGRAM_CHAT_ID')!

        const db = createClient(supabaseUrl, serviceRoleKey)

        // Загружаем данные гостя
        const { data: guest } = await db
            .from('vaishnavas')
            .select('spiritual_name, first_name, last_name, phone, email, telegram')
            .eq('id', vaishnavaId)
            .single()

        // Загружаем ретрит
        const { data: retreat } = await db
            .from('retreats')
            .select('name_ru, start_date, end_date')
            .eq('id', retreatId)
            .single()

        // Формируем имя гостя
        const guestName = guest?.spiritual_name ||
            [guest?.first_name, guest?.last_name].filter(Boolean).join(' ') ||
            'Неизвестный'

        // Контакты
        const contacts = [
            guest?.phone ? `📞 ${guest.phone}` : null,
            guest?.email ? `📧 ${guest.email}` : null,
            guest?.telegram ? `✈️ @${guest.telegram.replace('@', '')}` : null,
        ].filter(Boolean).join('\n')

        // Заметки
        const notes = record.notes ? `\n💬 ${record.notes}` : ''

        const message = `🆕 *Новая заявка!*\n\n` +
            `👤 *${guestName}*\n` +
            `${contacts}\n` +
            `🏕 ${retreat?.name_ru || 'Ретрит'}\n` +
            `📅 ${retreat?.start_date || ''} — ${retreat?.end_date || ''}\n` +
            `📌 Источник: ${source}` +
            `${notes}\n\n` +
            `[Открыть сделку](https://in.rupaseva.com/crm/deal.html?id=${dealId})`

        // Отправляем в Telegram
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: message,
                parse_mode: 'Markdown',
                disable_web_page_preview: true,
            }),
        })

        return new Response(JSON.stringify({ ok: true }), {
            headers: { 'Content-Type': 'application/json' },
        })
    } catch (error) {
        console.error('Error:', error)
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
        })
    }
})
