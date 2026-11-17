-- NO aplicar hasta revisar 02_revision_testigos.sql con un DBA sin filtrado RLS.
-- No reclasifica plantas ni elige testigos. Aborta ante datos incompatibles.
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL row_security=off;
LOCK TABLE public.plantas,public.posiciones_croquis,public.actividades_agricolas IN SHARE ROW EXCLUSIVE MODE;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.es_testigo AND p.estado='activa' GROUP BY p.proyecto_id,pc.fila_id HAVING count(*)>1) THEN
    RAISE EXCEPTION 'Hay testigos activos duplicados. Revisar sin modificar automáticamente';
  END IF;
  IF EXISTS(SELECT 1 FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=p.proyecto_id WHERE p.es_testigo AND
    (p.tipo_propagacion<>'pie_franco' OR p.portainjerto_id IS NOT NULL OR p.unidad_experimental_id IS NOT NULL OR
      EXISTS(SELECT 1 FROM public.actividades_agricolas a WHERE a.proyecto_id=p.proyecto_id AND a.tipo='tratamiento_experimental' AND (a.planta_id=p.id OR (a.planta_id IS NULL AND a.parcela_id=f.parcela_id))))) THEN
    RAISE EXCEPTION 'Hay testigos incompatibles con la definición natural. Revisar el croquis y el historial';
  END IF;
END $$;
CREATE TABLE public.testigos_fila_guardia (
  fila_id uuid PRIMARY KEY,
  proyecto_id uuid NOT NULL,
  planta_id uuid NOT NULL UNIQUE,
  FOREIGN KEY(fila_id,proyecto_id) REFERENCES public.filas_cultivo(id,proyecto_id),
  FOREIGN KEY(planta_id,proyecto_id) REFERENCES public.plantas(id,proyecto_id)
);
CREATE TABLE public.testigos_fila_eventos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proyecto_id uuid NOT NULL,
  fila_id uuid NOT NULL,
  planta_anterior_id uuid,
  planta_nueva_id uuid,
  accion text NOT NULL CHECK(accion IN ('asignacion','continuar','pendiente')),
  referencia text NOT NULL CHECK(length(btrim(referencia)) BETWEEN 5 AND 500),
  usuario_id uuid NOT NULL REFERENCES public.usuarios(id),
  creado_en timestamptz NOT NULL DEFAULT now(),
  transaccion bigint NOT NULL DEFAULT txid_current(),
  CHECK(planta_anterior_id IS NOT NULL OR planta_nueva_id IS NOT NULL),
  FOREIGN KEY(fila_id,proyecto_id) REFERENCES public.filas_cultivo(id,proyecto_id),
  FOREIGN KEY(planta_anterior_id,proyecto_id) REFERENCES public.plantas(id,proyecto_id),
  FOREIGN KEY(planta_nueva_id,proyecto_id) REFERENCES public.plantas(id,proyecto_id)
);
ALTER TABLE public.testigos_fila_guardia ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.testigos_fila_eventos ENABLE ROW LEVEL SECURITY;
CREATE POLICY testigos_guardia_leer ON public.testigos_fila_guardia FOR SELECT TO maracuya_api USING(public.puede_acceder(proyecto_id));
CREATE POLICY testigos_eventos_leer ON public.testigos_fila_eventos FOR SELECT TO maracuya_api USING(public.puede_acceder(proyecto_id));
CREATE POLICY testigos_eventos_insertar ON public.testigos_fila_eventos FOR INSERT TO maracuya_api WITH CHECK(public.puede_acceder(proyecto_id,ARRAY['administrador','investigador']) AND usuario_id=public.usuario_actual_id());
GRANT SELECT ON public.testigos_fila_guardia TO maracuya_api;
GRANT SELECT,INSERT ON public.testigos_fila_eventos TO maracuya_api;
REVOKE ALL ON public.testigos_fila_guardia,public.testigos_fila_eventos FROM PUBLIC;
-- Se registra solo la proyección de asignaciones existentes verificadas; no cambia es_testigo.
INSERT INTO public.testigos_fila_guardia(fila_id,proyecto_id,planta_id)
SELECT pc.fila_id,p.proyecto_id,p.id FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.es_testigo AND p.estado='activa';

