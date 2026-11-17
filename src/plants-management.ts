import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { SessionGuard } from './auth';
import { requireWitnessSchema, validateWitness } from './row-controls';

const uuid = z.string().uuid();
const code = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[\p{L}\p{N}_.-]+$/u, 'Código con caracteres no permitidos');

const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Fecha inválida');

const rawPlantInput = z
  .object({
    posicion_id: uuid,
    codigo: code,
    unidad_experimental_id: uuid.nullable().optional(),
    material_copa_id: uuid.nullable().optional(),
    portainjerto_id: uuid.nullable().optional(),
    tipo_propagacion: z.enum([
      'injertada',
      'pie_franco',
      'otra',
      'no_determinado',
    ]),
    es_testigo: z.boolean().default(false),
    fecha_plantacion: date.nullable().optional(),
    observaciones: z.string().trim().max(2000).nullable().optional(),
    croquis_referencia: z.string().trim().min(5).max(500).optional(),
    croquis_verificado: z.literal(true).optional(),
  })
  .strict();

function checkPropagation(
  v: { tipo_propagacion: string; portainjerto_id?: string | null },
  ctx: z.RefinementCtx,
) {
  if (v.tipo_propagacion === 'pie_franco' && v.portainjerto_id != null) {
    ctx.addIssue({
      code: 'custom',
      path: ['portainjerto_id'],
      message: 'Una planta de pie franco no lleva portainjerto',
    });
  }
}

const plantInput = rawPlantInput.superRefine(checkPropagation);
const assignUnitInput = z.object({ unidad_experimental_id: uuid.nullable() }).strict();

const replaceInput = rawPlantInput
  .omit({ posicion_id: true })
  .extend({
    observaciones_retiro: z.string().trim().max(2000).optional(),
    continuidad_testigo: z.enum(['continuar','pendiente']).optional(),
  })
  .strict()
  .superRefine(checkPropagation);

// Conservar el tipo de SALIDA de Zod: .default(false) devuelve boolean,
// aunque en la ENTRADA de la API se pueda omitir es_testigo.
function parsed<S extends z.ZodTypeAny>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new BadRequestException({
      message: 'Datos inválidos',
      errors: result.error.flatten(),
    });
  }
  return result.data;
}

function user(req: Request & { userId?: string }): string {
  if (!req.userId) throw new ForbiddenException('Identidad no verificada');
  return req.userId;
}

function failure(e: unknown): never {
  if (
    e instanceof BadRequestException ||
    e instanceof ForbiddenException ||
    e instanceof NotFoundException ||
    e instanceof ConflictException
  ) {
    throw e;
  }
  const errorCode = (e as { code?: string } | null)?.code;
  if (errorCode === '23505') {
    throw new ConflictException('Código de planta duplicado o posición ya ocupada');
  }
  if (['23503', '23514', '23502', '22P02', '22007', '22008'].includes(errorCode ?? '')) {
    throw new BadRequestException('Datos incompatibles con las restricciones agrícolas');
  }
  if (errorCode === '42501') {
    throw new ForbiddenException('Acceso denegado por PostgreSQL');
  }
  throw e;
}

type CreatePlant = z.output<typeof plantInput>;
type PlantReferences = Pick<
  CreatePlant,
  'unidad_experimental_id' | 'material_copa_id' | 'portainjerto_id'
>;

@Injectable()
export class PlantsManagementService {
  constructor(private readonly db: Db) {}

  private async permission(tx: PoolClient, projectId: string, write: boolean) {
    const membership = await tx.query<{ rol: string }>(
      `SELECT rol FROM public.membresias
       WHERE proyecto_id=$1
         AND usuario_id=public.usuario_actual_id()
         AND activo=true
       LIMIT 1`,
      [projectId],
    );
    if (!membership.rows.length) {
      throw new NotFoundException('Proyecto no encontrado o sin acceso');
    }
    if (write && membership.rows[0].rol !== 'administrador') {
      throw new ForbiddenException('Se requiere rol administrador');
    }
  }

