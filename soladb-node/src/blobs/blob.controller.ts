import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  Param,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Address } from '@solana/kit';
import type { Response } from 'express';
import { isChunkId } from '../storage/chunk-store';
import { BlobService } from './blob.service';

function blobParam(value: string): Address {
  if (!isChunkId(value)) throw new BadRequestException('The blob must be a base58 account address');
  return value as Address;
}

function intParam(value: string | undefined, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(value ?? '0');
  if (!Number.isInteger(n) || n < 0 || n > max) throw new BadRequestException(`${name} must be an integer between 0 and ${max}`);
  return n;
}

/**
 * Erasure-coded blobs (docs/blob-protocol.md §7): uploaders push shards,
 * readers and other nodes fetch fragments with their Merkle proof.
 */
@ApiTags('SolaDB')
@Controller('blob')
export class BlobController {
  constructor(private readonly blobs: BlobService) {}

  @Get('status')
  @ApiOperation({ summary: 'Blob shards held, pushes, proofs, claims and challenges' })
  status() {
    return this.blobs.status;
  }

  @Put(':blob/shard/:index')
  @ApiOperation({ summary: 'Append shard bytes (resumable, raw application/octet-stream)' })
  async push(
    @Param('blob') blob: string,
    @Param('index') index: string,
    @Query('offset') offset: string | undefined,
    @Body() body: unknown,
    @Headers('x-soladb-shard-roots') roots: string | undefined,
    @Headers('x-soladb-fragment-size') fragmentSize: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ) {
    if (!Buffer.isBuffer(body) || body.length === 0) {
      throw new BadRequestException('Send the shard bytes as application/octet-stream');
    }
    const result = await this.blobs.acceptPush(blobParam(blob), intParam(index, 'index', 31), intParam(offset, 'offset'), body, {
      roots,
      fragmentSize,
    });
    res.status(result.status);
    const { status: _status, ...payload } = result;
    return payload;
  }

  @Get(':blob/info')
  @ApiOperation({ summary: 'Layout and shard roots of a blob this node holds a shard of' })
  info(@Param('blob') blob: string) {
    return this.blobs.info(blobParam(blob));
  }

  @Get(':blob/roots')
  @ApiOperation({ summary: 'Shard roots (hex), verifiable against the on-chain blob root' })
  async roots(@Param('blob') blob: string) {
    return (await this.blobs.info(blobParam(blob))).roots;
  }

  @Get(':blob/shard/:index/fragment/:stripe')
  @ApiOperation({ summary: 'One fragment of a shard; header X-SolaDB-Proof = its Merkle path to the shard root' })
  async fragment(
    @Param('blob') blob: string,
    @Param('index') index: string,
    @Param('stripe') stripe: string,
    @Res() res: Response,
  ) {
    const { data, proof } = await this.blobs.fragment(blobParam(blob), intParam(index, 'index', 31), intParam(stripe, 'stripe'));
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('X-SolaDB-Proof', proof.join(','));
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.end(data);
  }
}
