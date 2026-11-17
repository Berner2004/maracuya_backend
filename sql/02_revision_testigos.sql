-- Solo lectura. Ejecutar como DBA autorizado que pueda ver todos los registros.
BEGIN READ ONLY;
SET LOCAL row_security=off;
SELECT f.proyecto_id,f.id fila_id,f.numero,
  count(p.id) FILTER(WHERE p.es_testigo AND p.estado='activa') testigos_activos,
  array_agg(p.codigo) FILTER(WHERE p.es_testigo AND p.estado='activa') codigos
FROM public.filas_cultivo f LEFT JOIN public.posiciones_croquis pc ON pc.fila_id=f.id AND pc.proyecto_id=f.proyecto_id
LEFT JOIN public.plantas p ON p.posicion_id=pc.id AND p.proyecto_id=pc.proyecto_id
GROUP BY f.proyecto_id,f.id,f.numero ORDER BY f.proyecto_id,f.numero;
SELECT p.id,p.codigo,p.estado,p.tipo_propagacion,p.portainjerto_id,p.unidad_experimental_id,pc.fila_id
FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id
WHERE p.es_testigo;
SELECT a.id,a.proyecto_id,a.planta_id,a.parcela_id,a.fecha FROM public.actividades_agricolas a
WHERE a.tipo='tratamiento_experimental';
ROLLBACK;
