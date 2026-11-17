# Maracuyá Backend — Sprint 1 (base de desarrollo)

API NestJS + PostgreSQL **sin Supabase Auth**. Implementa inicio de sesión Argon2id, renovación con rotación de tokens, cierre de sesión, perfil, proyectos y listado de lotes sujeto a RLS. **No está listo para producción**.

## Requisitos
Node.js 24 LTS, PostgreSQL 15+, esquema institucional migrado. Debes crear dos roles de LOGIN con privilegios separados, autorizados exclusivamente a heredar el rol correspondiente (`maracuya_identity`, `maracuya_api`). En PostgreSQL institucional usa SQL de `sql/01_provisionar_roles_ejemplo.sql` únicamente tras reemplazar contraseñas; en Supabase alojado NO debes asumir que puedes crear estos roles. No expongas PostgreSQL a Internet.

## Instalar en Windows PowerShell

```powershell
cd C:\ruta\maracuya_backend
npm install
Copy-Item .env.example .env
# Edita .env con credenciales reales de conexiones limitadas y JWT_SECRET aleatorio (>=64 caracteres)
# Windows Powershell no carga .env automaticamente: instalar y usar dotenv-cli o configurar variables de entorno.
npm install -D dotenv-cli
# Luego: npx dotenv -e .env -- npm run start:dev
npm run check
npx dotenv -e .env -- npm run start:dev
```

Para generar JWT_SECRET:

```powershell
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

Nunca subir `.env` a Git.

## Crear el primer usuario

El servicio de identidad puede crear el usuario inicial, pero NO asignarse superadmin por sí mismo:

```powershell
$env:BOOTSTRAP_EMAIL='admin@example.edu.ec'
$env:BOOTSTRAP_NAME='Administrador'
$env:BOOTSTRAP_PASSWORD='CONTRASENA_LARGA_Y_UNICA'
npx dotenv -e .env -- npm run bootstrap
```

El DBA debe verificar su identidad y promoverlo mediante sesión administrativa controlada:

```sql
UPDATE public.usuarios SET superadmin=true, requiere_cambio_clave=true
WHERE correo='admin@example.edu.ec' AND activo=true;
```

Esta orden **no está disponible desde la API pública**. Antes de producción crear flujos administrativos auditables, revisión de membresías y recuperación de contraseñas.

## Rutas disponibles

- `GET /health`
- `POST /auth/login` JSON `{ "email": "...", "password": "..." }`
- `POST /auth/refresh` JSON `{ "refreshToken": "..." }`
- `POST /auth/logout` con Bearer y JSON `{ "refreshToken": "..." }`
- `GET /me` Bearer
- `GET /proyectos` Bearer
- `GET /proyectos/:id/lotes` Bearer

Ejemplo login en PowerShell:

```powershell
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:3001/auth/login -ContentType 'application/json' -Body '{"email":"admin@example.edu.ec","password":"CONTRASENA_LARGA_Y_UNICA"}'
```

## Controles y trabajo pendiente

1. **Seguridad adicional necesaria:** comprobar `FORCE ROW LEVEL SECURITY` o asegurar que el dueño nunca actúa como cuenta API; testear cuenta sin membresía y con proyecto ajeno. Verificar funciones SECURITY DEFINER y search_path. Asegurar que los LOGIN no tienen privilegios SQL propios más amplios que su rol.
2. Login: límite global por IP aplicado por guard de NestJS, además de 5 fallos con bloqueo 15 min. En despliegue multiinstancia usar rate-limit centralizado y revisar protección anti-enumeración, evitar registrar contraseñas/tokens.
3. Renovación: la rotación es atómica, pero falta detección y revocación de toda la familia por reutilización. Access tokens existentes no se revocan instantáneamente: implementar comprobación de estado de sesión y usuario para rutas sensibles. Logout revoca refresh token, pero JWT podría durar hasta 15 minutos.
4. La tabla `privado.sesiones` y la tabla `usuarios` se consultan por el servicio `maracuya_identity` sin acceso a operaciones agrícolas. Cambios de rol/membresía se aplican a la lectura RLS siguiente, no a datos precargados en cliente.
5. Crear módulo protegido de gestión de usuarios, recuperación de contraseñas con tokens de un solo uso y registro de auditoría. No ofrecer registro público libre por defecto.
6. Añadir tests unitarios/integración y despliegue HTTPS, validación exhaustiva CORS, logging redactado, copias de seguridad, monitorización y gestión de secretos.
7. Configurar Flutter para HTTP únicamente en emulador local durante desarrollo (Android 10.0.2.2:3001) y HTTPS en institución. No eliminar aún supabase_flutter hasta reemplazar todos sus usos.
8. Revisar que las políticas RLS se apliquen realmente con LOGINs separados. El backend usa `set_config` **solo después** de verificar JWT y dentro de una transacción.

## Criterio de aceptación del primer incremento

La API debe arrancar, crear el primer usuario de forma controlada, iniciar sesión, rotar refresh, mostrar perfil, listar proyectos autorizados y **no listar lotes de un proyecto ajeno**. Se requiere verificarlo con dos cuentas en una base de prueba.
