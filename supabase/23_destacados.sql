-- =====================================================================
--  23 · Destacados ⭐ (29/10/2026)
--  La oficina marca un servicio con la estrella desde su ficha y escribe
--  una anotación compartida. La página ⭐ de la oficina los lista para
--  tener acceso rápido entre todos los usuarios de oficina.
--  Una anotación por servicio. Solo oficina (el operario no la ve).
--  Nunca va a SIGMA.
-- =====================================================================
create table if not exists public.destacados (
  id               uuid primary key default gen_random_uuid(),
  parte_id         uuid not null unique references public.partes (id) on delete cascade,
  nota             text not null default '',
  creado_por       uuid default auth.uid() references public.perfiles (id),
  creado_en        timestamptz not null default now(),
  actualizado_por  uuid default auth.uid() references public.perfiles (id),
  actualizado_en   timestamptz not null default now()
);
alter table public.destacados enable row level security;

create policy "oficina gestiona destacados" on public.destacados
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());

-- Quién y cuándo tocó la anotación por última vez
create or replace function public.destacados_tocar()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  new.actualizado_por := coalesce(auth.uid(), new.actualizado_por);
  return new;
end $$;
create or replace trigger destacados_tocar
  before update on public.destacados
  for each row execute function public.destacados_tocar();

-- Tiempo real (lo que escribe un ordenador aparece en los demás)
alter publication supabase_realtime add table public.destacados;
