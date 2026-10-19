-- 11 · Fecha en que SIGMA asignó el servicio a KUBEL (para «Nuevos hoy» en la oficina)
-- SIGMA: «Fecha/Hora Asignación» de la ficha (sigma_ficha->>'asignacion', "dd/mm/aaaa / hh:mi:ss", hora de Madrid).
-- Manuales: fecha de alta en el hub. SIGMA sin ficha leída aún: null (no cuenta como nuevo hasta leerla).
alter table public.partes add column if not exists asignado_en timestamptz;

create or replace function public.partes_calcular_asignado_en()
returns trigger language plpgsql set search_path = public as $$
declare t text;
begin
  if new.origen = 'sigma' then
    t := substring(coalesce(new.sigma_ficha->>'asignacion', '') from '(\d{2}/\d{2}/\d{4}\s*/?\s*\d{2}:\d{2}(:\d{2})?)');
    if t is not null then
      t := regexp_replace(t, '\s*/\s*(\d{2}:)', ' \1');
      begin
        new.asignado_en := (to_timestamp(t, 'DD/MM/YYYY HH24:MI:SS')::timestamp) at time zone 'Europe/Madrid';
      exception when others then null; -- formato raro: se deja lo que hubiera
      end;
    end if;
  elsif new.asignado_en is null then
    new.asignado_en := new.creado_en;
  end if;
  return new;
end $$;
revoke execute on function public.partes_calcular_asignado_en() from public, anon, authenticated;

drop trigger if exists partes_asignado_en on public.partes;
create trigger partes_asignado_en before insert or update of sigma_ficha, origen on public.partes
  for each row execute function public.partes_calcular_asignado_en();

-- Rellenar los existentes
update public.partes set origen = origen;
create index if not exists partes_asignado_en_idx on public.partes (asignado_en);
