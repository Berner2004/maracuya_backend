import { BadRequestException, Body, ConflictException, Controller, Get, Injectable, NotFoundException, Param, Patch, Req, UseGuards, ForbiddenException, ServiceUnavailableException } from '@nestjs/common';
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { Db } from './db';
import { SessionGuard } from './auth';

export type WitnessPlant = {id:string; es_testigo:boolean; estado:string; tipo_propagacion:string; portainjerto_id:string|null; unidad_experimental_id:string|null; intervenida?:boolean};
export function naturalWitness(p: WitnessPlant): boolean {
  return p.es_testigo && p.tipo_propagacion === 'pie_franco' && !p.portainjerto_id && !p.unidad_experimental_id && !p.intervenida;
}
export function witnessStatus(plants: WitnessPlant[]) {
  const controls = plants.filter(p => p.es_testigo && p.estado === 'activa');
  return {estado: controls.length === 0 ? 'pendiente' : controls.length > 1 ? 'duplicado'
    : naturalWitness(controls[0]) ? 'asignado' : 'incompatible',
    testigo_id: controls.length === 1 ? controls[0].id : null, cantidad:controls.length};
}
export async function witnessSchemaReady(tx: PoolClient): Promise<boolean> {
  const installed = await tx.query(`SELECT count(*)=4 AND bool_and(tgenabled IN ('O','A'))
    AND to_regclass('public.testigos_fila_guardia') IS NOT NULL
    AND to_regclass('public.testigos_fila_eventos') IS NOT NULL AS ok
    FROM pg_trigger WHERE tgrelid='public.plantas'::regclass
    AND tgname IN ('plantas_testigo_fila_guard','plantas_testigo_fila_actual','testigo_continuidad_obligatoria','testigo_asignacion_verificada')`);
  return installed.rows[0]?.ok === true;
}
export async function requireWitnessSchema(tx: PoolClient) {
  if (!await witnessSchemaReady(tx)) {
    throw new ServiceUnavailableException('No se pudo confirmar la proteccion de testigos y su auditoria. Solicita una revision de integridad al administrador');
  }
}
export async function validateWitness(tx: PoolClient, project:string, position:string,
  input:{es_testigo:boolean;tipo_propagacion:string;portainjerto_id?:string|null;unidad_experimental_id?:string|null}, exclude?:string, plantId?:string) {
  const row = await tx.query(`SELECT f.id FROM public.filas_cultivo f JOIN public.posiciones_croquis pc ON pc.fila_id=f.id AND pc.proyecto_id=f.proyecto_id WHERE pc.id=$2 AND pc.proyecto_id=$1 FOR UPDATE OF f`,[project,position]);
  if (!row.rows[0]) throw new NotFoundException('Fila de la posición no encontrada');
  if (!input.es_testigo) return;
  if (input.tipo_propagacion !== 'pie_franco' || input.portainjerto_id || input.unidad_experimental_id) {
    throw new BadRequestException('El testigo natural debe ser de pie franco, sin portainjerto ni unidad experimental');
  }
  const interventions = await tx.query(
    `SELECT 1
     FROM public.actividades_agricolas a
     JOIN public.filas_cultivo f ON f.id=$2 AND f.proyecto_id=$1
     WHERE a.proyecto_id=$1 AND a.tipo='tratamiento_experimental'
       AND (a.planta_id=$3::uuid OR (a.planta_id IS NULL AND a.parcela_id=f.parcela_id))
     LIMIT 1`,
    [project,row.rows[0].id,plantId ?? null],
  );
  if (interventions.rowCount) throw new BadRequestException('Una planta con intervención experimental no puede ser testigo natural');
  const duplicates = await tx.query(`SELECT p.id FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.proyecto_id=$1 AND pc.fila_id=$2 AND p.es_testigo AND p.estado='activa' AND ($3::uuid IS NULL OR p.id<>$3)`,[project,row.rows[0].id,exclude ?? null]);
  if (duplicates.rowCount) throw new ConflictException('La fila ya tiene una planta testigo activa');
}

