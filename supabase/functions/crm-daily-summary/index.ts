// CRM Утренняя сводка — отправляет в Telegram-чат менеджеров
// Вызывается по cron ежедневно в 8:00 IST (2:30 UTC)

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const telegramBotToken = Deno.env.get('CRM_TELEGRAM_BOT_TOKEN') || Deno.env.get('TELEGRAM_BOT_TOKEN')
    const telegramChatId = Deno.env.get('CRM_TELEGRAM_CHAT_ID')

    if (!telegramBotToken || !telegramChatId) {
      return new Response(JSON.stringify({ error: 'Telegram не настроен' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const db = createClient(supabaseUrl, serviceKey)

    const today = new Date().toISOString().split('T')[0]
    const yesterday = new Date(Date.now() - 86400000).toISOString()

    // 1. Новые заявки за 24ч
    const { count: newToday } = await db
      .from('crm_deals')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', yesterday)

    // 2. Без контакта (lead)
    const { count: newLeads } = await db
      .from('crm_deals')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'lead')

    // 3. Без контакта >24ч — АЛЕРТ
    const { data: staleDeals } = await db
      .from('crm_deals')
      .select('id, created_at, vaishnavas!inner(spiritual_name, first_name, last_name)')
      .eq('status', 'lead')
      .lt('created_at', yesterday)
      .limit(10)

    // 4. Просроченные задачи (completed_at IS NULL и due_date < today)
    const { count: overdueTasks } = await db
      .from('crm_tasks')
      .select('*', { count: 'exact', head: true })
      .is('completed_at', null)
      .lt('due_date', today)

    // 5. Задачи на сегодня
    const { count: todayTasks } = await db
      .from('crm_tasks')
      .select('*', { count: 'exact', head: true })
      .is('completed_at', null)
      .eq('due_date', today)

    // 6. Общая статистика
    const { data: activeDeals } = await db
      .from('crm_deals')
      .select('status, total_paid')
      .neq('status', 'cancelled')

    const totalDeals = activeDeals?.length || 0
    const totalRevenue = activeDeals?.reduce((sum: number, d: any) => sum + (d.total_paid || 0), 0) || 0
    const paidCount = activeDeals?.filter((d: any) => d.total_paid > 0).length || 0

    // Формируем сообщение
    const lines = [
      '📊 *CRM — Утренняя сводка*',
      '',
      `📬 Новых заявок за 24ч: *${newToday || 0}*`,
      `🔴 Без контакта (lead): *${newLeads || 0}*`,
      '',
    ]

    // Алерт: сделки без контакта >24ч
    if (staleDeals && staleDeals.length > 0) {
      lines.push('🚨 *Без контакта >24ч:*')
      staleDeals.forEach((d: any) => {
        const guest = d.vaishnavas
        const name = guest?.spiritual_name ||
          [guest?.first_name, guest?.last_name].filter(Boolean).join(' ') || '?'
        const hours = Math.round((Date.now() - new Date(d.created_at).getTime()) / 3600000)
        lines.push(`  ⏰ ${name} — ${hours}ч назад`)
      })
      lines.push('')
    }

    lines.push(
      `📋 Задач на сегодня: *${todayTasks || 0}*`,
      overdueTasks ? `⚠️ Просроченных задач: *${overdueTasks}*` : '✅ Просроченных задач нет',
      '',
      `📈 Всего сделок: ${totalDeals} | Оплатили: ${paidCount}`,
      `💰 Выручка: ₹${totalRevenue.toLocaleString('en-IN')}`,
    )

    const message = lines.join('\n')

    // Отправляем в Telegram
    const tgResp = await fetch(`https://api.telegram.org/bot${telegramBotToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: telegramChatId,
        text: message,
        parse_mode: 'Markdown'
      })
    })

    const tgResult = await tgResp.json()

    return new Response(JSON.stringify({
      success: true,
      stats: { newToday, newLeads, staleCount: staleDeals?.length || 0, todayTasks, overdueTasks, totalDeals, paidCount, totalRevenue },
      telegram: tgResult.ok
    }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
