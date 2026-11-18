import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException,
  Get, Injectable, NotFoundException, Param, Post, Req, ServiceUnavailableException, UseGuards,
} from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { SessionGuard } from './auth';

const uuid = z.string().uuid();
const codigo = z.string().trim().min(1).max(80)
  .regex(/^[\p{L}\p{N}_.-]+$/u, 'El código solo admite letras, números, puntos, guiones y guiones bajos');
const nombre = z.string().trim().min(1).max(160);
const texto = z.string().trim().max(2000).nullable().optional();
const materialSchema = z.object({
  codigo,
  nombre,
  especie: z.string().trim().max(160).nullable().optional(),
  descripcion: texto,
}).strict();
const tratamientoSchema = z.object({
  codigo,
  nombre: nombre.nullable().optional(),
  descripcion: texto,
  es_control: z.boolean().optional(),
}).strict();
const unidadSchema = z.object({
  parcela_id: uuid,
  tratamiento_id: uuid,
  codigo,
  repeticion: z.string().trim().min(1).max(80).nullable().optional(),
}).strict();

const loteTratamientoSchema = z.object({
  tratamiento_id: uuid,
  codigo_local: codigo,
  referencia_validacion: z.string().trim().min(5).max(500),
}).strict();

function lotCatalogEnabled() {
  return process.env.TRATAMIENTOS_LOTE_ACTIVO === 'true';
}
function requireLotCatalog() {
  if (!lotCatalogEnabled()) {
    throw new ServiceUnavailableException('El cat\u00e1logo por lote no est\u00e1 habilitado');
  }
}

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  if (!r.success) {
    throw new BadRequestException({ message: 'Datos inválidos', errors: r.error.flatten() });
  }
  return r.data;
}
function authenticatedUser(req: Request & { userId?: string }): string {
  if (!req.userId) throw new ForbiddenException('Identidad no verificada');
  return req.userId;
}
function dbError(error: unknown): never {
  if (error instanceof BadRequestException || error instanceof ForbiddenException ||
      error instanceof NotFoundException || error instanceof ConflictException ||
      error instanceof ServiceUnavailableException) throw error;
  const pgCode = (error as {code?: string})?.code;
  if (pgCode === '42P01') throw new ServiceUnavailableException('Estructura experimental no disponible; revisa la activaci\u00f3n del cat\u00e1logo');
  if (pgCode === '23505') throw new ConflictException('Ya existe un c\u00f3digo o una correspondencia equivalente en este contexto');
  if (['23503','23514','23502','22P02'].includes(pgCode ?? '')) {
    throw new BadRequestException('Datos incompatibles con las restricciones experimentales');
  }
  if (pgCode === '42501') throw new ForbiddenException('Acceso denegado por PostgreSQL');
  throw error;
}

@Injectable()
export class ExperimentalManagementService {
  constructor(private readonly db: Db) {}

  private async authorize(tx: PoolClient, projectId: string, write: boolean) {
    const memberships = await tx.query<{ rol: string }>(
      `SELECT rol FROM public.membresias
       WHERE proyecto_id=$1 AND usuario_id=public.usuario_actual_id() AND activo=true
       LIMIT 1`, [projectId],
    );
    if (!memberships.rows.length) throw new NotFoundException('Proyecto no encontrado o sin acceso');
    if (write && memberships.rows[0].rol !== 'administrador') {
      throw new ForbiddenException('Se requiere rol administrador');
    }
  }

  private run<T>(userId: string, projectId: string, write: boolean,
    operation: (tx: PoolClient) => Promise<T>): Promise<T> {
    const id = parse(uuid, projectId);
    return this.db.apiAs(userId, async tx => {
      try {
        await this.authorize(tx, id, write);
        return await operation(tx);
      } catch (err) {
        return dbError(err);
      }
    });
  }

  listMaterials(userId: string, projectId: string) {
    return this.run(userId, projectId, false, async tx => (
      await tx.query(
        `SELECT id, proyecto_id, codigo, nombre, especie, descripcion
         FROM public.materiales_vegetales WHERE proyecto_id=$1 ORDER BY codigo`,
        [projectId],
      )
    ).rows);
  }

  createMaterial(userId: string, projectId: string, body: unknown) {
    const v = parse(materialSchema, body);
    return this.run(userId, projectId, true, async tx => (
      await tx.query(
        `INSERT INTO public.materiales_vegetales
           (proyecto_id, codigo, nombre, especie, descripcion)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, proyecto_id, codigo, nombre, especie, descripcion`,
        [projectId, v.codigo, v.nombre, v.especie ?? null, v.descripcion ?? null],
      )
    ).rows[0]);
  }

