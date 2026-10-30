// KUBEL — Robot de PRESUPUESTOS del portal SIGMA (Multiasistencia, proveedores) · 21/10/2026
// Gremios 11A, 77A, 30A, 10A y 76A + fontanería 01A, 75A y 22A (30/10/2026, filtro «Fontanería» de la oficina). Entra con cada cuenta (Valladolid, Palencia), lee la pestaña «Presupuesto»
// (valprincipal.php → servicio JSON valuations-initial-data, SOLO LECTURA) de cada servicio abierto y lo clasifica en
// partes.sigma_ptto_* para la vista «Presupuestos» de la oficina:
//   · 'enviado'     → hay partidas en «Pendiente»: valorado y esperando respuesta de compañía/MA
//   · 'aceptado'    → en la ÚLTIMA fecha con decisión hay alguna partida ACEPTADO (POR COMPAÑIA o POR MA)
//   · 'rechazado'   → en la ÚLTIMA fecha con decisión solo hay partidas RECHAZADO (POR COMPAÑIA o POR MA): volver a valorar
//   · 'sin_valorar' → no hay ninguna partida subida
//   · 'bloqueado'   → el portal aún no deja valorar (siniestro sin confirmar, falta la firma del presupuesto/encargo…);
//                     cuenta como sin valorar; el texto del portal va en sigma_ptto_motivo
// Va aparte de sigma-sync para no tocar el robot principal. Lo llama pg_cron a los minutos 07 y 37 (entre pasadas de
// sigma-sync, que dura < 2 min) con la cabecera secreta x-kubel-secreto.
// Solo guarda un servicio cuando cambia su presupuesto (estado, partidas, motivo o fecha de decisión): así no se toca
// partes.actualizado_en («modificado» en la ficha) ni se avisa en directo a la oficina sin motivo (21/10/2026).
// También guarda el «importe total» (partes.sigma_ptto_total): al quedar ACEPTADO, el servicio entra en Facturación con
// ese importe (disparador partes_facturacion_ptto) aunque aún no esté cerrado (21/10/2026).
// v5 (30/10/2026): + gremios de fontanería 01A (privativos), 75A (comunidades) y 22A (pocero). Con más servicios, tope de
// tiempo (deja de empezar servicios a los 115 s; la función se corta a los 150 s) y los ya leídos en orden aleatorio, para
// que una pasada cortada no deje siempre fuera a los mismos (sigma_ptto_revisado_en solo cambia cuando cambia el presupuesto).
// ?prueba=1 → lee el portal pero NO escribe y devuelve el resumen.  ?cuenta=VLL → solo esa cuenta.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import postgres from 'npm:postgres@3.4.4';

const BASE = 'https://web.multiasistencia.com/w3multi/';
const API = 'https://mawmods.plataforma-smart.com/me';
const CUENTAS = [
  { id: 'VLL', nombre: 'Valladolid' },
  { id: 'PAL', nombre: 'Palencia' },
];
const GREMIOS_PTTO = ['11A', '77A', '30A', '10A', '76A', '01A', '75A', '22A'];
const TOPE_MS = 115_000; // a partir de aquí no se empiezan servicios nuevos
let INICIO = Date.now(); // se reinicia en cada llamada
const PARALELO = 3; // servicios a la vez (sin agobiar al portal)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0 Safari/537.36';
const dec = new TextDecoder('windows-1252');

// ---------------------------------------------------------------- utilidades
// Algunos textos del portal vienen con tildes rotas ("2ÂºI"): se recomponen si es posible
const utf8 = new TextDecoder('utf-8', { fatal: true });
function arreglar(t: string) {
  if (!/[\u00c2\u00c3][\u0080-\u00ff]/.test(t)) return t;
  return t.replace(/[\u00c2-\u00f4][\u0080-\u00bf]+/g, (m) => {
    try { return utf8.decode(Uint8Array.from([...m].map((c) => c.charCodeAt(0)))); } catch { return m; }
  });
}
const limpio = (t?: string | null) =>
  arreglar((t ?? '').replace(/\u00a0/g, ' ').replace(/[ \t\r]+/g, ' ').replace(/ *\n */g, '\n').trim());

