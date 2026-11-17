
const { Client } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const caPath = path.resolve(
  process.env.DATABASE_CA_PATH || 'certs/supabase-ca.crt'
);

if (!fs.existsSync(caPath)) {
  throw new Error(`Certificado CA no encontrado: ${caPath}`);
}

const ca = fs.readFileSync(caPath, 'utf8');

function crearCliente(connectionString) {
  if (!connectionString) {
    throw new Error('Falta la cadena de conexión PostgreSQL');
  }

  const url = new URL(connectionString);

  return new Client({
    host: url.hostname,
    port: Number(url.port || 5432),
    database: decodeURIComponent(url.pathname.slice(1)),
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    connectionTimeoutMillis: 10000,
    ssl: {
      ca,
      rejectUnauthorized: true,
      servername: url.hostname
    }
  });
}

async function verificar(nombre, url, rolPermitido, rolProhibido) {
  const client = crearCliente(url);

  try {
    await client.connect();

    // Verificar que puede asumir su rol autorizado.
    await client.query('BEGIN');

    try {
      await client.query(`SET LOCAL ROLE ${rolPermitido}`);

      const result = await client.query(
        'SELECT current_user, session_user'
      );

      console.log(`${nombre}: ROL CORRECTO`, result.rows[0]);
    } finally {
      await client.query('ROLLBACK');
    }

    // Verificar que NO puede asumir el rol contrario.
    await client.query('BEGIN');

    try {
      await client.query(`SET LOCAL ROLE ${rolProhibido}`);

      console.error(
        `${nombre}: FALLO DE SEGURIDAD: rol contrario permitido`
      );

      process.exitCode = 1;
    } catch (error) {
      if (error.code === '42501') {
        console.log(
          `${nombre}: rol contrario bloqueado correctamente`
        );
      } else {
        throw error;
      }
    } finally {
      await client.query('ROLLBACK');
    }

  } finally {
    await client.end();
  }
}

async function main() {
  await verificar(
    'API',
    process.env.DATABASE_API_URL,
    'maracuya_api',
    'maracuya_identity'
  );

  await verificar(
    'IDENTITY',
    process.env.DATABASE_IDENTITY_URL,
    'maracuya_identity',
    'maracuya_api'
  );
}

main().catch(error => {
  console.error('ERROR:', error.code || '', error.message);
  process.exitCode = 1;
});
