import { Body, Controller, Get, HttpException, HttpStatus, Injectable, Post, Req, UnauthorizedException, UseGuards, CanActivate, ExecutionContext } from '@nestjs/common';
import { Db } from './db';
import * as argon2 from 'argon2';
import { createHash, randomBytes } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import { z } from 'zod';
import type { Request } from 'express';

const loginSchema = z.object({ email: z.string().email().max(254), password: z.string().min(1).max(1024) });
const tokenSchema = z.object({ refreshToken: z.string().min(32).max(512) });
const dummyHashPromise = argon2.hash('dummy-password-that-does-not-match', { type: argon2.argon2id });
function tokenHash(t: string): Buffer { return createHash('sha256').update(t).digest(); }
function secret(): Uint8Array {
  const s = process.env.JWT_SECRET ?? '';
  if (s.length < 64) throw new Error('JWT_SECRET must have >=64 characters');
  return new TextEncoder().encode(s);
}

@Injectable()
export class AuthService {
  constructor(private readonly db: Db) {}
  async signAccess(userId: string): Promise<string> {
    return new SignJWT({ scope: 'user' }).setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId).setIssuer(process.env.JWT_ISSUER ?? 'maracuya-api')
      .setAudience(process.env.JWT_AUDIENCE ?? 'maracuya-mobile')
      .setIssuedAt().setExpirationTime('15m').sign(secret());
  }
  async verifyAccess(token: string): Promise<string> {
    try {
      const v = await jwtVerify(token, secret(), { algorithms: ['HS256'], issuer: process.env.JWT_ISSUER ?? 'maracuya-api', audience: process.env.JWT_AUDIENCE ?? 'maracuya-mobile' });
      if (!v.payload.sub || v.payload.scope !== 'user') throw new Error('bad token');
      return v.payload.sub;
    } catch { throw new UnauthorizedException('Sesión inválida o caducada'); }
  }
  async login(body: unknown) {
    const valid = loginSchema.safeParse(body);
    if (!valid.success) throw new HttpException('Credenciales inválidas', 400);
    const email = valid.data.email.toLowerCase();
    const res = await this.db.identityQuery<{id:string; activo:boolean; password_hash:string|null; bloqueado_hasta:Date|null}>(
      `SELECT u.id,u.activo,c.password_hash,c.bloqueado_hasta
       FROM public.usuarios u LEFT JOIN privado.credenciales_usuario c ON c.usuario_id=u.id
       WHERE lower(u.correo)=$1 LIMIT 1`, [email]);
    const user = res.rows[0];
    const usable = !!user?.password_hash && user.activo && (!user.bloqueado_hasta || user.bloqueado_hasta < new Date());
    const ok = await argon2.verify(usable ? user.password_hash! : await dummyHashPromise, valid.data.password).catch(() => false);
    if (!usable || !ok) {
      if (user?.password_hash && user.activo) {
        await this.db.identityQuery(`UPDATE privado.credenciales_usuario SET intentos_fallidos=intentos_fallidos+1,
          bloqueado_hasta=CASE WHEN intentos_fallidos+1>=5 THEN now()+interval '15 minutes' ELSE bloqueado_hasta END
          WHERE usuario_id=$1`, [user.id]);
      }
      throw new UnauthorizedException('Correo o contraseña incorrectos');
    }
    await this.db.identityQuery('UPDATE privado.credenciales_usuario SET intentos_fallidos=0,bloqueado_hasta=NULL WHERE usuario_id=$1', [user.id]);
    const refreshToken = randomBytes(48).toString('base64url');
    await this.db.identityQuery(`INSERT INTO privado.sesiones (usuario_id,refresh_token_hash,expira_en)
      VALUES ($1,$2,now()+interval '30 days')`,[user.id,tokenHash(refreshToken)]);
    return { accessToken: await this.signAccess(user.id), refreshToken, tokenType: 'Bearer', expiresIn: 900 };
  }
  async refresh(body: unknown) {
    const valid = tokenSchema.safeParse(body);
    if (!valid.success) throw new UnauthorizedException();
    // Atomic rotation: one use only; concurrent re-use returns unauthorized.
    const previous = tokenHash(valid.data.refreshToken);
    const replacement = randomBytes(48).toString('base64url');
    const res = await this.db.identityQuery<{usuario_id:string}>(`UPDATE privado.sesiones s SET refresh_token_hash=$2, ultima_actividad_en=now()
      FROM public.usuarios u WHERE s.refresh_token_hash=$1 AND s.usuario_id=u.id
      AND s.expira_en>now() AND s.revocada_en IS NULL AND u.activo
      RETURNING s.usuario_id`,[previous, tokenHash(replacement)]);
    if (res.rowCount !== 1) throw new UnauthorizedException('Sesión no válida');
    return {accessToken: await this.signAccess(res.rows[0].usuario_id), refreshToken: replacement, tokenType:'Bearer',expiresIn:900};
  }
  async logout(userId: string, body: unknown) {
    const valid = tokenSchema.safeParse(body);
    if (!valid.success) throw new HttpException('Solicitud incorrecta',400);
    await this.db.identityQuery(`UPDATE privado.sesiones SET revocada_en=now() WHERE usuario_id=$1 AND refresh_token_hash=$2 AND revocada_en IS NULL`, [userId, tokenHash(valid.data.refreshToken)]);
    return {ok:true};
  }
}
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}
  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<Request & { userId?: string }>();
    const h = req.headers.authorization ?? '';
    if (!h.startsWith('Bearer ')) throw new UnauthorizedException();
    req.userId = await this.auth.verifyAccess(h.slice(7));
    return true;
  }
}
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}
  @Post('login') login(@Body() body: unknown) { return this.auth.login(body); }
  @Post('refresh') refresh(@Body() body: unknown) { return this.auth.refresh(body); }
  @Post('logout') @UseGuards(SessionGuard)
  logout(@Req() req: Request & {userId:string}, @Body() body: unknown) { return this.auth.logout(req.userId,body); }
}
