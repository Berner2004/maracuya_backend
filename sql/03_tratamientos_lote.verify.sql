-- Verificación manual posterior a la migración: solo lectura, sin datos de prueba.
BEGIN READ ONLY;
SET LOCAL search_path = pg_catalog, public;
DO $verify$
DECLARE rol text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class WHERE oid='public.tratamientos_lote'::regclass
      AND relowner='postgres'::regrole AND relrowsecurity AND relforcerowsecurity
      AND obj_description(oid,'pg_class')='maracuya:03_tratamientos_lote:v1'
  ) THEN RAISE EXCEPTION 'Propietario, RLS o versión inesperados'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conrelid='public.tratamientos_lote'::regclass
      AND conname='tratamientos_lote_codigo_uk' AND contype='u'
      AND pg_get_constraintdef(oid)='UNIQUE (proyecto_id, lote_id, codigo_normalizado)'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_attribute a JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE a.attrelid='public.tratamientos_lote'::regclass
      AND a.attname='codigo_normalizado' AND a.attgenerated='s'
      AND pg_get_expr(d.adbin,d.adrelid)='lower(codigo_local)'
  ) THEN RAISE EXCEPTION 'Falta la unicidad normalizada por lote'; END IF;
  IF NOT has_table_privilege('maracuya_api','public.tratamientos_lote','SELECT')
     OR NOT has_column_privilege('maracuya_api','public.tratamientos_lote','codigo_local','INSERT')
     OR has_table_privilege('maracuya_api','public.tratamientos_lote','UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
     OR has_any_column_privilege('maracuya_api','public.tratamientos_lote','UPDATE')
     OR has_column_privilege('maracuya_api','public.tratamientos_lote','creado_por','INSERT')
     OR has_column_privilege('maracuya_api','public.tratamientos_lote','creado_en','INSERT')
     OR has_column_privilege('maracuya_api','public.tratamientos_lote','id','INSERT') THEN
    RAISE EXCEPTION 'Privilegios de API inesperados';
  END IF;
  FOREACH rol IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF has_table_privilege(rol,'public.tratamientos_lote','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
       OR has_any_column_privilege(rol,'public.tratamientos_lote','INSERT,UPDATE,REFERENCES') THEN
      RAISE EXCEPTION 'Permiso no previsto para %',rol;
    END IF;
  END LOOP;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid='public.tratamientos_lote'::regclass)<>2
     OR EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='public.tratamientos_lote'::regclass AND (polcmd NOT IN ('r','a') OR polroles<>ARRAY['maracuya_api'::regrole::oid])) THEN
    RAISE EXCEPTION 'Policies inesperadas; solo se admiten SELECT e INSERT';
  END IF;
END $verify$;
SELECT current_user AS ejecutado_como,
       lower('T1')=lower('t1') AS normalizacion_correcta,
       to_regclass('public.tratamientos_lote') AS tabla;
SELECT policyname,roles,cmd,qual,with_check FROM pg_policies
WHERE schemaname='public' AND tablename='tratamientos_lote' ORDER BY policyname;
ROLLBACK;
