import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Address, isAddress } from '@solana/kit';
import { StorageService } from '../storage/storage.service';
import { SolanaService } from '../solana/solana.service';
import { ReplicatorService } from '../replicator/replicator.service';
import { QueryDto } from './dto/query.dto';
import { chunkRecordFromAccount, ChunkRecord } from '../storage/metadata-store';

export type ChunkMeta = Omit<ChunkRecord, 'storedAt'> & {
  storedAt: Date | null;
  /** `local`: this node stores the chunk; `chain`: read from the Chunk account */
  source: 'local' | 'chain';
};

@Injectable()
export class QueryService {
  private readonly logger = new Logger(QueryService.name);

  constructor(
    private readonly storage: StorageService,
    private readonly solana: SolanaService,
    private readonly replicator: ReplicatorService,
    private readonly config: ConfigService,
  ) { }

  /**
   * JSON query — returns metadata records matching the filter.
   */
  async query(dto: QueryDto): Promise<ChunkRecord[]> {
    return this.storage.queryChunks({
      filter: dto.filter,
      orderBy: dto.orderBy,
      order: dto.order,
      limit: dto.limit,
      offset: dto.offset,
    });
  }

  /**
   * Retrieve raw chunk bytes from the local chunk store.  Readers verify them
   * against the content hash in their manifest.
   */
  async getChunkData(chunkId: string): Promise<Buffer> {
    this._assertChunkId(chunkId);
    const raw = await this.storage.getRawChunk(chunkId);
    if (!raw) {
      throw new NotFoundException(
        `Chunk ${chunkId} not found on this node. ` +
        `Query the network for a replicator that holds it.`,
      );
    }
    return raw;
  }

  /**
   * Get chunk metadata — tries the local store first, then the Chunk account.
   */
  async getChunkMeta(chunkId: string): Promise<ChunkMeta> {
    this._assertChunkId(chunkId);
    const local = await this.storage.getChunkMeta(chunkId);
    if (local) return { ...local, source: 'local' };

    // Fallback: read the Chunk account
    const onChain = await this.solana.getChunk(chunkId as Address, 'confirmed').catch(() => null);
    if (!onChain) {
      throw new NotFoundException(`Chunk ${chunkId} not found`);
    }
    return { ...chunkRecordFromAccount(chunkId, onChain.data), storedAt: null, source: 'chain' };
  }

  /**
   * Health/status of this replicator node.
   */
  async getNodeStatus(): Promise<Record<string, unknown>> {
    const [slot, balance, replicator, storedChunks] = await Promise.all([
      this.solana.getSlot(),
      this.solana.getBalance(),
      // fresher than the scan commitment; the scan decides confirmations itself
      this.solana.getReplicator('confirmed'),
      this.storage.countChunks(),
    ]);
    return {
      status: 'ok',
      ...this.solana.network,
      slot: Number(slot),
      replicatorAddress: this.solana.address,
      registered: replicator !== null,
      active: replicator?.active ?? false,
      // On-chain endpoint vs the one this node is configured with
      endpoint: replicator?.endpoint ?? null,
      nodeEndpoint: this.config.get<string>('replication.nodeEndpoint'),
      confirmations: replicator ? Number(replicator.confirmations) : 0,
      // lamport amounts as strings (JSON has no bigint)
      lamportsEarned: (replicator?.lamportsEarned ?? 0n).toString(),
      balanceLamports: balance.toString(),
      storage: { ...this.storage.drivers, chunks: storedChunks },
      scan: this.replicator.status,
    };
  }

  private _assertChunkId(chunkId: string): void {
    if (!isAddress(chunkId)) {
      throw new BadRequestException(`"${chunkId}" is not a chunk account address (base58)`);
    }
  }
}