  listTreatments(userId: string, projectId: string) {
    return this.run(userId, projectId, false, async tx => (
      await tx.query(
        `SELECT id, proyecto_id, codigo, nombre, descripcion, es_control
         FROM public.tratamientos WHERE proyecto_id=$1 ORDER BY codigo`,
        [projectId],
      )
    ).rows);
  }

  createTreatment(userId: string, projectId: string, body: unknown) {
    const v = parse(tratamientoSchema, body);
    return this.run(userId, projectId, true, async tx => (
      await tx.query(
        `INSERT INTO public.tratamientos
           (proyecto_id, codigo, nombre, descripcion, es_control)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, proyecto_id, codigo, nombre, descripcion, es_control`,
        [projectId, v.codigo, v.nombre ?? null, v.descripcion ?? null, v.es_control ?? false],
      )
    ).rows[0]);
  }

  listLotTreatments(userId: string, projectId: string, lotId: string) {
    const lot = parse(uuid, lotId);
    return this.run(userId, projectId, false, async tx => {
      requireLotCatalog();
      const parent = await tx.query('SELECT id FROM public.lotes WHERE id=$1 AND proyecto_id=$2', [lot, projectId]);
      if (!parent.rowCount) throw new NotFoundException('Lote inexistente en el proyecto');
      return (await tx.query(
        `SELECT tl.id,tl.proyecto_id,tl.lote_id,tl.tratamiento_id,tl.codigo_local,
                tl.referencia_validacion,tl.creado_por,tl.creado_en,
                t.codigo AS tratamiento_codigo,t.nombre,t.descripcion,t.es_control
         FROM public.tratamientos_lote tl
         JOIN public.tratamientos t ON t.id=tl.tratamiento_id AND t.proyecto_id=tl.proyecto_id
         WHERE tl.proyecto_id=$1 AND tl.lote_id=$2 ORDER BY tl.codigo_normalizado,tl.id`,
        [projectId, lot],
      )).rows;
    });
  }

  createLotTreatment(userId: string, projectId: string, lotId: string, body: unknown) {
    const lot = parse(uuid, lotId);
    const v = parse(loteTratamientoSchema, body);
    return this.run(userId, projectId, true, async tx => {
      requireLotCatalog();
      const parents = await tx.query(
        `SELECT
          EXISTS (SELECT 1 FROM public.lotes WHERE id=$2 AND proyecto_id=$1) AS lote,
          EXISTS (SELECT 1 FROM public.tratamientos WHERE id=$3 AND proyecto_id=$1) AS tratamiento`,
        [projectId, lot, v.tratamiento_id],
      );
      if (!parents.rows[0]?.lote) throw new NotFoundException('Lote inexistente en el proyecto');
      if (!parents.rows[0]?.tratamiento) throw new NotFoundException('Tratamiento inexistente en el proyecto');
      // PostgreSQL resolves case-insensitive uniqueness, author and capture time.
      return (await tx.query(
        `INSERT INTO public.tratamientos_lote
          (proyecto_id,lote_id,tratamiento_id,codigo_local,referencia_validacion)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id,proyecto_id,lote_id,tratamiento_id,codigo_local,
                   referencia_validacion,creado_por,creado_en`,
        [projectId, lot, v.tratamiento_id, v.codigo_local, v.referencia_validacion],
      )).rows[0];
    });
  }

  listUnits(userId: string, projectId: string) {
    return this.run(userId, projectId, false, async tx => {
      const scoped = lotCatalogEnabled();
      return (await tx.query(
        `SELECT ue.id, ue.proyecto_id, ue.parcela_id, ue.tratamiento_id,
                ue.codigo, ue.repeticion,
                p.codigo AS parcela_codigo, t.codigo AS tratamiento_codigo
                ${scoped ? ', p.lote_id, tl.id AS tratamiento_lote_id, tl.codigo_local, (tl.id IS NOT NULL) AS correspondencia_validada' : ''}
         FROM public.unidades_experimentales ue
         JOIN public.parcelas p ON p.id=ue.parcela_id AND p.proyecto_id=ue.proyecto_id
         JOIN public.tratamientos t ON t.id=ue.tratamiento_id AND t.proyecto_id=ue.proyecto_id
         ${scoped ? `LEFT JOIN public.tratamientos_lote tl ON tl.proyecto_id=ue.proyecto_id
                     AND tl.lote_id=p.lote_id AND tl.tratamiento_id=ue.tratamiento_id` : ''}
         WHERE ue.proyecto_id=$1 ORDER BY ue.codigo`,
        [projectId],
      )).rows;
    });
  }

