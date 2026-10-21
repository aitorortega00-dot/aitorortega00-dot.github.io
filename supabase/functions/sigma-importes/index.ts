// KUBEL — Importe de los servicios cerrados para Facturación (panel admin) · 21/10/2026
// Comprobación AL CERRARSE: para cada fila de facturación de un servicio SIGMA ya cerrado y aún sin comprobar
// (importe_cierre_en vacío), lee la pestaña «Presupuesto» del portal (valuations-initial-data, SOLO LECTURA):
//   · todas las partidas ACEPTADAS → importe total de la valoración (totals.totSubtotalP, el que muestra el portal):
//       - sin importe → se anota;  - igual → OK;  - distinto → se pone el de SIGMA (manda el último) con aviso
//         «Cambió al cerrar: de X a Y».   Queda comprobado.
//   · pendientes / rechazadas / sin presupuesto → nota para revisar y se vuelve a mirar cada 6 h (30 días como mucho).
// (Con el servicio abierto, el importe lo pone al quedar ACEPTADO el disparador partes_facturacion_ptto en los gremios
//  11A, 77A, 30A, 10A, 76A, y este robot con ?abiertos=1 en todos; en ambos casos SOLO si un operario ha tenido visita.)
// Lo llama pg_cron (minutos 12 y 42) con la cabecera secreta x-kubel-secreto.
// ?abiertos=1 (pg_cron cada hora, minuto 52) → servicios SIGMA ABIERTOS (todos los gremios) en los que un operario ya ha
//   tenido visita en KUBEL (public.tiene_visita): si el presupuesto está aceptado (sin partidas pendientes) el servicio
//   entra en Facturación con ese importe (fecha y operario de la visita). Si cambia, manda el último.
//   Un presupuesto aceptado SIN visita no es facturación real: no entra (decisión del usuario 21/10).
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
async function leer(ut: string, n: string, intentos = 2): Promise<any> {
  for (let i = 0; i < intentos; i++) {
    try {
      const r = await fetch(`${API}/valuations-initial-data`, { method: 'POST', signal: AbortSignal.timeout(20000), body: JSON.stringify({ reparation: n }), headers: cab(ut) });
      if (r.ok) { const j = await r.json(); if (j?.success) return j; } else await r.body?.cancel();
    } catch (_) { /* reintento */ }
    if (i + 1 < intentos) await new Promise((res) => setTimeout(res, 4000));
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
  if (est.some((e) => /^pendiente/i.test(e))) return { importe: null, nota: 'Presupuesto pendiente de aceptar' + (total ? ` (${euros(total)})` : '') };
  // Con partidas rechazadas el total del portal solo suma las aceptadas (comprobado con 29412780): se anota con aviso
  const acep = est.filter((e) => /ACEPTAD/i.test(e)).length;
  if (acep && total != null && total > 0) return { importe: total, nota: acep < est.length ? 'Tiene partidas rechazadas: comprueba el importe' : null };
  return { importe: null, nota: 'Presupuesto rechazado' };
}

const PARALELO = 4; // por cuenta
const TOPE_MS = 110_000; // las funciones se cortan a los 150 s: lo que no dé tiempo, en la siguiente pasada
// Fecha de la última aceptación de las partidas («dd/mm/aaaa» → aaaa-mm-dd)
// deno-lint-ignore no-explicit-any
function fechaAceptacion(j: any): string | null {
  let m: string | null = null;
  for (const l of j?.data?.budgetLinesList || []) {
    const x = String(l.statusDate || '').match(/(\d{2})\/(\d{2})\/(\d{4})/);
    if (x && /ACEPTAD/i.test(String(l.status || ''))) { const f = `${x[3]}-${x[2]}-${x[1]}`; if (!m || f > m) m = f; }
  }
  return m;
}
// deno-lint-ignore no-explicit-any
async function revisarAbiertos(sql: any, resumen: Record<string, unknown>[]) {
  const lista = await sql`
    select p.id, p.numero_servicio, p.sigma_cuenta from public.partes p join public.companias c on c.id = p.compania_id
     where c.nombre = 'SIGMA' and p.sigma_en_curso and p.estado not in ('cerrado', 'anulado') and p.sigma_cuenta is not null
       and public.tiene_visita(p.id)
       and not exists (select 1 from public.facturacion f where f.parte_id = p.id and f.liquidado)
     order by random()`; // orden al azar: si no da tiempo a todos, en las siguientes pasadas les toca a los demás
  const inicio = Date.now();
  // Las dos cuentas a la vez (cada una con su sesión), para que a Palencia también le dé tiempo
  await Promise.all(['VLL', 'PAL'].map(async (cuenta) => {
    // deno-lint-ignore no-explicit-any
    const mias = lista.filter((x: any) => x.sigma_cuenta === cuenta);
    const r = { cuenta, servicios: mias.length, leidos: 0, aceptados: 0, cambios: 0, fallidos: 0, error: null as string | null };
    resumen.push(r);
    if (!mias.length) return;
    try {
      const s = new Sesion();
      await entrar(s, Deno.env.get(`SIGMA_${cuenta}_USUARIO`)!, Deno.env.get(`SIGMA_${cuenta}_CLAVE`)!);
      const ut = await pase(s, mias[0].numero_servicio);
      if (!ut) throw new Error('No se pudo abrir la pestaña Presupuesto');
      let i = 0;
      await Promise.all(Array.from({ length: PARALELO }, async () => {
        while (i < mias.length && Date.now() - inicio < TOPE_MS) {
          const p = mias[i++];
          const j = await leer(ut, p.numero_servicio, 1);
          r.leidos++;
          if (!j) { r.fallidos++; continue; }
          const d = decidir(j);
          if (d.importe == null) continue; // sin aceptar todavía: no entra
          r.aceptados++;
          await sql`select public.facturacion_alta(${p.id}::uuid, ${fechaAceptacion(j)}::date, null)`;
          const [f] = await sql`select id, importe from public.facturacion where parte_id = ${p.id} and not liquidado`;
          if (!f) continue;
          const antes = f.importe == null ? null : Number(f.importe);
          if (antes != null && Math.abs(antes - d.importe) < 0.01) continue; // sin cambios
          const nota = antes == null ? d.nota : `Presupuesto cambiado en SIGMA: de ${euros(antes)} a ${euros(d.importe)}`;
          await sql`update public.facturacion set importe = ${d.importe}::numeric, importe_origen = 'presupuesto', importe_nota = ${nota},
                      importe_leido_en = now() where id = ${f.id}`;
          r.cambios++;
        }
      }));
    } catch (err) { r.error = (err as Error).message; console.error(cuenta, err); }
  }));
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
  if (url.searchParams.get('abiertos') === '1') {
    try { await revisarAbiertos(sql, resumen); } finally { await sql.end(); }
    console.log('importes abiertos', JSON.stringify(resumen));
    return new Response(JSON.stringify({ abiertos: true, resultados: resumen }), { headers: { 'Content-Type': 'application/json' } });
  }
  try {
    const filas = await sql`
      select f.id, f.importe, f.importe_origen, p.numero_servicio, p.sigma_cuenta from public.facturacion f join public.partes p on p.id = f.parte_id
       where f.importe_cierre_en is null and not f.liquidado and upper(coalesce(f.compania, '')) = 'SIGMA'
         and p.sigma_cuenta is not null and p.estado = 'cerrado' and f.creado_en > now() - interval '30 days'
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
          if (!j) { r.fallidos++; await sql`update public.facturacion set importe_leido_en = now() where id = ${f.id}`; continue; }
          const d = decidir(j);
          const antes = f.importe == null ? null : Number(f.importe);
          if (d.importe == null) {
            // Aún sin aceptar: no se toca el importe; se vuelve a mirar
            await sql`update public.facturacion set importe_nota = ${antes == null ? d.nota : 'Al cerrar: ' + d.nota}, importe_leido_en = now() where id = ${f.id}`;
            r.notas++; continue;
          }
          let importe = antes, origen = f.importe_origen, nota: string | null = d.nota;
          if (antes == null) { importe = d.importe; origen = 'presupuesto'; }
          else if (Math.abs(antes - d.importe) >= 0.01) {
            // Al cerrar manda SIEMPRE el último importe de SIGMA (decisión del usuario 21/10); se avisa del anterior
            importe = d.importe; origen = 'presupuesto'; nota = `Cambió al cerrar: de ${euros(antes)} a ${euros(d.importe)}`;
          }
          await sql`update public.facturacion set importe = ${importe}::numeric, importe_origen = ${origen}, importe_nota = ${nota},
                      importe_leido_en = now(), importe_cierre_en = now() where id = ${f.id} and not liquidado`;
          r.anotados++;
        }
      } catch (err) { r.error = (err as Error).message; console.error(cuenta, err); }
    }
  } finally { await sql.end(); }
  console.log('importes', JSON.stringify(resumen));
  return new Response(JSON.stringify({ resultados: resumen }), { headers: { 'Content-Type': 'application/json' } });
});
