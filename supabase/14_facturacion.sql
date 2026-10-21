-- =====================================================================
--  KUBEL — 14: Facturación (panel admin → Facturación) · 21/10/2026
--
--  Sustituye al «EXCEL DE SERVICIOS» del usuario. Una fila por servicio terminado:
--    · NO LIQUIDADO  → entra sola cuando el operario manda el informe con «trabajo terminado»
--                      o cuando el robot pasa el servicio a Cerrado (lo primero que ocurra).
--    · LIQUIDADO     → a mano, o al subir la factura de SIGMA (cotejo en la web).
--  El importe (sin IVA) lo escribe el administrador; el de la factura de compañía se guarda
--  aparte (factura_importe) para ver diferencias.
--  Solo el administrador lee y escribe estas tablas.
-- =====================================================================

create table if not exists public.facturacion (
  id              uuid primary key default gen_random_uuid(),
  parte_id        uuid references public.partes(id) on delete set null,
  servicio        text not null,                 -- nº de servicio («29199656», «RED/28818681», «YAVOI»…)
  fecha           date,                          -- día del trabajo terminado / cierre
  mes             text,                          -- mes de facturación si difiere (histórico del Excel)
  operario        text,
  compania        text,                          -- SIGMA, TASHO, YAVOI…
  direccion       text,
  provincia       text,
  importe         numeric(10,2),                 -- sin IVA, lo escribe el admin
  gasto_real      numeric(10,2),
  comentario      text,
  liquidado       boolean not null default false,
  factura         text,                          -- nº de factura de la compañía (SG26000022, FACT.11-09…)
  factura_importe numeric(10,2),                 -- importe que paga la compañía en esa factura
  liquidado_en    timestamptz,
  origen          text not null default 'auto' check (origen in ('auto', 'manual', 'excel', 'factura')),
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);
create unique index if not exists facturacion_parte_uk on public.facturacion (parte_id) where parte_id is not null;
create index if not exists facturacion_servicio_idx on public.facturacion (servicio);
create index if not exists facturacion_fecha_idx on public.facturacion (fecha);

-- Facturas de compañía subidas (PDF de SIGMA): cabecera, líneas y descuentos tal cual
create table if not exists public.facturas (
  id            uuid primary key default gen_random_uuid(),
  compania      text not null default 'SIGMA',
  numero        text not null,
  fecha         date,
  base          numeric(10,2),
  total         numeric(10,2),
  a_transferir  numeric(10,2),
  lineas        jsonb not null default '[]',     -- [{servicio, importe, concepto, direccion}]
  descuentos    jsonb not null default '[]',     -- [{concepto, importe}]
  resumen       jsonb,                           -- resultado del cotejo al aplicarla
  subida_en     timestamptz not null default now(),
  unique (compania, numero)
);

alter table public.facturacion enable row level security;
alter table public.facturas enable row level security;
drop policy if exists "facturacion solo admin" on public.facturacion;
create policy "facturacion solo admin" on public.facturacion for all to authenticated
  using (public.es_admin()) with check (public.es_admin());
drop policy if exists "facturas solo admin" on public.facturas;
create policy "facturas solo admin" on public.facturas for all to authenticated
  using (public.es_admin()) with check (public.es_admin());

create or replace function public.facturacion_tocar()
returns trigger language plpgsql as $$
begin
  new.actualizado_en := now();
  if new.liquidado and (tg_op = 'INSERT' or not old.liquidado) then new.liquidado_en := coalesce(new.liquidado_en, now()); end if;
  if not new.liquidado then new.liquidado_en := null; end if;
  return new;
end; $$;
drop trigger if exists facturacion_tocar on public.facturacion;
create trigger facturacion_tocar before insert or update on public.facturacion
  for each row execute function public.facturacion_tocar();

