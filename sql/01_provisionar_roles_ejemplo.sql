-- SOLO en PostgreSQL institucional por DBA: no ejecutar sobre Supabase alojado.
-- Reemplazar CONTRASENAS usando un gestor de secretos; ejecutar por canal cifrado.
-- Los roles NOLOGIN maracuya_api y maracuya_identity deben existir.
-- Los inicios de sesion NO pueden tomar el rol opuesto ni pertenecer a roles privilegiados.
CREATE ROLE maracuya_api_login LOGIN PASSWORD 'REEMPLAZAR_CON_SECRETO_UNICO_1' NOINHERIT;
CREATE ROLE maracuya_identity_login LOGIN PASSWORD 'REEMPLAZAR_CON_SECRETO_UNICO_2' NOINHERIT;
GRANT maracuya_api TO maracuya_api_login;
GRANT maracuya_identity TO maracuya_identity_login;
-- IMPORTANTE: estos roles NOINHERIT requieren SET ROLE apropiado para actuar.
-- Alternativa RECOMENDADA para versión inicial: cambiar a INHERIT:
ALTER ROLE maracuya_api_login INHERIT;
ALTER ROLE maracuya_identity_login INHERIT;
-- Auditoria de derechos y prueba de RLS obligatorias antes de exponer API.
