import { Module } from '@nestjs/common';
import { QueryController } from './query.controller';
import { QueryService } from './query.service';
import { StorageModule } from '../storage/storage.module';
import { SolanaModule } from '../solana/solana.module';
import { ReplicatorModule } from '../replicator/replicator.module';

@Module({
  imports: [StorageModule, SolanaModule, ReplicatorModule],
  controllers: [QueryController],
  providers: [QueryService],
})
export class QueryModule { }
