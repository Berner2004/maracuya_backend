
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

async function test(nombre, value) {
  if (!value) throw new Error(`Falta la URL de ${nombre}`);

  const url = new URL(value);

  // Eliminar parámetros que podrían sobrescribir ssl.
  for (const key of [
    'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'ssl'
  ]) {
    url.searchParams.delete(key);
  }

  const client = new Client({
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

  try {
    await client.connect();
    const result = await client.query(
      'SELECT current_user, current_database()'
    );
    console.log(`${nombre}: CONEXIÓN CORRECTA`, result.rows[0]);
  } finally {
    await client.end();
  }
}

async function main() {
  await test('API', process.env.DATABASE_API_URL);
  await test('IDENTITY', process.env.DATABASE_IDENTITY_URL);
}

main().catch((err) => {
  console.error('FALLO:', err.code || '', err.message);
  process.exitCode = 1;
});
