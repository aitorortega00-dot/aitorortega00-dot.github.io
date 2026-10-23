-- =====================================================================
--  KUBEL — Confirmación SIGMA desde el informe del operario (23/10/2026)
--  Pestaña «Confirmación» del portal (componente multiasistencia-fnol).
--  Regla del usuario: solo se confirma cuando llega el informe del operario; la rellena la oficina.
--   · El robot mira (solo lectura) cada informe nuevo de un servicio SIGMA: si el servicio está sin confirmar
--     crea UN borrador tipo 'confirmacion' enganchado a ese informe.
--       - variante 'rapida'   (fasttrack): SIGMA ya trae causa/garantía; se acepta → la manda el robot al aprobar.
--       - variante 'completa' (clasificador de daños): la oficina la hace en el portal; al aprobar, el robot
--         solo comprueba que ya está confirmada.
--   · Fecha de primera visita = fecha/hora CITADAS de la visita (cita_fecha / cita_hora).
--   · Fecha de contacto con el cliente (si SIGMA la pide) → contacto_en, la pone la oficina.
--  Aplicado en Supabase con execute_sql el 23/10/2026.
-- =====================================================================

-- 1) Nuevo tipo de envío
alter table public.sigma_envios drop constraint if exists sigma_envios_tipo_check;
alter table public.sigma_envios add constraint sigma_envios_tipo_check
  check (tipo in ('repaso', 'informar_cita', 'tramitacion', 'confirmacion'));

-- 2) Datos de la confirmación
alter table public.sigma_envios add column if not exists confir_variante text
  check (confir_variante in ('rapida', 'completa'));
alter table public.sigma_envios add column if not exists confir_datos jsonb;   -- lo que muestra SIGMA (causa, garantía, descripción…)

-- 3) Marcas del robot
alter table public.informes add column if not exists sigma_confir_revisado_en timestamptz; -- informe ya mirado
alter table public.partes   add column if not exists sigma_confirmado_en timestamptz;      -- servicio ya confirmado en SIGMA

-- 4) Una sola confirmación viva por servicio
create unique index if not exists sigma_envios_una_confirmacion
  on public.sigma_envios (parte_id)
  where tipo = 'confirmacion' and estado in ('borrador', 'aprobado', 'enviando', 'error');

-- 5) Informes anteriores a esta versión: no se revisan (solo los que lleguen desde ahora)
update public.informes set sigma_confir_revisado_en = now() where sigma_confir_revisado_en is null;