// Formularios en windows-1252 (el portal no es UTF-8)
const W1252: Record<number, number> = { 0x20AC: 0x80, 0x201A: 0x82, 0x0192: 0x83, 0x201E: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02C6: 0x88, 0x2030: 0x89, 0x0160: 0x8A, 0x2039: 0x8B, 0x0152: 0x8C, 0x017D: 0x8E, 0x2018: 0x91, 0x2019: 0x92, 0x201C: 0x93, 0x201D: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02DC: 0x98, 0x2122: 0x99, 0x0161: 0x9A, 0x203A: 0x9B, 0x0153: 0x9C, 0x017E: 0x9E, 0x0178: 0x9F };
function enc(s: string) {
  let o = '';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80 && /[A-Za-z0-9\-_.*]/.test(ch)) o += ch;
    else if (c === 0x20) o += '+';
    else {
      const b = c < 0x80 ? c : (W1252[c] ?? (c <= 0xFF ? c : 0x3F));
      o += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
  }
  return o;
}
const codificar = (f: Record<string, string>) => Object.entries(f).map(([k, v]) => enc(k) + '=' + enc(v)).join('&');

// ---------------------------------------------------------------- sesión con el portal
class Sesion {
  cookies = new Map<string, string>();
  private guardar(res: Response) {
    for (const c of res.headers.getSetCookie()) {
      const kv = c.split(';')[0];
      const i = kv.indexOf('=');
      if (i > 0) this.cookies.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }
  // Si el portal está saturado un momento (502/503/504) se reintenta hasta 2 veces (a los 4 s y a los 12 s).
  // Un 50x significa que el portal no atendió la petición, así que repetirla no duplica nada.
  // Si se corta la conexión o tarda demasiado, solo se reintentan lecturas (GET) y el login/listado,
  // nunca un envío (aceptar ofrecidos, informar citas): podría haberse guardado ya.
  private async conReintento(url: string, method: string, body: string | undefined, headers: Record<string, string>) {
    const esperas = [4000, 12000];
    const repetible = method === 'GET' || /\/(acceso|frepasos_new)\.php/.test(url);
    for (let intento = 0; ; intento++) {
      let res: Response | null = null;
      try {
        res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
      } catch (err) {
        if (!repetible || intento >= esperas.length) throw err;
      }
      if (res && (![502, 503, 504].includes(res.status) || intento >= esperas.length)) return res;
      if (res) await res.body?.cancel();
      console.warn(`Portal ${res ? res.status : 'sin respuesta'} en ${url.split('?')[0]}: reintento ${intento + 1}`);
      await new Promise((r) => setTimeout(r, esperas[intento]));
    }
  }
  async pedir(ruta: string, form?: Record<string, string>): Promise<string> {
    let url = BASE + ruta;
    let method = form ? 'POST' : 'GET';
    let body: string | undefined = form ? codificar(form) : undefined;
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: BASE, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await this.conReintento(url, method, body, headers);
      this.guardar(res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location')!, url).href;
        method = 'GET'; body = undefined;
        await res.body?.cancel();
        continue;
      }
      if (!res.ok) throw new Error(`El portal respondió ${res.status} en ${ruta.split('?')[0]}`);
      return dec.decode(await res.arrayBuffer());
    }
    throw new Error('Demasiadas redirecciones');
  }
}

