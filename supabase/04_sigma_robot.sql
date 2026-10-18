-- =====================================================================
--  KUBEL — Fase 3: robot de lectura del portal SIGMA (Multiasistencia)
--  YA APLICADO en el proyecto kubel el 18/10/2026 (migraciones
--  sigma_robot_lectura, sigma_programacion, sigma_aceptados). Copia de referencia.
--  Credenciales del portal: secretos de Edge Functions
--    SIGMA_VLL_USUARIO / SIGMA_VLL_CLAVE (Valladolid)
--    SIGMA_PAL_USUARIO / SIGMA_PAL_CLAVE (Palencia)
-- =====================================================================

-- 1. Campos SIGMA en los partes (solo los escribe el robot)
alter table public.partes
  add column origen            text not null default 'manual' check (origen in ('manual', 'sigma')),
  add column sigma_cuenta      text,          -- 'VLL' Valladolid / 'PAL' Palencia
  add column sigma_profesional text,
  add column sigma_procedencia text,
  add column sigma_gremio      text,          -- código SIGMA (01A, 11A…)
  add column sigma_estado      text,          -- código SIGMA (1, 2, 37…)
  add column sigma_estado_texto text,         -- "Contacto con Cliente (16/10/2026 - 18:28)"
  add column sigma_caducidad   integer,
  add column sigma_duracion    text,
  add column sigma_llamadas    integer,
  add column sigma_alerta      text check (sigma_alerta in ('rojo', 'amarillo', 'verde')),
  add column sigma_marcas      text[] not null default '{}',
  add column sigma_poliza      text,
  add column sigma_telefonos   jsonb,         -- [{numero, tipo, desde, hasta, de}]
  add column sigma_bitacora    jsonb,         -- [{fecha, texto}]
  add column sigma_ficha       jsonb,         -- resto de datos de la ficha
  add column sigma_en_curso    boolean,       -- sale en "Servicios en curso"
  add column sigma_huella      text,          -- para detectar cambios del listado
  add column sigma_ficha_en    timestamptz,   -- última lectura de la ficha
  add column sigma_cambio_en   timestamptz;   -- último cambio detectado en SIGMA

create index partes_sigma_idx on public.partes (compania_id, sigma_cuenta, sigma_en_curso);

-- 2. Tablas de códigos (estado, gremio, procedencia), se rellenan solas
create table public.sigma_codigos (
  tipo           text not null check (tipo in ('estado', 'gremio', 'procedencia')),
  codigo         text not null,
  texto          text,
  gremio_kubel   text,                         -- solo gremios: a qué gremio de KUBEL corresponde
  actualizado_en timestamptz not null default now(),
  primary key (tipo, codigo)
);

insert into public.sigma_codigos (tipo, codigo, texto, gremio_kubel) values
  ('gremio','00A','Contratista','Albañilería'),
  ('gremio','01A','Fontanero/Albañil','Fontanería'),
  ('gremio','02A','Electricista','Electricidad'),
  ('gremio','06A','Carpintero','Carpintería'),
  ('gremio','10A','Albañil','Albañilería'),
  ('gremio','11A','Pintor','Pintura'),
  ('gremio','20A','Reparador Tejados','Albañilería'),
  ('gremio','22A','Pocero','Fontanería'),
  ('gremio','30A','Inst. loza sanitaria','Fontanería'),
  ('gremio','75A','Fontanería Comunidades','Fontanería'),
  ('gremio','76A','Albañilería Comunidades','Albañilería'),
  ('gremio','77A','Pintura Comunidades','Pintura'),
  ('estado','1','Contacto con Cliente',null),
  ('estado','2','Visita al Cliente',null),
  ('estado','6','Aplazamiento Pte. Cia./Perito',null),
  ('estado','7','Aplazamiento pte. otra reparación MA',null),
  ('estado','15','Primer contacto con cliente',null),
  ('estado','16','Introducción ptto./Confirmación por MA',null),
  ('estado','26','Cliente ilocalizable',null),
  ('estado','37','Pendiente de instrucciones de cliente',null),
  ('estado','43','Visita aplazada por cliente',null),
  ('estado','100','Incumplimiento de Cita',null);

alter table public.sigma_codigos enable row level security;
create policy "todos leen códigos SIGMA" on public.sigma_codigos
  for select to authenticated using (true);
create policy "oficina gestiona códigos SIGMA" on public.sigma_codigos
  for all to authenticated using (public.es_oficina()) with check (public.es_oficina());

-- 3. Registro de cada pasada del robot
create table public.sigma_sincronizaciones (
  id            bigserial primary key,
  cuenta        text not null,
  inicio        timestamptz not null default now(),
  fin           timestamptz,
  ok            boolean,
  prueba        boolean not null default false,
  en_listado    integer,
  nuevos        integer,
  cambiados     integer,
  fichas        integer,
  desaparecidos integer,
  pendientes    integer,      -- fichas que quedan para la siguiente pasada
  aceptados     integer,      -- servicios ofrecidos aceptados automáticamente
  error         text
);
create index sigma_sinc_idx on public.sigma_sincronizaciones (cuenta, inicio desc);

alter table public.sigma_sincronizaciones enable row level security;
create policy "oficina ve sincronizaciones" on public.sigma_sincronizaciones
  for select to authenticated using (public.es_oficina());

alter publication supabase_realtime add table public.sigma_sincronizaciones;

-- 4. Limpieza: el registro guarda 30 días
create or replace function privado.limpiar_sigma()
returns void language sql security definer set search_path = public as $$
  delete from public.sigma_sincronizaciones where inicio < now() - interval '30 days';
$$;
revoke execute on function privado.limpiar_sigma() from public, anon, authenticated;

-- 5. Programación: cada 15 min de 7:00 a 21:45 (verano) / 6:00 a 20:45 (invierno). pg_cron va en UTC.
create or replace function privado.lanzar_sigma()
returns void language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text;
begin
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  perform net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-sync',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000
  );
end; $$;
revoke execute on function privado.lanzar_sigma() from public, anon, authenticated;

select cron.schedule('kubel-sigma-sync', '*/15 5-19 * * *', 'select privado.lanzar_sigma()');
select cron.schedule('kubel-sigma-limpiar', '30 3 * * *', 'select privado.limpiar_sigma()');
