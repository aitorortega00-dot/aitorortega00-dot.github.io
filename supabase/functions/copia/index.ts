// KUBEL — copia de seguridad de los datos (sin las fotos), cifrada con AES-256-GCM.
// La pide GitHub cada semana y se guarda allí cifrada. Solo la oficina puede descifrarla (web de oficina → Operarios → Copias).
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import postgres from 'npm:postgres@3.4.4';
import { encodeBase64, decodeBase64 } from 'jsr:@std/encoding@1/base64';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
};
const TABLAS = ['companias', 'perfiles', 'partes', 'asignaciones', 'informes', 'fotos'];

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sql = postgres(Deno.env.get('SUPABASE_DB_URL')!, { max: 1, prepare: false });
    let clave: string;
    try { clave = (await sql`select valor from privado.ajustes where clave = 'backup_key'`)[0].valor; } finally { await sql.end(); }

    const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
    const datos: Record<string, unknown[]> = {};
    for (const t of TABLAS) {
      const filas: unknown[] = [];
      for (let desde = 0; ; desde += 1000) {
        const { data, error } = await admin.from(t).select('*').range(desde, desde + 999);
        if (error) throw error;
        filas.push(...(data || []));
        if (!data || data.length < 1000) break;
      }
      datos[t] = filas;
    }
    const texto = new TextEncoder().encode(JSON.stringify({ app: 'KUBEL', fecha: new Date().toISOString(), datos }));
    const key = await crypto.subtle.importKey('raw', decodeBase64(clave), 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cifrado = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, texto));
    const resumen = Object.fromEntries(TABLAS.map((t) => [t, datos[t].length]));
    return new Response(JSON.stringify({ formato: 'kubel-copia-v1', fecha: new Date().toISOString(), filas: resumen, iv: encodeBase64(iv), datos: encodeBase64(cifrado) }), {
      headers: { ...cors, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: (e as Error).message }), { status: 500, headers: { ...cors, 'Content-Type': 'application/json' } });
  }
});
