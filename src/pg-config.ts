import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PoolConfig } from 'pg';

/** Build TLS-verified pg config without allowing URL sslmode to override ssl.ca. */
export function pgConfig(envName: 'DATABASE_API_URL' | 'DATABASE_IDENTITY_URL'): PoolConfig {
  const raw = process.env[envName];
  if (!raw) throw new Error(`Missing ${envName}`);
  const url = new URL(raw);
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') throw new Error(`Invalid protocol for ${envName}`);
  const caPath = process.env.DATABASE_CA_PATH;
  if (!caPath) throw new Error('Missing DATABASE_CA_PATH');
  const database = decodeURIComponent(url.pathname.substring(1));
  if (!database || !url.username || !url.password) throw new Error(`Incomplete ${envName}`);
  return {
    host: url.hostname,
    port: Number(url.port || '5432'),
    database,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    max: envName === 'DATABASE_API_URL' ? 10 : 5,
    connectionTimeoutMillis: 10000,
    ssl: { ca: readFileSync(resolve(caPath), 'utf8'), rejectUnauthorized: true, servername: url.hostname }
  };
}
