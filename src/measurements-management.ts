import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, Injectable, NotFoundException, Param, Post, Req, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { SessionGuard } from './auth';

const uuid = z.string().uuid();
const nonnegative = z.number().finite().nonnegative();
const count = z.number().int().nonnegative().max(2147483647);
const measurementFields = {
  altura_cm: nonnegative.nullable().optional(),
  diametro_tallo_mm: nonnegative.nullable().optional(),
  entrenudos: count.nullable().optional(),
  botones_florales: count.nullable().optional(),
  flores: count.nullable().optional(),
  frutos: count.nullable().optional(),
  clorofila: nonnegative.nullable().optional(),
} as const;
const fieldNames = Object.keys(measurementFields) as Array<keyof typeof measurementFields>;

const createSchema = z.object({
  cliente_registro_id: uuid,
  fecha_medicion: z.string().datetime({ offset: true }).optional(),
  ...measurementFields,
  observaciones: z.string().trim().max(4000).nullable().optional(),
}).strict().superRefine((input, ctx) => {
  if (!fieldNames.some(key => input[key] != null)) {
    ctx.addIssue({ code: 'custom', path: ['altura_cm'], message: 'Indica al menos una medición numérica' });
  }
  if (input.fecha_medicion && new Date(input.fecha_medicion).getTime() > Date.now() + 5 * 60_000) {
    ctx.addIssue({ code: 'custom', path: ['fecha_medicion'], message: 'La fecha no puede estar en el futuro' });
  }
});

type CreateMeasurement = z.output<typeof createSchema>;
type MeasurementRow = { id: string; cliente_registro_id: string; planta_id: string; capturado_por: string };

function validate<S extends z.ZodTypeAny>(schema: S, input: unknown): z.output<S> {
  const result = schema.safeParse(input);
  if (!result.success) {
    throw new BadRequestException({ message: 'Datos inválidos', errors: result.error.flatten() });
  }
  return result.data;
}

function requestUser(req: Request & { userId?: string }): string {
  if (!req.userId) throw new ForbiddenException('Identidad no verificada');
  return req.userId;
}

function databaseError(error: unknown): never {
  if (error instanceof BadRequestException || error instanceof ConflictException ||
      error instanceof ForbiddenException || error instanceof NotFoundException) throw error;
  const code = (error as { code?: string } | null)?.code;
  if (code === '23505') throw new ConflictException('Registro duplicado');
  if (code === '42501') throw new ForbiddenException('Acceso denegado por PostgreSQL');
  if (['23503','23514','23502','22P02','22007','22008','22003'].includes(code ?? '')) {
    throw new BadRequestException('Valores incompatibles con las restricciones de la base de datos');
  }
  throw error;
}

@Injectable()
export class MeasurementsManagementService {
  constructor(private readonly db: Db) {}

  private async access(tx: PoolClient, projectId: string, write: boolean) {
    const membership = await tx.query<{ rol: string }>(
      `SELECT rol FROM public.membresias
       WHERE proyecto_id=$1 AND usuario_id=public.usuario_actual_id() AND activo=true LIMIT 1`,
      [projectId],
    );
    if (!membership.rows[0]) throw new NotFoundException('Proyecto no encontrado o sin acceso');
    if (write && !['administrador', 'investigador', 'tecnico_campo'].includes(membership.rows[0].rol)) {
      throw new ForbiddenException('No tienes permiso para registrar mediciones');
    }
  }

  private async run<T>(userId: string, projectId: string, write: boolean, task: (tx: PoolClient) => Promise<T>): Promise<T> {
    const project = validate(uuid, projectId);
    return this.db.apiAs(userId, async tx => {
      try {
        await this.access(tx, project, write);
        return await task(tx);
      } catch (error) {
        return databaseError(error);
      }
    });
  }

  private async plantExists(tx: PoolClient, projectId: string, plantId: string) {
    const found = await tx.query<{ estado: string }>(
      `SELECT estado FROM public.plantas WHERE id=$1 AND proyecto_id=$2`, [plantId, projectId],
    );
    if (!found.rows[0]) throw new NotFoundException('Planta no encontrada');
    return found.rows[0];
  }