CREATE FUNCTION public.verificar_evento_testigo() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
DECLARE v_id uuid;
BEGIN
  FOREACH v_id IN ARRAY ARRAY[NEW.planta_anterior_id,NEW.planta_nueva_id] LOOP
    IF v_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.id=v_id AND p.proyecto_id=NEW.proyecto_id AND pc.fila_id=NEW.fila_id) THEN
      RAISE EXCEPTION 'Toda planta de la continuidad debe pertenecer a la misma fila' USING ERRCODE='23514';
    END IF;
  END LOOP;
  IF NEW.accion IN ('asignacion','continuar') AND NOT EXISTS(SELECT 1 FROM public.plantas WHERE id=NEW.planta_nueva_id AND proyecto_id=NEW.proyecto_id AND es_testigo AND estado='activa') THEN
    RAISE EXCEPTION 'La decisión debe señalar un nuevo testigo activo' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER testigos_evento_misma_fila BEFORE INSERT ON public.testigos_fila_eventos FOR EACH ROW EXECUTE FUNCTION public.verificar_evento_testigo();

CREATE FUNCTION public.validar_testigo_fila() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_fila uuid; v_parcela uuid;
BEGIN
  IF TG_OP='DELETE' THEN
    IF OLD.es_testigo THEN RAISE EXCEPTION 'Conservar la planta testigo y su historial; usar reemplazo' USING ERRCODE='23514'; END IF;
    RETURN OLD;
  END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.posicion_id<>OLD.posicion_id OR NEW.proyecto_id<>OLD.proyecto_id THEN
      RAISE EXCEPTION 'La ubicación histórica de la planta es inmutable' USING ERRCODE='23514';
    END IF;
    IF OLD.es_testigo AND NOT NEW.es_testigo THEN
      RAISE EXCEPTION 'No borrar la clasificación histórica del testigo' USING ERRCODE='23514';
    END IF;
  END IF;
  SELECT pc.fila_id,f.parcela_id INTO STRICT v_fila,v_parcela FROM public.posiciones_croquis pc JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=pc.proyecto_id WHERE pc.id=NEW.posicion_id AND pc.proyecto_id=NEW.proyecto_id;
  -- Serializa clasificación e intervención experimental en una misma parcela.
  PERFORM 1 FROM public.parcelas WHERE id=v_parcela AND proyecto_id=NEW.proyecto_id FOR UPDATE;
  IF NEW.es_testigo THEN
    IF NEW.tipo_propagacion<>'pie_franco' OR NEW.portainjerto_id IS NOT NULL OR NEW.unidad_experimental_id IS NOT NULL OR EXISTS(
      SELECT 1 FROM public.actividades_agricolas a WHERE a.proyecto_id=NEW.proyecto_id AND a.tipo='tratamiento_experimental' AND (a.planta_id=NEW.id OR (a.planta_id IS NULL AND a.parcela_id=v_parcela))) THEN
      RAISE EXCEPTION 'Testigo natural: pie franco, sin portainjerto, unidad ni intervención experimental' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plantas_testigo_fila_guard BEFORE INSERT OR UPDATE OR DELETE ON public.plantas FOR EACH ROW EXECUTE FUNCTION public.validar_testigo_fila();
CREATE FUNCTION public.actualizar_guardia_testigo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_fila uuid;
BEGIN
  IF NEW.es_testigo AND NEW.estado='activa' THEN
    SELECT fila_id INTO STRICT v_fila FROM public.posiciones_croquis WHERE id=NEW.posicion_id AND proyecto_id=NEW.proyecto_id;
    INSERT INTO public.testigos_fila_guardia(fila_id,proyecto_id,planta_id) VALUES(v_fila,NEW.proyecto_id,NEW.id)
      ON CONFLICT(planta_id) DO NOTHING;
    -- La PK fila_id impide duplicados incluso entre transacciones concurrentes.
  ELSE
    DELETE FROM public.testigos_fila_guardia WHERE planta_id=NEW.id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER plantas_testigo_fila_actual AFTER INSERT OR UPDATE ON public.plantas FOR EACH ROW EXECUTE FUNCTION public.actualizar_guardia_testigo();
