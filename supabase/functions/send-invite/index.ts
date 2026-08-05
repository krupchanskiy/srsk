import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const ALLOWED_ORIGIN = 'https://in.rupaseva.com';

const corsHeaders = {
  'Access-Control-Allow-Origin': ALLOWED_ORIGIN,
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
    const { email, vaishnavId, mode = 'email' } = await req.json();

    if (!email || !vaishnavId) {
      return new Response(
        JSON.stringify({ error: 'Email and vaishnavId are required' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (!['email', 'link'].includes(mode)) {
      return new Response(
        JSON.stringify({ error: 'Unsupported invite mode' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // Проверяем профиль и не позволяем связать чужой email.
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

    if ((vaishnava.email || '').trim().toLowerCase() !== email.trim().toLowerCase()) {
      return new Response(
        JSON.stringify({ error: 'Email does not match the profile' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const siteUrl = (Deno.env.get('SITE_URL') || 'https://in.rupaseva.com').replace(/\/$/, '');
    // И приглашение, и повторная выдача доступа ведут на установку нового пароля.
    // После назначения роли AB Kitchen страница сама вернёт пользователя в кухню.
    const redirectUrl = `${siteUrl}/reset-password/`;
    const metadata = {
      vaishnava_id: vaishnavId,
      full_name: vaishnava.spiritual_name || `${vaishnava.first_name || ''}`
    };

    let authUserId = vaishnava.user_id as string | null;

    // Профиль мог быть создан раньше Auth-пользователя или остаться несвязанным
    // после неудачного приглашения. Ищем существующий Auth-аккаунт по email.
    if (!authUserId) {
      let page = 1;
      while (!authUserId) {
        const { data: usersPage, error: listError } = await supabaseAdmin.auth.admin.listUsers({
          page,
          perPage: 200
        });
        if (listError) throw listError;
        const existing = usersPage.users.find(
          candidate => (candidate.email || '').toLowerCase() === email.trim().toLowerCase()
        );
        if (existing) {
          authUserId = existing.id;
          break;
        }
        if (usersPage.users.length < 200) break;
        page += 1;
      }
    }

    if (authUserId) {
      const { error: linkError } = await supabaseAdmin
        .from('vaishnavas')
        .update({ user_id: authUserId })
        .eq('id', vaishnavId);
      if (linkError) throw linkError;

      if (mode === 'link') {
        const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
          type: 'recovery',
          email,
          options: { redirectTo: redirectUrl }
        });
        if (linkError) throw linkError;
        return new Response(
          JSON.stringify({ success: true, url: linkData.properties.action_link, accountRecovered: true }),
          { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        );
      }

      const { error: recoveryError } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: redirectUrl
      });
      if (recoveryError) throw recoveryError;
      return new Response(
        JSON.stringify({ success: true, message: 'Password setup link sent', accountRecovered: true }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    if (mode === 'link') {
      const { data: linkData, error: linkError } = await supabaseAdmin.auth.admin.generateLink({
        type: 'invite',
        email,
        options: { redirectTo: redirectUrl, data: metadata }
      });
      if (linkError) throw linkError;

      const createdUserId = linkData.user?.id;
      if (!createdUserId) throw new Error('Invite link did not create an Auth user');
      const { error: profileLinkError } = await supabaseAdmin
        .from('vaishnavas')
        .update({ user_id: createdUserId })
        .eq('id', vaishnavId);
      if (profileLinkError) throw profileLinkError;

      return new Response(
        JSON.stringify({ success: true, url: linkData.properties.action_link }),
        { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const { data: inviteData, error: inviteError } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      redirectTo: redirectUrl,
      data: metadata
    });
    if (inviteError) throw inviteError;
    if (inviteData.user?.id) {
      const { error: profileLinkError } = await supabaseAdmin
        .from('vaishnavas')
        .update({ user_id: inviteData.user.id })
        .eq('id', vaishnavId);
      if (profileLinkError) throw profileLinkError;
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
