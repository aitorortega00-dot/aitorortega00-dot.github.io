// KUBEL — gestión de cuentas desde la web de oficina.
// Solo responde a usuarios con rol 'oficina'. Desplegada en Supabase como "usuarios".
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const resp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: u, error: eu } = await admin.auth.getUser(token);
    if (eu || !u?.user) return resp({ error: 'Sesión no válida' }, 401);
    const { data: yo } = await admin.from('perfiles').select('rol, activo').eq('id', u.user.id).single();
    if (!yo || yo.rol !== 'oficina' || !yo.activo) return resp({ error: 'Solo la oficina puede gestionar cuentas' }, 403);

    const b = await req.json();
    if (b.accion === 'crear') {
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const nombre = String(b.nombre || '').trim();
      const rol = b.rol === 'oficina' ? 'oficina' : 'operario';
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return resp({ error: 'Correo no válido' }, 400);
      if (password.length < 6) return resp({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
      if (!nombre) return resp({ error: 'Falta el nombre' }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { nombre } });
      if (error) return resp({ error: /already|registered|exists/i.test(error.message) ? 'Ya existe una cuenta con ese correo' : error.message }, 400);
      const gremios = Array.isArray(b.gremios) ? b.gremios.map(String) : [];
      await admin.from('perfiles').update({ nombre, rol, telefono: b.telefono || null, gremios }).eq('id', data.user.id);
      return resp({ ok: true, id: data.user.id });
    }
    if (b.accion === 'clave') {
      const password = String(b.password || '');
      if (password.length < 6) return resp({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
      const { error } = await admin.auth.admin.updateUserById(String(b.id), { password });
      if (error) return resp({ error: error.message }, 400);
      return resp({ ok: true });
    }
    if (b.accion === 'correos') {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
      if (error) return resp({ error: error.message }, 400);
      const mapa: Record<string, string> = {};
      data.users.forEach((x) => { mapa[x.id] = x.email || ''; });
      return resp({ ok: true, correos: mapa });
    }
    return resp({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    return resp({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
