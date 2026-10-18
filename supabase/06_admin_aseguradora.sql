-- =====================================================================
--  KUBEL — 06: cuenta ADMINISTRADOR + compañía oculta al operario
--  Aplicado en el proyecto kubel el 18/10/2026.
-- =====================================================================

-- 1. Nuevo rol 'admin' (panel de administrador /admin/)
alter table public.perfiles drop constraint perfiles_rol_check;
alter table public.perfiles add constraint perfiles_rol_check
  check (rol in ('operario', 'oficina', 'admin'));

create or replace function public.es_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.perfiles where id = auth.uid() and rol = 'admin' and activo);
$$;
revoke execute on function public.es_admin() from public, anon;
grant execute on function public.es_admin() to authenticated;

-- El admin puede leer todos los perfiles (la oficina ya podía)
drop policy "ver mi perfil o todos si oficina" on public.perfiles;
create policy "ver mi perfil o todos si oficina" on public.perfiles
  for select to authenticated
  using (id = auth.uid() or public.es_oficina() or public.es_admin());

-- Nadie salvo un admin (o el servidor) puede tocar una cuenta admin ni dar el rol admin
create or replace function public.proteger_perfil_admin()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is not null and not public.es_admin()
     and (old.rol = 'admin' or new.rol = 'admin') then
    raise exception 'Solo el administrador puede modificar esta cuenta';
  end if;
  return new;
end;
$$;
revoke execute on function public.proteger_perfil_admin() from public, anon, authenticated;
create trigger perfiles_proteger_admin
  before update on public.perfiles
  for each row execute function public.proteger_perfil_admin();

-- 2. El operario no ve la compañía (SIGMA, HomeServe…): solo oficina/admin leen 'companias'
drop policy "todos leen compañías" on public.companias;
create policy "oficina y admin leen compañías" on public.companias
  for select to authenticated using (public.es_oficina() or public.es_admin());

-- 3. Aseguradora y póliza generales (sí las ve el operario)
alter table public.partes add column if not exists aseguradora text;
alter table public.partes add column if not exists poliza text;

-- "Siniestros - Allianz Seguros" -> "Allianz Seguros"
create or replace function public.limpiar_aseguradora(t text)
returns text language sql immutable set search_path = public as $$
  select nullif(btrim(regexp_replace(coalesce(t, ''), '^[^-]*? - ', '')), '');
$$;

-- Al importar de SIGMA: rellena aseguradora/póliza solo si están vacías
create or replace function public.partes_aseguradora_sigma()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.aseguradora is null and new.sigma_procedencia is not null then
    select public.limpiar_aseguradora(texto) into new.aseguradora
      from public.sigma_codigos where tipo = 'procedencia' and codigo = new.sigma_procedencia;
  end if;
  if new.poliza is null and new.sigma_poliza is not null then
    new.poliza := new.sigma_poliza;
  end if;
  return new;
end;
$$;
revoke execute on function public.partes_aseguradora_sigma() from public, anon, authenticated;
create trigger partes_aseguradora
  before insert or update of sigma_procedencia, sigma_poliza, aseguradora, poliza on public.partes
  for each row execute function public.partes_aseguradora_sigma();

-- Cuando el robot aprende el nombre de una procedencia, completa los partes que la tienen
create or replace function public.codigos_aseguradora_sigma()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.tipo = 'procedencia' and new.texto is not null then
    update public.partes set aseguradora = public.limpiar_aseguradora(new.texto)
     where sigma_procedencia = new.codigo and aseguradora is null;
  end if;
  return new;
end;
$$;
revoke execute on function public.codigos_aseguradora_sigma() from public, anon, authenticated;
create trigger sigma_codigos_aseguradora
  after insert or update on public.sigma_codigos
  for each row execute function public.codigos_aseguradora_sigma();

-- Rellenar lo ya importado
update public.partes p
   set aseguradora = coalesce(p.aseguradora, public.limpiar_aseguradora(c.texto)),
       poliza = coalesce(p.poliza, p.sigma_poliza)
  from public.sigma_codigos c
 where c.tipo = 'procedencia' and c.codigo = p.sigma_procedencia;
update public.partes set poliza = sigma_poliza where poliza is null and sigma_poliza is not null;
