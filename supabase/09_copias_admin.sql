-- 09 · Las copias de seguridad pasan al panel de administrador (2026-10-18)
-- La web de oficina ya no tiene el apartado Operarios; el administrador también puede abrir las copias.
create or replace function public.clave_copias()
 returns text language plpgsql stable security definer
 set search_path to 'public', 'privado'
as $function$
begin
  if not (public.es_oficina() or public.es_admin()) then raise exception 'Solo oficina o administrador'; end if;
  return (select valor from privado.ajustes where clave = 'backup_key');
end; $function$;
