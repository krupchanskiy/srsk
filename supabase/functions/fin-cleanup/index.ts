// ==================== fin-cleanup ====================
// Фоновая чистка непривязанных файлов finance-files старше 24ч
// (ТЗ 4.13 / Guide 13.2). Вызывается pg_cron'ом (миграция 199)
// с заголовком x-cleanup-key; секрет живёт только в vault —
// функция сверяет его через RPC fin_private_cleanup_secret.
// Deploy: mcp deploy_edge_function / supabase functions deploy
//         fin-cleanup --project-ref mymrijdfqeevoaocbzfy --no-verify-jwt
import { createClient } from "jsr:@supabase/supabase-js@2";

Deno.serve(async (req) => {
  const supa = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // авторизация: заголовок против секрета в vault
  const { data: secret, error: secErr } = await supa.rpc("fin_private_cleanup_secret");
  if (secErr || !secret || req.headers.get("x-cleanup-key") !== secret) {
    return new Response(JSON.stringify({ ok: false, error: "forbidden" }), {
      status: 403,
      headers: { "Content-Type": "application/json" },
    });
  }

  // кандидаты: файлы старше суток без строки fin_attachments
  const { data: files, error } = await supa.rpc("fin_private_unbound_files");
  if (error) {
    return new Response(JSON.stringify({ ok: false, error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  let removed = 0;
  const names = (files ?? []).map((f: { name: string }) => f.name);
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    const { error: delErr } = await supa.storage.from("finance-files").remove(batch);
    if (delErr) {
      return new Response(
        JSON.stringify({ ok: false, error: delErr.message, removed }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }
    removed += batch.length;
  }

  return new Response(JSON.stringify({ ok: true, candidates: names.length, removed }), {
    headers: { "Content-Type": "application/json" },
  });
});
