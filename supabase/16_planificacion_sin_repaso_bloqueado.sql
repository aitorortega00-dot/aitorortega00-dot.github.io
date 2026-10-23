-- 16 · Planificación sin borrador de Repaso en servicios bloqueados (23/10/2026)
-- Si el servicio tiene el Repaso bloqueado en SIGMA (documento de IVA pendiente de validar,
-- estado 6 «Aplazamiento Pte. Cia./Perito» o estado 16 «Introducción ptto./Confirmación por MA»),
-- al planificar o mover una visita NO se crea borrador de Repaso; la visita se guarda igual
-- para el operario. Si esa visita ya tenía un borrador pendiente, se descarta con el motivo.
-- Aplicada en Supabase el 23/10/2026 (execute_sql).

CREATE OR REPLACE FUNCTION public.sigma_borrador_desde_asignacion()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare p record; b uuid; com text; motivo_bloqueo text;
begin
  select id, sigma_cuenta, sigma_estado, sigma_iva_pendiente into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.hora is not distinct from old.hora then
    return new;
  end if;
  -- Repaso bloqueado en SIGMA (documento de IVA o estados 6 / 16): la visita se guarda, pero sin borrador de Repaso
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
  com := 'Visita al cliente programada el ' || to_char(new.fecha, 'DD/MM/YYYY')
         || coalesce(' a las ' || to_char(new.hora, 'HH24:MI'), '');
  select id into b from public.sigma_envios
   where asignacion_id = new.id and tipo = 'repaso' and estado in ('borrador', 'error') limit 1;
  if b is not null then
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
end; $function$;
