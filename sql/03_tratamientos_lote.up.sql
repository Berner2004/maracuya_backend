-- Revisada, NO aplicada. Ejecutar manualmente como postgres en Supabase SQL Editor.
-- No crea datos, no reclasifica unidades y no altera funciones/policies históricas.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = pg_catalog, public;
DO $preflight$
BEGIN
  IF current_user <> 'postgres' THEN
    RAISE EXCEPTION 'Ejecutar como postgres; la API no debe ser propietaria de esta tabla';
  END IF;
  IF to_regclass('public.tratamientos_lote') IS NOT NULL THEN
    RAISE EXCEPTION 'tratamientos_lote ya existe: revisar la instalación, no sobrescribirla';
  END IF;
  IF to_regprocedure('public.puede_acceder(uuid,text[])') IS NULL
     OR to_regprocedure('public.usuario_actual_id()') IS NULL THEN
    RAISE EXCEPTION 'Faltan las funciones del JWT propio';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid='public.puede_acceder(uuid,text[])'::regprocedure
      AND prosecdef AND proowner='postgres'::regrole
      AND proconfig @> ARRAY['search_path=""']::text[]
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_proc
    WHERE oid='public.usuario_actual_id()'::regprocedure
      AND NOT prosecdef AND proowner='postgres'::regrole
  ) THEN
    RAISE EXCEPTION 'Cambió la configuración de seguridad de las funciones; revisar antes de continuar';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='maracuya_api'
      AND NOT rolsuper AND NOT rolbypassrls AND NOT rolcanlogin)
     OR pg_has_role('maracuya_api','postgres','MEMBER') THEN
    RAISE EXCEPTION 'maracuya_api debe ser un rol restringido, sin propiedad ni bypass de RLS';
  END IF;
  IF NOT has_schema_privilege('maracuya_api','public','USAGE')
     OR NOT has_function_privilege('maracuya_api','public.puede_acceder(uuid,text[])','EXECUTE')
     OR NOT has_function_privilege('maracuya_api','public.usuario_actual_id()','EXECUTE') THEN
    RAISE EXCEPTION 'Faltan privilegios efectivos para evaluar RLS';
  END IF;
END $preflight$;

CREATE TABLE public.tratamientos_lote (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL,
  lote_id uuid NOT NULL,
  tratamiento_id uuid NOT NULL,
  codigo_local text NOT NULL CHECK (
    length(codigo_local) BETWEEN 1 AND 80
    AND codigo_local = btrim(codigo_local)
    AND codigo_local !~ '[[:space:]]'
  ),
  -- Normalización única en PostgreSQL: T1 y t1 colisionan dentro del mismo lote.
  codigo_normalizado text GENERATED ALWAYS AS (lower(codigo_local)) STORED,
  referencia_validacion text NOT NULL CHECK (length(btrim(referencia_validacion)) BETWEEN 5 AND 500),
  creado_por uuid NOT NULL DEFAULT public.usuario_actual_id(),
  creado_en timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tratamientos_lote_lote_fk FOREIGN KEY (lote_id, proyecto_id)
    REFERENCES public.lotes(id, proyecto_id),
  CONSTRAINT tratamientos_lote_tratamiento_fk FOREIGN KEY (tratamiento_id, proyecto_id)
    REFERENCES public.tratamientos(id, proyecto_id),
  CONSTRAINT tratamientos_lote_codigo_uk UNIQUE (proyecto_id, lote_id, codigo_normalizado),
  CONSTRAINT tratamientos_lote_definicion_uk UNIQUE (proyecto_id, lote_id, tratamiento_id)
);
ALTER TABLE public.tratamientos_lote OWNER TO postgres;
COMMENT ON TABLE public.tratamientos_lote IS 'maracuya:03_tratamientos_lote:v1';
CREATE INDEX tratamientos_lote_tratamiento_idx
  ON public.tratamientos_lote (proyecto_id, tratamiento_id);
ALTER TABLE public.tratamientos_lote ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tratamientos_lote FORCE ROW LEVEL SECURITY;

-- Elimina TODOS los grants no propietarios, incluidos los default ACL de Supabase.
-- No cambia ALTER DEFAULT PRIVILEGES ni los permisos de otras tablas.
DO $acl$
DECLARE destino record;
BEGIN
  FOR destino IN
    SELECT DISTINCT a.grantee
    FROM pg_class c
    CROSS JOIN LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    WHERE c.oid='public.tratamientos_lote'::regclass AND a.grantee<>c.relowner
  LOOP
    IF destino.grantee=0 THEN
      REVOKE ALL ON TABLE public.tratamientos_lote FROM PUBLIC;
    ELSE
      EXECUTE format('REVOKE ALL ON TABLE public.tratamientos_lote FROM %I',
                     pg_get_userbyid(destino.grantee));
    END IF;
  END LOOP;
END $acl$;
REVOKE ALL ON TABLE public.tratamientos_lote FROM PUBLIC;
GRANT SELECT ON public.tratamientos_lote TO maracuya_api;
GRANT INSERT (proyecto_id,lote_id,tratamiento_id,codigo_local,referencia_validacion)
  ON public.tratamientos_lote TO maracuya_api;
-- La API no puede elegir id, autor, fecha ni la clave normalizada.
CREATE POLICY api_leer_tratamientos_lote ON public.tratamientos_lote
  FOR SELECT TO maracuya_api USING (public.puede_acceder(proyecto_id));
CREATE POLICY api_insertar_tratamientos_lote ON public.tratamientos_lote
  FOR INSERT TO maracuya_api WITH CHECK (
    public.puede_acceder(proyecto_id,ARRAY['administrador']::text[])
    AND creado_por=public.usuario_actual_id()
  );
-- Sin grants ni policies de UPDATE, DELETE o TRUNCATE para roles de aplicación.
-- postgres sigue siendo un rol DBA con BYPASSRLS: nunca usarlo en NestJS.
DO $postflight$
DECLARE nombre text;
BEGIN
  IF NOT has_table_privilege('maracuya_api','public.tratamientos_lote','SELECT')
     OR NOT has_any_column_privilege('maracuya_api','public.tratamientos_lote','INSERT')
     OR has_table_privilege('maracuya_api','public.tratamientos_lote','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_any_column_privilege('maracuya_api','public.tratamientos_lote','UPDATE')
     OR has_column_privilege('maracuya_api','public.tratamientos_lote','creado_por','INSERT') THEN
    RAISE EXCEPTION 'Privilegios efectivos inesperados para maracuya_api';
  END IF;
  FOREACH nombre IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=nombre) AND (
      has_table_privilege(nombre,'public.tratamientos_lote','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
      OR has_any_column_privilege(nombre,'public.tratamientos_lote','INSERT,UPDATE,REFERENCES')
    ) THEN
      RAISE EXCEPTION 'El rol % conserva privilegios no previstos', nombre;
    END IF;
  END LOOP;
END $postflight$;
-- No backfill ni cambios a unidades/plantas/tratamientos existentes.
COMMIT;
