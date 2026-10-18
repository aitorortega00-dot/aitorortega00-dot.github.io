// KUBEL — Robot de lectura del portal SIGMA (Multiasistencia, proveedores).
// Entra con cada cuenta (Valladolid, Palencia), lee "Servicios en curso" y las fichas,
// y vuelca en Supabase: partes nuevos, cambios y servicios que dejan de estar en curso.
// Si el portal tiene servicios ofrecidos pendientes de confirmación, los ACEPTA TODOS y avisa a la oficina.
// También manda a SIGMA lo que la oficina ha aprobado en "Envíos a SIGMA" (Repaso e Informar citas).
// Lo llama pg_cron cada 15 minutos con la cabecera secreta x-kubel-secreto.
// ?prueba=1  → lee el portal pero NO escribe ni acepta nada y devuelve un resumen.
// ?cuenta=VLL → solo esa cuenta.  ?enviar=1 → solo manda a SIGMA los envíos aprobados (sin leer el listado).
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

// ---------------------------------------------------------------- ENVÍOS A SIGMA (lo que la oficina ha aprobado)
// Repaso: componente moderno del portal que habla con su servicio JSON (review-initial-data / review-update).
// Informar citas: formulario clásico citasPendientes.php.
// Reglas de la oficina (18/10/2026):
//  - En "Informar citas" la fecha/hora de la visita es SIEMPRE la citada, nunca la del informe.
//  - El aviso "este aplazamiento va a generar un SMS al cliente" se confirma SIEMPRE con "Sí".
const API_REPASO = 'https://mawmods.plataforma-smart.com/me';
const HORAS_REPASO = Array.from({ length: 28 }, (_, i) => String(28800 + i * 1800)); // 08:00 … 21:30
const MOTIVOS_CITA: Record<string, string[]> = { V: ['609', '611', '604', '601'], I: ['706', '707', '708'], C: ['213', '215', '212', '214'] };
type Envio = {
  id: string; parte_id: string; tipo: 'repaso' | 'informar_cita'; motivo_codigo: string | null; motivo_texto: string | null;
  fecha: string | null; hora: string | null; resolucion: string | null; resolucion_motivo: string | null;
  cita_fecha: string | null; cita_hora: string | null; comentario: string; parte: { numero_servicio: string; sigma_cuenta: string };
};

function traducirCodigos(codes: { code?: string }[] | undefined) {
  const c = (codes || []).map((x) => x.code || '').filter(Boolean);
  if (!c.length) return 'El portal no aceptó el cambio (sin detalle)';
  return c.map((x) => ({
    APPEND_PENDING_APPOINTMENTS: 'Hay una cita anterior sin informar: primero hay que enviar "Informar citas"',
    TXT_GENERICERROR: 'Error genérico del portal',
  } as Record<string, string>)[x] || x).join(' · ');
}
const hoyMadrid = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Madrid' }).format(new Date());

