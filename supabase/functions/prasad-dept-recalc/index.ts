// ==================== prasad-dept-recalc ====================
// Питание по департаментам — итоги по месяцам (мигр. 779, ВГ 04.11).
// Раз в час (pg_cron, заголовок x-prasad-key) пересчитывает месяцы, у которых изменились
// исходные данные (отпечаток fin_private_prasad_dept_fingerprint), ТЕМ ЖЕ js/kitchen-cost.js,
// что и сайт: файлы кладёт рядом scripts/deploy-prasad-dept.sh (папка _lib, в git не идёт).
// Если kitchen-cost.js на сайте уже другой — пишет code_matches_site = false (⚠ на Кухне): передеплоить.
// Deploy: scripts/deploy-prasad-dept.sh
import { createClient } from "jsr:@supabase/supabase-js@2";
import "./_lib/env.js";
import "./_lib/date-utils.js";
import "./_lib/eating-utils.js";
import "./_lib/kitchen-cost.js";
import { SOURCES } from "./_lib/version.js";

// реальные цены и меню — с августа 2026
const START = "2026-08-01";
const SITE = "https://in.rupaseva.com/";
const BUDGET_MS = 240_000;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function sha256(text: string) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// совпадает ли расчёт здесь с файлами на сайте
async function codeMatchesSite() {
  try {
    for (const [path, hash] of Object.entries(SOURCES)) {
      const r = await fetch(SITE + path, { cache: "no-store" });
      if (!r.ok || await sha256(await r.text()) !== hash) return false;
    }
    return true;
  } catch {
    return null;
  }
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
function monthsUntilNow() {
  const out: string[] = [];
  const now = new Date();
  for (let d = new Date(START + "T00:00:00Z"); d <= now; d.setUTCMonth(d.getUTCMonth() + 1)) out.push(iso(d));
  return out.reverse();   // свежие — первыми: они меняются чаще
}
const monthEnd = (m: string) => {
  const d = new Date(m + "T00:00:00Z");
  return iso(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)));
};

Deno.serve(async (req) => {
  const supa = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: secret, error: secErr } = await supa.rpc("fin_private_prasad_dept_secret");
  if (secErr || !secret || req.headers.get("x-prasad-key") !== secret) return json({ ok: false, error: "forbidden" }, 403);

  // eating-utils берёт базу из Layout.db; ошибка подсчёта вкушающих — прерывает месяц
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  g.Layout = { db: supa, handleError: (err: unknown) => { throw err; } };
  const KC = g.KitchenCost;

  const body = await req.json().catch(() => ({}));
  const force: string[] = Array.isArray(body?.months) ? body.months : [];
  const started = Date.now();
  const codeHash = Object.values(SOURCES).join("|");
  const matches = await codeMatchesSite();

  const { data: loc } = await supa.from("locations").select("id").eq("slug", "main").single();
  const { data: runs } = await supa.rpc("fin_private_prasad_dept_runs");
  const known = new Map((runs ?? []).map((r: { month: string; fingerprint: string }) => [r.month, r.fingerprint]));

  const done: unknown[] = [];
  for (const month of monthsUntilNow()) {
    if (Date.now() - started > BUDGET_MS) break;
    const { data: fp, error: fpErr } = await supa.rpc("fin_private_prasad_dept_fingerprint", { p_month: month });
    if (fpErr) { await supa.rpc("fin_private_prasad_dept_error", { p_month: month, p_error: fpErr.message }); continue; }
    const fingerprint = `${fp}|${await sha256(codeHash)}`;
    if (known.get(month) === fingerprint && !force.includes(month)) continue;
    try {
      const from = month, to = monthEnd(month);
      const res = await KC.calculate(supa, loc!.id, from, to);
      const detail = await KC.loadDetail(supa, from, to);
      const src = await KC.loadDeptSources(supa, detail);
      const dep = KC.byDepartment(res, detail, src);
      const names = await KC.loadDeptNames(supa, dep);
      const rows = KC.deptSummary(dep, names);
      let costTotal = 0;
      for (const ev of Object.values(res.cells) as Record<string, Record<string, number>>[]) {
        for (const c of Object.values(ev)) costTotal += c.food + c.dishware + c.external + c.overheadRetreat + c.overheadGeneral;
      }
      const detailTotal = KC.detailTotal(res, detail);
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const meta = { cost_total: r2(costTotal), detail_total: r2(detailTotal), code_matches_site: matches,
                     error: res.warnings.overheadError || null };
      const { error } = await supa.rpc("fin_private_save_prasad_dept", { p_month: month, p_fingerprint: fingerprint, p_rows: rows, p_meta: meta });
      if (error) throw error;
      done.push({ month, ...meta, rows: rows.length });
    } catch (err) {
      const msg = (err as { message?: string })?.message || String(err);
      await supa.rpc("fin_private_prasad_dept_error", { p_month: month, p_error: msg });
      done.push({ month, error: msg });
    }
  }
  return json({ ok: true, code_matches_site: matches, done, ms: Date.now() - started });
});
