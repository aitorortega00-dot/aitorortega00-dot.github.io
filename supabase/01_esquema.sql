-- =====================================================================
--  API KUBEL — Esquema de base de datos (Supabase / PostgreSQL)
--  Fase 1: partes dados de alta a mano + asignación a operarios por día
--          + informes con fotos desde la app móvil.
--
--  Cómo usarlo: Supabase → SQL Editor → New query → pegar TODO → Run.
--  Se puede ejecutar una sola vez sobre un proyecto vacío.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. PERFILES (una fila por cada cuenta: operario u oficina)
--    Se crea sola al dar de alta un usuario en Authentication.
-- ---------------------------------------------------------------------
create table public.perfiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  nombre      text        not null,
  telefono    text,
  rol         text        not null default 'operario'
                          check (rol in ('operario', 'oficina')),
  gremios     text[]      not null default '{}',
  activo      boolean     not null default true,
  creado_en   timestamptz not null default now()
);

create or replace function public.crear_perfil_nuevo_usuario()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.perfiles (id, nombre)
  values (
    new.id,
    coalesce(new.raw_user_meta_data ->> 'nombre', split_part(new.email, '@', 1))
  );
  return new;
end;
$$;

create trigger al_crear_usuario
  after insert on auth.users
  for each row execute function public.crear_perfil_nuevo_usuario();

-- ¿El usuario conectado es de oficina? (lo usan las reglas de seguridad)
create or replace function public.es_oficina()
returns boolean
language sql
stable
security definer set search_path = public
as $$
  select exists (
    select 1 from public.perfiles
    where id = auth.uid() and rol = 'oficina' and activo
  );
$$;

-- ---------------------------------------------------------------------
-- 2. COMPAÑÍAS
-- ---------------------------------------------------------------------
create table public.companias (
  id      serial primary key,
  nombre  text not null unique,
  activa  boolean not null default true
);

insert into public.companias (nombre) values
  ('SIGMA'), ('HomeServe'), ('Tasho'), ('OnRed');

-- ---------------------------------------------------------------------
-- 3. PARTES / EXPEDIENTES
-- ---------------------------------------------------------------------
create table public.partes (
  id               uuid primary key default gen_random_uuid(),
  compania_id      integer not null references public.companias (id),
  numero_servicio  text    not null,
  asegurado        text,
  telefono         text,
  telefono2        text,
  direccion        text    not null,
  poblacion        text,
  codigo_postal    text,
  gremio           text,
  descripcion      text,
  urgente          boolean not null default false,
  estado           text    not null default 'pendiente'
                   check (estado in ('pendiente', 'asignado', 'en_curso',
                                     'terminado', 'cerrado', 'anulado')),
  notas_oficina    text,
  creado_en        timestamptz not null default now(),
  actualizado_en   timestamptz not null default now(),
  unique (compania_id, numero_servicio)
);

create index partes_estado_idx on public.partes (estado);

-- ---------------------------------------------------------------------
-- 4. ASIGNACIONES  (parte ↔ operario ↔ día)  = la "ruta" de cada día
-- ---------------------------------------------------------------------
create table public.asignaciones (
  id           uuid primary key default gen_random_uuid(),
  parte_id     uuid not null references public.partes (id) on delete cascade,
  operario_id  uuid not null references public.perfiles (id),
  fecha        date not null,
  hora         time,
  orden        integer not null default 0,
  tipo         text not null default 'visita'
               check (tipo in ('visita', 'repaso')),
  estado       text not null default 'pendiente'
               check (estado in ('pendiente', 'en_camino', 'hecho', 'no_realizado')),
  notas        text,
  creado_en    timestamptz not null default now()
);

create index asignaciones_operario_fecha_idx
  on public.asignaciones (operario_id, fecha, orden);

-- ---------------------------------------------------------------------
-- 5. INFORMES (lo que escribe el operario al terminar una visita)
-- ---------------------------------------------------------------------
create table public.informes (
  id                 uuid primary key default gen_random_uuid(),
  asignacion_id      uuid not null references public.asignaciones (id) on delete cascade,
  parte_id           uuid not null references public.partes (id) on delete cascade,
  operario_id        uuid not null default auth.uid() references public.perfiles (id),
  texto              text not null,
  trabajo_terminado  boolean not null default false,
  necesita_repaso    boolean not null default false,
  importe_gastos     numeric(10, 2),
  creado_en          timestamptz not null default now()
);

create index informes_parte_idx on public.informes (parte_id);

-- ---------------------------------------------------------------------
-- 6. FOTOS (servicio antes/después y facturas de gastos)
--    El archivo va al almacenamiento "fotos"; aquí solo su ruta.
-- ---------------------------------------------------------------------
create table public.fotos (
  id          uuid primary key default gen_random_uuid(),
  informe_id  uuid not null references public.informes (id) on delete cascade,
  parte_id    uuid not null references public.partes (id) on delete cascade,
  tipo        text not null check (tipo in ('antes', 'despues', 'factura')),
  ruta        text not null,
  subido_por  uuid not null default auth.uid() references public.perfiles (id),
  creado_en   timestamptz not null default now()
);

create index fotos_informe_idx on public.fotos (informe_id);

-- ---------------------------------------------------------------------
-- 7. AUTOMATISMOS
-- ---------------------------------------------------------------------

