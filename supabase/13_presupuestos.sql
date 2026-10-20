-- =====================================================================
--  KUBEL — 13: Presupuestos (pestaña «Presupuesto» del portal SIGMA) · 21/10/2026
--
--  Solo servicios de los gremios 11A, 77A, 30A, 10A y 76A. El robot sigma-sync lee las
--  partidas del presupuesto (servicio JSON valuations-initial-data del portal) y clasifica:
--    · 'aceptado'      → en la última fecha con decisión hay alguna partida ACEPTADO POR COMPAÑIA / POR MA
--    · 'rechazado'     → en la última fecha con decisión solo hay partidas RECHAZADO POR … (volver a valorar)
--    · 'enviado'       → hay partidas en «Pendiente»: valorado y esperando respuesta de compañía/MA
--    · 'sin_valorar'   → no hay ninguna partida subida
--    · 'bloqueado'     → el portal no deja valorar aún (siniestro sin confirmar, falta la firma del
--                        presupuesto/encargo…); cuenta como sin valorar. El motivo, en sigma_ptto_motivo
--
--  · partes.sigma_ptto_estado       = clasificación actual (null = aún no leído o fuera de esos gremios)
--  · partes.sigma_ptto_motivo       = texto del portal cuando está 'bloqueado'
--  · partes.sigma_ptto_lineas       = partidas leídas: [{baremo, descripcion, unidades, estado, fecha}]
--  · partes.sigma_ptto_fecha        = fecha de la última decisión de compañía/MA (dd/mm/aaaa → date)
--  · partes.sigma_ptto_desde        = desde cuándo está en la clasificación actual
--  · partes.sigma_ptto_revisado_en  = última vez que el robot guardó un cambio (solo escribe cuando cambia algo)
-- =====================================================================
alter table public.partes
  add column if not exists sigma_ptto_estado text
    check (sigma_ptto_estado in ('aceptado', 'rechazado', 'enviado', 'sin_valorar', 'bloqueado')),
  add column if not exists sigma_ptto_motivo text,
  add column if not exists sigma_ptto_lineas jsonb,
  add column if not exists sigma_ptto_fecha date,
  add column if not exists sigma_ptto_desde timestamptz,
  add column if not exists sigma_ptto_revisado_en timestamptz;

create index if not exists partes_ptto_idx on public.partes (sigma_ptto_estado) where sigma_ptto_estado is not null;

-- Lectura: función sigma-presupuestos (aparte de sigma-sync), a los minutos 07 y 37 entre las pasadas de sigma-sync.
-- Mismo horario que sigma-sync (pg_cron va en UTC).
alter table public.partes drop constraint if exists partes_sigma_ptto_estado_check;
alter table public.partes add constraint partes_sigma_ptto_estado_check
  check (sigma_ptto_estado in ('aceptado', 'rechazado', 'enviado', 'sin_valorar', 'bloqueado'));

create or replace function privado.lanzar_presupuestos()
returns void language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-presupuestos',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000
  );
end; $$;
revoke execute on function privado.lanzar_presupuestos() from public, anon, authenticated;

select cron.schedule('kubel-sigma-presupuestos', '7,37 5-19 * * *', 'select privado.lanzar_presupuestos()');