CREATE FUNCTION public.exigir_continuidad_testigo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE evento public.testigos_fila_eventos; v_fila uuid;
BEGIN
  IF OLD.es_testigo AND OLD.estado='activa' AND NEW.estado<>'activa' THEN
    SELECT fila_id INTO STRICT v_fila FROM public.posiciones_croquis WHERE id=OLD.posicion_id AND proyecto_id=OLD.proyecto_id;
    SELECT * INTO evento FROM public.testigos_fila_eventos WHERE planta_anterior_id=OLD.id AND proyecto_id=OLD.proyecto_id AND fila_id=v_fila AND transaccion=txid_current() AND accion IN ('continuar','pendiente') ORDER BY creado_en DESC LIMIT 1;
    IF NOT FOUND THEN RAISE EXCEPTION 'El retiro de testigo exige continuidad explícita y auditada' USING ERRCODE='23514'; END IF;
    IF evento.accion='continuar' AND NOT EXISTS(SELECT 1 FROM public.testigos_fila_guardia WHERE fila_id=v_fila AND proyecto_id=OLD.proyecto_id AND planta_id=evento.planta_nueva_id) THEN
      RAISE EXCEPTION 'La continuidad debe señalar el nuevo testigo de la misma fila' USING ERRCODE='23514';
    END IF;
    IF evento.accion='pendiente' AND EXISTS(SELECT 1 FROM public.testigos_fila_guardia WHERE fila_id=v_fila AND proyecto_id=OLD.proyecto_id) THEN
      RAISE EXCEPTION 'La fila declarada pendiente aún tiene testigo activo' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER testigo_continuidad_obligatoria AFTER UPDATE ON public.plantas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.exigir_continuidad_testigo();
CREATE FUNCTION public.exigir_asignacion_testigo() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_fila uuid; verificar boolean;
BEGIN
  verificar=NEW.es_testigo AND NEW.estado='activa';
  IF TG_OP='UPDATE' THEN verificar=verificar AND (NOT OLD.es_testigo OR OLD.estado<>'activa'); END IF;
  IF verificar THEN
    SELECT fila_id INTO STRICT v_fila FROM public.posiciones_croquis WHERE id=NEW.posicion_id AND proyecto_id=NEW.proyecto_id;
    IF NOT EXISTS(SELECT 1 FROM public.testigos_fila_eventos WHERE planta_nueva_id=NEW.id AND proyecto_id=NEW.proyecto_id AND fila_id=v_fila AND transaccion=txid_current() AND accion IN ('asignacion','continuar')) THEN
      RAISE EXCEPTION 'La asignación de testigo exige verificación de croquis auditada' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER testigo_asignacion_verificada AFTER INSERT OR UPDATE ON public.plantas DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.exigir_asignacion_testigo();
CREATE FUNCTION public.inmovilizar_posicion_ocupada() RETURNS trigger LANGUAGE plpgsql SET search_path='' AS $$
BEGIN
  IF (NEW.fila_id<>OLD.fila_id OR NEW.proyecto_id<>OLD.proyecto_id OR NEW.numero<>OLD.numero) AND EXISTS(SELECT 1 FROM public.plantas WHERE posicion_id=OLD.id AND proyecto_id=OLD.proyecto_id) THEN
    RAISE EXCEPTION 'No mover una posición con plantas e historial' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER posiciones_preservar_historia BEFORE UPDATE ON public.posiciones_croquis FOR EACH ROW EXECUTE FUNCTION public.inmovilizar_posicion_ocupada();
-- Reemplaza la protección previa manteniendo el nombre de la función y el trigger existentes.
CREATE OR REPLACE FUNCTION public.proteger_testigos() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE v_parcela uuid;
BEGIN
  IF NEW.tipo='tratamiento_experimental' THEN
    IF NEW.planta_id IS NOT NULL THEN
      SELECT f.parcela_id INTO v_parcela FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=p.proyecto_id WHERE p.id=NEW.planta_id AND p.proyecto_id=NEW.proyecto_id;
    ELSE v_parcela=NEW.parcela_id;
    END IF;
    PERFORM 1 FROM public.parcelas WHERE id=v_parcela AND proyecto_id=NEW.proyecto_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=p.proyecto_id WHERE p.proyecto_id=NEW.proyecto_id AND p.es_testigo AND (p.id=NEW.planta_id OR (NEW.planta_id IS NULL AND f.parcela_id=NEW.parcela_id))) THEN
      RAISE EXCEPTION 'No aplicar intervención experimental a testigos, tampoco por parcela' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.validar_testigo_fila(),public.actualizar_guardia_testigo(),public.proteger_testigos() FROM PUBLIC;
COMMIT;
