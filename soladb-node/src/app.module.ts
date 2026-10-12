import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { SolanaModule } from './solana/solana.module';
import { StorageModule } from './storage/storage.module';
import { ReplicatorModule } from './replicator/replicator.module';
import { QueryModule } from './query/query.module';

@Module({
  imports: [
    // Load env vars and config factory globally
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
      envFilePath: ['.env'],
    }),
    SolanaModule,
    StorageModule,
    ReplicatorModule,
    QueryModule,
  ],
})
export class AppModule { }
