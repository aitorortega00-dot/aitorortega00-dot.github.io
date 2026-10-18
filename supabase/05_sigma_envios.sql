-- =====================================================================
--  KUBEL — Envíos a SIGMA (bandeja con aprobación de la oficina)
--  YA APLICADO en el proyecto kubel el 18/10/2026 (migraciones sigma_envios,
--  sigma_envios_disparo). Copia de referencia.
--  Reglas de la oficina:
--   - Nada sale al portal sin que la oficina lo apruebe.
--   - "Informar citas" usa SIEMPRE la fecha y hora citadas, nunca la del informe.
--   - El aviso de SMS al cliente del Repaso se confirma siempre con "Sí".
-- =====================================================================
create table public.sigma_envios (
  id               uuid primary key default gen_random_uuid(),
  parte_id         uuid not null references public.partes (id) on delete cascade,
  asignacion_id    uuid references public.asignaciones (id) on delete set null,
  informe_id       uuid references public.informes (id) on delete set null,
  tipo             text not null check (tipo in ('repaso', 'informar_cita')),
  origen           text not null default 'manual' check (origen in ('planificacion', 'informe', 'no_realizado', 'manual')),
  motivo_codigo    text, motivo_texto text, fecha date, hora time,            -- Repaso
  resolucion       text check (resolucion in ('V', 'I', 'C')),               -- Informar citas
  resolucion_motivo text, cita_fecha date, cita_hora time,
  comentario       text not null default '',
  estado           text not null default 'borrador'
                   check (estado in ('borrador', 'aprobado', 'enviando', 'enviado', 'error', 'descartado')),
  resultado        text,
  intentos         integer not null default 0,
  creado_en        timestamptz not null default now(),
  creado_por       uuid default auth.uid(),
  aprobado_por     uuid, aprobado_en timestamptz, enviado_en timestamptz,
  actualizado_en   timestamptz not null default now()
);
create index sigma_envios_estado_idx on public.sigma_envios (estado, creado_en);
create index sigma_envios_parte_idx on public.sigma_envios (parte_id);
create trigger sigma_envios_actualizado_en before update on public.sigma_envios
  for each row execute function public.tocar_actualizado_en();
alter table public.sigma_envios enable row level security;
create policy "oficina gestiona envíos SIGMA" on public.sigma_envios
  for all to authenticated using (public.es_oficina()) with check (public.es_oficina());
alter publication supabase_realtime add table public.sigma_envios;

-- Protección: lo ya enviado no se toca; al aprobar se guarda quién y cuándo
create or replace function public.proteger_envio_sigma()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.estado in ('enviado', 'enviando') and auth.uid() is not null then
    raise exception 'Este envío ya se ha mandado a SIGMA y no se puede modificar';
  end if;
  if new.estado = 'aprobado' and old.estado is distinct from 'aprobado' and auth.uid() is not null then
    new.aprobado_por := auth.uid(); new.aprobado_en := now();
  end if;
  return new;
end; $$;
create trigger sigma_envios_proteger before update on public.sigma_envios
  for each row execute function public.proteger_envio_sigma();

-- Borradores automáticos:
--  1) planificar/mover visita de un parte SIGMA → Repaso "Visita al Cliente" (código 2)
--  2) informe del operario → Informar citas "Visita realizada" (609 terminado / 601 parcial / 604 no reparado)
--  3) visita no realizada → Informar citas "Visita cancelada" (706 causa asegurado)
--  (funciones sigma_borrador_desde_asignacion, sigma_borrador_desde_informe, sigma_borrador_no_realizado:
--   ver migración sigma_envios en Supabase)

-- Al aprobar → el robot lo manda en el momento (sigma-sync?enviar=1&cuenta=…)
--  (función privado.disparar_envio_sigma + trigger sigma_envios_disparar: ver migración sigma_envios_disparo)