-- 7.1 Fecha de última modificación del parte
create or replace function public.tocar_actualizado_en()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  return new;
end;
$$;

create trigger partes_actualizado_en
  before update on public.partes
  for each row execute function public.tocar_actualizado_en();

-- 7.2 Al asignar un parte pendiente → pasa a "asignado"
create or replace function public.al_asignar_parte()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.partes set estado = 'asignado'
  where id = new.parte_id and estado = 'pendiente';
  return new;
end;
$$;

create trigger asignaciones_marcar_parte
  after insert on public.asignaciones
  for each row execute function public.al_asignar_parte();

-- 7.3 El operario solo puede cambiar el ESTADO de su asignación
--     (no la fecha, el parte, el orden…). La oficina puede todo.
create or replace function public.proteger_asignacion()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  if not public.es_oficina() then
    if (new.parte_id, new.operario_id, new.fecha, new.hora, new.orden, new.tipo, new.notas)
       is distinct from
       (old.parte_id, old.operario_id, old.fecha, old.hora, old.orden, old.tipo, old.notas) then
      raise exception 'Solo la oficina puede modificar la planificación';
    end if;
  end if;
  return new;
end;
$$;

create trigger asignaciones_proteger
  before update on public.asignaciones
  for each row execute function public.proteger_asignacion();

-- 7.4 Al enviar un informe: la visita queda "hecha" y el parte avanza
create or replace function public.al_crear_informe()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  update public.asignaciones set estado = 'hecho' where id = new.asignacion_id;

  update public.partes
     set estado = case when new.trabajo_terminado then 'terminado' else 'en_curso' end
   where id = new.parte_id
     and estado not in ('cerrado', 'anulado');
  return new;
end;
$$;

create trigger informes_avanzar_estado
  after insert on public.informes
  for each row execute function public.al_crear_informe();

-- ---------------------------------------------------------------------
-- 8. SEGURIDAD POR FILAS (RLS)
--    Oficina: ve y modifica todo.
--    Operario: solo ve los partes que tiene asignados y lo que él sube.
-- ---------------------------------------------------------------------
alter table public.perfiles     enable row level security;
alter table public.companias    enable row level security;
alter table public.partes       enable row level security;
alter table public.asignaciones enable row level security;
alter table public.informes     enable row level security;
alter table public.fotos        enable row level security;

-- perfiles
create policy "ver mi perfil o todos si oficina" on public.perfiles
  for select to authenticated
  using (id = auth.uid() or public.es_oficina());
create policy "oficina modifica perfiles" on public.perfiles
  for update to authenticated
  using (public.es_oficina()) with check (public.es_oficina());

-- compañías
create policy "todos leen compañías" on public.companias
  for select to authenticated using (true);
create policy "oficina gestiona compañías" on public.companias
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());

-- partes
create policy "oficina gestiona partes" on public.partes
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());
create policy "operario ve sus partes asignados" on public.partes
  for select to authenticated
  using (exists (
    select 1 from public.asignaciones a
    where a.parte_id = partes.id and a.operario_id = auth.uid()
  ));

-- asignaciones
create policy "oficina gestiona asignaciones" on public.asignaciones
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());
create policy "operario ve sus asignaciones" on public.asignaciones
  for select to authenticated
  using (operario_id = auth.uid());
create policy "operario cambia estado de sus asignaciones" on public.asignaciones
  for update to authenticated
  using (operario_id = auth.uid()) with check (operario_id = auth.uid());

-- informes
create policy "oficina gestiona informes" on public.informes
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());
create policy "operario ve sus informes" on public.informes
  for select to authenticated
  using (operario_id = auth.uid());
create policy "operario crea informe de su asignación" on public.informes
  for insert to authenticated
  with check (
    operario_id = auth.uid()
    and exists (
      select 1 from public.asignaciones a
      where a.id = asignacion_id
        and a.operario_id = auth.uid()
        and a.parte_id = informes.parte_id
    )
  );

-- fotos
create policy "oficina gestiona fotos" on public.fotos
  for all to authenticated
  using (public.es_oficina()) with check (public.es_oficina());
create policy "operario ve sus fotos" on public.fotos
  for select to authenticated
  using (subido_por = auth.uid());
create policy "operario añade fotos a su informe" on public.fotos
  for insert to authenticated
  with check (
    subido_por = auth.uid()
    and exists (
      select 1 from public.informes i
      where i.id = informe_id
        and i.operario_id = auth.uid()
        and i.parte_id = fotos.parte_id
    )
  );

-- ---------------------------------------------------------------------
-- 9. ALMACENAMIENTO DE FOTOS (privado)
--    Ruta de cada archivo: <id del operario>/<id del parte>/<id informe>/<foto>.jpg
-- ---------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('fotos', 'fotos', false, 6291456, array['image/jpeg']);   -- 6 MB, solo JPEG (como SIGMA)

create policy "operario sube a su carpeta" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'fotos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy "ver fotos propias o todas si oficina" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'fotos'
    and ((storage.foldername(name))[1] = auth.uid()::text or public.es_oficina())
  );

create policy "oficina borra fotos" on storage.objects
  for delete to authenticated
  using (bucket_id = 'fotos' and public.es_oficina());
