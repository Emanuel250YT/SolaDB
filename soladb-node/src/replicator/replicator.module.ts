import { Module } from '@nestjs/common';
import { SolanaModule } from '../solana/solana.module';
import { StorageModule } from '../storage/storage.module';
import { ReplicatorService } from './replicator.service';

@Module({
  imports: [SolanaModule, StorageModule],
  providers: [ReplicatorService],
  exports: [ReplicatorService],
})
export class ReplicatorModule { }
