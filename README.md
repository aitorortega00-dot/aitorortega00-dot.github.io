# KUBEL

- **Oficina** → https://kubelapp.github.io/oficina/
- **Operarios** → https://kubelapp.github.io/operario/
- **APK Android** → https://github.com/kubelapp/kubelapp.github.io/releases/latest/download/kubel-operario.apk

Web estática (HTML + JS) sobre Supabase. Cada cambio subido a `main` se publica solo en GitHub Pages.
La APK (carpeta `android/`) es un envoltorio Trusted Web Activity de la web de operarios: los cambios de la web
llegan a todos los móviles sin reinstalar. Se fabrica con la acción **APK Android** (necesita el secreto `KUBEL_KEYSTORE_PASS`).

## Automático
- **Notificaciones push**: función Supabase `notificar`, llamada por disparadores de la base de datos (servicio nuevo/cambiado/retirado → operario; informe o visita no realizada → oficina).
- **Supabase siempre activo**: ping diario (pg_cron dentro de Supabase + acción "Copia de seguridad" de GitHub).
- **Copia de seguridad**: cada lunes, cifrada, 90 días en Actions → "Copia de seguridad". Se abre desde la web de oficina → Operarios.
