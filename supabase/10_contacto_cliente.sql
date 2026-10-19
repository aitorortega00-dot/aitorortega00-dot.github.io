-- =====================================================================
--  KUBEL — Repaso de servicios sin primer contacto (estado SIGMA 15)
--  YA APLICADO en el proyecto kubel el 19/10/2026 (migración sigma_envios_contacto_cliente).
--  SIGMA exige en esos servicios la «Fecha en la que contactó con el cliente»
--  (día, hora y minutos). Sin ella, el Repaso responde con el código 68.
-- =====================================================================
alter table public.sigma_envios add column if not exists contacto_en timestamptz;
comment on column public.sigma_envios.contacto_en is 'Repaso de servicios en estado 15 (sin primer contacto): fecha y hora en que se contactó con el cliente. SIGMA la exige ("Fecha en la que contactó con el cliente"); sin ella responde código 68.';
