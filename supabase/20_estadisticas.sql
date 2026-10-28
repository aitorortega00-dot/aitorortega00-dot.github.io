-- =====================================================================
--  20 · Estadísticas del panel admin (28/10/2026)
--  El admin no lee la tabla `partes` (solo oficina). Esta función le da,
--  solo a él, los datos mínimos de cada servicio para contar entradas y cierres.
--  · entrada = «Fecha/Hora Asignación» de la ficha SIGMA (misma regla que «Nuevos hoy»);
--              manuales o sin ficha: día de alta en KUBEL (hora de Madrid).
--  · cierre  = «Fecha/Hora Cierre» de la ficha SIGMA (fecha_cierre_sigma).
-- =====================================================================
create or replace function public.estadisticas_servicios()
returns table (
  id uuid, entrada date, cierre date, cuenta text, provincia text,
  gremio text, gremio_codigo text, urgente boolean, estado text, origen text
)
language sql stable security definer set search_path = public as $$
  select p.id,
    coalesce(
      case when p.sigma_ficha->>'asignacion' ~ '^\d{2}/\d{2}/\d{4}'
           then to_date(left(p.sigma_ficha->>'asignacion', 10), 'DD/MM/YYYY') end,
      (p.creado_en at time zone 'Europe/Madrid')::date),
    public.fecha_cierre_sigma(p.sigma_ficha),
    p.sigma_cuenta,
    case when p.codigo_postal like '47%' then 'VALLADOLID' when p.codigo_postal like '34%' then 'PALENCIA'
         when p.sigma_cuenta = 'VLL' then 'VALLADOLID' when p.sigma_cuenta = 'PAL' then 'PALENCIA' end,
    p.gremio, p.sigma_gremio, coalesce(p.urgente, false), p.estado::text, p.origen::text
  from public.partes p
  where public.es_admin();
$$;
revoke all on function public.estadisticas_servicios() from public, anon;
grant execute on function public.estadisticas_servicios() to authenticated;
