// Carga la librería de Supabase (CDN principal y uno de reserva).
(function () {
  var fuentes = [
    'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
    'https://unpkg.com/@supabase/supabase-js@2.45.4/dist/umd/supabase.js',
  ];
  function probar(i) {
    if (i >= fuentes.length) { window.KUBEL_SB='error'; document.dispatchEvent(new Event('supabase-error')); return; }
    var s = document.createElement('script');
    s.src = fuentes[i];
    s.onload = function () { if (window.supabase) { window.KUBEL_SB='listo'; document.dispatchEvent(new Event('supabase-listo')); } else probar(i + 1); };
    s.onerror = function () { probar(i + 1); };
    document.head.appendChild(s);
  }
  probar(0);
})();
