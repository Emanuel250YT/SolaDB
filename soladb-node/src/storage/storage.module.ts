import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BLOB_STORE } from './blob-store';
import { CHUNK_STORE } from './chunk-store';
import { METADATA_STORE } from './metadata-store';
import { RocksDBService } from './rocksdb.service';
import { FsChunkStore } from './fs-chunk-store.service';
import { S3ChunkStore } from './s3-chunk-store.service';
import { FsBlobStore } from './fs-blob-store.service';
import { S3BlobStore } from './s3-blob-store.service';
import { OracleService } from './oracle.service';
import { PostgresMetadataService } from './postgres-metadata.service';
import { FileMetadataService } from './file-metadata.service';
import { StorageService } from './storage.service';

/**
 * Drivers are picked from the environment:
 *   CHUNK_STORE    = rocksdb (default) | fs | s3
 *   METADATA_STORE = oracle  (default) | postgres | file
 *   BLOB_STORE     = fs | s3 (default: s3 with CHUNK_STORE=s3, fs otherwise)
 * Only the selected driver is instantiated (and its lifecycle hooks run).
 * BLOB_STORE is exported for modules that serve blob shards; everything else
 * goes through StorageService.
 */
@Module({
  providers: [
    {
      provide: CHUNK_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        switch (config.get<string>('storage.chunkStore')) {
          case 'fs':
            return new FsChunkStore(config);
          case 's3':
            return new S3ChunkStore(config);
          default:
            return new RocksDBService(config);
        }
      },
    },
    {
      provide: METADATA_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => {
        switch (config.get<string>('storage.metadataStore')) {
          case 'file':
            return new FileMetadataService(config);
          case 'postgres':
            return new PostgresMetadataService(config);
          default:
            return new OracleService(config);
        }
      },
    },
    {
      provide: BLOB_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('storage.blobStore') === 's3' ? new S3BlobStore(config) : new FsBlobStore(config),
    },
    StorageService,
  ],
  exports: [StorageService, BLOB_STORE],
})
export class StorageModule { }
