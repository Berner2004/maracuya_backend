import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type QueryResultRow } from 'pg';
import { pgConfig } from './pg-config';

@Injectable()
export class Db implements OnModuleDestroy {
  private readonly identity = new Pool(pgConfig('DATABASE_IDENTITY_URL'));
  private readonly api = new Pool(pgConfig('DATABASE_API_URL'));

  async identityQuery<T extends QueryResultRow = any>(sql: string, params: unknown[] = []) {
    const client = await this.identity.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE maracuya_identity');
      const result = await client.query<T>(sql, params);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async apiAs<T>(userId: string, run: (client: PoolClient) => Promise<T>): Promise<T> {
    // The caller must derive userId exclusively from a validated JWT.
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(userId)) {
      throw new Error('Invalid authenticated user ID');
    }
    const client = await this.api.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE maracuya_api');
      await client.query("SELECT set_config('app.usuario_id', $1, true)", [userId]);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async onModuleDestroy() {
    await Promise.all([this.identity.end(), this.api.end()]);
  }
}
