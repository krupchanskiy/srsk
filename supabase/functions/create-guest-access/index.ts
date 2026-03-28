import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    // Проверяем авторизацию вызывающего (менеджер)
    const authHeader = req.headers.get('Authorization')
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Не авторизован' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    const { vaishnava_id } = await req.json()
    if (!vaishnava_id) {
      return new Response(JSON.stringify({ error: 'vaishnava_id обязателен' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Service role клиент для admin-операций
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
    )

    // 1. Получаем данные гостя
    const { data: guest, error: guestError } = await supabaseAdmin
      .from('vaishnavas')
      .select('id, first_name, last_name, spiritual_name, email, phone, user_id')
      .eq('id', vaishnava_id)
      .single()

    if (guestError || !guest) {
      return new Response(JSON.stringify({ error: 'Гость не найден' }), {
        status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Проверяем, есть ли уже доступ
    if (guest.user_id) {
      return new Response(JSON.stringify({ error: 'Доступ уже создан' }), {
        status: 409, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    if (!guest.email) {
      return new Response(JSON.stringify({ error: 'У гостя не указан email' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 2. Генерируем временный пароль
    const chars = 'abcdefghjkmnpqrstuvwxyz23456789'
    let password = 'seva'
    for (let i = 0; i < 4; i++) {
      password += chars[Math.floor(Math.random() * chars.length)]
    }
    password += Math.floor(Math.random() * 90 + 10) // 2 цифры

    // 3. Создаём auth user через Admin API
    const { data: authData, error: authError } = await supabaseAdmin.auth.admin.createUser({
      email: guest.email,
      password: password,
      email_confirm: true, // Без подтверждения
      user_metadata: {
        full_name: `${guest.first_name || ''} ${guest.last_name || ''}`.trim(),
        spiritual_name: guest.spiritual_name || '',
      }
    })

    if (authError) {
      console.error('Auth create error:', authError)
      return new Response(JSON.stringify({ error: `Ошибка создания аккаунта: ${authError.message}` }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // 4. Привязываем user_id к vaishnavas
    const { error: updateError } = await supabaseAdmin
      .from('vaishnavas')
      .update({ user_id: authData.user.id, is_active: true })
      .eq('id', vaishnava_id)

    if (updateError) {
      console.error('Update vaishnavas error:', updateError)
    }

    // 5. Назначаем роль guest
    const { data: guestRole } = await supabaseAdmin
      .from('roles')
      .select('id')
      .eq('code', 'guest')
      .single()

    if (guestRole) {
      await supabaseAdmin
        .from('user_roles')
        .insert({
          user_id: authData.user.id,
          role_id: guestRole.id,
        })
        .select()
    }

    return new Response(JSON.stringify({
      success: true,
      email: guest.email,
      password: password,
      user_id: authData.user.id,
    }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })

  } catch (err) {
    console.error('Unexpected error:', err)
    return new Response(JSON.stringify({ error: 'Внутренняя ошибка сервера' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