const assignment = z.object({planta_id:z.string().uuid(), croquis_referencia:z.string().trim().min(5).max(500), verificado:z.literal(true)}).strict();
@Injectable()
export class RowControlsService {
  constructor(private readonly db:Db) {}
  private run<T>(user:string, project:string, write:boolean, operation:(tx:PoolClient)=>Promise<T>) {
    if (!z.string().uuid().safeParse(project).success) throw new BadRequestException('Proyecto inválido');
    return this.db.apiAs(user,async tx=> {
      const m=await tx.query(`SELECT rol FROM public.membresias WHERE proyecto_id=$1 AND usuario_id=public.usuario_actual_id() AND activo`,[project]);
      if (!m.rows[0]) throw new NotFoundException('Proyecto no encontrado o sin acceso');
      if(write && m.rows[0].rol !== 'administrador') throw new ForbiddenException('Se requiere rol administrador');
      try {return await operation(tx);} catch(e) {
        if((e as {code?:string}).code==='23505') throw new ConflictException('La fila ya tiene testigo');
        if((e as {code?:string}).code==='23514') throw new BadRequestException('El testigo no cumple las reglas de integridad');
        throw e;
      }
    });
  }
  field(user:string, project:string) {
    return this.run(user,project,false, async tx=> {
      const lots=await tx.query(`SELECT * FROM public.lotes WHERE proyecto_id=$1 ORDER BY codigo`,[project]);
      const plots=await tx.query(`SELECT * FROM public.parcelas WHERE proyecto_id=$1 ORDER BY codigo`,[project]);
      const rows=await tx.query(`SELECT * FROM public.filas_cultivo WHERE proyecto_id=$1 ORDER BY numero`,[project]);
      const positions=await tx.query(`SELECT * FROM public.posiciones_croquis WHERE proyecto_id=$1 ORDER BY numero`,[project]);
      const plants=await tx.query(`SELECT p.*,pc.fila_id,pc.numero AS posicion_numero,f.parcela_id,pa.lote_id,
          mv.nombre material_nombre,pr.nombre portainjerto_nombre,ue.tratamiento_id,ue.repeticion,
          t.nombre tratamiento_nombre,t.codigo tratamiento_codigo,t.es_control,
          EXISTS(SELECT 1 FROM public.actividades_agricolas a WHERE a.proyecto_id=p.proyecto_id AND a.tipo='tratamiento_experimental' AND (a.planta_id=p.id OR (a.planta_id IS NULL AND a.parcela_id=f.parcela_id))) AS intervenida
        FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id
        JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=p.proyecto_id
        JOIN public.parcelas pa ON pa.id=f.parcela_id AND pa.proyecto_id=p.proyecto_id
        LEFT JOIN public.materiales_vegetales mv ON mv.id=p.material_copa_id AND mv.proyecto_id=p.proyecto_id
        LEFT JOIN public.materiales_vegetales pr ON pr.id=p.portainjerto_id AND pr.proyecto_id=p.proyecto_id
        LEFT JOIN public.unidades_experimentales ue ON ue.id=p.unidad_experimental_id AND ue.proyecto_id=p.proyecto_id
        LEFT JOIN public.tratamientos t ON t.id=ue.tratamiento_id AND t.proyecto_id=p.proyecto_id
        WHERE p.proyecto_id=$1 ORDER BY pc.numero,p.codigo`,[project]);
      const units=await tx.query(`SELECT ue.*,t.codigo tratamiento_codigo,t.es_control FROM public.unidades_experimentales ue JOIN public.tratamientos t ON t.id=ue.tratamiento_id AND t.proyecto_id=ue.proyecto_id WHERE ue.proyecto_id=$1 ORDER BY ue.codigo`,[project]);
      const treatments=await tx.query(`SELECT * FROM public.tratamientos WHERE proyecto_id=$1 ORDER BY codigo`,[project]);
      const materials=await tx.query(`SELECT * FROM public.materiales_vegetales WHERE proyecto_id=$1 ORDER BY codigo`,[project]);
      const integrity = await witnessSchemaReady(tx);
      return {integridad_testigos_activa:integrity,lotes:lots.rows,parcelas:plots.rows,filas:rows.rows.map(f=>({...f,testigo:witnessStatus(plants.rows.filter(p=>p.fila_id===f.id))})), posiciones:positions.rows,plantas:plants.rows,unidades:units.rows,tratamientos:treatments.rows,materiales:materials.rows,
        geometria:'Orden por numero de fila y posicion. Orientación física del Excel sin verificar.'};
    });
  }
  comparison(user:string, project:string, row:string) {
    if(!z.string().uuid().safeParse(row).success) throw new BadRequestException('Fila inválida');
    return this.run(user,project,false,async tx=> {
      const plants=await tx.query(`SELECT p.*, EXISTS(SELECT 1 FROM public.actividades_agricolas a JOIN public.filas_cultivo f ON f.id=pc.fila_id AND f.proyecto_id=pc.proyecto_id WHERE a.proyecto_id=p.proyecto_id AND a.tipo='tratamiento_experimental' AND (a.planta_id=p.id OR (a.planta_id IS NULL AND a.parcela_id=f.parcela_id))) AS intervenida FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.proyecto_id=$1 AND pc.fila_id=$2`,[project,row]);
      const status=witnessStatus(plants.rows);
      if(status.estado!=='asignado') throw new ConflictException('La fila necesita exactamente un testigo natural válido para comparar');
      const ids=plants.rows.filter(p=>p.id===status.testigo_id || (p.estado==='activa' && !p.es_testigo && p.unidad_experimental_id)).map(p=>p.id);
      const data=await tx.query(`SELECT * FROM (SELECT m.*,row_number() OVER(PARTITION BY planta_id ORDER BY fecha_medicion DESC,id DESC) AS orden FROM public.mediciones_campo m WHERE proyecto_id=$1 AND planta_id=ANY($2::uuid[])) v WHERE orden<=500 ORDER BY fecha_medicion DESC,id DESC`,[project,ids]);
      return {fila_id:row,testigo_id:status.testigo_id,plantas:plants.rows.filter(p=>ids.includes(p.id)),mediciones:data.rows,limite_por_planta:500,
        criterio:'Series observadas de la misma fila. Fechas independientes; no se imputan valores ni se infiere eficacia.'};
    });
  }
  history(user:string,project:string,row:string) {
    if(!z.string().uuid().safeParse(row).success) throw new BadRequestException('Fila inválida');
    return this.run(user,project,false,async tx=> {
      await requireWitnessSchema(tx);
      return (await tx.query(`SELECT * FROM public.testigos_fila_eventos WHERE proyecto_id=$1 AND fila_id=$2 ORDER BY creado_en DESC,id DESC LIMIT 500`,[project,row])).rows;
    });
  }
  assign(user:string, project:string, row:string, body:unknown) {
    const parsed=assignment.safeParse(body);
    if(!parsed.success || !z.string().uuid().safeParse(row).success) throw new BadRequestException('Confirma la planta y la referencia del croquis revisado');
    const v=parsed.data;
    return this.run(user,project,true,async tx=> {
      await requireWitnessSchema(tx);
      const lock=await tx.query(`SELECT id FROM public.filas_cultivo WHERE id=$2 AND proyecto_id=$1 FOR UPDATE`,[project,row]);
      if(!lock.rowCount) throw new NotFoundException('Fila no encontrada');
      const p=await tx.query(`SELECT p.* FROM public.plantas p JOIN public.posiciones_croquis pc ON pc.id=p.posicion_id AND pc.proyecto_id=p.proyecto_id WHERE p.id=$3 AND p.proyecto_id=$1 AND pc.fila_id=$2 FOR UPDATE OF p`,[project,row,v.planta_id]);
      if(!p.rows[0] || p.rows[0].estado!=='activa') throw new NotFoundException('La planta activa no pertenece a esta fila');
      await validateWitness(tx,project,p.rows[0].posicion_id,{...p.rows[0],es_testigo:true},v.planta_id,v.planta_id);
      // Una repeticion de la misma asignacion no constituye un nuevo evento.
      if (p.rows[0].es_testigo) return {planta_id:v.planta_id,fila_id:row,es_testigo:true};
      await tx.query(`UPDATE public.plantas SET es_testigo=true WHERE id=$2 AND proyecto_id=$1`,[project,v.planta_id]);
      await tx.query(`INSERT INTO public.testigos_fila_eventos(proyecto_id,fila_id,planta_nueva_id,accion,referencia,usuario_id) VALUES($1,$2,$3,'asignacion',$4,$5)`,[project,row,v.planta_id,v.croquis_referencia,user]);
      return {planta_id:v.planta_id,fila_id:row,es_testigo:true};
    });
  }
}
@Controller('proyectos/:id')
@UseGuards(SessionGuard)
export class RowControlsController {
  constructor(private readonly service:RowControlsService) {}
  @Get('campo') field(@Req() r:Request&{userId:string},@Param('id') p:string) {return this.service.field(r.userId,p);}
  @Get('filas/:rowId/comparacion') compare(@Req() r:Request&{userId:string},@Param('id') p:string,@Param('rowId') row:string) {return this.service.comparison(r.userId,p,row);}
  @Get('filas/:rowId/testigo/historial') history(@Req() r:Request&{userId:string},@Param('id') p:string,@Param('rowId') row:string) {return this.service.history(r.userId,p,row);}
  @Patch('filas/:rowId/testigo') assign(@Req() r:Request&{userId:string},@Param('id') p:string,@Param('rowId') row:string,@Body() body:unknown) {return this.service.assign(r.userId,p,row,body);}
}
