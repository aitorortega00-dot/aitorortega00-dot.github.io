-- 18 · Registro de cierres (28/10/2026)
-- De momento, «quién cierra un servicio» = la cuenta de oficina que marca revisado su informe en KUBEL.
-- Se guarda quién y cuándo marca cada informe revisado, y en Facturación (solo admin) cada línea lleva
-- «Cerrado por» = la cuenta que marcó revisado el último informe del servicio.

-- 18a · Quién y cuándo marca revisado un informe
alter table public.informes add column if not exists revisado_por uuid references public.perfiles(id) on delete set null;
alter table public.informes add column if not exists revisado_en timestamptz;

create or replace function public.informes_quien_revisa() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.revisado and not coalesce(old.revisado, false) then
    new.revisado_por := auth.uid();
    new.revisado_en := now();
  elsif not new.revisado then
    new.revisado_por := null;
    new.revisado_en := null;
  end if;
  return new;
end $$;

create or replace trigger informes_quien_revisa before update of revisado on public.informes
  for each row execute function public.informes_quien_revisa();

-- 18b · «Cerrado por» en Facturación
alter table public.facturacion add column if not exists cerrado_por text;      -- nombre de la cuenta (NANCY…)
alter table public.facturacion add column if not exists cerrado_por_id uuid;
alter table public.facturacion add column if not exists cerrado_en timestamptz;

-- Último informe revisado (con cuenta registrada) del servicio
create or replace function public.cierre_de_parte(p_parte uuid, out por_id uuid, out por text, out en timestamptz)
language sql stable security definer set search_path = public as $$
  select i.revisado_por, upper(coalesce(nullif(pf.nombre, ''), split_part(u.email, '@', 1))), i.revisado_en
  from public.informes i
  left join public.perfiles pf on pf.id = i.revisado_por
  left join auth.users u on u.id = i.revisado_por
  where i.parte_id = p_parte and i.revisado and i.revisado_por is not null
  order by i.revisado_en desc limit 1
$$;
revoke execute on function public.cierre_de_parte(uuid) from public, anon, authenticated;

-- Al marcar revisado un informe → actualizar sus líneas de Facturación (la oficina no ve Facturación: security definer)
create or replace function public.informes_cierre_facturacion() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.revisado is distinct from old.revisado then
    select * into c from cierre_de_parte(new.parte_id);
    update facturacion set cerrado_por_id = c.por_id, cerrado_por = c.por, cerrado_en = c.en
    where parte_id = new.parte_id
      and (cerrado_por_id is distinct from c.por_id or cerrado_en is distinct from c.en);
  end if;
  return null;
end $$;

create or replace trigger informes_cierre_facturacion after update of revisado on public.informes
  for each row execute function public.informes_cierre_facturacion();

-- Línea nueva de Facturación (o enganchada a otro servicio) → rellenar «Cerrado por»
create or replace function public.facturacion_poner_cierre() returns trigger
language plpgsql security definer set search_path = public as $$
declare c record;
begin
  if new.parte_id is not null and (tg_op = 'INSERT' or new.parte_id is distinct from old.parte_id) then
    select * into c from cierre_de_parte(new.parte_id);
    new.cerrado_por_id := c.por_id; new.cerrado_por := c.por; new.cerrado_en := c.en;
  end if;
  return new;
end $$;

create or replace trigger facturacion_poner_cierre before insert or update of parte_id on public.facturacion
  for each row execute function public.facturacion_poner_cierre();
