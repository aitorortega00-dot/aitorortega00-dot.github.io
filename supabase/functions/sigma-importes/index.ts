// KUBEL — Importe de los servicios cerrados para Facturación (panel admin) · 21/10/2026
// Para cada fila de facturación SIN importe de un servicio SIGMA cerrado, lee la pestaña «Presupuesto» del portal
// (servicio JSON valuations-initial-data, SOLO LECTURA) y, si todas las partidas están ACEPTADAS, anota el importe
// total de la valoración (totals.totSubtotalP, el «importe total» que muestra el portal al final de la pestaña).
// Si hay partidas pendientes o rechazadas no anota nada y deja una nota para revisar; se vuelve a mirar cada 6 h.
// Nunca pisa un importe ya escrito. Lo llama pg_cron (minutos 12 y 42) con la cabecera secreta x-kubel-secreto.
// ?ver=29339818,29426060&cuenta=VLL → devuelve la respuesta del portal tal cual (para revisar).
import postgres from 'npm:postgres@3.4.4';
const BASE = 'https://web.multiasistencia.com/w3multi/';
const API = 'https://mawmods.plataforma-smart.com/me';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const dec = new TextDecoder('windows-1252');
const enc = (s: string) => encodeURIComponent(s);
class Sesion {
  cookies = new Map<string, string>();
  async pedir(ruta: string, form?: Record<string, string>): Promise<string> {
    let url = BASE + ruta, method = form ? 'POST' : 'GET';
    let body: string | undefined = form ? Object.entries(form).map(([k, v]) => enc(k) + '=' + enc(v)).join('&') : undefined;
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: BASE, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      for (const c of res.headers.getSetCookie()) { const kv = c.split(';')[0]; const j = kv.indexOf('='); if (j > 0) this.cookies.set(kv.slice(0, j).trim(), kv.slice(j + 1).trim()); }
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, url).href; method = 'GET'; body = undefined; await res.body?.cancel(); continue; }
      if (!res.ok) throw new Error(`Portal ${res.status}`);
      return dec.decode(await res.arrayBuffer());
    }
    throw new Error('redirecciones');
  }
}
const pideClave = (h: string) => /name=["']?clave["'\s>]/i.test(h);
async function entrar(s: Sesion, usuario: string, clave: string) {
  await s.pedir('acceso.php');
  const h = await s.pedir('acceso.php', { usuario, clave });
  if (!pideClave(h) && /frepasos/i.test(h)) return;
  const ini = await s.pedir('inicio.php');
  if (pideClave(ini) || !/frepasos/i.test(ini)) throw new Error('login');
}
const cab = (ut?: string) => ({ 'Content-Type': 'application/json', Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'valprincipal.php', ...(ut ? { Authorization: `Bearer ${ut}` } : {}) });
let secreto: string | null = null;
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try { const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`; secreto = f?.valor ?? null; } finally { await sql.end(); }
  return secreto;
}
async function pase(s: Sesion, n: string) {
  const html = await s.pedir(`valprincipal.php?reparacion=${n}&modo=0`);
  if (pideClave(html)) throw new Error('Sesión caducada');
  return (html.match(/<multiasistencia-valoraciones[^>]*\sut="([^"]+)"/i) || [])[1] || null;
}
// deno-lint-ignore no-explicit-any
async function leer(ut: string, n: string): Promise<any> {
  for (let i = 0; i < 2; i++) {
    try {
      const r = await fetch(`${API}/valuations-initial-data`, { method: 'POST', signal: AbortSignal.timeout(20000), body: JSON.stringify({ reparation: n }), headers: cab(ut) });
      if (r.ok) { const j = await r.json(); if (j?.success) return j; } else await r.body?.cancel();
    } catch (_) { /* reintento */ }
    await new Promise((res) => setTimeout(res, 4000));
  }
  return null;
}
const num = (t: unknown) => { const v = parseFloat(String(t ?? '').replace(/\./g, '').replace(',', '.')); return isFinite(v) ? Math.round(v * 100) / 100 : null; };
const euros = (v: number) => v.toFixed(2).replace('.', ',') + ' €';

// deno-lint-ignore no-explicit-any
function decidir(j: any): { importe: number | null; nota: string | null } {
  const lineas: { status?: string }[] = j?.data?.budgetLinesList || [];
  const total = num(j?.data?.totals?.totSubtotalP);
  if (!lineas.length) return { importe: null, nota: 'Sin presupuesto en SIGMA' };
  const est = lineas.map((l) => String(l.status || ''));
  if (est.every((e) => /ACEPTAD/i.test(e)) && total != null && total > 0) return { importe: total, nota: null };
  if (est.some((e) => /^pendiente/i.test(e))) return { importe: null, nota: 'Presupuesto pendiente de aceptar' + (total ? ` (${euros(total)})` : '') };
  if (est.some((e) => /ACEPTAD/i.test(e))) return { importe: null, nota: `Partidas rechazadas: revisar (SIGMA ${euros(total ?? 0)})` };
  return { importe: null, nota: 'Presupuesto rechazado' };
}

Deno.serve(async (req) => {
  const sec = await leerSecreto();
  if (!sec || req.headers.get('x-kubel-secreto') !== sec) return new Response('no', { status: 401 });
  const url = new URL(req.url);
  const ver = (url.searchParams.get('ver') || '').split(',').filter(Boolean);
  if (ver.length) {
    const c = url.searchParams.get('cuenta') || 'VLL';
    const s = new Sesion();
    await entrar(s, Deno.env.get(`SIGMA_${c}_USUARIO`)!, Deno.env.get(`SIGMA_${c}_CLAVE`)!);
    const ut = await pase(s, ver[0]);
    const out: Record<string, unknown> = {};
    for (const n of ver) { const j = await leer(ut!, n); out[n] = { decision: decidir(j), respuesta: j }; }
    return new Response(JSON.stringify(out), { headers: { 'Content-Type': 'application/json' } });
  }
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  const resumen: Record<string, unknown>[] = [];
  try {
    const filas = await sql`
      select f.id, p.numero_servicio, p.sigma_cuenta from public.facturacion f join public.partes p on p.id = f.parte_id
       where f.importe is null and upper(coalesce(f.compania, '')) = 'SIGMA' and p.sigma_cuenta is not null and p.estado = 'cerrado'
         and (f.importe_leido_en is null or f.importe_leido_en < now() - interval '6 hours')
       order by f.importe_leido_en nulls first limit 60`;
    for (const cuenta of ['VLL', 'PAL']) {
      const mias = filas.filter((f) => f.sigma_cuenta === cuenta);
      const r = { cuenta, servicios: mias.length, anotados: 0, notas: 0, fallidos: 0, error: null as string | null };
      resumen.push(r);
      if (!mias.length) continue;
      try {
        const s = new Sesion();
        await entrar(s, Deno.env.get(`SIGMA_${cuenta}_USUARIO`)!, Deno.env.get(`SIGMA_${cuenta}_CLAVE`)!);
        const ut = await pase(s, mias[0].numero_servicio);
        if (!ut) throw new Error('No se pudo abrir la pestaña Presupuesto');
        for (const f of mias) {
          const j = await leer(ut, f.numero_servicio);
          if (!j) { r.fallidos++; continue; }
          const d = decidir(j);
          // Nunca pisa un importe escrito entretanto a mano
          await sql`update public.facturacion set importe = coalesce(importe, ${d.importe}::numeric),
                      importe_origen = case when importe is null and ${d.importe}::numeric is not null then 'presupuesto' else importe_origen end,
                      importe_nota = ${d.nota}, importe_leido_en = now() where id = ${f.id}`;
          if (d.importe != null) r.anotados++; else r.notas++;
        }
      } catch (err) { r.error = (err as Error).message; console.error(cuenta, err); }
    }
  } finally { await sql.end(); }
  console.log('importes', JSON.stringify(resumen));
  return new Response(JSON.stringify({ resultados: resumen }), { headers: { 'Content-Type': 'application/json' } });
});