  list(userId: string, projectId: string, plantId: string) {
    const plant = validate(uuid, plantId);
    return this.run(userId, projectId, false, async tx => {
      await this.plantExists(tx, projectId, plant);
      const result = await tx.query(
        `SELECT m.id, m.proyecto_id, m.planta_id, m.capturado_por, m.fecha_medicion,
                m.altura_cm, m.diametro_tallo_mm, m.entrenudos, m.botones_florales,
                m.flores, m.frutos, m.clorofila, m.observaciones, m.cliente_registro_id, m.creado_en,
                u.nombre AS capturado_por_nombre
         FROM public.mediciones_campo m
         LEFT JOIN public.usuarios u ON u.id=m.capturado_por
         WHERE m.proyecto_id=$1 AND m.planta_id=$2
         ORDER BY m.fecha_medicion DESC, m.id DESC LIMIT 500`,
        [projectId, plant],
      );
      return result.rows;
    });
  }

  create(userId: string, projectId: string, plantId: string, body: unknown) {
    const plant = validate(uuid, plantId);
    const input: CreateMeasurement = validate(createSchema, body);
    return this.run(userId, projectId, true, async tx => {
      // Idempotency: same UUID and same plant/author returns original row.
      const previous = await tx.query<MeasurementRow>(
        `SELECT id, cliente_registro_id, planta_id, capturado_por FROM public.mediciones_campo
         WHERE proyecto_id=$1 AND cliente_registro_id=$2`,
        [projectId, input.cliente_registro_id],
      );
      if (previous.rows[0]) {
        const row = previous.rows[0];
        if (row.planta_id !== plant || row.capturado_por !== userId) {
          throw new ConflictException('cliente_registro_id ya se utilizó para otro registro');
        }
        const existing = await tx.query(
          `SELECT * FROM public.mediciones_campo WHERE proyecto_id=$1 AND id=$2`,
          [projectId, row.id],
        );
        return { medicion: existing.rows[0], repetida: true };
      }

      const plantRow = await this.plantExists(tx, projectId, plant);
      if (plantRow.estado !== 'activa') {
        throw new ConflictException('Solo se pueden registrar nuevas mediciones para plantas activas');
      }

      const recordedAt = input.fecha_medicion ?? new Date().toISOString();
      const result = await tx.query(
        `INSERT INTO public.mediciones_campo
         (proyecto_id, planta_id, capturado_por, fecha_medicion,
          altura_cm, diametro_tallo_mm, entrenudos, botones_florales,
          flores, frutos, clorofila, observaciones, cliente_registro_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
         ON CONFLICT (proyecto_id, cliente_registro_id) DO NOTHING
         RETURNING *`,
        [projectId, plant, userId, recordedAt,
         input.altura_cm ?? null, input.diametro_tallo_mm ?? null,
         input.entrenudos ?? null, input.botones_florales ?? null,
         input.flores ?? null, input.frutos ?? null, input.clorofila ?? null,
         input.observaciones ?? null, input.cliente_registro_id],
      );
      if (result.rows[0]) return { medicion: result.rows[0], repetida: false };
      // If a concurrent insert won, let the mobile client retry with the same UUID.
      throw new ConflictException('Registro concurrente detectado: vuelve a consultar antes de reintentar');
    });
  }
}

@Controller('proyectos/:id/plantas/:plantId/mediciones')
@UseGuards(SessionGuard)
export class MeasurementsManagementController {
  constructor(private readonly service: MeasurementsManagementService) {}

  @Get()
  list(@Req() req: Request & { userId?: string }, @Param('id') projectId: string, @Param('plantId') plantId: string) {
    return this.service.list(requestUser(req), projectId, plantId);
  }

  @Post()
  create(@Req() req: Request & { userId?: string }, @Param('id') projectId: string,
         @Param('plantId') plantId: string, @Body() body: unknown) {
    return this.service.create(requestUser(req), projectId, plantId, body);
  }
}
