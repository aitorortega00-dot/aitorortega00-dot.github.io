// KUBEL — notificaciones push en el móvil / ordenador.
// iPhone: solo funciona con la app añadida a la pantalla de inicio (iOS 16.4 o superior).
(function () {
  function claveBytes(b64) {
    const pad = '='.repeat((4 - (b64.length % 4)) % 4);
    const raw = atob((b64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
  }
  function dispositivo() {
    const ua = navigator.userAgent;
    if (/iPhone|iPad/.test(ua)) return 'iPhone';
    if (/Android/.test(ua)) return 'Android';
    if (/Windows/.test(ua)) return 'Windows';
    if (/Mac/.test(ua)) return 'Mac';
    return 'Otro';
  }
  const esIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const instalada = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  window.KubelAvisos = {
    soportado() { return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window; },
    // En iPhone sin instalar no hay avisos: hay que añadirla a inicio primero
    necesitaInstalar() { return esIOS && !instalada; },
    permiso() { return 'Notification' in window ? Notification.permission : 'unsupported'; },
    async guardar(sb, sub) {
      const j = sub.toJSON();
      const { error } = await sb.rpc('registrar_suscripcion', { p_endpoint: j.endpoint, p_p256dh: j.keys.p256dh, p_auth: j.keys.auth, p_dispositivo: dispositivo() });
      if (error) throw error;
    },
    async activar(sb) {
      if (!this.soportado()) throw new Error(this.necesitaInstalar() ? 'En iPhone, primero añade la app a la pantalla de inicio y ábrela desde ahí.' : 'Este navegador no admite avisos.');
      const p = await Notification.requestPermission();
      if (p !== 'granted') throw new Error('Has denegado los avisos. Actívalos en los ajustes del navegador/móvil para esta web.');
      const reg = await navigator.serviceWorker.ready;
      let sub = await reg.pushManager.getSubscription();
      if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: claveBytes(window.KUBEL_CONFIG.vapid) });
      await this.guardar(sb, sub);
      return true;
    },
    // Al entrar: si ya dio permiso, renueva la suscripción en silencio
    async sincronizar(sb) {
      try {
        if (!this.soportado() || Notification.permission !== 'granted') return false;
        const reg = await navigator.serviceWorker.ready;
        let sub = await reg.pushManager.getSubscription();
        if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: claveBytes(window.KUBEL_CONFIG.vapid) });
        await this.guardar(sb, sub);
        return true;
      } catch (e) { console.warn('avisos', e); return false; }
    },
    // Al salir: este móvil deja de recibir avisos de esta cuenta
    async desactivar(sb) {
      try {
        if (!this.soportado()) return;
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = reg && (await reg.pushManager.getSubscription());
        if (sub) { await sb.rpc('borrar_suscripcion', { p_endpoint: sub.endpoint }); await sub.unsubscribe(); }
      } catch (e) { console.warn('avisos', e); }
    },
    async activos() {
      try {
        if (!this.soportado() || Notification.permission !== 'granted') return false;
        const reg = await navigator.serviceWorker.getRegistration();
        return !!(reg && (await reg.pushManager.getSubscription()));
      } catch { return false; }
    },
  };
})();