  createUnit(userId: string, projectId: string, body: unknown) {
    const v = parse(unidadSchema, body);
    return this.run(userId, projectId, true, async tx => {
      const parents = await tx.query(
        `SELECT
          EXISTS (SELECT 1 FROM public.parcelas WHERE id=$2 AND proyecto_id=$1) AS parcela,
          EXISTS (SELECT 1 FROM public.tratamientos WHERE id=$3 AND proyecto_id=$1) AS tratamiento`,
        [projectId, v.parcela_id, v.tratamiento_id],
      );
      if (!parents.rows[0]?.parcela) throw new NotFoundException('Parcela inexistente en el proyecto');
      if (!parents.rows[0]?.tratamiento) throw new NotFoundException('Tratamiento inexistente en el proyecto');
      if (lotCatalogEnabled()) {
        const mapping = await tx.query(
          `SELECT tl.id FROM public.tratamientos_lote tl
           JOIN public.parcelas p ON p.proyecto_id=tl.proyecto_id AND p.lote_id=tl.lote_id
           WHERE tl.proyecto_id=$1 AND p.id=$2 AND tl.tratamiento_id=$3`,
          [projectId, v.parcela_id, v.tratamiento_id],
        );
        if (!mapping.rowCount) {
          throw new BadRequestException('El tratamiento no tiene correspondencia revisada para el lote de la parcela');
        }
      }
      const duplicate = await tx.query(
        `SELECT id FROM public.unidades_experimentales
         WHERE proyecto_id=$1 AND parcela_id=$2 AND tratamiento_id=$3
           AND repeticion IS NOT DISTINCT FROM $4::text LIMIT 1`,
        [projectId, v.parcela_id, v.tratamiento_id, v.repeticion ?? null],
      );
      if (duplicate.rowCount) throw new ConflictException('Ya existe la combinación de parcela, tratamiento y repetición');
      return (await tx.query(
        `INSERT INTO public.unidades_experimentales
           (proyecto_id, parcela_id, tratamiento_id, codigo, repeticion)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING id, proyecto_id, parcela_id, tratamiento_id, codigo, repeticion`,
        [projectId, v.parcela_id, v.tratamiento_id, v.codigo, v.repeticion ?? null],
      )).rows[0];
    });
  }
}

@Controller('proyectos/:id')
@UseGuards(SessionGuard)
export class ExperimentalManagementController {
  constructor(private readonly service: ExperimentalManagementService) {}

  @Get('materiales')
  listMaterials(@Req() req: Request & {userId?: string}, @Param('id') id: string) {
    return this.service.listMaterials(authenticatedUser(req), id);
  }

  @Post('materiales')
  createMaterial(@Req() req: Request & {userId?: string}, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createMaterial(authenticatedUser(req), id, body);
  }

  @Get('tratamientos')
  listTreatments(@Req() req: Request & {userId?: string}, @Param('id') id: string) {
    return this.service.listTreatments(authenticatedUser(req), id);
  }

  @Post('tratamientos')
  createTreatment(@Req() req: Request & {userId?: string}, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createTreatment(authenticatedUser(req), id, body);
  }

  @Get('lotes/:lotId/tratamientos')
  listLotTreatments(@Req() req: Request & {userId?: string}, @Param('id') id: string, @Param('lotId') lot: string) {
    return this.service.listLotTreatments(authenticatedUser(req), id, lot);
  }

  @Post('lotes/:lotId/tratamientos')
  createLotTreatment(@Req() req: Request & {userId?: string}, @Param('id') id: string, @Param('lotId') lot: string, @Body() body: unknown) {
    return this.service.createLotTreatment(authenticatedUser(req), id, lot, body);
  }

  @Get('unidades-experimentales')
  listUnits(@Req() req: Request & {userId?: string}, @Param('id') id: string) {
    return this.service.listUnits(authenticatedUser(req), id);
  }

  @Post('unidades-experimentales')
  createUnit(@Req() req: Request & {userId?: string}, @Param('id') id: string, @Body() body: unknown) {
    return this.service.createUnit(authenticatedUser(req), id, body);
  }
}
