
import 'reflect-metadata';

import {
  Controller,
  Get,
  Logger,
  Module,
} from '@nestjs/common';

import {
  APP_GUARD,
  NestFactory,
} from '@nestjs/core';

import {
  ThrottlerGuard,
  ThrottlerModule,
} from '@nestjs/throttler';

import helmet from 'helmet';

import { Db } from './db';
import { RowControlsController, RowControlsService } from './row-controls';

import {
  AuthController,
  AuthService,
  SessionGuard,
} from './auth';

import {
  AgrarianController,
  AgrarianService,
} from './agrarian';

import {
  AgriculturalManagementController,
  AgriculturalManagementService,
} from './agricultural-management';

import {
  PlantsManagementController,
  PlantsManagementService,
} from './plants-management';

import {
  ExperimentalManagementController,
  ExperimentalManagementService,
} from './experimental-management';

import {
  MeasurementsManagementController,
  MeasurementsManagementService,
} from './measurements-management';

// ==========================================
// HEALTH CHECK
// ==========================================

@Controller()
class HealthController {
  @Get('health')
  health() {
    return {
      status: 'ok',
    };
  }
}

// ==========================================
// MÓDULO PRINCIPAL
// ==========================================

@Module({
  imports: [
    ThrottlerModule.forRoot([
      {
        ttl: 60_000,
        limit: 20,
      },
    ]),
  ],

  controllers: [
    RowControlsController,
    HealthController,
    AuthController,
    AgrarianController,
    AgriculturalManagementController,
    PlantsManagementController,
    ExperimentalManagementController,
    MeasurementsManagementController,
  ],

  providers: [
    RowControlsService,
    Db,
    AuthService,
    SessionGuard,
    AgrarianService,
    AgriculturalManagementService,
    PlantsManagementService,
    ExperimentalManagementService,
    MeasurementsManagementService,

    {
      provide: APP_GUARD,
      useClass: ThrottlerGuard,
    },
  ],
})
class AppModule {}

// ==========================================
// ARRANQUE DE NESTJS
// ==========================================

async function bootstrap(): Promise<void> {
  const logger = new Logger('MaracuyaBootstrap');

  const requiredVariables = [
    'DATABASE_API_URL',
    'DATABASE_IDENTITY_URL',
    'JWT_SECRET',
  ];

  for (const variable of requiredVariables) {
    if (!process.env[variable]) {
      throw new Error(
        `Variable de entorno requerida: ${variable}`,
      );
    }
  }

  const port = Number(process.env.PORT ?? 3001);

  if (
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  ) {
    throw new Error('PORT debe ser un puerto válido');
  }

  const app = await NestFactory.create(AppModule, {
    rawBody: false,
  });

  // Cabeceras de seguridad HTTP
  app.use(helmet());

  // Cierre ordenado de conexiones y servicios
  app.enableShutdownHooks();

  // Escuchar únicamente en localhost durante desarrollo
  await app.listen(port, '0.0.0.0');

  logger.log(
    `Maracuya API disponible en http://0.0.0.0:${port}`,
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Error al iniciar Maracuya API:', error);
  process.exitCode = 1;
});
