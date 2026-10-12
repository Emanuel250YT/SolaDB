import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CHUNK_STORE } from './chunk-store';
import { METADATA_STORE } from './metadata-store';
import { RocksDBService } from './rocksdb.service';
import { FsChunkStore } from './fs-chunk-store.service';
import { OracleService } from './oracle.service';
import { FileMetadataService } from './file-metadata.service';
import { StorageService } from './storage.service';

/**
 * Drivers are picked from the environment:
 *   CHUNK_STORE    = rocksdb (default) | fs
 *   METADATA_STORE = oracle  (default) | file
 * Only the selected driver is instantiated (and its lifecycle hooks run).
 */
@Module({
  providers: [
    {
      provide: CHUNK_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('storage.chunkStore') === 'fs'
          ? new FsChunkStore(config)
          : new RocksDBService(config),
    },
    {
      provide: METADATA_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('storage.metadataStore') === 'file'
          ? new FileMetadataService(config)
          : new OracleService(config),
    },
    StorageService,
  ],
  exports: [StorageService],
})
export class StorageModule { }