const pideClave = (html: string) => /name=["']?clave["'\s>]/i.test(html);

async function entrar(s: Sesion, usuario: string, clave: string) {
  await s.pedir('acceso.php');
  const html = await s.pedir('acceso.php', { usuario, clave });
  if (!pideClave(html) && /frepasos/i.test(html)) return;
  const ini = await s.pedir('inicio.php');
  if (pideClave(ini) || !/frepasos/i.test(ini)) throw new Error('No se pudo entrar: revisa usuario y contraseña de esta cuenta');
}


// ---------------------------------------------------------------- pestaña Presupuesto
type PttoLinea = { baremo: string; descripcion: string; unidades: string; estado: string; fecha: string | null };
type Ptto = { estado: 'aceptado' | 'rechazado' | 'enviado' | 'sin_valorar' | 'bloqueado'; lineas: PttoLinea[]; fecha: string | null; motivo: string | null; total: number | null };
// «Importe total» que muestra el portal al final de la pestaña (totals.totSubtotalP, «1.241,80»)
const aNum = (t: unknown) => { const v = parseFloat(String(t ?? '').replace(/\./g, '').replace(',', '.')); return isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null; };

// Pase del componente de la pestaña (ut, JWT del usuario: vale para todos los servicios de la cuenta)
async function pasePresupuesto(s: Sesion, n: string) {
  const html = await s.pedir(`valprincipal.php?reparacion=${n}&modo=0`);
  if (pideClave(html)) throw new Error('Sesión caducada al abrir la pestaña Presupuesto');
  return (html.match(/<multiasistencia-valoraciones[^>]*\sut="([^"]+)"/i) || [])[1] || null;
}
const cabeceras = (ut?: string) => ({
  'Content-Type': 'application/json', Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com',
  Referer: BASE + 'valprincipal.php', ...(ut ? { Authorization: `Bearer ${ut}` } : {}),
});

// Textos oficiales de los errores de la pestaña (los mismos que muestra el portal)
let TEXTOS: Record<string, string> | null = null;
async function cargarTextos() {
  if (TEXTOS) return;
  try {
    const r = await fetch(`${API}/translations?module=VALUATIONS&lang=es`, { signal: AbortSignal.timeout(10000), headers: cabeceras() });
    const j = r.ok ? await r.json() : null;
    const err = j?.error ?? j?.data?.error;
    if (err && typeof err === 'object') TEXTOS = err as Record<string, string>;
  } catch (err) { console.error('textos', (err as Error).message); }
}

// Motivos de bloqueo vistos en el portal (por si no se pudieran cargar los textos oficiales)
const BLOQUEOS_CONOCIDOS: Record<string, string> = {
  TXTNOCONFIRMADO: 'Debe confirmar el siniestro antes de introducir la valoración',
  '6030': 'Antes de introducir el presupuesto se debe recoger la firma del presupuesto/encargo',
};
const fechaDMA = (t?: string | null) => { const m = String(t || '').match(/(\d{2})\/(\d{2})\/(\d{4})/); return m ? `${m[3]}-${m[2]}-${m[1]}` : null; };

// deno-lint-ignore no-explicit-any
function clasificar(j: any): Ptto | null {
  if (!j?.success) {
    const codes: string[] = (j?.metadata?.errorCodes || []).map((x: { code?: string }) => String(x?.code ?? '')).filter(Boolean);
    // Solo es «bloqueado» si el portal da un motivo de su propio diccionario (siniestro sin confirmar, falta la firma…).
    // Cualquier otro error (p. ej. «PASARELA: Error interno…») es pasajero: se reintenta y el servicio conserva su estado.
    const conocido = (c: string) => !!BLOQUEOS_CONOCIDOS[c] || (!!TEXTOS?.[c] && !/generic|error|pasarela/i.test(c + ' ' + TEXTOS?.[c]));
    if (!codes.length || !codes.every(conocido)) {
      if (codes.length) console.warn('error pasajero del portal', codes.join(' | '));
      return null;
    }
    const motivo = codes.map((c) => TEXTOS?.[c] || BLOQUEOS_CONOCIDOS[c]).join(' · ');
    return { estado: 'bloqueado', lineas: [], fecha: null, motivo, total: null };
  }
  // deno-lint-ignore no-explicit-any
  const lineas: PttoLinea[] = (j.data?.budgetLinesList || []).map((l: any) => ({
    baremo: String(l.scaleCode ?? ''), descripcion: limpio(String(l.scaleDescription ?? '')), unidades: String(l.units ?? ''),
    estado: limpio(String(l.status ?? '')), fecha: fechaDMA(l.statusDate),
  }));
  const total = aNum(j.data?.totals?.totSubtotalP);
  if (!lineas.length) return { estado: 'sin_valorar', lineas, fecha: null, motivo: null, total: null };
  const decididas = lineas.filter((l) => /ACEPTAD|RECHAZAD/i.test(l.estado) && l.fecha);
  const ultima = decididas.reduce<string | null>((m, l) => (!m || l.fecha! > m ? l.fecha : m), null);
  if (lineas.some((l) => /^pendiente/i.test(l.estado))) return { estado: 'enviado', lineas, fecha: ultima, motivo: null, total };
  const deUltima = decididas.filter((l) => l.fecha === ultima);
  if (deUltima.some((l) => /ACEPTAD/i.test(l.estado))) return { estado: 'aceptado', lineas, fecha: ultima, motivo: null, total };
  if (deUltima.some((l) => /RECHAZAD/i.test(l.estado))) return { estado: 'rechazado', lineas, fecha: ultima, motivo: null, total };
  console.warn('estados no reconocidos', [...new Set(lineas.map((l) => l.estado))].join(' | '));
  return { estado: 'enviado', lineas, fecha: ultima, motivo: null, total }; // estado desconocido: aún sin decisión
}

async function leer(ut: string, n: string): Promise<Ptto | null> {
  // Solo lectura: si el portal está saturado se repite una vez
  for (let intento = 0; intento < 2; intento++) {
    try {
      const r = await fetch(`${API}/valuations-initial-data`, {
        method: 'POST', signal: AbortSignal.timeout(20000), body: JSON.stringify({ reparation: n }), headers: cabeceras(ut),
      });
      if (r.status === 401) { await r.body?.cancel(); throw new Error('El portal no aceptó el pase de la pestaña Presupuesto (401)'); }
      if (r.ok) {
        const c = clasificar(await r.json());
        if (c) return c; // si es null (error pasajero) se reintenta una vez
      } else await r.body?.cancel();
    } catch (err) { if (/401/.test((err as Error).message)) throw err; }
    await new Promise((res) => setTimeout(res, 4000));
  }
  return null;
}

type Resumen = { cuenta: string; ok: boolean; servicios: number; leidos: number; guardados: number; fallidos: string[]; estados: Record<string, number>; cambios: string[]; cortado?: boolean; error?: string };

// Huella del presupuesto para saber si ha cambiado (independiente del orden de claves que devuelve jsonb)
// deno-lint-ignore no-explicit-any
const huellaLineas = (l: any) => (Array.isArray(l) ? l : []).map((x: PttoLinea) => [x.baremo, x.descripcion, x.unidades, x.estado, x.fecha ?? ''].join('|')).join('\n');

async function revisarCuenta(admin: SupabaseClient, ciaId: number, cuenta: string, usuario: string, clave: string, prueba: boolean, r: Resumen) {
  const { data, error } = await admin.from('partes').select('id, numero_servicio, sigma_ptto_estado, sigma_ptto_motivo, sigma_ptto_fecha, sigma_ptto_lineas, sigma_ptto_total')
    .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_en_curso', true).in('sigma_gremio', GREMIOS_PTTO)
    .not('estado', 'in', '(cerrado,anulado)').order('sigma_ptto_revisado_en', { ascending: true, nullsFirst: true });
  if (error) throw error;
  // Primero los nunca leídos; el resto, al azar
  const todos = data || [];
  const lista = [...todos.filter((p) => !p.sigma_ptto_estado), ...todos.filter((p) => p.sigma_ptto_estado).sort(() => Math.random() - 0.5)];
  r.servicios = lista.length;
  if (!lista.length) { r.ok = true; return; }
  const s = new Sesion();
  await entrar(s, usuario, clave);
  const ut = await pasePresupuesto(s, lista[0].numero_servicio);
  if (!ut) throw new Error('No se pudo abrir la pestaña Presupuesto');
  await cargarTextos();
  let idx = 0;
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (idx < lista.length) {
      if (Date.now() - INICIO > TOPE_MS) { r.cortado = true; return; }
      const p = lista[idx++];
      const res = await leer(ut, p.numero_servicio);
      if (!res) { r.fallidos.push(p.numero_servicio); continue; }
      r.leidos++;
      r.estados[res.estado] = (r.estados[res.estado] || 0) + 1;
      const igual = p.sigma_ptto_estado === res.estado && (p.sigma_ptto_motivo ?? null) === res.motivo
        && (p.sigma_ptto_fecha ?? null) === res.fecha && (p.sigma_ptto_total == null ? null : Number(p.sigma_ptto_total)) === res.total && huellaLineas(p.sigma_ptto_lineas) === huellaLineas(res.lineas);
      if (igual) continue; // sin cambios: no se escribe nada
      const ahora = new Date().toISOString();
      const d: Record<string, unknown> = {
        sigma_ptto_estado: res.estado, sigma_ptto_motivo: res.motivo, sigma_ptto_lineas: res.lineas,
        sigma_ptto_fecha: res.fecha, sigma_ptto_total: res.total, sigma_ptto_revisado_en: ahora,
      };
      if (p.sigma_ptto_estado !== res.estado) {
        d.sigma_ptto_desde = ahora;
        if (p.sigma_ptto_estado) r.cambios.push(`${p.numero_servicio}: ${p.sigma_ptto_estado} → ${res.estado}`);
      }
      if (prueba) continue;
      const { error: e } = await admin.from('partes').update(d).eq('id', p.id);
      if (e) console.error('guardar', p.numero_servicio, e.message);
      else r.guardados++;
    }
  }));
  r.ok = true;
}

