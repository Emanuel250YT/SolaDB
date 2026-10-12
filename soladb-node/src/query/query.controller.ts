import {
  Body,
  Controller,
  Get,
  Param,
  Post,
  Res,
  UsePipes,
  ValidationPipe,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Response } from 'express';
import { QueryService } from './query.service';
import { QueryDto } from './dto/query.dto';

/**
 * QueryController
 *
 * REST API for querying the SolaDB network from this replicator node.
 * Chunk ids are chunk account addresses (base58).
 *
 * Endpoints:
 *   GET  /status                    — node health, replicator account, scan stats
 *   POST /query                     — JSON query language (filter, sort, page)
 *   GET  /chunk/:chunkId/meta       — local metadata, else the on-chain Chunk account
 *   GET  /chunk/:chunkId/data       — raw binary data (served as octet-stream)
 */
@ApiTags('SolaDB')
@Controller()
export class QueryController {
  constructor(private readonly queryService: QueryService) { }

  // ── Node status ─────────────────────────────────────────────────────────────

  @Get('status')
  @ApiOperation({ summary: 'Node health, replicator account, balance and scan stats' })
  async getStatus() {
    return this.queryService.getNodeStatus();
  }

  // ── JSON query language ─────────────────────────────────────────────────────

  /**
   * Execute a structured JSON query against the local metadata store.
   *
   * Example body:
   * ```json
   * {
   *   "filter": { "owner": "7xKX…", "state": "Cool" },
   *   "orderBy": "uploadedAt",
   *   "order": "desc",
   *   "limit": 20,
   *   "offset": 0
   * }
   * ```
   */
  @Post('query')
  @HttpCode(HttpStatus.OK)
  @UsePipes(new ValidationPipe({ transform: true, whitelist: true }))
  @ApiOperation({ summary: 'JSON query for stored chunks' })
  @ApiResponse({ status: 200, description: 'Array of matching chunk records' })
  async query(@Body() dto: QueryDto) {
    const results = await this.queryService.query(dto);
    return { count: results.length, data: results };
  }

  // ── Chunk endpoints ─────────────────────────────────────────────────────────

  @Get('chunk/:chunkId/meta')
  @ApiOperation({ summary: 'Get metadata for a specific chunk' })
  @ApiParam({ name: 'chunkId', description: 'Chunk account address (base58)' })
  async getChunkMeta(@Param('chunkId') chunkId: string) {
    return this.queryService.getChunkMeta(chunkId);
  }

  @Get('chunk/:chunkId/data')
  @ApiOperation({ summary: 'Download raw binary chunk data' })
  @ApiParam({ name: 'chunkId', description: 'Chunk account address (base58)' })
  @ApiResponse({
    status: 200,
    description: 'Raw bytes as application/octet-stream',
  })
  @ApiResponse({ status: 404, description: 'This node does not store the chunk' })
  async getChunkData(
    @Param('chunkId') chunkId: string,
    @Res() res: Response,
  ): Promise<void> {
    const data = await this.queryService.getChunkData(chunkId);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${chunkId}.bin"`);
    res.setHeader('X-Chunk-Id', chunkId);
    res.setHeader('Content-Length', data.length);
    res.send(data);
  }
}
