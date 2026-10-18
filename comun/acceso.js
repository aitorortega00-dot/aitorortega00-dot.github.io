// KUBEL — Acceso único del personal (oficina, operarios y administrador).
// Un solo formulario para todos: entra con usuario + contraseña, mira el tipo de cuenta
// y abre la web que le toca. Cada web guarda su sesión aparte en el navegador
// (así oficina y administrador pueden estar abiertos a la vez sin echarse).
(function () {
  const c = window.KUBEL_CONFIG;
  const ref = new URL(c.url).hostname.split('.')[0];
  // Dónde guarda la sesión cada web (las mismas claves que ya usaban, para no echar a nadie)
  const CLAVE = { operario: 'kubel-operario', oficina: 'sb-' + ref + '-auth-token', admin: 'kubel-admin-sesion' };
  const DESTINO = { operario: '/operario/', oficina: '/oficina/', admin: '/admin/' };
  const NOMBRE = { operario: 'App de operarios', oficina: 'Oficina', admin: 'Panel de administrador' };
  const MSG = 'kubel-acceso-msg';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const aCorreo = (s) => { s = String(s || '').trim().toLowerCase(); return s && !s.includes('@') ? s + '@kubel.app' : s; };
  const verUsuario = (e) => /@kubel\.app$/i.test(e || '') ? e.replace(/@kubel\.app$/i, '').toUpperCase() : (e || '');
  // App instalada (iPhone en pantalla de inicio, APK, PWA): no se puede saltar a otra web sin perder la sesión
  const instalada = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true || document.referrer.startsWith('android-app://');

  function textoError(e) {
    const m = e?.message || String(e);
    if (/Invalid login credentials/i.test(m)) return 'Usuario o contraseña incorrectos.';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(m)) return 'Sin conexión a internet. Inténtalo de nuevo.';
    return m;
  }
  function textoOtraWeb(rol) {
    return `Esta cuenta es de ${rol === 'admin' ? 'administrador' : rol}. Ábrela desde el navegador en ${location.host}.`;
  }
  function dejarMensaje(t) { try { sessionStorage.setItem(MSG, t); } catch (_) {} }
  function leerMensaje() { try { const t = sessionStorage.getItem(MSG); sessionStorage.removeItem(MSG); return t || ''; } catch (_) { return ''; } }

  // Guarda la sesión en el sitio de la web que corresponde a ese tipo de cuenta
  async function guardar(sesion, rol) {
    const cli = window.supabase.createClient(c.url, c.key, {
      auth: { storageKey: CLAVE[rol], persistSession: true, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await cli.auth.setSession({ access_token: sesion.access_token, refresh_token: sesion.refresh_token });
    if (error) throw error;
  }

  async function entrar(usuario, clave, app) {
    const tmp = window.supabase.createClient(c.url, c.key, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { data, error } = await tmp.auth.signInWithPassword({ email: aCorreo(usuario), password: clave });
    if (error) throw error;
    const { data: p, error: e2 } = await tmp.from('perfiles').select('rol, activo').eq('id', data.user.id).single();
    const cerrar = () => tmp.auth.signOut({ scope: 'local' }).catch(() => {});
    if (e2 || !p) { await cerrar(); throw new Error('No se encontró el perfil de esta cuenta.'); }
    if (!p.activo) { await cerrar(); throw new Error('Esta cuenta está desactivada. Habla con la oficina.'); }
    if (!CLAVE[p.rol]) { await cerrar(); throw new Error('Tipo de cuenta desconocido.'); }
    if (app && p.rol !== app && instalada()) { await cerrar(); throw new Error(textoOtraWeb(p.rol)); }
    await guardar(data.session, p.rol);
    if (DESTINO[p.rol] === location.pathname) location.reload(); else location.assign(DESTINO[p.rol]);
  }

  // Una web abierta con una cuenta que no es la suya: pasa la sesión a su web y la abre.
  // sb = cliente de la web actual; sesion = sesión actual; rol = tipo real de la cuenta.
  async function mover(sb, sesion, rol) {
    if (CLAVE[rol] && !instalada()) {
      try {
        sb.auth.stopAutoRefresh?.();
        await guardar(sesion, rol);
        try { localStorage.removeItem(sb.auth.storageKey); } catch (_) {}
        location.replace(DESTINO[rol]);
        return;
      } catch (_) { /* si falla, se cierra aquí y se vuelve a pedir el acceso */ }
    }
    dejarMensaje(CLAVE[rol] ? textoOtraWeb(rol) : 'Esta cuenta no tiene acceso.');
    await sb.auth.signOut({ scope: 'local' });
  }

  function estilos() {
    if (document.getElementById('kacc-css')) return;
    const st = document.createElement('style');
    st.id = 'kacc-css';
    st.textContent = `
      .kacc{background:#fff;border-radius:18px;padding:24px;width:100%;max-width:400px;margin:0 auto;color:#1E2328;
        font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;text-align:left;box-shadow:0 10px 30px rgba(0,0,0,.18)}
      .kacc h1{margin:0;text-align:center;color:#1F4E5F;letter-spacing:5px;font-size:32px}
      .kacc .kacc-sub{text-align:center;color:#5F6770;margin:2px 0 18px}
      .kacc label{display:block;font-size:14px;font-weight:600;color:#3A4148;margin:12px 0 4px}
      .kacc input{display:block;width:100%;box-sizing:border-box;font:inherit;font-size:16px;padding:12px;border:1.5px solid #E2DED6;border-radius:10px;background:#fff;color:#1E2328}
      .kacc input:focus{outline:none;border-color:#1F4E5F}
      .kacc .kacc-err{color:#B3261E;font-size:14px;min-height:20px;margin-top:10px}
      .kacc button{display:block;width:100%;font:inherit;font-weight:600;border:0;border-radius:10px;padding:13px;margin-top:8px;cursor:pointer;background:#1F4E5F;color:#fff}
      .kacc button:disabled{opacity:.6}
      .kacc .kacc-seguir{background:#fff;color:#1F4E5F;border:1.5px solid #1F4E5F;margin:0 0 8px;text-align:left}
      .kacc .kacc-seguir small{display:block;font-weight:400;color:#5F6770}
      .kacc .kacc-o{text-align:center;color:#5F6770;font-size:13px;margin:10px 0 0}
      .kacc .kacc-extra{margin-top:16px;font-size:14px;color:#5F6770}`;
    document.head.appendChild(st);
  }

  // Sesiones ya guardadas en este navegador (para el portal: "Continuar como…")
  function guardadas() {
    const r = [];
    for (const rol of ['oficina', 'operario', 'admin']) {
      try {
        const j = JSON.parse(localStorage.getItem(CLAVE[rol]) || 'null');
        const s = j?.currentSession || j;
        if (s?.refresh_token && s?.user?.email) r.push({ rol, usuario: verUsuario(s.user.email) });
      } catch (_) {}
    }
    return r;
  }

  // Pinta el formulario de acceso dentro de "el".
  // opciones: app ('operario' | 'oficina' | 'admin' | null en el portal), mensaje, extra (HTML debajo), seguir (mostrar "Continuar como…")
  function pintar(el, opciones = {}) {
    estilos();
    const msg = opciones.mensaje || leerMensaje();
    const seguir = opciones.seguir ? guardadas() : [];
    el.innerHTML = `<form class="kacc" autocomplete="on" novalidate>
      <h1>KUBEL</h1><p class="kacc-sub">Acceso del personal</p>
      ${seguir.map((g) => `<button type="button" class="kacc-seguir" data-rol="${g.rol}">Continuar como ${esc(g.usuario)}<small>${NOMBRE[g.rol]}</small></button>`).join('')}
      ${seguir.length ? '<p class="kacc-o">o entra con otra cuenta</p>' : ''}
      <label for="kacc-u">Usuario</label>
      <input id="kacc-u" name="username" type="text" autocomplete="username" autocapitalize="characters" autocorrect="off" spellcheck="false" placeholder="Tu usuario">
      <label for="kacc-c">Contraseña</label>
      <input id="kacc-c" name="password" type="password" autocomplete="current-password">
      <div class="kacc-err" role="alert">${esc(msg)}</div>
      <button type="submit">Entrar</button>
      ${opciones.extra ? `<div class="kacc-extra">${opciones.extra}</div>` : ''}
    </form>`;
    const f = el.querySelector('form'), err = f.querySelector('.kacc-err'), btn = f.querySelector('button[type=submit]');
    f.querySelectorAll('.kacc-seguir').forEach((b) => { b.onclick = () => location.assign(DESTINO[b.dataset.rol]); });
    f.onsubmit = async (e) => {
      e.preventDefault();
      const u = f.querySelector('#kacc-u').value, k = f.querySelector('#kacc-c').value;
      if (!u.trim() || !k) { err.textContent = 'Escribe tu usuario y tu contraseña.'; return; }
      err.textContent = ''; btn.disabled = true; btn.textContent = 'Entrando…';
      try { await entrar(u, k, opciones.app || null); }
      catch (x) { err.textContent = textoError(x); btn.disabled = false; btn.textContent = 'Entrar'; }
    };
  }

  window.KubelAcceso = { pintar, mover, dejarMensaje, CLAVE, DESTINO };
})();
