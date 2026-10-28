-- =====================================================================
-- 21. FOTOS INTERNAS (de la oficina para el operario)
--     La oficina las sube al crear o editar una visita. Van ligadas al
--     servicio (y a la visita desde la que se subieron): el operario las ve
--     en todas sus visitas de ese servicio. Nunca se envían a SIGMA.
--     Archivo en el almacenamiento «fotos»: internas/<id servicio>/<uuid>.jpg
-- =====================================================================
create table if not exists public.fotos_internas (
  id             uuid primary key default gen_random_uuid(),
  parte_id       uuid not null references public.partes (id) on delete cascade,
  asignacion_id  uuid references public.asignaciones (id) on delete set null,
  ruta           text not null,
  nombre         text,
  subido_por     uuid default auth.uid() references public.perfiles (id),
  creado_en      timestamptz not null default now()
);
create index if not exists fotos_internas_parte_idx on public.fotos_internas (parte_id);
alter table public.fotos_internas enable row level security;

create policy "oficina gestiona fotos internas" on public.fotos_internas
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());
create policy "operario ve fotos internas de sus servicios" on public.fotos_internas
  for select to authenticated
  using (exists (select 1 from public.asignaciones a
                 where a.parte_id = fotos_internas.parte_id and a.operario_id = auth.uid()));

-- Almacenamiento: la oficina sube a internas/…; el operario lee las de sus servicios
create policy "oficina sube fotos internas" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'fotos' and (storage.foldername(name))[1] = 'internas' and public.es_oficina());
create policy "operario ve fotos internas de sus servicios" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'fotos' and (storage.foldername(name))[1] = 'internas'
    and exists (select 1 from public.asignaciones a
                where a.parte_id::text = (storage.foldername(name))[2] and a.operario_id = auth.uid())
  );

-- Tiempo real (la oficina ve al momento lo que sube otro ordenador)
alter publication supabase_realtime add table public.fotos_internas;