  private run<T>(
    userId: string,
    projectId: string,
    write: boolean,
    fn: (tx: PoolClient) => Promise<T>,
  ): Promise<T> {
    const project = parsed(uuid, projectId);
    return this.db.apiAs(userId, async (tx) => {
      try {
        await this.permission(tx, project, write);
        return await fn(tx);
      } catch (e) {
        return failure(e);
      }
    });
  }

  private async validateRefs(
    tx: PoolClient,
    projectId: string,
    input: PlantReferences,
  ): Promise<void> {
    // Nombres de tablas constantes definidos por el servidor, nunca del usuario.
    const refs = [
      ['public.unidades_experimentales', input.unidad_experimental_id],
      ['public.materiales_vegetales', input.material_copa_id],
      ['public.materiales_vegetales', input.portainjerto_id],
    ] as const;

    for (const [table, id] of refs) {
      if (id) {
        const result = await tx.query(
          `SELECT 1 FROM ${table} WHERE id=$1 AND proyecto_id=$2`,
          [id, projectId],
        );
        if (!result.rowCount) {
          throw new BadRequestException('Una referencia no pertenece al proyecto');
        }
      }
    }
  }

  // La unidad experimental y la posición deben pertenecer a la misma parcela.
  private async validateUnitParcel(
    tx: PoolClient,
    projectId: string,
    positionId: string,
    unitId?: string | null,
  ): Promise<void> {
    if (!unitId) return;

    const match = await tx.query(
      `SELECT 1
       FROM public.unidades_experimentales ue
       JOIN public.posiciones_croquis pc
         ON pc.id=$3 AND pc.proyecto_id=ue.proyecto_id
       JOIN public.filas_cultivo fc
         ON fc.id=pc.fila_id AND fc.proyecto_id=ue.proyecto_id
       WHERE ue.id=$2 AND ue.proyecto_id=$1
         AND ue.parcela_id=fc.parcela_id
       LIMIT 1`,
      [projectId, unitId, positionId],
    );
    if (!match.rowCount) {
      throw new BadRequestException(
        'La unidad experimental debe pertenecer a la misma parcela que la planta',
      );
    }
  }

  list(userId: string, projectId: string, position?: string) {
    if (position !== undefined) parsed(uuid, position);
    return this.run(userId, projectId, false, async (tx) => {
      const result = await tx.query(
        `SELECT id, proyecto_id, posicion_id, codigo, unidad_experimental_id,
                material_copa_id, portainjerto_id, tipo_propagacion,
                es_testigo, estado, fecha_plantacion, fecha_retiro, observaciones
         FROM public.plantas
         WHERE proyecto_id=$1 AND ($2::uuid IS NULL OR posicion_id=$2::uuid)
         ORDER BY codigo`,
        [projectId, position ?? null],
      );
      return result.rows;
    });
  }

  get(userId: string, projectId: string, plantId: string) {
    parsed(uuid, plantId);
    return this.run(userId, projectId, false, async (tx) => {
      const result = await tx.query(
        'SELECT * FROM public.plantas WHERE proyecto_id=$1 AND id=$2',
        [projectId, plantId],
      );
      if (!result.rows[0]) throw new NotFoundException('Planta no encontrada');
      return result.rows[0];
    });
  }

