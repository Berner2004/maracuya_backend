# Activar el catálogo por lote

## Estado y cambios

Preparado; no se aplicaron SQL ni se escribieron datos reales. Los archivos canónicos están en `maracuya_backend/sql/03_tratamientos_lote.*.sql`; `maracuya_mobile/docs/sql/` conserva copias idénticas de entrega.

Se conserva la definición global del tratamiento y se añade una correspondencia inmutable por lote. `codigo_normalizado=lower(codigo_local)` y su UNIQUE compuesto impiden registrar T1/t1 dentro del mismo lote. Otro lote puede usar T1 con otro UUID de tratamiento; no se fusionan definiciones por código. Se conserva el código original ingresado.

La consulta real de catálogo confirmó: propietario `postgres`; `puede_acceder(uuid,text[])` es SECURITY DEFINER con search_path vacío; `usuario_actual_id()` es SECURITY INVOKER y toma `app.usuario_id`; `maracuya_api` no tiene LOGIN, SUPERUSER ni BYPASSRLS; su login usa SET ROLE en Db.apiAs. No se cambiaron esas funciones. Se conservan la validación de membresía administrativa en NestJS y el comportamiento administrativo/superadmin de puede_acceder en PostgreSQL.

La migración elimina grants no propietarios, incluidos los default ACL de Supabase para anon/authenticated/service_role. Concede a maracuya_api SELECT e INSERT limitado a las cinco columnas de entrada, con RLS; autor, UUID y fecha provienen de PostgreSQL. No hay permisos o policies generales de UPDATE, DELETE o TRUNCATE. postgres mantiene privilegios de DBA: no se utiliza como conexión de la API.

## Activación manual en Supabase

1. Desplegar primero el backend actualizado con `TRATAMIENTOS_LOTE_ACTIVO=false` (también es el valor por defecto). No reemplazar el `.env` real con `.env.example`. Las rutas existentes siguen funcionando y las nuevas rutas del catálogo responden 503 mientras esté deshabilitado.
2. En el proyecto correcto de Supabase, abrir SQL Editor, crear una consulta y seleccionar el rol `postgres`. Comprobar `SELECT current_user, to_regclass('public.tratamientos_lote');`: debe devolver postgres y NULL. Pegar y ejecutar **una sola vez** el contenido completo de `sql/03_tratamientos_lote.up.sql`. El script incluye BEGIN/COMMIT y comprobaciones de seguridad. No ejecutar los archivos de reversión ni de otros sprints. Si una comprobación falla, cancelar y ejecutar ROLLBACK antes de revisar; no omitir el control ni usar CREATE TABLE IF NOT EXISTS.
3. Ejecutar completo `sql/03_tratamientos_lote.verify.sql` en SQL Editor. Debe terminar sin excepciones, con normalizacion_correcta=true y únicamente policies SELECT/INSERT para maracuya_api. Esta verificación es de solo lectura; no inserta plantas, tratamientos ni correspondencias de prueba.
4. Configurar `TRATAMIENTOS_LOTE_ACTIVO=true` en el entorno del backend y reiniciar todas sus instancias. En desarrollo Windows: editar esa clave en `.env`, detener la instancia anterior e iniciar desde `maracuya_backend` con `.\node_modules\.bin\dotenv.cmd -e .env -- npm.cmd run start:dev`. En hosting, cambiar la variable del servicio y reiniciarlo. Mantener las conexiones restringidas y el JWT propio; no usar credenciales postgres ni Supabase Auth.
5. Con JWT válido, consultar `GET /proyectos/:id/lotes/:lotId/tratamientos`. Responde 200 y una lista, inicialmente vacía. Solo un administrador con membresía activa puede registrar una correspondencia revisada mediante POST en la misma ruta, con `tratamiento_id`, `codigo_local` y `referencia_validacion`. Usar UUID reales y metodología validada; no crear correspondencias desde códigos o Excel automáticamente. No enviar autor, fecha, UUID de correspondencia ni proyecto en el body.

Con la bandera activa, crear una **unidad nueva** exige una correspondencia para el lote de su parcela; si falta responde 400. Las unidades históricas siguen consultándose mediante LEFT JOIN, con `correspondencia_validada=false` y códigos locales nulos si no tienen revisión. Su selección/asignación compatible y los registros históricos no se bloquean ni se modifican. No se añadieron PATCH/DELETE de correspondencias.

## Reversión protegida

Primero poner `TRATAMIENTOS_LOTE_ACTIVO=false` y reiniciar todas las instancias. Después ejecutar manualmente `sql/03_tratamientos_lote.down.sql` como postgres. Comprueba propietario/versión bajo bloqueo exclusivo, verifica toda la tabla con row_security=off y solo la retira si está vacía y no tiene dependencias externas. Si existen correspondencias, aborta: dejar la tabla deshabilitada y conservar los datos; no borrarlos para forzar la reversión.

## Pruebas

En maracuya_backend: `npm.cmd run check` y `npm.cmd test`. Este último ejecuta `npm run build`. Resultado: TypeScript y compilación correctos; 61 pruebas aprobadas (14 nuevas). Las nuevas pruebas usan DB simulada y comprobaciones estáticas del contrato SQL; no ejecutan migraciones. La verificación efectiva de la tabla nueva queda para el paso manual 3, pues aún no existe. Flutter no se modificó.
