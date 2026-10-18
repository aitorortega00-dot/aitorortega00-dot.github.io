-- KUBEL — Clasificación "CADUCADAS / CADUCAN HOY" (18/10/2026)
-- El robot sigma-sync lee el filtro Caducidad (vigencia) del listado "Servicios en curso" del portal:
--   1 = Caducadas / Caducan Hoy REDES · 5 = … RESTO · 3 = … CLIENTE
-- y deja en cada parte su grupo y CUÁNDO entró y salió de la lista, para que la oficina vea
-- el avance del repaso diario (Caducada → Repaso en bandeja → Enviado → Resuelta hoy).
alter table public.partes
  add column if not exists sigma_cad_grupo text check (sigma_cad_grupo in ('redes', 'resto', 'cliente')),
  add column if not exists sigma_cad_desde timestamptz,        -- entró en "Caducadas / Caducan hoy"
  add column if not exists sigma_cad_hasta timestamptz,        -- salió (null mientras siga caducada)
  add column if not exists sigma_cad_estado text,              -- estado SIGMA al entrar
  add column if not exists sigma_cad_estado_fin text;          -- estado SIGMA al salir (null si salió de "en curso")
create index if not exists partes_cad_idx on public.partes (sigma_cad_desde) where sigma_cad_desde is not null;