// ---------------------------------------------------------------- entrada
let secreto: string | null = null;
async function leerSecreto() {
  if (secreto) return secreto;
  const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
  try {
    const [f] = await sql`select valor from privado.ajustes where clave = 'notif_secreto'`;
    secreto = f?.valor ?? null;
  } finally {
    await sql.end();
  }
  return secreto;
}

Deno.serve(async (req) => {
  const sec = await leerSecreto();
  if (!sec || req.headers.get('x-kubel-secreto') !== sec) return new Response('no', { status: 401 });
  INICIO = Date.now();
  const url = new URL(req.url);
  const prueba = url.searchParams.get('prueba') === '1';
  const solo = url.searchParams.get('cuenta');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: cia } = await admin.from('companias').select('id').eq('nombre', 'SIGMA').single();
  const resultados: Resumen[] = [];
  for (const c of CUENTAS) {
    if (solo && solo !== c.id) continue;
    const r: Resumen = { cuenta: c.id, ok: false, servicios: 0, leidos: 0, guardados: 0, fallidos: [], estados: {}, cambios: [] };
    const usuario = Deno.env.get(`SIGMA_${c.id}_USUARIO`);
    const clave = Deno.env.get(`SIGMA_${c.id}_CLAVE`);
    try {
      if (!usuario || !clave) throw new Error('Faltan las credenciales en los secretos');
      await revisarCuenta(admin, cia!.id, c.id, usuario, clave, prueba, r);
    } catch (err) {
      console.error(c.id, err);
      r.error = (err as Error).message;
    }
    resultados.push(r);
  }
  console.log('presupuestos', JSON.stringify(resultados.map((x) => ({ cuenta: x.cuenta, ok: x.ok, servicios: x.servicios, leidos: x.leidos, guardados: x.guardados, fallidos: x.fallidos.length, estados: x.estados, cambios: x.cambios.length, cortado: x.cortado, error: x.error }))));
  return new Response(JSON.stringify({ prueba, resultados }), { headers: { 'Content-Type': 'application/json' } });
});
