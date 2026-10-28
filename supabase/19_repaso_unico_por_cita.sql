-- 19 · Un solo Repaso por cita (servicio + fecha + hora), también frente a Repasos ya mandados a SIGMA
-- Aplicado el 28/10/2026 con execute_sql.
-- Caso: 29292961 tenía un borrador de planificación (28/10 11:30) y otro Repaso manual idéntico ya enviado;
-- el borrador se quedaba en la bandeja («La hora ya ha pasado»). Igual en 29472856 y 29463104.

-- 19a: al aprobar/enviar un Repaso, descartar los borradores/errores del mismo servicio + fecha + hora
create or replace function public.sigma_repaso_unico_al_enviar()
returns trigger language plpgsql security definer set search_path to 'public' as $$
begin
  if new.tipo = 'repaso' and new.estado in ('aprobado','enviando','enviado')
     and (tg_op = 'INSERT' or old.estado is distinct from new.estado) then
    update public.sigma_envios
       set estado = 'descartado',
           resultado = 'Descartado solo: ya se ha mandado a SIGMA un Repaso para la misma cita ('
                       || to_char(new.fecha, 'DD/MM/YYYY') || coalesce(' ' || to_char(new.hora, 'HH24:MI'), '') || ')'
     where parte_id = new.parte_id and id <> new.id and tipo = 'repaso'
       and estado in ('borrador','error')
       and fecha = new.fecha and hora is not distinct from new.hora;
  end if;
  return new;
end; $$;

create or replace trigger sigma_envios_repaso_unico
after insert or update of estado on public.sigma_envios
for each row execute function public.sigma_repaso_unico_al_enviar();

-- 19b: al planificar, no crear (o descartar) el borrador si ya se mandó un Repaso para esa cita
create or replace function public.sigma_borrador_desde_asignacion()
 returns trigger language plpgsql security definer set search_path to 'public'
as $function$
declare p record; b uuid; com text; motivo_bloqueo text; ya_enviado boolean;
begin
  select id, sigma_cuenta, sigma_estado, sigma_iva_pendiente into p from public.partes where id = new.parte_id;
  if p.sigma_cuenta is null then return new; end if;
  if tg_op = 'UPDATE' and new.fecha is not distinct from old.fecha and new.hora is not distinct from old.hora then
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

-- Limpieza única (28/10/2026): descartó 29292961, 29472856 y 29463104
update public.sigma_envios e
   set estado = 'descartado',
       resultado = 'Descartado solo: ya se ha mandado a SIGMA un Repaso para la misma cita ('
                   || to_char(e.fecha, 'DD/MM/YYYY') || coalesce(' ' || to_char(e.hora, 'HH24:MI'), '') || ')'
 where e.tipo = 'repaso' and e.estado in ('borrador','error')
   and exists (select 1 from public.sigma_envios x
                where x.parte_id = e.parte_id and x.id <> e.id and x.tipo = 'repaso'
                  and x.estado in ('aprobado','enviando','enviado')
                  and x.fecha = e.fecha and x.hora is not distinct from e.hora);

-- 19c: Repasos sin enviar (borrador o error) cuya cita ya ha pasado → descartados solos (cada 5 min)
create or replace function public.sigma_descartar_repasos_caducados()
returns integer language plpgsql security definer set search_path to 'public' as $$
declare n integer; ahora timestamp := now() at time zone 'Europe/Madrid';
begin
  update public.sigma_envios
     set estado = 'descartado',
         resultado = 'Descartado solo: la cita (' || to_char(fecha, 'DD/MM/YYYY') || coalesce(' ' || to_char(hora, 'HH24:MI'), '')
                     || ') ya ha pasado sin enviarse a SIGMA'
                     || case when estado = 'error' and resultado is not null then ' · Error anterior: ' || resultado else '' end
   where tipo = 'repaso' and estado in ('borrador','error') and fecha is not null
     and (case when hora is null then fecha < ahora::date else (fecha + hora) <= ahora end);
  get diagnostics n = row_count;
  return n;
end; $$;
revoke all on function public.sigma_descartar_repasos_caducados() from public, anon, authenticated;
select cron.schedule('kubel-repasos-caducados', '*/5 * * * *', 'select public.sigma_descartar_repasos_caducados()');
