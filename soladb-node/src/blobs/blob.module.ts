import { Module } from '@nestjs/common';
import { SolanaModule } from '../solana/solana.module';
import { StorageModule } from '../storage/storage.module';
import { BlobController } from './blob.controller';
import { BlobService } from './blob.service';

@Module({
  imports: [SolanaModule, StorageModule],
  providers: [BlobService],
  controllers: [BlobController],
  exports: [BlobService],
})
export class BlobModule {}
