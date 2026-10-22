-- =====================================================================
--  15 · Visitas duplicadas y borradores de SIGMA huérfanos (22/10/2026)
--  a) Un solo borrador de Repaso (planificación) por servicio + fecha + hora.
--  b) Al quitar una visita, su borrador pendiente pasa a otra visita igual
--     del mismo servicio o, si no hay, a «descartado».
-- =====================================================================

-- a) Borrador desde asignación: no crea otro si ya hay uno igual pendiente
create or replace function public.sigma_borrador_desde_asignacion()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare p record; b uuid; com text;
begin
  select id, sigma_cuenta into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.hora is not distinct from old.hora then
    return new;
  end if;
  com := 'Visita al cliente programada el ' || to_char(new.fecha, 'DD/MM/YYYY')
         || coalesce(' a las ' || to_char(new.hora, 'HH24:MI'), '');
  select id into b from public.sigma_envios
   where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error') limit 1;
  if b is not null then
    -- ¿Ya existe otro borrador pendiente para la misma cita? Entonces este sobra.
    if exists (select 1 from public.sigma_envios
                where parte_id = new.parte_id and id <> b and tipo = 'repaso' and origen = 'planificacion'
                  and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
      update public.sigma_envios set estado = 'descartado', resultado = 'Duplicado: ya hay un borrador para esta cita'
       where id = b;
    else
      update public.sigma_envios set fecha = new.fecha, hora = new.hora, comentario = com, estado = 'borrador', resultado = null
       where id = b;
    end if;
  elsif not exists (select 1 from public.sigma_envios
                     where parte_id = new.parte_id and tipo = 'repaso' and origen = 'planificacion'
                       and estado in ('borrador', 'error') and fecha = new.fecha and hora is not distinct from new.hora) then
    insert into public.sigma_envios (parte_id, asignacion_id, tipo, origen, motivo_codigo, motivo_texto, fecha, hora, comentario)
    values (new.parte_id, new.id, 'repaso', 'planificacion', '2', 'Visita al Cliente', new.fecha, new.hora, com);
  end if;
  return new;
end; $$;

-- b) Al borrar una visita: su borrador pendiente pasa a otra visita igual o se descarta
create or replace function public.sigma_borrador_al_quitar_visita()
returns trigger language plpgsql security definer set search_path to 'public' as $$
declare otra uuid;
begin
  select id into otra from public.asignaciones
   where parte_id = old.parte_id and id <> old.id and estado <> 'no_realizado'
     and fecha = old.fecha and hora is not distinct from old.hora
   order by creado_en limit 1;
  if otra is not null then
    update public.sigma_envios set asignacion_id = otra
     where asignacion_id = old.id and tipo = 'repaso' and estado in ('borrador', 'error');
  else
    update public.sigma_envios set estado = 'descartado', resultado = 'Visita quitada de la planificación'
     where asignacion_id = old.id and tipo = 'repaso' and estado in ('borrador', 'error');
  end if;
  return old;
end; $$;

drop trigger if exists asignaciones_sigma_quitar on public.asignaciones;
create trigger asignaciones_sigma_quitar before delete on public.asignaciones
  for each row execute function public.sigma_borrador_al_quitar_visita();
