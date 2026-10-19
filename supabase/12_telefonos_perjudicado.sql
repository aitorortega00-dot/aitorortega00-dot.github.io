-- =====================================================================
--  12 · Teléfonos del asegurado y del perjudicado en la ficha del servicio
--  (oficina v2.15, 19/10/2026)
--
--  telefono                 = TELÉFONO ASEGURADO (el primero)
--  telefono2                = TELÉFONO ASEGURADO 2 (los demás: "000000000 - 000000000")
--  telefono_perjudicado     = TELÉFONO PERJUDICADO (el primero)   ← nuevo
--  telefono_perjudicado2    = TELÉFONO PERJUDICADO 2 (los demás)  ← nuevo
--
--  Se rellenan solos desde partes.sigma_telefonos (los lee el robot) cuando
--  están vacíos o tienen el valor automático anterior. Lo que escriba la
--  oficina a mano no se pisa. No hace falta cambiar el robot.
-- =====================================================================

alter table public.partes
  add column if not exists telefono_perjudicado  text,
  add column if not exists telefono_perjudicado2 text;

create or replace function public.partes_telefonos_sigma()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  aseg  text[];
  perj  text[];
  aseg_old text[];
  perj_old text[];
  resto text;
begin
  if new.sigma_telefonos is null or jsonb_typeof(new.sigma_telefonos) <> 'array' then
    return new;
  end if;

  select coalesce(array_agg(n order by o), '{}') into aseg from (
    select distinct on (e->>'numero') e->>'numero' n, o from jsonb_array_elements(new.sigma_telefonos) with ordinality x(e, o)
    where coalesce(e->>'de', 'cliente') = 'cliente' and coalesce(e->>'numero', '') <> '' order by e->>'numero', o) s;
  select coalesce(array_agg(n order by o), '{}') into perj from (
    select distinct on (e->>'numero') e->>'numero' n, o from jsonb_array_elements(new.sigma_telefonos) with ordinality x(e, o)
    where e->>'de' = 'perjudicado' and coalesce(e->>'numero', '') <> '' order by e->>'numero', o) s;

  -- Valores automáticos anteriores (para saber si la oficina los ha cambiado)
  aseg_old := '{}'; perj_old := '{}';
  if tg_op = 'UPDATE' and old.sigma_telefonos is not null and jsonb_typeof(old.sigma_telefonos) = 'array' then
    select coalesce(array_agg(n order by o), '{}') into aseg_old from (
      select distinct on (e->>'numero') e->>'numero' n, o from jsonb_array_elements(old.sigma_telefonos) with ordinality x(e, o)
      where coalesce(e->>'de', 'cliente') = 'cliente' and coalesce(e->>'numero', '') <> '' order by e->>'numero', o) s;
    select coalesce(array_agg(n order by o), '{}') into perj_old from (
      select distinct on (e->>'numero') e->>'numero' n, o from jsonb_array_elements(old.sigma_telefonos) with ordinality x(e, o)
      where e->>'de' = 'perjudicado' and coalesce(e->>'numero', '') <> '' order by e->>'numero', o) s;
  end if;

  -- Asegurado 2: todos menos el primero. El robot pone aquí solo el 2º número;
  -- se sustituye si está vacío, es ese 2º número o era el valor automático anterior.
  if cardinality(aseg) > 1 then
    resto := array_to_string(aseg[2:], ' - ');
    if coalesce(new.telefono2, '') = '' or new.telefono2 = aseg[2]
       or (cardinality(aseg_old) > 1 and new.telefono2 = array_to_string(aseg_old[2:], ' - '))
       or (cardinality(aseg_old) > 1 and new.telefono2 = aseg_old[2]) then
      new.telefono2 := resto;
    end if;
  end if;

  -- Perjudicado
  if cardinality(perj) > 0 then
    if coalesce(new.telefono_perjudicado, '') = ''
       or (cardinality(perj_old) > 0 and new.telefono_perjudicado = perj_old[1]) then
      new.telefono_perjudicado := perj[1];
    end if;
  end if;
  if cardinality(perj) > 1 then
    resto := array_to_string(perj[2:], ' - ');
    if coalesce(new.telefono_perjudicado2, '') = ''
       or (cardinality(perj_old) > 1 and new.telefono_perjudicado2 = array_to_string(perj_old[2:], ' - ')) then
      new.telefono_perjudicado2 := resto;
    end if;
  end if;
  return new;
end;
$$;

revoke execute on function public.partes_telefonos_sigma() from public, anon, authenticated;

drop trigger if exists partes_telefonos_sigma on public.partes;
create trigger partes_telefonos_sigma
  before insert or update of sigma_telefonos on public.partes
  for each row execute function public.partes_telefonos_sigma();

-- Rellenar los servicios que ya existen
update public.partes set sigma_telefonos = sigma_telefonos where sigma_telefonos is not null;
