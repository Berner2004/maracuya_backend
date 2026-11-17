import { Controller, Get, Param, Req, UseGuards, Injectable } from '@nestjs/common';
import { Db } from './db';
import { SessionGuard } from './auth';
import type { Request } from 'express';

@Injectable()
export class AgrarianService {
  constructor(private readonly db: Db) {}
  me(userId: string) {
    return this.db.apiAs(userId, async tx => {
      const u = await tx.query('SELECT id,nombre,correo,superadmin,activo FROM public.usuarios WHERE id=$1', [userId]);
      if (!u.rows[0]?.activo) return null;
      const m = await tx.query('SELECT proyecto_id,rol,activo FROM public.membresias WHERE usuario_id=$1 AND activo=true', [userId]);
      return {user:u.rows[0], memberships:m.rows};
    });
  }
  projects(userId: string) { return this.db.apiAs(userId, async tx => (await tx.query('SELECT id,nombre,descripcion FROM public.proyectos ORDER BY nombre')).rows); }
  lotes(userId: string, proyectoId: string) { return this.db.apiAs(userId, async tx => (await tx.query('SELECT id,proyecto_id,codigo,nombre,ubicacion,distancia_filas_m,distancia_plantas_m FROM public.lotes WHERE proyecto_id=$1 ORDER BY codigo', [proyectoId])).rows); }
}
@Controller()
@UseGuards(SessionGuard)
export class AgrarianController {
  constructor(private readonly service: AgrarianService) {}
  @Get('me') me(@Req() r: Request & {userId:string}) { return this.service.me(r.userId); }
  @Get('proyectos') projects(@Req() r: Request & {userId:string}) { return this.service.projects(r.userId); }
  @Get('proyectos/:id/lotes') lots(@Req() r: Request & {userId:string}, @Param('id') id:string) { return this.service.lotes(r.userId,id); }
}
