// KUBEL — Robot de lectura del portal SIGMA (Multiasistencia, proveedores).
// Entra con cada cuenta (Valladolid, Palencia), lee "Servicios en curso" y las fichas,
// y vuelca en Supabase: partes nuevos, cambios y servicios que dejan de estar en curso.
// Si el portal tiene servicios ofrecidos pendientes de confirmación, los ACEPTA TODOS y avisa a la oficina.
// Lo llama pg_cron cada 15 minutos con la cabecera secreta x-kubel-secreto.
// ?prueba=1  → lee el portal pero NO escribe ni acepta nada y devuelve un resumen.
// ?cuenta=VLL → solo esa cuenta.
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2.45.4';
import postgres from 'npm:postgres@3.4.4';
import { DOMParser, Element } from 'https://deno.land/x/deno_dom@v0.1.45/deno-dom-wasm.ts';

const BASE = 'https://web.multiasistencia.com/w3multi/';
const CUENTAS = [
  { id: 'VLL', nombre: 'Valladolid' },
  { id: 'PAL', nombre: 'Palencia' },
];
const MAX_FICHAS = 50;       // fichas por cuenta y pasada (el resto, en la siguiente)
const REFRESCO_FICHA_H = 20;  // horas: repaso diario de la bitácora
const PARALELO = 3;           // fichas a la vez (sin agobiar al portal)
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
const txt = (e?: Element | null) => limpio(e?.textContent);
const parse = (html: string) => {
  const d = new DOMParser().parseFromString(html, 'text/html');
  if (!d) throw new Error('No se pudo leer la página');
  return d;
};

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
  async pedir(ruta: string, form?: Record<string, string>): Promise<string> {
    let url = BASE + ruta;
    let method = form ? 'POST' : 'GET';
    let body: string | undefined = form ? codificar(form) : undefined;
    for (let i = 0; i < 6; i++) {
      const headers: Record<string, string> = { 'User-Agent': UA, Referer: BASE, Cookie: [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ') };
      if (body) headers['Content-Type'] = 'application/x-www-form-urlencoded';
      const res = await fetch(url, { method, body, headers, redirect: 'manual', signal: AbortSignal.timeout(25000) });
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

// ---------------------------------------------------------------- listado "Servicios en curso"
type FilaListado = {
  numero: string; profesional: string; procedencia: string; gremio: string;
  caducidad: number | null; duracion: string; llamadas: number | null; estado: string;
  alerta: 'rojo' | 'amarillo' | 'verde'; marcas: string[]; direccion: string; descripcion: string;
};
type Codigo = { tipo: string; codigo: string; texto: string | null };

const FILTROS_VACIOS = {
  reparacion: '', navid: '', cmbgremio: '', cmbestado: '',
  estado: '', fprocedencia: '', vigencia: '', color: '', tiposervicio: '', gremio: '', furgente: '', fcomarca: '',
};
const PENDIENTES = 'Hay servicios ofrecidos pendientes de confirmación: acéptalos o recházalos en el portal para que se pueda leer el listado';
const num = (s: string) => { const n = parseInt(s.replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; };

function leerListado(html: string) {
  if (pideClave(html)) throw new Error('Sesión caducada en el listado');
  const doc = parse(html);
  const cuerpo = limpio(doc.body?.textContent);
  const total = num((cuerpo.match(/(\d+)\s*Resultados/) || [])[1] ?? '');
  const paginas = num((cuerpo.match(/Página:\s*\d+\s*de\s*(\d+)/) || [])[1] ?? '') ?? 1;
  const filas: FilaListado[] = [];
  for (const nodo of doc.querySelectorAll('td[rowspan="3"]')) {
    const td = nodo as Element;
    const tr = td.parentElement as Element;
    const enlace = tr?.querySelector('a[href*="repasos1.php?reparacion="]');
    if (!enlace) continue;
    const numero = (enlace.getAttribute('href')!.match(/reparacion=(\d+)/) || [])[1];
    if (!numero) continue;
    const c = [...tr.children].filter((x) => x.tagName === 'TD') as Element[];
    const marcas = [...td.querySelectorAll('[title]')].map((e) => (e as Element).getAttribute('title')!.trim()).filter(Boolean);
    const sinMarcas = txt(td);
    if (new RegExp(numero + '\\s*\\*').test(sinMarcas)) marcas.push('Asterisco');
    const cls = td.getAttribute('class') || '';
    const alerta = /rojo/i.test(cls) ? 'rojo' : /amarillo/i.test(cls) ? 'amarillo' : 'verde';
    const sub = (fila: Element | null, et: string) =>
      fila && /^(tr)$/i.test(fila.tagName) && txt(fila.querySelector('td.tcab')).startsWith(et)
        ? txt(fila.querySelector('td.tdet')) : '';
    const f2 = tr.nextElementSibling;
    const f3 = f2?.nextElementSibling ?? null;
    filas.push({
      numero,
      profesional: txt(c[1]), procedencia: txt(c[2]), gremio: txt(c[3]).toUpperCase(),
      caducidad: num(txt(c[4])), duracion: txt(c[5]), llamadas: num(txt(c[6])), estado: txt(c[7]),
      alerta, marcas: [...new Set(marcas)],
      direccion: sub(f2, 'Direcci'), descripcion: sub(f3, 'Descripci'),
    });
  }
  // Códigos de los desplegables de filtros
  const codigos: Codigo[] = [];
  for (const o of doc.querySelectorAll('select[name="estado"] option')) {
    const v = (o as Element).getAttribute('value'); if (!v) continue;
    codigos.push({ tipo: 'estado', codigo: v, texto: txt(o as Element).replace(/^[^-]*-/, '').replace(/-\(\d+\)\s*$/, '').trim() });
  }
  for (const o of doc.querySelectorAll('select[name="gremio"] option')) {
    const v = (o as Element).getAttribute('value'); if (!v) continue;
    const m = txt(o as Element).match(/\(([^)]*)\)/);
    codigos.push({ tipo: 'gremio', codigo: v.toUpperCase(), texto: m ? m[1].trim() : null });
  }
  for (const o of doc.querySelectorAll('select[name="fprocedencia"] option')) {
    const v = (o as Element).getAttribute('value'); if (v) codigos.push({ tipo: 'procedencia', codigo: v, texto: null });
  }
  // El portal obliga a aceptar/rechazar los servicios ofrecidos antes de dejar ver el listado
  if (!filas.length && total === null && /confirmserv/i.test(html)) throw new Error(PENDIENTES);
  // Si no hay filas, guardar un trozo del texto para saber qué mostró el portal
  const ini = Math.max(0, cuerpo.lastIndexOf('Servicios en curso'));
  const aviso = filas.length ? null : cuerpo.slice(ini, ini + 500);
  return { total, paginas, filas, codigos, aviso };
}

async function leerTodoElListado(s: Sesion) {
  // Página 1 sin filtros y con "Recargar datos" (refresh vacío) para tener datos frescos
  const p1 = leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, refresh: '', paginasiguiente: '1', filtrar: 'Filtrar' }));
  const filas = [...p1.filas];
  for (let p = 2; p <= Math.min(p1.paginas, 40); p++) {
    const pg = leerListado(await s.pedir('frepasos_new.php', { ...FILTROS_VACIOS, refresh: '1', paginasiguiente: String(p) }));
    filas.push(...pg.filas);
  }
  const unicos = [...new Map(filas.map((f) => [f.numero, f])).values()];
  return { total: p1.total, paginas: p1.paginas, filas: unicos, leidas: filas.length, codigos: p1.codigos, aviso: p1.aviso };
}

// ---------------------------------------------------------------- servicios ofrecidos (confirmserv.php)
// El portal no deja ver "Servicios en curso" mientras haya ofrecimientos sin responder.
// Por decisión de la oficina (18/10/2026) el robot los ACEPTA TODOS y avisa a la oficina.
type Ofrecido = { numero: string; gremio: string; fecha: string; hora: string; domicilio: string };

function leerOfrecidos(form: Element): Ofrecido[] {
  const out: Ofrecido[] = [];
  const filas = [...form.querySelectorAll('tr')] as Element[];
  filas.forEach((tr, i) => {
    const c = [...tr.children].map((x) => txt(x as Element));
    if (!/^\d{7,9}$/.test(c[0] || '')) return;
    let domicilio = '';
    for (const sig of filas.slice(i + 1, i + 8)) {
      const d = [...sig.children].map((x) => txt(x as Element));
      if (/^\d{7,9}$/.test(d[0] || '')) break;
      if (d[0] === 'Domicilio' && d[1]) { domicilio = d[1]; break; }
    }
    out.push({ numero: c[0], gremio: (c[1] || '').toUpperCase(), fecha: c[4] || '', hora: c[5] || '', domicilio });
  });
  return out;
}

async function aceptarOfrecidos(s: Sesion): Promise<Ofrecido[]> {
  const html = await s.pedir('confirmserv.php');
  const doc = parse(html);
  const form = doc.querySelector('form[name="confirmserv"]') as Element | null;
  if (!form) throw new Error('No se encontró la página de servicios ofrecidos');
  // Los números que acepta "Aceptar todas" vienen en su propio script
  const nums = [...new Set([...html.matchAll(/cadena_repa\s*\+\s*'\|(\d+)'/g)].map((m) => m[1]))];
  if (!nums.length) throw new Error('Hay ofrecimientos pendientes pero no se encontró ninguno para aceptar');
  const campos: Record<string, string> = {};
  for (const i of form.querySelectorAll('input[type="hidden"]')) {
    const e = i as Element; const n = e.getAttribute('name'); if (n) campos[n] = e.getAttribute('value') ?? '';
  }
  for (const sel of form.querySelectorAll('select')) {
    const e = sel as Element; const n = e.getAttribute('name'); if (!n) continue;
    const opt = (e.querySelector('option[selected]') ?? e.querySelector('option')) as Element | null;
    campos[n] = opt?.getAttribute('value') ?? '';
  }
  campos.todas = nums.join('|'); // lo mismo que hace el botón "Aceptar todas"
  const ofrecidos = leerOfrecidos(form);
  await s.pedir(form.getAttribute('action') || 'confirmserv.php', campos);
  // Comprobar que ya no están pendientes
  const despues = await s.pedir('confirmserv.php');
  const siguen = nums.filter((n) => new RegExp(`processAcepRech\\(\\s*${n}\\s*\\)|'\\|${n}'`).test(despues));
  if (siguen.length) throw new Error(`El portal no aceptó los servicios ofrecidos: ${siguen.join(', ')}`);
  return nums.map((n) => ofrecidos.find((o) => o.numero === n) ?? { numero: n, gremio: '', fecha: '', hora: '', domicilio: '' });
}

// ---------------------------------------------------------------- ficha del servicio
function textoConSaltos(el: Element): string {
  let s = '';
  for (const n of el.childNodes) {
    if (n.nodeType === 3) s += n.textContent;
    else if (n.nodeName === 'BR') s += '\n';
    else if (n.nodeType === 1) s += textoConSaltos(n as Element);
  }
  return s;
}
const MARCA_FECHA = /\((\d{2})\/(\d{2})\/(\d{4})\s*-\s*(\d{2}):(\d{2})\)/;

function leerBitacora(el: Element) {
  const trozos = textoConSaltos(el).split(/\n\s*\n/).map(limpio).filter(Boolean);
  let descripcion = '';
  const entradas: { fecha: string | null; texto: string }[] = [];
  trozos.forEach((t, i) => {
    if (i === 0) {
      const p = t.search(MARCA_FECHA);
      if (p === -1) { descripcion = t; return; }
      descripcion = t.slice(0, p).trim();
      t = t.slice(p);
    }
    const m = t.match(new RegExp('^' + MARCA_FECHA.source));
    entradas.push({
      fecha: m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}:${m[5]}` : null,
      texto: m ? t.slice(m[0].length).trim() : t,
    });
  });
  return { descripcion, entradas: entradas.filter((e) => e.texto) };
}

function filasDe(tabla: Element) {
  return ([...tabla.querySelectorAll('tr')] as Element[]).filter((tr) => {
    let p = tr.parentElement;
    while (p && p.tagName !== 'TABLE') p = p.parentElement;
    return p === tabla;
  });
}
const tablaDe = (el: Element) => { let p = el.parentElement; while (p && p.tagName !== 'TABLE') p = p.parentElement; return p; };

function leerFicha(html: string) {
  if (pideClave(html)) throw new Error('Sesión caducada en la ficha');
  const doc = parse(html);
  const cab = [...doc.querySelectorAll('td.tcab')] as Element[];
  // Cabecera horizontal: títulos en una fila, valores en la siguiente
  const cabecera: Record<string, string> = {};
  const inicio = cab.find((td) => txt(td) === 'Número Reparación');
  if (!inicio) throw new Error('La ficha no tiene el formato esperado');
  const tCab = tablaDe(inicio)!;
  const [fT, fV] = filasDe(tCab);
  const tit = [...fT.children].map((c) => txt(c as Element));
  const val = fV ? [...fV.children].map((c) => txt(c as Element)) : [];
  tit.forEach((t, i) => (cabecera[t] = val[i] ?? ''));
  // Campos verticales: etiqueta (tcab) + valor (tdet)
  const campos: Record<string, string> = {};
  let celdaDescripcion: Element | null = null;
  for (const td of cab) {
    const sig = td.nextElementSibling as Element | null;
    if (!sig || !(sig.getAttribute('class') || '').includes('tdet')) continue;
    const et = txt(td);
    if (!et || et.length > 60) continue;
    if (et.startsWith('Descripción de la Reparación')) celdaDescripcion = sig;
    else if (!(et in campos)) campos[et] = txt(sig);
  }
  // Teléfonos: tablas con títulos Número · Tipo · Desde · Hasta
  const telefonos: { numero: string; tipo: string; desde: string; hasta: string; de: string }[] = [];
  let nTabla = 0;
  for (const td of cab.filter((x) => txt(x) === 'Número')) {
    const t = tablaDe(td)!;
    const fs = filasDe(t);
    const t0 = [...fs[0].children].map((c) => txt(c as Element));
    if (t0[0] !== 'Número') continue;
    const de = nTabla++ === 0 ? 'cliente' : 'perjudicado';
    for (const f of fs.slice(1)) {
      const v = [...f.children].map((c) => txt(c as Element));
      const numero = (v[0] || '').replace(/\s+/g, '');
      if (/\d{6,}/.test(numero)) telefonos.push({ numero, tipo: v[1] || '', desde: v[2] || '', hasta: v[3] || '', de });
    }
  }
  const bit = celdaDescripcion ? leerBitacora(celdaDescripcion) : { descripcion: '', entradas: [] };
  const dp = (cabecera['Distrito Postal'] || '').match(/^(\d{5})\s*-\s*(.*)$/);
  const procTexto = (campos['Procedencia'] || '').replace(/^\d+\s*-\s*/, '').trim();
  return {
    numero: cabecera['Número Reparación'],
    poliza: cabecera['Número de Póliza'] || null,
    cliente: cabecera['Nombre Cliente'] || null,
    direccion: cabecera['Dirección'] || null,
    cp: dp ? dp[1] : null,
    poblacion: dp ? dp[2].trim() : (cabecera['Distrito Postal'] || null),
    procedenciaTexto: procTexto || null,
    urgente: /^s[ií]/i.test(campos['Urgente'] || ''),
    estadoTexto: campos['Estado'] || null,
    telefonos,
    descripcion: bit.descripcion,
    bitacora: bit.entradas,
    otros: {
      baremo: cabecera['Baremo'] || null,
      procedencia: campos['Procedencia'] || null,
      forma_pago: campos['Forma de pago'] || null,
      franquicia: campos['Franquicia'] || null,
      fecha_realizacion: campos['Fecha realización'] || null,
      confirmado: campos['Confirmado'] || null,
      apertura: campos['Fecha/Hora Apertura'] || null,
      asignacion: campos['Fecha/Hora Asignación'] || null,
      tramitador: campos['Tramitador'] || null,
      especialidades: campos['Especialidades'] || null,
      herramientas: campos['Herramientas'] || null,
    },
  };
}

// ---------------------------------------------------------------- sincronización de una cuenta
type Resumen = {
  cuenta: string; ok: boolean; en_listado: number; total_portal: number | null; paginas: number;
  nuevos: { numero: string; direccion: string; gremio: string; urgente: boolean }[];
  cambiados: number; fichas: number; desaparecidos: string[]; pendientes: number; error?: string; diagnostico?: unknown;
  aceptados?: Ofrecido[];
};

function partirDireccion(d: string) {
  const m = d.match(/^(.*?)\s+-\s+(\d{5})\s+(.*)$/);
  return m ? { direccion: m[1].trim(), cp: m[2], poblacion: m[3].trim() } : { direccion: d, cp: null, poblacion: null };
}
const vacio = (v: unknown) => v === null || v === undefined || v === '';

// r se rellena sobre la marcha: si algo falla a mitad, lo ya hecho (p. ej. aceptados) no se pierde
async function sincronizar(admin: SupabaseClient, ciaId: number, usuario: string, clave: string, prueba: boolean, r: Resumen): Promise<Resumen> {
  const cuenta = r.cuenta;
  const s = new Sesion();
  await entrar(s, usuario, clave);

  let lis: Awaited<ReturnType<typeof leerTodoElListado>>;
  try {
    lis = await leerTodoElListado(s);
  } catch (err) {
    if ((err as Error).message !== PENDIENTES) throw err;
    if (prueba) {
      const doc = parse(await s.pedir('confirmserv.php'));
      const form = doc.querySelector('form[name="confirmserv"]') as Element | null;
      r.aceptados = (form ? leerOfrecidos(form) : []).map((o) => ({ ...o, domicilio: '' }));
      r.ok = true; r.diagnostico = { ofrecidos_pendientes: r.aceptados.length, nota: 'En modo prueba no se aceptan' };
      return r;
    }
    r.aceptados = await aceptarOfrecidos(s);
    lis = await leerTodoElListado(s);
  }
  r.en_listado = lis.filas.length; r.total_portal = lis.total; r.paginas = lis.paginas;
  const completo = lis.total !== null && lis.filas.length === lis.total;

  // Tablas de códigos
  const { data: cods } = await admin.from('sigma_codigos').select('tipo, codigo, texto, gremio_kubel');
  const mapa = new Map((cods || []).map((c) => [`${c.tipo}:${c.codigo}`, c]));
  const nuevosCodigos = lis.codigos.filter((c) => {
    const k = mapa.get(`${c.tipo}:${c.codigo}`);
    return !k || (c.texto && k.texto !== c.texto && c.tipo !== 'procedencia');
  });
  const gremioKubel = (cod: string) => {
    const g = mapa.get(`gremio:${cod}`) ?? nuevosCodigos.find((c) => c.tipo === 'gremio' && c.codigo === cod);
    return (g as { gremio_kubel?: string })?.gremio_kubel || g?.texto || cod || null;
  };

  // Lo que ya tenemos
  const numeros = lis.filas.map((f) => f.numero);
  const campos = 'id, numero_servicio, asegurado, telefono, telefono2, direccion, poblacion, codigo_postal, gremio, descripcion, urgente, sigma_cuenta, sigma_huella, sigma_en_curso, sigma_ficha_en';
  const existentes = new Map<string, Record<string, unknown>>();
  for (let i = 0; i < numeros.length; i += 200) {
    const { data, error } = await admin.from('partes').select(campos).eq('compania_id', ciaId).in('numero_servicio', numeros.slice(i, i + 200));
    if (error) throw error;
    (data || []).forEach((p) => existentes.set(p.numero_servicio, p));
  }
  const { data: enCurso, error: e2 } = await admin.from('partes').select('id, numero_servicio').eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).eq('sigma_en_curso', true);
  if (e2) throw e2;

  const ahora = new Date().toISOString();
  const altas: Record<string, unknown>[] = [];
  const cambios: { id: string; datos: Record<string, unknown> }[] = [];
  const colaFichas: { numero: string; prio: number; edad: number }[] = [];
  const nuevosLista: Resumen['nuevos'] = [];

  for (const f of lis.filas) {
    const huella = JSON.stringify([f.profesional, f.procedencia, f.gremio, f.caducidad, f.duracion, f.llamadas, f.estado, f.alerta, f.marcas, f.direccion, f.descripcion]);
    const datosLista = {
      sigma_cuenta: cuenta, sigma_profesional: f.profesional, sigma_procedencia: f.procedencia, sigma_gremio: f.gremio,
      sigma_estado: f.estado, sigma_caducidad: f.caducidad, sigma_duracion: f.duracion, sigma_llamadas: f.llamadas,
      sigma_alerta: f.alerta, sigma_marcas: f.marcas, sigma_en_curso: true, sigma_huella: huella, sigma_cambio_en: ahora,
    };
    const e = existentes.get(f.numero);
    if (!e) {
      const d = partirDireccion(f.direccion);
      const urgente = f.marcas.some((m) => /urgente/i.test(m));
      altas.push({
        compania_id: ciaId, numero_servicio: f.numero, origen: 'sigma',
        direccion: d.direccion || '(sin dirección)', codigo_postal: d.cp, poblacion: d.poblacion,
        gremio: gremioKubel(f.gremio), descripcion: f.descripcion || null, urgente, ...datosLista,
      });
      nuevosLista.push({ numero: f.numero, direccion: [d.direccion, d.poblacion].filter(Boolean).join(', '), gremio: String(gremioKubel(f.gremio) ?? ''), urgente });
      colaFichas.push({ numero: f.numero, prio: 0, edad: 0 });
    } else if (e.sigma_huella !== huella || e.sigma_en_curso !== true || e.sigma_cuenta !== cuenta) {
      r.cambiados++;
      cambios.push({ id: e.id as string, datos: { ...datosLista, sigma_ficha_en: null } });
      colaFichas.push({ numero: f.numero, prio: 1, edad: 0 });
    } else {
      const edad = e.sigma_ficha_en ? (Date.now() - new Date(e.sigma_ficha_en as string).getTime()) / 3600000 : 1e6;
      if (edad > REFRESCO_FICHA_H) colaFichas.push({ numero: f.numero, prio: e.sigma_ficha_en ? 3 : 2, edad });
    }
  }

  // Servicios que ya no salen en el listado (solo si el listado se leyó completo)
  const desaparecidos: string[] = [];
  if (completo) {
    const vivos = new Set(numeros);
    for (const p of enCurso || []) if (!vivos.has(p.numero_servicio)) desaparecidos.push(p.numero_servicio);
  }

  // Fichas: primero nuevos, luego cambiados, luego las nunca leídas, luego las más antiguas
  colaFichas.sort((a, b) => a.prio - b.prio || b.edad - a.edad);
  const aLeer = colaFichas.slice(0, MAX_FICHAS);
  r.pendientes = colaFichas.length - aLeer.length;
  const fichas = new Map<string, ReturnType<typeof leerFicha>>();
  const erroresFicha: string[] = [];
  let idx = 0;
  await Promise.all(Array.from({ length: PARALELO }, async () => {
    while (idx < aLeer.length) {
      const { numero } = aLeer[idx++];
      try {
        fichas.set(numero, leerFicha(await s.pedir(`repasos1.php?reparacion=${numero}`)));
      } catch (err) {
        erroresFicha.push(`${numero}: ${(err as Error).message}`);
      }
    }
  }));
  r.fichas = fichas.size;
  if (erroresFicha.length && !fichas.size) throw new Error('No se pudo leer ninguna ficha: ' + erroresFicha[0]);
  // Procedencia: el código sale en el listado y el nombre en la ficha
  const porNumero = new Map(lis.filas.map((f) => [f.numero, f]));
  for (const [n, f] of fichas) {
    const cod = porNumero.get(n)?.procedencia;
    if (cod && f.procedenciaTexto) nuevosCodigos.push({ tipo: 'procedencia', codigo: cod, texto: f.procedenciaTexto });
  }

  if (prueba) {
    r.nuevos = nuevosLista; r.desaparecidos = desaparecidos;
    const una = fichas.values().next().value;
    r.diagnostico = {
      listado_completo: completo, filas_leidas: lis.leidas, codigos_leidos: lis.codigos.length, aviso_portal: lis.aviso,
      alertas: lis.filas.reduce((a, f) => ((a[f.alerta] = (a[f.alerta] || 0) + 1), a), {} as Record<string, number>),
      marcas: [...new Set(lis.filas.flatMap((f) => f.marcas))],
      filas_sin_direccion: lis.filas.filter((f) => !f.direccion).length,
      errores_ficha: erroresFicha.slice(0, 5),
      procedencias: [...new Map(nuevosCodigos.filter((c) => c.tipo === 'procedencia' && c.texto).map((c) => [c.codigo, c.texto])).entries()],
      ficha_ejemplo: una && {
        tiene_cliente: !!una.cliente, tiene_direccion: !!una.direccion, cp: !!una.cp, procedencia: !!una.procedenciaTexto,
        urgente: una.urgente, estado: !!una.estadoTexto, telefonos: una.telefonos.length, entradas_bitacora: una.bitacora.length,
        descripcion_inicial: una.descripcion.length, otros: Object.entries(una.otros).filter(([, v]) => v).map(([k]) => k),
      },
    };
    r.nuevos = r.nuevos.map((n) => ({ ...n, direccion: '' }));
    r.ok = true;
    return r;
  }

  // ----- Escritura
  if (nuevosCodigos.length) {
    const filas = [...new Map(nuevosCodigos.map((c) => [`${c.tipo}:${c.codigo}`, c])).values()]
      .map((c) => ({ ...c, texto: c.texto ?? mapa.get(`${c.tipo}:${c.codigo}`)?.texto ?? null, actualizado_en: ahora }));
    const { error } = await admin.from('sigma_codigos').upsert(filas, { onConflict: 'tipo,codigo' });
    if (error) console.error('códigos', error.message);
  }
  if (altas.length) {
    const { error } = await admin.from('partes').insert(altas);
    if (error) throw new Error('Alta de partes: ' + error.message);
  }
  r.nuevos = nuevosLista; // solo cuentan como nuevos si se han dado de alta
  for (const c of cambios) {
    const { error } = await admin.from('partes').update(c.datos).eq('id', c.id);
    if (error) throw new Error('Actualizar parte: ' + error.message);
  }
  if (desaparecidos.length) {
    const { error } = await admin.from('partes').update({ sigma_en_curso: false, sigma_cambio_en: ahora })
      .eq('compania_id', ciaId).eq('sigma_cuenta', cuenta).in('numero_servicio', desaparecidos);
    if (error) throw new Error('Marcar desaparecidos: ' + error.message);
    r.desaparecidos = desaparecidos;
  }
  // Datos de las fichas: los campos SIGMA siempre; los generales solo si están vacíos (no pisar a la oficina)
  if (fichas.size) {
    const { data: actuales } = await admin.from('partes').select(campos).eq('compania_id', ciaId).in('numero_servicio', [...fichas.keys()]);
    for (const p of actuales || []) {
      const f = fichas.get(p.numero_servicio)!;
      const tels = f.telefonos.filter((t) => t.de === 'cliente').map((t) => t.numero);
      const d: Record<string, unknown> = {
        sigma_poliza: f.poliza, sigma_telefonos: f.telefonos, sigma_bitacora: f.bitacora,
        sigma_estado_texto: f.estadoTexto, sigma_ficha: f.otros, sigma_ficha_en: ahora,
      };
      if (vacio(p.asegurado) && f.cliente) d.asegurado = f.cliente;
      if (vacio(p.telefono) && tels[0]) d.telefono = tels[0];
      if (vacio(p.telefono2) && tels[1]) d.telefono2 = tels[1];
      if ((vacio(p.direccion) || p.direccion === '(sin dirección)') && f.direccion) d.direccion = f.direccion;
      if (vacio(p.codigo_postal) && f.cp) d.codigo_postal = f.cp;
      if (vacio(p.poblacion) && f.poblacion) d.poblacion = f.poblacion;
      if (f.descripcion && (vacio(p.descripcion) || (String(p.descripcion).endsWith('...') && f.descripcion.length > String(p.descripcion).length))) d.descripcion = f.descripcion;
      if (f.urgente && !p.urgente) d.urgente = true;
      const { error } = await admin.from('partes').update(d).eq('id', p.id);
      if (error) console.error('ficha', p.numero_servicio, error.message);
    }
  }
  if (erroresFicha.length) r.error = `Fichas con error: ${erroresFicha.length}`;
  r.ok = true;
  return r;
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
  const s = await leerSecreto();
  if (!s || req.headers.get('x-kubel-secreto') !== s) return new Response('no', { status: 401 });
  const url = new URL(req.url);
  const prueba = url.searchParams.get('prueba') === '1';
  const solo = url.searchParams.get('cuenta');
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const { data: cia } = await admin.from('companias').select('id').eq('nombre', 'SIGMA').single();
  const resultados: Resumen[] = [];

  for (const c of CUENTAS) {
    if (solo && solo !== c.id) continue;
    const usuario = Deno.env.get(`SIGMA_${c.id}_USUARIO`);
    const clave = Deno.env.get(`SIGMA_${c.id}_CLAVE`);
    if (!usuario || !clave) {
      resultados.push({ cuenta: c.id, ok: false, en_listado: 0, total_portal: null, paginas: 0, nuevos: [], cambiados: 0, fichas: 0, desaparecidos: [], pendientes: 0, error: 'Faltan las credenciales en los secretos' });
      continue;
    }
    const { data: reg } = await admin.from('sigma_sincronizaciones').insert({ cuenta: c.id, prueba }).select('id').single();
    const r: Resumen = { cuenta: c.id, ok: false, en_listado: 0, total_portal: null, paginas: 0, nuevos: [], cambiados: 0, fichas: 0, desaparecidos: [], pendientes: 0 };
    try {
      await sincronizar(admin, cia!.id, usuario, clave, prueba, r);
    } catch (err) {
      console.error(c.id, err);
      r.ok = false; r.error = (err as Error).message;
    }
    resultados.push(r);
    if (reg) {
      await admin.from('sigma_sincronizaciones').update({
        fin: new Date().toISOString(), ok: r.ok, en_listado: r.en_listado, nuevos: r.nuevos.length, cambiados: r.cambiados,
        fichas: r.fichas, desaparecidos: r.desaparecidos.length, pendientes: r.pendientes, error: r.error ?? null,
        aceptados: r.aceptados?.length ?? 0,
      }).eq('id', reg.id);
    }
    // Avisos a la oficina (no en modo prueba)
    if (!prueba) {
      let avisarError = false;
      if (!r.ok) {
        const { data: ult } = await admin.from('sigma_sincronizaciones').select('ok, error').eq('cuenta', c.id).eq('prueba', false).order('inicio', { ascending: false }).limit(4);
        if (r.error === PENDIENTES || /ofrecid|ofrecimiento/i.test(r.error || '')) {
          avisarError = !(ult?.[1] && ult[1].error === r.error); // avisa en cuanto aparece, una vez
        } else {
          let fallos = (ult || []).findIndex((x) => x.ok !== false); if (fallos === -1) fallos = (ult || []).length;
          avisarError = fallos === 3; // avisa una vez, al tercer fallo seguido
        }
      }
      // Los aceptados ya tienen su propio aviso: no repetirlos como "nuevos"
      const nuevos = r.nuevos.filter((n) => !r.aceptados?.some((a) => a.numero === n.numero));
      if (avisarError || nuevos.length || r.desaparecidos.length || r.aceptados?.length) {
        try {
          await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': s },
            body: JSON.stringify({ tabla: 'sigma', evento: 'resumen', nuevo: {
              cuenta: c.id, nombre: c.nombre, error: avisarError ? r.error : null,
              nuevos, desaparecidos: r.desaparecidos, aceptados: r.aceptados ?? [],
            } }),
          });
        } catch (err) { console.error('aviso', (err as Error).message); }
      }
    }
  }
  return new Response(JSON.stringify({ prueba, resultados }), { headers: { 'Content-Type': 'application/json' } });
});
