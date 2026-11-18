-- Reversión manual, NO aplicada. Primero desactivar TRATAMIENTOS_LOTE_ACTIVO.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
SET LOCAL row_security = off;
DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Ejecutar la reversión como postgres';
  END IF;
  IF to_regclass('public.tratamientos_lote') IS NULL THEN
    RAISE EXCEPTION 'La tabla no existe; no hay migración que revertir';
  END IF;
END $preflight$;
LOCK TABLE public.tratamientos_lote IN ACCESS EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF obj_description('public.tratamientos_lote'::regclass,'pg_class')
     IS DISTINCT FROM 'maracuya:03_tratamientos_lote:v1'
     OR (SELECT relowner FROM pg_class WHERE oid='public.tratamientos_lote'::regclass)
        <> 'postgres'::regrole THEN
    RAISE EXCEPTION 'La tabla no corresponde a esta migración o cambió de propietario';
  END IF;
  -- row_security=off impide que una lectura filtrada simule que la tabla está vacía.
  IF EXISTS (SELECT 1 FROM public.tratamientos_lote) THEN
    RAISE EXCEPTION 'Reversión bloqueada: hay correspondencias registradas; conservarlas y revisar un plan de archivo';
  END IF;
END $guard$;
DROP TABLE public.tratamientos_lote RESTRICT;
-- Sin CASCADE ni cambios a datos/policies/funciones históricas.
COMMIT;
