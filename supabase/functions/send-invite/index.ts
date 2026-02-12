import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Получаем service role client для admin операций
    const supabaseAdmin = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Получаем обычный client для проверки прав вызывающего
    const authHeader = req.headers.get('Authorization');
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

    // Проверяем что вызывающий авторизован и имеет права
    const { data: { user }, error: authError } = await supabase.auth.getUser();
    if (authError || !user) {
      return new Response(
        JSON.stringify({ error: 'Unauthorized' }),
        { status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Проверяем права (superuser или manage_users)
    const { data: callerVaishnava } = await supabaseAdmin
      .from('vaishnavas')
      .select('is_superuser')
      .eq('user_id', user.id)
      .single();

    const { data: superuserCheck } = await supabaseAdmin
      .from('superusers')
      .select('user_id')
      .eq('user_id', user.id)
      .maybeSingle();

    const isSuperuser = callerVaishnava?.is_superuser || !!superuserCheck;

    if (!isSuperuser) {
      // Проверяем permission manage_users
      const { data: hasPermission } = await supabaseAdmin.rpc('has_permission', {
        p_user_id: user.id,
        p_permission_code: 'manage_users'
      });

      if (!hasPermission) {
        return new Response(
          JSON.stringify({ error: 'Insufficient permissions' }),
          { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }
    }

    // Получаем данные запроса
    const { email, vaishnavId } = await req.json();

    if (!email) {
      return new Response(
        JSON.stringify({ error: 'Email is required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Проверяем что vaishnava существует и не имеет user_id
    const { data: vaishnava, error: vaishError } = await supabaseAdmin
      .from('vaishnavas')
      .select('id, email, user_id, spiritual_name, first_name')
      .eq('id', vaishnavId)
      .single();

    if (vaishError || !vaishnava) {
      return new Response(
        JSON.stringify({ error: 'Vaishnava not found' }),
        { status: 404, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (vaishnava.user_id) {
      return new Response(
        JSON.stringify({ error: 'User already has an account', alreadyHasAccount: true }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Отправляем invite (создаст пользователя если не существует)
    const redirectUrl = `${Deno.env.get('SITE_URL') || 'https://in.rupaseva.com'}/guest-portal/auth-callback.html`;

    const { error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectUrl,
      data: {
        vaishnava_id: vaishnavId,
        full_name: vaishnava.spiritual_name || `${vaishnava.first_name || ''}`
      }
    });

    if (inviteError) {
      console.error('Invite error:', inviteError);
      return new Response(
        JSON.stringify({ error: inviteError.message }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    return new Response(
      JSON.stringify({ success: true, message: 'Invite sent successfully' }),
      { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Function error:', error);
    return new Response(
      JSON.stringify({ error: error.message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  }
});
