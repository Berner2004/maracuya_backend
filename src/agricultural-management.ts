import { BadRequestException, ConflictException, Controller, ForbiddenException, Get, Injectable, NotFoundException, Param, Patch, Post, Body, Req, UseGuards } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { SessionGuard } from './auth';

const uuid = z.string().uuid();
const label = z.string().trim().min(1).max(120);
const optionalText = z.string().trim().max(500).nullable().optional();
const positiveDecimal = z.number().positive().finite().nullable().optional();
const codigo = z.string().trim().min(1).max(40).regex(/^[\p{L}\p{N}_.-]+$/u, 'Código: use letras, números, _, - o .');
const lotCreate = z.object({ codigo, nombre: label, ubicacion: optionalText, distancia_filas_m: positiveDecimal, distancia_plantas_m: positiveDecimal }).strict();
const lotPatch = lotCreate.partial().refine(v => Object.keys(v).length > 0, 'Sin campos para actualizar');
const plotCreate = z.object({ lote_id: uuid, codigo, nombre: label.nullable().optional() }).strict();
const plotPatch = z.object({ codigo, nombre: label.nullable() }).partial().strict().refine(v => Object.keys(v).length > 0, 'Sin campos para actualizar');
const rowCreate = z.object({ parcela_id: uuid, numero: z.number().int().positive().max(100000) }).strict();
const positionCreate = z.object({ fila_id: uuid, numero: z.number().int().positive().max(100000), codigo_croquis: z.string().trim().max(100).nullable().optional() }).strict();
const positionsBatchCreate = z.object({
  fila_id: uuid,
  desde_numero: z.number().int().positive().max(100000),
  hasta_numero: z.number().int().positive().max(100000),
  prefijo_croquis: z.string().trim().max(50).nullable().optional(),
}).strict().refine(v => v.hasta_numero >= v.desde_numero, {
  message: 'El número final debe ser mayor o igual al inicial',
  path: ['hasta_numero'],
}).refine(v => (v.hasta_numero - v.desde_numero + 1) <= 500, {
  message: 'No se pueden crear más de 500 posiciones por operación',
  path: ['hasta_numero'],
});
const userRequest = (r: Request & { userId?: string }): string => { if (!r.userId) throw new ForbiddenException('Sesión inválida'); return r.userId; };
function parse<T>(schema: z.ZodType<T>, raw: unknown): T {
  const result = schema.safeParse(raw);
  if (!result.success) throw new BadRequestException({ message: 'Datos inválidos', errors: result.error.flatten() });
  return result.data;
}
function parseId(id: string): string { return parse(uuid, id); }
function dbError(e: unknown): never {
  if (e instanceof BadRequestException || e instanceof ForbiddenException || e instanceof NotFoundException || e instanceof ConflictException) throw e;
  const code = (e as { code?: string })?.code;
  if (code === '23505') throw new ConflictException('Ya existe un registro con ese código o número dentro de su ámbito');
  if (code === '23503' || code === '23514' || code === '23502' || code === '22P02') throw new BadRequestException('Relación inexistente o datos incompatibles con las reglas de cultivo');
  if (code === '42501') throw new ForbiddenException('Operación denegada por PostgreSQL');
  throw e;
}

