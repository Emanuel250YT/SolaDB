import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { LogLevel, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { ReplicatorService } from './replicator/replicator.service';

const LOG_LEVELS: LogLevel[] = ['fatal', 'error', 'warn', 'log', 'debug', 'verbose'];

/** LOG_LEVEL=debug → every level up to debug */
function logLevels(): LogLevel[] {
  const wanted = (process.env.LOG_LEVEL ?? 'log').toLowerCase() as LogLevel;
  const index = LOG_LEVELS.indexOf(wanted);
  return LOG_LEVELS.slice(0, index < 0 ? LOG_LEVELS.indexOf('log') + 1 : index + 1);
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: logLevels() });
  const config = app.get(ConfigService);

  // Browsers (the SolaDB app, SDK users) download chunks straight from the node.
  // Chunks are ciphertext addressed by hash, so cross-origin reads are safe.
  const corsOrigin = config.get<string>('corsOrigin');
  app.enableCors({
    origin: corsOrigin ? corsOrigin.split(',').map((o) => o.trim()) : '*',
    exposedHeaders: ['X-Chunk-Id', 'Content-Length'],
  });

  // Global validation pipe
  app.useGlobalPipes(
    new ValidationPipe({ transform: true, whitelist: true }),
  );

  // Swagger / OpenAPI docs at /docs
  const swaggerConfig = new DocumentBuilder()
    .setTitle('SolaDB Node API')
    .setDescription(
      'REST API for querying and retrieving data from a SolaDB replicator node (Solana)',
    )
    .setVersion('2.0.0')
    .addTag('SolaDB')
    .build();
  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, document);

  // Graceful stop: finish the in-flight replications before the stores close
  // (Nest destroys the storage module before the replicator module)
  let closing = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, async () => {
      if (closing) return;
      closing = true;
      try {
        await app.get(ReplicatorService).stop();
        await app.close();
      } finally {
        process.exit(0);
      }
    });
  }

  const port = config.get<number>('port');
  await app.listen(port);
  console.log(`SolaDB node running on http://localhost:${port}`);
  console.log(`Swagger docs:         http://localhost:${port}/docs`);
}

bootstrap().catch((err) => {
  console.error('Fatal error during bootstrap:', err);
  process.exit(1);
});
