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
- **Presupuestos SIGMA**: función Supabase `sigma-presupuestos` (pg_cron a los minutos 07 y 37). Lee la pestaña Presupuesto del portal de los gremios 11A, 77A, 30A, 10A y 76A y los clasifica (aceptado / pendiente de valoración / enviado / rechazado) para la vista **Presupuestos** de la oficina.
- **Copia de seguridad**: cada lunes, cifrada, 90 días en Actions → "Copia de seguridad". Se abre desde el panel de administrador (/admin/).
