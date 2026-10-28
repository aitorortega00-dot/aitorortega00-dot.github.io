-- =====================================================================
--  22 · Visitas en servicios cerrados (28/10/2026)
--  Se pueden planificar visitas en servicios ya cerrados (o anulados) sin
--  tocar lo que ya tienen:
--   · no se crea borrador de Repaso al planificar (SIGMA no admite Repaso),
--   · el informe del operario y «No realizado» no crean «Informar cita»,
--   · «Cerrado por» (Facturación) solo cuenta informes anteriores al cierre
--     en SIGMA, así que revisar el informe de una visita posterior no lo cambia.
--  El estado del servicio ya no cambiaba (al_asignar_parte solo pasa
--  pendiente → asignado; al_crear_informe excluye cerrado/anulado) y la
--  línea de Facturación no se rehace (facturacion_alta sale si ya existe).
-- =====================================================================

-- Fecha/hora del cierre en SIGMA («dd/mm/aaaa / hh:mm:ss», hora de Madrid)
create or replace function public.momento_cierre_sigma(f jsonb)
returns timestamptz language sql immutable as $$
  select case when f->>'cierre' ~ '^\d{2}/\d{2}/\d{4} / \d{2}:\d{2}:\d{2}'
    then to_timestamp(replace(left(f->>'cierre', 21), ' / ', ' '), 'DD/MM/YYYY HH24:MI:SS')::timestamp at time zone 'Europe/Madrid'
    when f->>'cierre' ~ '^\d{2}/\d{2}/\d{4}'
    then (to_date(left(f->>'cierre', 10), 'DD/MM/YYYY') + 1)::timestamp at time zone 'Europe/Madrid'
  end;
$$;

-- 1) Planificar: sin borrador de Repaso en servicios cerrados/anulados
CREATE OR REPLACE FUNCTION public.sigma_borrador_desde_asignacion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; b uuid; com text; motivo_bloqueo text; ya_enviado boolean;
begin
  select id, sigma_cuenta, sigma_estado, sigma_iva_pendiente, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.hora is not distinct from old.hora then
    return new;
  end if;
  if p.estado in ('cerrado', 'anulado') then
    update public.sigma_envios
       set estado = 'descartado', resultado = 'Servicio ' || p.estado || ': visita solo interna, sin Repaso en SIGMA'
     where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error');
    return new;
  end if;
  motivo_bloqueo := case
    when p.sigma_iva_pendiente is not null then 'documento de IVA pendiente de validar'
    when p.sigma_estado = '6' then 'estado 6 «Aplazamiento Pte. Cia./Perito»'
    when p.sigma_estado = '16' then 'estado 16 «Introducción ptto./Confirmación por MA»'
  end;
  if motivo_bloqueo is not null then
    update public.sigma_envios
       set estado = 'descartado', resultado = 'Repaso bloqueado por SIGMA (' || motivo_bloqueo || '): no se crea al planificar'
     where asignacion_id = new.id and tipo = 'repaso' and origen = 'planificacion' and estado in ('borrador', 'error');
    return new;
  end if;
  ya_enviado := exists (select 1 from public.sigma_envios
                         where parte_id = new.parte_id and tipo = 'repaso'
                           and estado in ('aprobado','enviando','enviado')
                           and fecha = new.fecha and hora is not distinct from new.hora);
  com := 'Visita al cliente programada el ' || to_char(new.fecha, 'DD/MM/YYYY')
         || coalesce(' a las ' || to_char(new.hora, 'HH24:MI'), '');
  select id into b from public.sigma_envios
   where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error') limit 1;
  if b is not null then
    if ya_enviado then
      update public.sigma_envios
         set estado = 'descartado', resultado = 'Descartado solo: ya se ha mandado a SIGMA un Repaso para esta cita'
       where id = b;
    elsif exists (select 1 from public.sigma_envios
                where parte_id = new.parte_id and id <> b and tipo = 'repaso' and origen = 'planificacion'
                  and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
      update public.sigma_envios set estado = 'descartado', resultado = 'Duplicado: ya hay un borrador para esta cita'
       where id = b;
    else
      update public.sigma_envios set fecha = new.fecha, hora = new.hora, comentario = com, estado = 'borrador', resultado = null
       where id = b;
    end if;
  elsif not ya_enviado and not exists (select 1 from public.sigma_envios
                     where parte_id = new.parte_id and tipo = 'repaso' and origen = 'planificacion'
                       and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
    insert into public.sigma_envios (parte_id, asignacion_id, tipo, origen, motivo_codigo, motivo_texto, fecha, hora, comentario)
    values (new.parte_id, new.id, 'repaso', 'planificacion', '2', 'Visita al Cliente', new.fecha, new.hora, com);
  end if;
  return new;
end; $function$;

-- 2) Informe del operario: sin «Informar cita» en servicios cerrados/anulados
CREATE OR REPLACE FUNCTION public.sigma_borrador_desde_informe()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; a record; mot text; mtx text;
begin
  select id, sigma_cuenta, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null or p.estado in ('cerrado', 'anulado') then return new; end if;
  select fecha, hora into a from public.asignaciones where id = new.asignacion_id;
  if new.trabajo_terminado then mot := '609'; mtx := 'Finalizado reparación no requiere nueva cita.';
  elsif new.necesita_repaso then mot := '601'; mtx := 'Reparado parcialmente, requiere nueva cita';
  else mot := '604'; mtx := 'No reparado requiere nueva cita.';
  end if;
  insert into public.sigma_envios (parte_id, asignacion_id, informe_id, tipo, origen, resolucion, resolucion_motivo, motivo_texto, cita_fecha, cita_hora, comentario)
  values (new.parte_id, new.asignacion_id, new.id, 'informar_cita', 'informe', 'V', mot, mtx, a.fecha, a.hora, new.texto);
  return new;
end; $function$;

-- 3) «No realizado»: igual
CREATE OR REPLACE FUNCTION public.sigma_borrador_no_realizado()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record;
begin
  if new.estado <> 'no_realizado' or old.estado = 'no_realizado' then return new; end if;
  select id, sigma_cuenta, estado into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null or p.estado in ('cerrado', 'anulado') then return new; end if;
  insert into public.sigma_envios (parte_id, asignacion_id, tipo, origen, resolucion, resolucion_motivo, motivo_texto, cita_fecha, cita_hora, comentario)
  values (new.parte_id, new.id, 'informar_cita', 'no_realizado', 'I', '706', 'Causa asegurado/perjudicado', new.fecha, new.hora,
          coalesce(nullif(new.notas, ''), 'Visita no realizada'));
  return new;
end; $function$;

-- 4) «Cerrado por»: en un servicio cerrado solo cuentan los informes anteriores al cierre de SIGMA
CREATE OR REPLACE FUNCTION public.cierre_de_parte(p_parte uuid, OUT por_id uuid, OUT por text, OUT en timestamp with time zone)
 RETURNS record
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  select i.revisado_por, upper(coalesce(nullif(pf.nombre, ''), split_part(u.email, '@', 1))), i.revisado_en
  from public.informes i
  join public.partes pa on pa.id = i.parte_id
  left join public.perfiles pf on pf.id = i.revisado_por
  left join auth.users u on u.id = i.revisado_por
  where i.parte_id = p_parte and i.revisado and i.revisado_por is not null
    and (pa.estado <> 'cerrado' or public.momento_cierre_sigma(pa.sigma_ficha) is null
         or i.creado_en <= public.momento_cierre_sigma(pa.sigma_ficha))
  order by i.revisado_en desc limit 1
$function$;