-- ---------------------------------------------------------------------
--  Alta automática. p_operario = quien terminó (si se sabe); p_fecha = día del trabajo
-- ---------------------------------------------------------------------
create or replace function public.facturacion_alta(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p record; v_comp text; v_op text; v_prov text; v_dir text;
begin
  select * into p from public.partes where id = p_parte;
  if not found then return; end if;
  select nombre into v_comp from public.companias where id = p.compania_id;
  v_comp := upper(coalesce(v_comp, ''));
  -- Operario: el indicado; si no, el de la última visita hecha (o la última asignada)
  if p_operario is not null then
    select nombre into v_op from public.perfiles where id = p_operario;
  end if;
  if v_op is null then
    select pf.nombre into v_op from public.asignaciones a join public.perfiles pf on pf.id = a.operario_id
     where a.parte_id = p_parte order by (a.estado = 'hecho') desc, a.fecha desc, a.hora desc nulls last limit 1;
  end if;
  v_prov := case left(coalesce(p.codigo_postal, ''), 2) when '47' then 'VALLADOLID' when '34' then 'PALENCIA'
            else case p.sigma_cuenta when 'VLL' then 'VALLADOLID' when 'PAL' then 'PALENCIA' else null end end;
  v_dir := upper(trim(coalesce(p.direccion, '') ||
           case when p.poblacion is not null and upper(p.poblacion) not in ('VALLADOLID', 'PALENCIA')
                then ' ' || p.poblacion else '' end));

  -- Ya existe (por el servicio): no se duplica; solo se completa lo que falte
  if exists (select 1 from public.facturacion where parte_id = p_parte) then
    update public.facturacion set operario = coalesce(operario, upper(v_op))
     where parte_id = p_parte and operario is null and v_op is not null;
    return;
  end if;
  -- Fila del histórico (Excel / manual) con el mismo nº: se enlaza
  update public.facturacion set parte_id = p_parte
   where id = (select id from public.facturacion
                where parte_id is null and servicio = p.numero_servicio
                  and (compania is null or upper(compania) = v_comp)
                order by creado_en limit 1);
  if found then return; end if;

  insert into public.facturacion (parte_id, servicio, fecha, operario, compania, direccion, provincia, origen)
  values (p_parte, p.numero_servicio, coalesce(p_fecha, (now() at time zone 'Europe/Madrid')::date),
          upper(v_op), v_comp, nullif(v_dir, ''), v_prov, 'auto')
  on conflict do nothing;
end; $$;
revoke execute on function public.facturacion_alta(uuid, date, uuid) from public, anon, authenticated;

-- Fecha de cierre SIGMA («dd/mm/aaaa / hh:mm:ss») → date
create or replace function public.fecha_cierre_sigma(f jsonb)
returns date language sql immutable as $$
  select case when f->>'cierre' ~ '^\d{2}/\d{2}/\d{4}' then to_date(left(f->>'cierre', 10), 'DD/MM/YYYY') end;
$$;

-- Informe con «trabajo terminado» → alta (fecha = día de la visita)
create or replace function public.facturacion_por_informe()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_fecha date;
begin
  if new.trabajo_terminado and (tg_op = 'INSERT' or not coalesce(old.trabajo_terminado, false)) then
    select fecha into v_fecha from public.asignaciones where id = new.asignacion_id;
    perform public.facturacion_alta(new.parte_id,
      coalesce(v_fecha, (new.creado_en at time zone 'Europe/Madrid')::date), new.operario_id);
  end if;
  return null;
end; $$;
revoke execute on function public.facturacion_por_informe() from public, anon, authenticated;
drop trigger if exists informes_facturacion on public.informes;
create trigger informes_facturacion after insert or update of trabajo_terminado on public.informes
  for each row execute function public.facturacion_por_informe();

-- Servicio pasado a Cerrado (robot) → alta (fecha = la de cierre de SIGMA)
create or replace function public.facturacion_por_cierre()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'cerrado' and old.estado is distinct from 'cerrado' then
    perform public.facturacion_alta(new.id, public.fecha_cierre_sigma(new.sigma_ficha), null);
  end if;
  return null;
end; $$;
revoke execute on function public.facturacion_por_cierre() from public, anon, authenticated;
drop trigger if exists partes_facturacion on public.partes;
create trigger partes_facturacion after update of estado on public.partes
  for each row execute function public.facturacion_por_cierre();

-- Puesta en marcha: servicios ya cerrados / con informe terminado (después de importar el Excel)
-- select public.facturacion_alta(i.parte_id, a.fecha, i.operario_id) from informes i left join asignaciones a on a.id = i.asignacion_id where i.trabajo_terminado;
-- select public.facturacion_alta(id, public.fecha_cierre_sigma(sigma_ficha), null) from partes where estado = 'cerrado';

-- =====================================================================
--  14b · Cambios del 21/10 (mismo día, decisión del usuario):
--   · Solo entra al pasar a Cerrado (el informe terminado ya NO da de alta; la función queda vacía).
--   · Fecha y operario = los de la última visita hecha (si no hay, última asignada; si no, fecha de cierre).
--   · Importe = «importe total» de la pestaña Presupuesto de SIGMA (todas las partidas aceptadas),
--     lo anota la función sigma-importes (pg_cron 12 y 42); nunca pisa un importe escrito.
-- =====================================================================
alter table public.facturacion
  add column if not exists importe_origen text check (importe_origen in ('presupuesto', 'manual', 'excel', 'factura')),
  add column if not exists importe_nota text,
  add column if not exists importe_leido_en timestamptz;
update public.facturacion set importe_origen = 'excel' where origen = 'excel' and importe is not null;

create or replace function public.facturacion_por_informe()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  return null;
end; $$;

-- facturacion_alta: versión vigente (fecha/operario de la última visita hecha)
create or replace function public.facturacion_alta(p_parte uuid, p_fecha date, p_operario uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  p record; v_comp text; v_op text; v_prov text; v_dir text; v_fecha date;
begin
  select * into p from public.partes where id = p_parte;
  if not found then return; end if;
  select nombre into v_comp from public.companias where id = p.compania_id;
  v_comp := upper(coalesce(v_comp, ''));
  select a.fecha, pf.nombre into v_fecha, v_op from public.asignaciones a left join public.perfiles pf on pf.id = a.operario_id
   where a.parte_id = p_parte order by (a.estado = 'hecho') desc, a.fecha desc, a.hora desc nulls last limit 1;
  if p_operario is not null then select nombre into v_op from public.perfiles where id = p_operario; end if;
  v_fecha := coalesce(v_fecha, p_fecha, (now() at time zone 'Europe/Madrid')::date);
  v_prov := case left(coalesce(p.codigo_postal, ''), 2) when '47' then 'VALLADOLID' when '34' then 'PALENCIA'
            else case p.sigma_cuenta when 'VLL' then 'VALLADOLID' when 'PAL' then 'PALENCIA' else null end end;
  v_dir := upper(trim(coalesce(p.direccion, '') ||
           case when p.poblacion is not null and upper(p.poblacion) not in ('VALLADOLID', 'PALENCIA')
                then ' ' || p.poblacion else '' end));
  if exists (select 1 from public.facturacion where parte_id = p_parte) then return; end if;
  update public.facturacion set parte_id = p_parte
   where id = (select id from public.facturacion
                where parte_id is null and servicio = p.numero_servicio
                  and (compania is null or upper(compania) = v_comp)
                order by fecha desc nulls last, creado_en desc limit 1);
  if found then return; end if;
  insert into public.facturacion (parte_id, servicio, fecha, operario, compania, direccion, provincia, origen)
  values (p_parte, p.numero_servicio, v_fecha, upper(v_op), v_comp, nullif(v_dir, ''), v_prov, 'auto')
  on conflict do nothing;
end; $$;
select public.facturacion_alta(id, public.fecha_cierre_sigma(sigma_ficha), null) from partes where estado = 'cerrado';

create or replace function privado.lanzar_importes()
returns bigint language plpgsql security definer set search_path = public, privado, extensions as $$
declare s text; r bigint;
begin
  select valor into s from privado.ajustes where clave = 'notif_secreto';
  select net.http_post(
    url := 'https://hytmotuhdxbzpustnlzx.supabase.co/functions/v1/sigma-importes',
    body := '{}'::jsonb,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-kubel-secreto', s),
    timeout_milliseconds := 150000) into r;
  return r;
end; $$;
revoke execute on function privado.lanzar_importes() from public, anon, authenticated;
select cron.schedule('kubel-sigma-importes', '12,42 5-19 * * *', 'select privado.lanzar_importes()');

-- Histórico: 420 filas importadas del «EXCEL DE SERVICIOS» (origen 'excel') el 21/10/2026.

-- =====================================================================
--  14c · 21/10 (decisión del usuario): el servicio entra en Facturación AL ACEPTARSE el presupuesto,
--  aunque no esté cerrado (gremios del robot de Presupuestos: 11A, 77A, 30A, 10A, 76A), y se vuelve
--  a comprobar el importe AL CERRARSE (función sigma-importes). El resto de gremios entra al cerrarse.
--   · partes.sigma_ptto_total = «importe total» de la pestaña Presupuesto (lo guarda sigma-presupuestos).
--   · Con partidas rechazadas el total del portal solo suma las aceptadas (29412780): se anota con aviso.
--   · Al aceptarse sin visita en KUBEL, la fecha es la de la aceptación en SIGMA (sigma_ptto_fecha).
-- =====================================================================
alter table public.partes add column if not exists sigma_ptto_total numeric(10,2);
alter table public.facturacion add column if not exists importe_cierre_en timestamptz;

create or replace function public.euros(v numeric) returns text language sql immutable as $$
  select replace(to_char(v, 'FM9999990.00'), '.', ',') || ' €';
$$;

create or replace function public.ptto_importe(p_lineas jsonb, p_total numeric, out importe numeric, out nota text)
language plpgsql immutable as $$
declare n int; acep int; pend int;
begin
  select count(*), count(*) filter (where x->>'estado' ~* 'ACEPTAD'), count(*) filter (where x->>'estado' ~* '^pendiente')
    into n, acep, pend from jsonb_array_elements(coalesce(p_lineas, '[]'::jsonb)) x;
  if n = 0 then nota := 'Sin presupuesto en SIGMA';
  elsif pend > 0 then nota := 'Presupuesto pendiente de aceptar' || coalesce(' (' || public.euros(p_total) || ')', '');
  elsif acep > 0 and coalesce(p_total, 0) > 0 then
    importe := p_total;
    if acep < n then nota := 'Tiene partidas rechazadas: comprueba el importe'; end if;
  else nota := 'Presupuesto rechazado';
  end if;
end; $$;

create or replace function public.facturacion_por_ptto()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_imp numeric; v_nota text;
begin
  if new.sigma_ptto_estado is distinct from 'aceptado' or new.estado = 'anulado' then return null; end if;
  if old.sigma_ptto_estado is not distinct from new.sigma_ptto_estado
     and old.sigma_ptto_total is not distinct from new.sigma_ptto_total
     and old.sigma_ptto_lineas is not distinct from new.sigma_ptto_lineas then return null; end if;
  perform public.facturacion_alta(new.id, new.sigma_ptto_fecha, null);
  select importe, nota into v_imp, v_nota from public.ptto_importe(new.sigma_ptto_lineas, new.sigma_ptto_total);
  update public.facturacion f set
    importe = case when v_imp is not null and (f.importe is null or f.importe_origen = 'presupuesto') then v_imp else f.importe end,
    importe_origen = case when v_imp is not null and f.importe is null then 'presupuesto' else f.importe_origen end,
    importe_nota = case
      when v_imp is null then v_nota
      when f.importe is null or f.importe = v_imp then v_nota
      when f.importe_origen = 'presupuesto' then 'Presupuesto cambiado en SIGMA: de ' || public.euros(f.importe) || ' a ' || public.euros(v_imp)
      else 'SIGMA dice ' || public.euros(v_imp) end,
    importe_leido_en = now()
  where f.parte_id = new.id and not f.liquidado;
  return null;
end; $$;
revoke execute on function public.facturacion_por_ptto() from public, anon, authenticated;
create trigger partes_facturacion_ptto after update of sigma_ptto_estado, sigma_ptto_total, sigma_ptto_lineas on public.partes
  for each row execute function public.facturacion_por_ptto();

create or replace function public.facturacion_por_cierre()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.estado = 'cerrado' and old.estado is distinct from 'cerrado' then
    perform public.facturacion_alta(new.id, public.fecha_cierre_sigma(new.sigma_ficha), null);
    update public.facturacion set importe_leido_en = null where parte_id = new.id and importe_cierre_en is null and not liquidado;
  end if;
  return null;
end; $$;

-- 14d · 21/10: manda siempre el ÚLTIMO importe de SIGMA (al aceptarse y al cerrarse), con aviso del anterior.
create or replace function public.facturacion_por_ptto()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_imp numeric; v_nota text;
begin
  if new.sigma_ptto_estado is distinct from 'aceptado' or new.estado = 'anulado' then return null; end if;
  if old.sigma_ptto_estado is not distinct from new.sigma_ptto_estado
     and old.sigma_ptto_total is not distinct from new.sigma_ptto_total
     and old.sigma_ptto_lineas is not distinct from new.sigma_ptto_lineas then return null; end if;
  perform public.facturacion_alta(new.id, new.sigma_ptto_fecha, null);
  select importe, nota into v_imp, v_nota from public.ptto_importe(new.sigma_ptto_lineas, new.sigma_ptto_total);
  update public.facturacion f set
    importe = coalesce(v_imp, f.importe),
    importe_origen = case when v_imp is not null then 'presupuesto' else f.importe_origen end,
    importe_nota = case
      when v_imp is not null and f.importe is not null and f.importe <> v_imp
        then 'Presupuesto cambiado en SIGMA: de ' || public.euros(f.importe) || ' a ' || public.euros(v_imp)
      else v_nota end,
    importe_leido_en = now()
  where f.parte_id = new.id and not f.liquidado;
  return null;
end; $$;
