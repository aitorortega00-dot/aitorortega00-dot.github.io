-- KUBEL — Clasificación "SIN PRIMER CONTACTO" (18/10/2026)
-- El robot sigma-sync marca los partes SIGMA que aún no han tenido el primer contacto con el cliente:
--   · los que el portal lista en Gestión repaso → "Pendiente de primer contacto" (gestRepaso.php / muestraservRepaso.php?posicion=servPteContacto)
--   · y los que están en el estado SIGMA 15 "Primer contacto con cliente" (cubre los recién llegados, que el cuadro del portal tarda en contar).
alter table public.partes
  add column if not exists sigma_sin_contacto boolean not null default false,
  add column if not exists sigma_sin_contacto_desde timestamptz;
create index if not exists partes_sin_contacto_idx on public.partes (sigma_sin_contacto) where sigma_sin_contacto;
update public.partes set sigma_sin_contacto = true, sigma_sin_contacto_desde = now()
 where sigma_en_curso and sigma_estado = '15';
