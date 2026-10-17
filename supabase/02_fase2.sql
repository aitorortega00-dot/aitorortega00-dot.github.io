
-- ---------------------------------------------------------------------
-- 11. FASE 2 (18/10/2026) — ya aplicado en el proyecto kubel
-- ---------------------------------------------------------------------
-- Informes revisados por la oficina
alter table public.informes add column if not exists revisado boolean not null default false;
-- Actualización en directo en la web de oficina y la app del operario
alter publication supabase_realtime add table public.asignaciones, public.informes, public.partes;
-- Edge Function "usuarios" (crear cuenta / cambiar contraseña / listar correos), solo rol oficina.
-- Su código está en el repositorio GitHub aitorortega00-dot.github.io → supabase/functions/usuarios/index.ts