async function enviarRepaso(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  if (!e.motivo_codigo) throw new Error('Falta el motivo');
  if (!e.fecha) throw new Error('Falta la fecha siguiente acción');
  if (!e.comentario.trim()) throw new Error('Falta el comentario');
  const html = await s.pedir(`fechaccion.php?reparacion=${n}&modo=0`);
  const ut = (html.match(/<multiasistencia-repaso[^>]*\sut="([^"]+)"/i) || [])[1];
  if (!ut) throw new Error('No se pudo abrir la pestaña Repaso de este servicio');
  const api = async (ruta: string, cuerpo: unknown) => {
    const r = await fetch(`${API_REPASO}/${ruta}`, {
      method: 'POST', signal: AbortSignal.timeout(30000), body: JSON.stringify(cuerpo),
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ut}`, Version: '3.0.0', 'User-Agent': UA, Origin: 'https://web.multiasistencia.com', Referer: BASE + 'fechaccion.php' },
    });
    if (r.status >= 500 || r.status === 401 || r.status === 404) throw new Error(`El servicio de Repaso respondió ${r.status}`);
    return await r.json();
  };
  const ini = await api('review-initial-data', { reparation: n });
  if (!ini?.success) throw new Error(traducirCodigos(ini?.metadata?.errorCodes));
  const d = ini.data;
  if (!d.availabilityPermission) throw new Error('El portal pide elegir hueco de agenda para este servicio: hazlo a mano en el portal');
  if (d.swConforme) throw new Error('El portal pide una conformidad adicional: hazlo a mano en el portal');
  const motivo = (d.reasonInfo?.reasonComboList || []).find((m: { value: string }) => String(m.value) === String(e.motivo_codigo));
  if (!motivo) throw new Error(`El motivo "${e.motivo_texto || e.motivo_codigo}" no está disponible ahora para este servicio`);
  if (motivo.sub?.length) throw new Error(`El motivo "${motivo.label}" pide un submotivo: hazlo a mano en el portal`);
  const max = Number((String(motivo.label).match(/\[(\d+)\]/) || [])[1] ?? NaN);
  const hoy = hoyMadrid();
  const dias = Math.round((Date.parse(e.fecha) - Date.parse(hoy)) / 86400000);
  if (dias < 0) throw new Error('La fecha ya ha pasado');
  if (Number.isFinite(max) && dias > max) throw new Error(`Para "${motivo.label}" la fecha no puede pasar de ${max} días desde hoy`);
  let hourRaw = '';
  if (e.hora) {
    const [h, m] = e.hora.split(':').map(Number);
    hourRaw = String(h * 3600 + m * 60);
    if (!HORAS_REPASO.includes(hourRaw)) throw new Error('La hora del Repaso debe ser en punto o y media, entre 08:00 y 21:30');
  }
  const [a, mes, dia] = e.fecha.split('-');
  const cmd: Record<string, unknown> = {
    reparation: n, controlAvailability: 1, controlDuration: 1,
    reviewReason: String(e.motivo_codigo), comment: e.comentario.trim(),
    dates: { actionDate: { day: String(Number(dia)), month: String(Number(mes)), year: a, hourRaw }, exceededDate: d.dates?.exceededDate ?? null },
  };
  if (d.heater?.enabled && d.heater.ageHeater) cmd.heater = { ageHeater: d.heater.ageHeater };
  // Secuencia del portal (probada a mano el 18/10/2026, servicio 29385460):
  //  1) review-update → AVISO_SMS ("va a generar un SMS al cliente")         → siempre "Sí" (smsResponse:"si")
  //  2) si la agenda no tiene hueco para esa fecha/hora, responde success:true SIN código y con la lista
  //     de huecos (dateGapSelectList): "No existe disponibilidad…" con a) mantener / b) siguiente hueco libre
  //     → siempre a) "No importa, quiero mantener la fecha / hora introducida" (hourRadioButton = la hora elegida)
  //  3) vuelve a pedir el aviso de SMS → siempre "Sí"
  //  4) APLAZAMOK = guardado.
  let sms = false, mantenida = false;
  let enviar: Record<string, unknown> = cmd;
  for (let paso = 0; paso < 6; paso++) {
    const res = await api('review-update', enviar);
    const code = res?.metadata?.errorCodes?.[0]?.code;
    if (code === 'APLAZAMOK') {
      return `Repaso guardado: ${motivo.label.replace(/\s*\[\d+\]/, '')} ${dia}/${mes}/${a}${e.hora ? ' ' + e.hora.slice(0, 5) : ''}`
        + `${mantenida ? ' (fecha/hora mantenida aunque la agenda no tenía hueco)' : ''}${sms ? ' (SMS al cliente confirmado)' : ''}`;
    }
    if (code === 'AVISO_SMS') { // aviso genérico de SMS al cliente: siempre "Sí"
      if (enviar.smsResponse) throw new Error('El portal repitió el aviso de SMS tras contestar "Sí"');
      sms = true;
      enviar = { ...enviar, smsResponse: 'si' };
      continue;
    }
    if (res?.success && !code && res.data?.dates) { // pantalla de huecos de agenda
      const nd = res.data;
      if (nd.requestMultiGap) throw new Error('El portal pide confirmar una cita de varios huecos (multihueco): hazlo a mano en el portal');
      if (mantenida) throw new Error('El portal volvió a pedir hueco de agenda tras elegir "mantener la fecha/hora"');
      if (!nd.allowMaintainAppointmentGap) throw new Error('No hay hueco en la agenda para esa fecha/hora y el portal no deja mantenerla: elige otro hueco en el portal');
      if (!hourRaw) throw new Error('El portal pide hora para mantener la cita y el envío no tiene hora');
      mantenida = true;
      // Igual que la opción a) del portal; el formulario se rehace, así que el aviso de SMS se pregunta otra vez
      enviar = {
        ...cmd, hourRadioButton: hourRaw,
        dates: { actionDate: { day: String(Number(dia)), month: String(Number(mes)), year: a, hourRaw, date: `${dia}/${mes}/${a}` }, exceededDate: nd.dates.exceededDate ?? null },
      };
      continue;
    }
    throw new Error(traducirCodigos(res?.metadata?.errorCodes));
  }
  throw new Error('El portal pidió demasiados pasos seguidos: revisa el servicio en el portal');
}

async function enviarInformarCita(s: Sesion, e: Envio): Promise<string> {
  const n = e.parte.numero_servicio;
  if (!e.resolucion || !e.resolucion_motivo) throw new Error('Falta la resolución o el motivo');
  if (!MOTIVOS_CITA[e.resolucion]?.includes(e.resolucion_motivo)) throw new Error('El motivo no corresponde a la resolución elegida');
  if (!e.comentario.trim()) throw new Error('Falta el comentario');
  const leer = async () => {
    const html = await s.pedir(`citasPendientes.php?reparacion=${n}&modo=0`);
    const doc = parse(html);
    const filas = ([...doc.querySelectorAll('tr[onclick*="seleccionarCita"]')] as Element[]).map((tr) => {
      const t = txt(tr);
      const m = t.match(/(\d{2})\/(\d{2})\/(\d{4})(?:\s*-\s*(\d{2}):(\d{2}))?/);
      return { id: tr.getAttribute('id') || '', primera: tr.getAttribute('primeravisita') === '1', fecha: m ? `${m[3]}-${m[2]}-${m[1]}` : null, hora: m && m[4] ? `${m[4]}:${m[5]}` : null };
    }).filter((f) => f.id);
    return { doc, filas };
  };
  const { doc, filas } = await leer();
  if (!filas.length) throw new Error('El portal no tiene ninguna cita pendiente de informar en este servicio');
  const fila = filas.find((f) => f.fecha && f.fecha === e.cita_fecha) ?? filas[0];
  const form = doc.querySelector('form[name="datos_cita"]') as Element | null;
  if (!form) throw new Error('No se encontró el formulario de Informar citas');
  const oculto = (nombre: string) => (form.querySelector(`input[name="${nombre}"]`) as Element | null)?.getAttribute('value') ?? '';
  const campos: Record<string, string> = {
    idCita: fila.id, reparacion: oculto('reparacion') || n, desde: oculto('desde'), UpdateFrm: '1',
    resolucion: e.resolucion, motivo: e.resolucion_motivo, comentario: e.comentario.trim(),
  };
  let cuando = '';
  if ((e.resolucion === 'V') && fila.primera) {
    // Hora de llegada = la CITADA (la del portal; si no se ve, la que planificamos)
    const fecha = fila.fecha ?? e.cita_fecha;
    const hora = fila.hora ?? e.cita_hora?.slice(0, 5) ?? null;
    if (!fecha || !hora) throw new Error('No se sabe la fecha y hora citadas de la visita');
    const [a, mes, dia] = fecha.split('-');
    const [hh, mm] = hora.split(':');
    if (Number(hh) < 7 || Number(hh) > 22) throw new Error('La hora citada está fuera del rango que admite el portal (07–22 h)');
    Object.assign(campos, { dia: String(Number(dia)), mes: String(Number(mes)), ano: a, hora: hh.padStart(2, '0'), minutos: mm.padStart(2, '0') });
    cuando = ` · visita ${dia}/${mes}/${a} ${hh}:${mm}`;
  }
  await s.pedir(form.getAttribute('action') || 'citasPendientes.php', campos);
  const despues = await leer();
  if (despues.filas.some((f) => f.id === fila.id)) throw new Error('El portal no dio por informada la cita (sigue pendiente)');
  const RES: Record<string, string> = { V: 'Visita realizada', I: 'Visita cancelada', C: 'Cita cancelada' };
  return `Cita informada: ${RES[e.resolucion]}${cuando}`;
}

async function procesarEnvios(admin: SupabaseClient, cuenta: string, nombre: string, usuario: string, clave: string, secretoAvisos: string) {
  // Envíos que se quedaron a medias hace más de 10 min: no se reintentan solos (podría duplicarse en el portal)
  await admin.from('sigma_envios').update({ estado: 'error', resultado: 'Envío interrumpido: comprueba en el portal si se guardó antes de reintentar' })
    .eq('estado', 'enviando').lt('actualizado_en', new Date(Date.now() - 10 * 60000).toISOString());
  const { data: cola } = await admin.from('sigma_envios')
    .select('*, parte:partes!inner(numero_servicio, sigma_cuenta)').eq('estado', 'aprobado').eq('parte.sigma_cuenta', cuenta)
    .order('creado_en');
  if (!cola?.length) return { enviados: 0, errores: 0 };
  // Reservar (evita que dos pasadas manden lo mismo)
  const { data: mios } = await admin.from('sigma_envios').update({ estado: 'enviando' })
    .in('id', cola.map((x) => x.id)).eq('estado', 'aprobado').select('id');
  const ids = new Set((mios || []).map((x) => x.id));
  const lista = (cola as Envio[]).filter((x) => ids.has(x.id))
    .sort((a, b) => (a.tipo === b.tipo ? 0 : a.tipo === 'informar_cita' ? -1 : 1)); // primero Informar citas
  if (!lista.length) return { enviados: 0, errores: 0 };
  const s = new Sesion();
  await entrar(s, usuario, clave);
  const fallidos = new Set<string>();
  let enviados = 0; const errores: string[] = [];
  for (const e of lista) {
    try {
      if (fallidos.has(e.parte_id)) throw new Error('No se envió porque falló el envío anterior de este servicio');
      const r = e.tipo === 'repaso' ? await enviarRepaso(s, e) : await enviarInformarCita(s, e);
      await admin.from('sigma_envios').update({ estado: 'enviado', resultado: r, enviado_en: new Date().toISOString(), intentos: 1 }).eq('id', e.id);
      await admin.from('partes').update({ sigma_ficha_en: null }).eq('id', e.parte_id); // releer la ficha en la próxima pasada
      enviados++;
    } catch (err) {
      fallidos.add(e.parte_id);
      const msg = (err as Error).message;
      await admin.from('sigma_envios').update({ estado: 'error', resultado: msg }).eq('id', e.id);
      errores.push(`${e.parte.numero_servicio}: ${msg}`);
    }
  }
  if (errores.length) {
    try {
      await fetch(`${Deno.env.get('SUPABASE_URL')}/functions/v1/notificar`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-kubel-secreto': secretoAvisos },
        body: JSON.stringify({ tabla: 'sigma', evento: 'resumen', nuevo: { cuenta, nombre, error: `Envío a SIGMA fallido · ${errores.slice(0, 2).join(' · ')}${errores.length > 2 ? ' …' : ''}` } }),
      });
    } catch (err) { console.error('aviso envíos', (err as Error).message); }
  }
  return { enviados, errores: errores.length };
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
  const soloEnviar = url.searchParams.get('enviar') === '1';
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
    if (soloEnviar) { // llamada inmediata al aprobar un envío en la oficina
      try { resultados.push({ cuenta: c.id, ...(await procesarEnvios(admin, c.id, c.nombre, usuario, clave, s)) } as unknown as Resumen); }
      catch (err) { console.error('envíos', c.id, err); }
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
    if (!prueba) {
      try { await procesarEnvios(admin, c.id, c.nombre, usuario, clave, s); } catch (err) { console.error('envíos', c.id, err); }
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