  create(userId: string, projectId: string, raw: unknown) {
    const v = parsed(plantInput, raw);
    return this.run(userId, projectId, true, async (tx) => {
      if (v.es_testigo) {
        await requireWitnessSchema(tx);
        if (!v.croquis_verificado || !v.croquis_referencia) {
          throw new BadRequestException('Verifica el testigo contra el croquis original');
        }
      }
      await validateWitness(tx, projectId, v.posicion_id, v);
      // Bloqueo por posición para serializar altas concurrentes.
      const position = await tx.query(
        `SELECT id FROM public.posiciones_croquis
         WHERE proyecto_id=$1 AND id=$2 FOR UPDATE`,
        [projectId, v.posicion_id],
      );
      if (!position.rowCount) {
        throw new NotFoundException('Posición inexistente en el proyecto');
      }

      const occupied = await tx.query(
        `SELECT 1 FROM public.plantas
         WHERE proyecto_id=$1 AND posicion_id=$2 AND estado='activa'
         LIMIT 1`,
        [projectId, v.posicion_id],
      );
      if (occupied.rowCount) {
        throw new ConflictException('La posición ya tiene una planta activa');
      }
      await this.validateRefs(tx, projectId, v);
      await this.validateUnitParcel(tx, projectId, v.posicion_id, v.unidad_experimental_id);

      const result = await tx.query(
        `INSERT INTO public.plantas
           (proyecto_id, posicion_id, codigo, unidad_experimental_id,
            material_copa_id, portainjerto_id, tipo_propagacion,
            es_testigo, estado, fecha_plantacion, observaciones)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activa',$9,$10)
         RETURNING *`,
        [
          projectId,
          v.posicion_id,
          v.codigo,
          v.unidad_experimental_id ?? null,
          v.material_copa_id ?? null,
          v.portainjerto_id ?? null,
          v.tipo_propagacion,
          v.es_testigo,
          v.fecha_plantacion ?? null,
          v.observaciones ?? null,
        ],
      );
      if (v.es_testigo) {
        await tx.query(`INSERT INTO public.testigos_fila_eventos(proyecto_id,fila_id,planta_nueva_id,accion,referencia,usuario_id) SELECT $1,fila_id,$3,'asignacion',$4,$5 FROM public.posiciones_croquis WHERE id=$2 AND proyecto_id=$1`, [projectId,v.posicion_id,result.rows[0].id,v.croquis_referencia,userId]);
      }
      return result.rows[0];
    });
  }

  assignUnit(userId: string, projectId: string, plantId: string, raw: unknown) {
    const id = parsed(uuid, plantId);
    const input = parsed(assignUnitInput, raw);
    return this.run(userId, projectId, true, async (tx) => {
      const plant = await tx.query<{ posicion_id: string; estado: string; es_testigo:boolean; unidad_experimental_id: string | null }>(
        `SELECT posicion_id, estado, es_testigo, unidad_experimental_id
         FROM public.plantas WHERE proyecto_id=$1 AND id=$2 FOR UPDATE`,
        [projectId, id],
      );
      if (!plant.rows[0]) throw new NotFoundException('Planta no encontrada');
      if (plant.rows[0].estado !== 'activa') {
        throw new ConflictException('Solo se pueden modificar plantas activas');
      }
      if (plant.rows[0].es_testigo && input.unidad_experimental_id !== null) throw new BadRequestException('El testigo natural no puede recibir una unidad experimental');
      if (input.unidad_experimental_id !== null) {
        await this.validateUnitParcel(
          tx,
          projectId,
          plant.rows[0].posicion_id,
          input.unidad_experimental_id,
        );
      }
      const updated = await tx.query(
        `UPDATE public.plantas SET unidad_experimental_id=$3
         WHERE proyecto_id=$1 AND id=$2 RETURNING *`,
        [projectId, id, input.unidad_experimental_id],
      );
      return {
        planta: updated.rows[0],
        unidad_anterior_id: plant.rows[0].unidad_experimental_id,
        modificada: plant.rows[0].unidad_experimental_id !== input.unidad_experimental_id,
      };
    });
  }