@Injectable()
export class AgriculturalManagementService {
  constructor(private readonly db: Db) {}
  private async scope(tx: PoolClient, projectId: string, write: boolean): Promise<void> {
    const result = await tx.query<{ role: string }>(
      `SELECT rol AS role FROM public.membresias
       WHERE proyecto_id=$1 AND usuario_id=public.usuario_actual_id() AND activo=true LIMIT 1`, [projectId]);
    if (!result.rows.length) throw new NotFoundException('Proyecto no encontrado o sin acceso');
    if (write && result.rows[0].role !== 'administrador') throw new ForbiddenException('Se requiere rol administrador');
  }
  private transact<T>(userId: string, projectId: string, write: boolean, callback: (tx: PoolClient) => Promise<T>) {
    const id = parseId(projectId);
    return this.db.apiAs(userId, async tx => {
      try { await this.scope(tx, id, write); return await callback(tx); }
      catch (e) { return dbError(e); }
    });
  }
  listLots(user: string, project: string) { return this.transact(user,project,false, async tx => (await tx.query('SELECT id,proyecto_id,codigo,nombre,ubicacion,distancia_filas_m,distancia_plantas_m FROM public.lotes WHERE proyecto_id=$1 ORDER BY codigo', [project])).rows); }
  createLot(user: string, project: string, raw: unknown) {
    const v = parse(lotCreate, raw);
    return this.transact(user,project,true, async tx => (await tx.query(
      `INSERT INTO public.lotes(proyecto_id,codigo,nombre,ubicacion,distancia_filas_m,distancia_plantas_m)
       VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [project,v.codigo,v.nombre,v.ubicacion ?? null,v.distancia_filas_m ?? null,v.distancia_plantas_m ?? null])).rows[0]);
  }
  updateLot(user: string, project: string, lot: string, raw: unknown) {
    const v = parse(lotPatch,raw); parseId(lot);
    return this.transact(user,project,true, async tx => {
      const keys = Object.keys(v) as (keyof typeof v)[];
      const result = await tx.query(`UPDATE public.lotes SET ${keys.map((k,i) => `"${k}"=$${i+3}`).join(', ')} WHERE proyecto_id=$1 AND id=$2 RETURNING *`, [project,lot,...keys.map(k=>v[k])]);
      if (!result.rows[0]) throw new NotFoundException('Lote no encontrado');
      return result.rows[0];
    });
  }
  listPlots(user:string,project:string,lot:string) { parseId(lot); return this.transact(user,project,false,async tx => {
    const r=await tx.query('SELECT id,proyecto_id,lote_id,codigo,nombre FROM public.parcelas WHERE proyecto_id=$1 AND lote_id=$2 ORDER BY codigo',[project,lot]); return r.rows;
  }); }
  createPlot(user:string,project:string,raw:unknown) { const v=parse(plotCreate,raw); return this.transact(user,project,true,async tx=> {
    const parent=await tx.query('SELECT 1 FROM public.lotes WHERE proyecto_id=$1 AND id=$2',[project,v.lote_id]);
    if(!parent.rowCount) throw new NotFoundException('Lote no encontrado en este proyecto');
    return (await tx.query('INSERT INTO public.parcelas(proyecto_id,lote_id,codigo,nombre) VALUES($1,$2,$3,$4) RETURNING *',[project,v.lote_id,v.codigo,v.nombre??null])).rows[0];
  }); }
  updatePlot(user:string,project:string,plot:string,raw:unknown) { const v=parse(plotPatch,raw); parseId(plot); return this.transact(user,project,true,async tx=>{
    const keys=Object.keys(v) as (keyof typeof v)[];
    const r=await tx.query(`UPDATE public.parcelas SET ${keys.map((k,i)=>`"${k}"=$${i+3}`).join(', ')} WHERE proyecto_id=$1 AND id=$2 RETURNING *`,[project,plot,...keys.map(k=>v[k])]);
    if(!r.rows[0]) throw new NotFoundException('Parcela no encontrada'); return r.rows[0];
  }); }
  listRows(user:string,project:string,plot:string) { parseId(plot); return this.transact(user,project,false,async tx => (await tx.query('SELECT id,proyecto_id,parcela_id,numero FROM public.filas_cultivo WHERE proyecto_id=$1 AND parcela_id=$2 ORDER BY numero',[project,plot])).rows); }
  createRow(user:string,project:string,raw:unknown) { const v=parse(rowCreate,raw); return this.transact(user,project,true,async tx=>{
    const parent=await tx.query('SELECT id FROM public.parcelas WHERE proyecto_id=$1 AND id=$2 FOR UPDATE',[project,v.parcela_id]);
    if(!parent.rowCount) throw new NotFoundException('Parcela no encontrada en este proyecto');
    const duplicate=await tx.query('SELECT 1 FROM public.filas_cultivo WHERE proyecto_id=$1 AND parcela_id=$2 AND numero=$3 LIMIT 1',[project,v.parcela_id,v.numero]);
    if(duplicate.rowCount) throw new ConflictException('Ya existe ese número de fila en la parcela');
    return (await tx.query('INSERT INTO public.filas_cultivo(proyecto_id,parcela_id,numero) VALUES($1,$2,$3) RETURNING *',[project,v.parcela_id,v.numero])).rows[0];
  }); }
  listPositions(user:string,project:string,row:string) { parseId(row); return this.transact(user,project,false,async tx => (await tx.query('SELECT id,proyecto_id,fila_id,numero,codigo_croquis FROM public.posiciones_croquis WHERE proyecto_id=$1 AND fila_id=$2 ORDER BY numero',[project,row])).rows); }
  createPosition(user:string,project:string,raw:unknown) { const v=parse(positionCreate,raw); return this.transact(user,project,true,async tx=>{
    const parent=await tx.query('SELECT id FROM public.filas_cultivo WHERE proyecto_id=$1 AND id=$2 FOR UPDATE',[project,v.fila_id]);
    if(!parent.rowCount) throw new NotFoundException('Fila no encontrada en este proyecto');
    const duplicate=await tx.query(
      `SELECT 1 FROM public.posiciones_croquis
       WHERE proyecto_id=$1 AND fila_id=$2
         AND (numero=$3 OR ($4::text IS NOT NULL AND codigo_croquis=$4))
       LIMIT 1`,
      [project,v.fila_id,v.numero,v.codigo_croquis??null],
    );
    if(duplicate.rowCount) throw new ConflictException('Ya existe ese número o código de croquis en la fila');
    return (await tx.query('INSERT INTO public.posiciones_croquis(proyecto_id,fila_id,numero,codigo_croquis) VALUES($1,$2,$3,$4) RETURNING *',[project,v.fila_id,v.numero,v.codigo_croquis??null])).rows[0];
  }); }
  createPositionsBatch(user:string,project:string,raw:unknown) {
    const v=parse(positionsBatchCreate,raw);
    return this.transact(user,project,true,async tx=>{
      const parent=await tx.query('SELECT id FROM public.filas_cultivo WHERE proyecto_id=$1 AND id=$2 FOR UPDATE',[project,v.fila_id]);
      if(!parent.rowCount) throw new NotFoundException('Fila no encontrada en este proyecto');
      const codes = v.prefijo_croquis
        ? Array.from({length: v.hasta_numero - v.desde_numero + 1}, (_, i) => `${v.prefijo_croquis}${v.desde_numero + i}`)
        : [];
      const conflicts = await tx.query(
        `SELECT 1 FROM public.posiciones_croquis
         WHERE proyecto_id=$1 AND fila_id=$2
           AND (numero BETWEEN $3 AND $4 OR codigo_croquis=ANY($5::text[]))
         LIMIT 1`,
        [project, v.fila_id, v.desde_numero, v.hasta_numero, codes],
      );
      if (conflicts.rowCount) {
        throw new ConflictException('El rango o los códigos de croquis ya existen en esta fila');
      }
      const placeholders: string[] = [];
      const values: (string | number | null)[] = [];
      let pIdx = 3;
      for (let num = v.desde_numero; num <= v.hasta_numero; num++) {
        const code = v.prefijo_croquis ? `${v.prefijo_croquis}${num}` : null;
        placeholders.push(`($1,$2,$${pIdx},$${pIdx + 1})`);
        values.push(num, code);
        pIdx += 2;
      }
      return (await tx.query(
        `INSERT INTO public.posiciones_croquis(proyecto_id,fila_id,numero,codigo_croquis)
         VALUES ${placeholders.join(',')}
         RETURNING *`,
        [project, v.fila_id, ...values]
      )).rows;
    });
  }
}

@Controller('proyectos/:id')
@UseGuards(SessionGuard)
export class AgriculturalManagementController {
  constructor(private readonly service: AgriculturalManagementService) {}
  // GET /proyectos/:id/lotes remains implemented by AgrarianController.
  @Post('lotes') createLot(@Req() req:Request&{userId?:string},@Param('id') id:string,@Body() body:unknown) { return this.service.createLot(userRequest(req),id,body); }
  @Patch('lotes/:lotId') patchLot(@Req() req:Request&{userId?:string},@Param('id') id:string,@Param('lotId') lot:string,@Body() body:unknown) { return this.service.updateLot(userRequest(req),id,lot,body); }
  @Get('lotes/:lotId/parcelas') plots(@Req() req:Request&{userId?:string},@Param('id') id:string,@Param('lotId') lot:string) { return this.service.listPlots(userRequest(req),id,lot); }
  @Post('parcelas') createPlot(@Req() req:Request&{userId?:string},@Param('id') id:string,@Body() body:unknown) { return this.service.createPlot(userRequest(req),id,body); }
  @Patch('parcelas/:plotId') patchPlot(@Req() req:Request&{userId?:string},@Param('id') id:string,@Param('plotId') plot:string,@Body() body:unknown) { return this.service.updatePlot(userRequest(req),id,plot,body); }
  @Get('parcelas/:plotId/filas') rows(@Req() req:Request&{userId?:string},@Param('id') id:string,@Param('plotId') plot:string) { return this.service.listRows(userRequest(req),id,plot); }
  @Post('filas') createRow(@Req() req:Request&{userId?:string},@Param('id') id:string,@Body() body:unknown) { return this.service.createRow(userRequest(req),id,body); }
  @Get('filas/:rowId/posiciones') positions(@Req() req:Request&{userId?:string},@Param('id') id:string,@Param('rowId') row:string) { return this.service.listPositions(userRequest(req),id,row); }
  @Post('posiciones') createPosition(@Req() req:Request&{userId?:string},@Param('id') id:string,@Body() body:unknown) { return this.service.createPosition(userRequest(req),id,body); }
  @Post('posiciones/rango') createPositionsBatch(@Req() req:Request&{userId?:string},@Param('id') id:string,@Body() body:unknown) { return this.service.createPositionsBatch(userRequest(req),id,body); }
}

