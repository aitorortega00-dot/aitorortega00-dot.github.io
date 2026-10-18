// KUBEL — gestión de cuentas.
// - Oficina: crear operarios/oficina, cambiar contraseñas y ver correos (nunca de cuentas admin).
// - Admin (panel /admin/): además listar todas las cuentas y cambiar correo, nombre, contraseña, rol y activo.
// Desplegada en Supabase como "usuarios".
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const resp = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

const ROLES = ['operario', 'oficina', 'admin'];
// "ADMINISTRADOR" (sin @) -> administrador@kubel.app
const aCorreo = (x: unknown) => {
  const s = String(x || '').trim().toLowerCase();
  return s && !s.includes('@') ? `${s}@kubel.app` : s;
};
const correoValido = (e: string) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e);
const traducir = (m: string) =>
  /already|registered|exists/i.test(m) ? 'Ya existe una cuenta con ese correo'
  : /password/i.test(m) && /weak|short|least/i.test(m) ? 'Contraseña demasiado débil (mínimo 6 caracteres)'
  : m;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

    const token = (req.headers.get('Authorization') || '').replace('Bearer ', '');
    const { data: u, error: eu } = await admin.auth.getUser(token);
    if (eu || !u?.user) return resp({ error: 'Sesión no válida' }, 401);
    const { data: yo } = await admin.from('perfiles').select('rol, activo').eq('id', u.user.id).single();
    if (!yo || !yo.activo || !['oficina', 'admin'].includes(yo.rol)) return resp({ error: 'Sin permiso para gestionar cuentas' }, 403);
    const soyAdmin = yo.rol === 'admin';

    const rolDe = async (id: string) =>
      (await admin.from('perfiles').select('rol').eq('id', id).single()).data?.rol as string | undefined;

    const b = await req.json();

    if (b.accion === 'crear') {
      const email = aCorreo(b.email);
      const password = String(b.password || '');
      const nombre = String(b.nombre || '').trim();
      const rol = soyAdmin && ROLES.includes(b.rol) ? b.rol : b.rol === 'oficina' ? 'oficina' : 'operario';
      if (!correoValido(email)) return resp({ error: 'Correo no válido' }, 400);
      if (password.length < 6) return resp({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
      if (!nombre) return resp({ error: 'Falta el nombre' }, 400);
      const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { nombre } });
      if (error) return resp({ error: traducir(error.message) }, 400);
      const gremios = Array.isArray(b.gremios) ? b.gremios.map(String) : [];
      await admin.from('perfiles').update({ nombre, rol, telefono: b.telefono || null, gremios }).eq('id', data.user.id);
      return resp({ ok: true, id: data.user.id, email });
    }

    if (b.accion === 'clave') {
      const id = String(b.id || '');
      const password = String(b.password || '');
      if (password.length < 6) return resp({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
      if (!soyAdmin && (await rolDe(id)) === 'admin') return resp({ error: 'Solo el administrador puede cambiar esta contraseña' }, 403);
      const { error } = await admin.auth.admin.updateUserById(id, { password });
      if (error) return resp({ error: traducir(error.message) }, 400);
      return resp({ ok: true });
    }

    if (b.accion === 'correos') {
      const { data, error } = await admin.auth.admin.listUsers({ perPage: 1000 });
      if (error) return resp({ error: error.message }, 400);
      const admins = new Set(((await admin.from('perfiles').select('id').eq('rol', 'admin')).data || []).map((x) => x.id));
      const mapa: Record<string, string> = {};
      data.users.forEach((x) => { if (soyAdmin || !admins.has(x.id)) mapa[x.id] = x.email || ''; });
      return resp({ ok: true, correos: mapa });
    }

    // ----- Solo administrador -----
    if (!soyAdmin) return resp({ error: 'Solo el administrador puede hacer esto' }, 403);

    if (b.accion === 'listar') {
      const [{ data: us, error }, { data: pf }] = await Promise.all([
        admin.auth.admin.listUsers({ perPage: 1000 }),
        admin.from('perfiles').select('id, nombre, telefono, rol, activo, gremios, creado_en'),
      ]);
      if (error) return resp({ error: error.message }, 400);
      const porId = new Map((us?.users || []).map((x) => [x.id, x]));
      const cuentas = (pf || []).map((p) => {
        const x = porId.get(p.id);
        return { ...p, email: x?.email || '', ultimo_acceso: x?.last_sign_in_at || null };
      }).sort((a, b) => ROLES.indexOf(b.rol) - ROLES.indexOf(a.rol) || a.nombre.localeCompare(b.nombre, 'es'));
      return resp({ ok: true, cuentas, yo: u.user.id });
    }

    if (b.accion === 'editar') {
      const id = String(b.id || '');
      const { data: actual } = await admin.from('perfiles').select('id, rol, activo').eq('id', id).single();
      if (!actual) return resp({ error: 'Cuenta no encontrada' }, 404);
      const cambiosAuth: Record<string, unknown> = {};
      const cambiosPerfil: Record<string, unknown> = {};

      if (b.email !== undefined) {
        const email = aCorreo(b.email);
        if (!correoValido(email)) return resp({ error: 'Correo no válido' }, 400);
        cambiosAuth.email = email; cambiosAuth.email_confirm = true;
      }
      if (b.password) {
        if (String(b.password).length < 6) return resp({ error: 'La contraseña debe tener al menos 6 caracteres' }, 400);
        cambiosAuth.password = String(b.password);
      }
      if (b.nombre !== undefined) {
        const nombre = String(b.nombre).trim();
        if (!nombre) return resp({ error: 'El nombre no puede quedar vacío' }, 400);
        cambiosPerfil.nombre = nombre; cambiosAuth.user_metadata = { nombre };
      }
      if (b.rol !== undefined && b.rol !== actual.rol) {
        if (!ROLES.includes(b.rol)) return resp({ error: 'Rol no válido' }, 400);
        if (id === u.user.id) return resp({ error: 'No puedes quitarte a ti mismo el rol de administrador' }, 400);
        cambiosPerfil.rol = b.rol;
      }
      if (b.activo !== undefined && Boolean(b.activo) !== actual.activo) {
        if (id === u.user.id) return resp({ error: 'No puedes desactivar tu propia cuenta' }, 400);
        cambiosPerfil.activo = Boolean(b.activo);
      }

      if (Object.keys(cambiosAuth).length) {
        const { error } = await admin.auth.admin.updateUserById(id, cambiosAuth);
        if (error) return resp({ error: traducir(error.message) }, 400);
      }
      if (Object.keys(cambiosPerfil).length) {
        const { error } = await admin.from('perfiles').update(cambiosPerfil).eq('id', id);
        if (error) return resp({ error: error.message }, 400);
      }
      return resp({ ok: true });
    }

    return resp({ error: 'Acción desconocida' }, 400);
  } catch (e) {
    return resp({ error: e instanceof Error ? e.message : String(e) }, 500);
  }
});