  replace(userId: string, projectId: string, oldId: string, raw: unknown) {
    parsed(uuid, oldId);
    const v = parsed(replaceInput, raw);
    return this.run(userId, projectId, true, async (tx) => {
      const old = await tx.query<{
        posicion_id: string;
        estado: string;
        fecha_plantacion: string | null;
        es_testigo: boolean;
      }>(
        `SELECT posicion_id, estado, fecha_plantacion, es_testigo
         FROM public.plantas
         WHERE id=$1 AND proyecto_id=$2 FOR UPDATE`,
        [oldId, projectId],
      );
      if (!old.rows[0]) {
        throw new NotFoundException('Planta original no encontrada');
      }
      if (old.rows[0].estado !== 'activa') {
        throw new ConflictException('Solo se puede reemplazar una planta activa');
      }
      if (
        old.rows[0].fecha_plantacion &&
        new Date(old.rows[0].fecha_plantacion) > new Date()
      ) {
        throw new BadRequestException(
          'La fecha de plantación original es posterior a la fecha de retiro',
        );
      }

      if (old.rows[0].es_testigo || v.es_testigo) {
        await requireWitnessSchema(tx);
        if (!v.croquis_verificado || !v.croquis_referencia) throw new BadRequestException('Verifica la continuidad con el croquis original');
        if (old.rows[0].es_testigo && v.continuidad_testigo !== (v.es_testigo ? 'continuar' : 'pendiente')) throw new BadRequestException('Indica explícitamente continuar o dejar la fila pendiente de testigo');
      }
      await validateWitness(tx,projectId,old.rows[0].posicion_id,v,oldId);
      const positionId = old.rows[0].posicion_id;
      await tx.query(
        `SELECT id FROM public.posiciones_croquis
         WHERE id=$1 AND proyecto_id=$2 FOR UPDATE`,
        [positionId, projectId],
      );
      const activeCount = await tx.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM public.plantas
         WHERE proyecto_id=$1 AND posicion_id=$2 AND estado='activa'`,
        [projectId, positionId],
      );
      if (activeCount.rows[0].count !== '1') {
        throw new ConflictException('Ocupación de la posición inconsistente');
      }

      await this.validateRefs(tx, projectId, v);
      await this.validateUnitParcel(tx, projectId, positionId, v.unidad_experimental_id);
      const oldNotes = await tx.query<{ observaciones: string | null }>(
        `SELECT observaciones FROM public.plantas
         WHERE id=$1 AND proyecto_id=$2`,
        [oldId, projectId],
      );
      const note = [
        oldNotes.rows[0]?.observaciones,
        v.observaciones_retiro ? `Reemplazo: ${v.observaciones_retiro}` : null,
      ].filter(Boolean).join('\n') || null;

      await tx.query(
        `UPDATE public.plantas
         SET estado='reemplazada', fecha_retiro=CURRENT_DATE, observaciones=$3
         WHERE id=$1 AND proyecto_id=$2`,
        [oldId, projectId, note],
      );
      const added = await tx.query(
        `INSERT INTO public.plantas
           (proyecto_id, posicion_id, codigo, unidad_experimental_id,
            material_copa_id, portainjerto_id, tipo_propagacion,
            es_testigo, estado, fecha_plantacion, observaciones)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'activa',$9,$10)
         RETURNING *`,
        [
          projectId,
          positionId,
          v.codigo,
          v.unidad_experimental_id ?? null,
          v.material_copa_id ?? null,
          v.portainjerto_id ?? null,
          v.tipo_propagacion,
          v.es_testigo,
          v.fecha_plantacion ?? null,
          v.observaciones ?? null,
        ],
      );
      if (old.rows[0].es_testigo || v.es_testigo) {
        await tx.query(`INSERT INTO public.testigos_fila_eventos(proyecto_id,fila_id,planta_anterior_id,planta_nueva_id,accion,referencia,usuario_id) SELECT $1,fila_id,$3,$4,$5,$6,$7 FROM public.posiciones_croquis WHERE id=$2 AND proyecto_id=$1`,[projectId,positionId,old.rows[0].es_testigo ? oldId : null,added.rows[0].id,old.rows[0].es_testigo ? v.continuidad_testigo : 'asignacion',v.croquis_referencia,userId]);
      }
      return { reemplazada_id: oldId, nueva_planta: added.rows[0] };
    });
  }
}

@Controller('proyectos/:id/plantas')
@UseGuards(SessionGuard)
export class PlantsManagementController {
  constructor(private readonly service: PlantsManagementService) {}

  @Get()
  list(@Req() req: Request & { userId?: string }, @Param('id') id: string) {
    return this.service.list(user(req), id);
  }

  @Get(':plantId')
  get(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Param('plantId') plantId: string,
  ) {
    return this.service.get(user(req), id, plantId);
  }

  @Post()
  create(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    return this.service.create(user(req), id, body);
  }

  @Patch(':plantId/unidad-experimental')
  assignUnit(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Param('plantId') plantId: string,
    @Body() body: unknown,
  ) {
    return this.service.assignUnit(user(req), id, plantId, body);
  }

  @Post(':plantId/reemplazar')
  replace(
    @Req() req: Request & { userId?: string },
    @Param('id') id: string,
    @Param('plantId') plantId: string,
    @Body() body: unknown,
  ) {
    return this.service.replace(user(req), id, plantId, body);
  }
}
