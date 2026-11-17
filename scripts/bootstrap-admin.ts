import { Pool } from 'pg';
import * as argon2 from 'argon2';
import { randomUUID } from 'node:crypto';
import { pgConfig } from '../src/pg-config';

async function main() {
  const correo = process.env.BOOTSTRAP_EMAIL?.trim().toLowerCase();
  const nombre = process.env.BOOTSTRAP_NAME?.trim() || 'Administrador';
  const password = process.env.BOOTSTRAP_PASSWORD;
  if (!correo || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(correo) || !password || password.length < 8) {
    throw new Error('BOOTSTRAP_EMAIL valido y BOOTSTRAP_PASSWORD de 8 caracteres como minimo son obligatorios');
  }
  const pool = new Pool(pgConfig('DATABASE_IDENTITY_URL'));
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE maracuya_identity');
    const existing = await client.query('SELECT id FROM public.usuarios WHERE lower(correo)=$1', [correo]);
    if (existing.rowCount) throw new Error('El usuario ya existe. No se modifica ni se eleva automaticamente.');
    const id = randomUUID();
    const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 65536, timeCost: 3, parallelism: 1 });
    await client.query('INSERT INTO public.usuarios (id,correo,nombre,superadmin,activo,requiere_cambio_clave) VALUES($1,$2,$3,false,true,true)', [id,correo,nombre]);
    await client.query('INSERT INTO privado.credenciales_usuario (usuario_id,password_hash) VALUES($1,$2)', [id,hash]);
    await client.query('COMMIT');
    console.log(`Usuario creado correctamente. ID: ${id}. superadmin=false; requiere_cambio_clave=true.`);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}
main().catch((err) => { console.error(err instanceof Error ? err.message : 'Error desconocido'); process.exitCode = 1; });
