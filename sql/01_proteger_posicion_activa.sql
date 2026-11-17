-- Ejecutar en SQL Editor por DBA, después de verificar que la consulta diagnóstica no devuelve filas.
-- Evita que una posición tenga dos plantas activas; permite histórico de retiradas/reemplazadas.
-- Antes de crear el índice, revisar manualmente las inconsistencias detectadas.
SELECT proyecto_id, posicion_id, count(*) AS activas
FROM public.plantas WHERE estado='activa'
GROUP BY proyecto_id,posicion_id HAVING count(*) > 1;

-- Ejecutar solo si la consulta anterior devuelve cero filas:
CREATE UNIQUE INDEX IF NOT EXISTS plantas_una_activa_por_posicion_idx
  ON public.plantas(proyecto_id,posicion_id)
  WHERE estado='activa';
