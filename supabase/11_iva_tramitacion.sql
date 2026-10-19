-- =====================================================================
--  API KUBEL — 11: Repaso bloqueado por "Documento de Iva pendiente de Validar"
--  y mensajes a tramitación (pestaña "Su Gestor/Tramitador" del portal SIGMA).
--
--  · partes.sigma_iva_pendiente  = desde cuándo SIGMA bloquea el Repaso de ese servicio
--                                  (null = no bloqueado). Lo pone y lo quita el robot.
--  · partes.sigma_iva_revisado_en = última vez que el robot lo comprobó en el portal.
--  · sigma_envios.tipo admite 'tramitacion' (mensaje a tramitación: motivo_codigo +
--    motivo_texto del desplegable del portal y el texto en comentario).
-- =====================================================================
alter table public.partes
  add column if not exists sigma_iva_pendiente   timestamptz,
  add column if not exists sigma_iva_revisado_en timestamptz;

create index if not exists partes_iva_idx on public.partes (sigma_iva_pendiente) where sigma_iva_pendiente is not null;

alter table public.sigma_envios drop constraint if exists sigma_envios_tipo_check;
alter table public.sigma_envios add constraint sigma_envios_tipo_check
  check (tipo in ('repaso', 'informar_cita', 'tramitacion'));
