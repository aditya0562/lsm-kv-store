import * as net from 'net';
import { LogEntry } from '../storage/wal/LogEntry';
import { IReplicationManager } from './IReplicationManager';
import { ReplicationState, ReplicationMetrics, ReplicationRole } from './ReplicationTypes';
import {
  ReplicationOpcode,
  ReplicationAckStatus,
  ReplicationProtocolSerializer,
  ReplicateAckMessage,
} from './ReplicationProtocol';

export interface ReplicationManagerConfig {
  readonly backupHost: string;
  readonly backupPort: number;
  readonly connectionTimeoutMs: number;
  readonly reconnectIntervalMs: number;
}

interface PendingReplication {
  readonly entry: LogEntry;
  readonly resolve: () => void;
  readonly reject: (err: Error) => void;
}

export class ReplicationManager implements IReplicationManager {
  private readonly config: ReplicationManagerConfig;

  private socket: net.Socket | null = null;
  private connected: boolean = false;
  private connecting: boolean = false;
  private buffer: Buffer = Buffer.alloc(0);

  private pendingAcks: PendingReplication[] = [];
  private lastReplicatedSequence: number = -1;
  private reconnectTimer: NodeJS.Timeout | null = null;

  private metrics: ReplicationMetrics = {
    entriesReplicated: 0,
    bytesReplicated: 0,
    failedAttempts: 0,
    lastSuccessTime: null,
    lastFailureTime: null,
  };

  constructor(config: ReplicationManagerConfig) {
    this.config = config;
  }

  public async connect(): Promise<void> {
    if (this.connected || this.connecting) {
      return;
    }

    this.connecting = true;

    try {
      await this.establishConnection();
    } finally {
      this.connecting = false;
    }
  }

  public async disconnect(): Promise<void> {
    this.stopReconnectTimer();
    this.rejectAllPending(new Error('Disconnecting'));

    if (!this.socket) {
      return;
    }

    return new Promise<void>((resolve) => {
      this.socket!.end(() => {
        this.socket = null;
        this.connected = false;
        resolve();
      });
    });
  }

  public replicate(entry: LogEntry): void {
    if (!this.connected || !this.socket) {
      this.scheduleReconnect();
      return;
    }

    const message = ReplicationProtocolSerializer.serializeReplicate(entry);

    const pending: PendingReplication = {
      entry,
      resolve: () => {
        this.lastReplicatedSequence = entry.sequenceId;
        this.updateMetricsSuccess(message.length);
      },
      reject: (err: Error) => {
        this.updateMetricsFailure();
        console.warn(`ReplicationManager: Failed to replicate entry ${entry.sequenceId}: ${err.message}`);
      },
    };

    this.pendingAcks.push(pending);

    const canWrite = this.socket.write(message);
    if (!canWrite) {
      this.socket.once('drain', () => {});
    }
  }

  public isConnected(): boolean {
    return this.connected;
  }

  public getState(): ReplicationState {
    return {
      role: ReplicationRole.PRIMARY,
      connected: this.connected,
      lastReplicatedSequence: this.lastReplicatedSequence,
      pendingEntries: this.pendingAcks.length,
      lagMs: this.calculateLag(),
    };
  }

  public getMetrics(): ReplicationMetrics {
    return { ...this.metrics };
  }

  private async establishConnection(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      this.socket.setTimeout(this.config.connectionTimeoutMs);

      this.socket.on('connect', () => {
        this.connected = true;
        console.log(`ReplicationManager: Connected to backup at ${this.config.backupHost}:${this.config.backupPort}`);
        resolve();
      });

      this.socket.on('data', (chunk: Buffer) => {
        this.handleData(chunk);
      });

      this.socket.on('error', (err: Error) => {
        this.handleConnectionError(err);
        if (!this.connected) {
          reject(err);
        }
      });

      this.socket.on('close', () => {
        this.handleConnectionClose();
      });

      this.socket.on('timeout', () => {
        this.socket?.destroy();
        this.handleConnectionError(new Error('Connection timeout'));
        if (!this.connected) {
          reject(new Error('Connection timeout'));
        }
      });

      this.socket.connect(this.config.backupPort, this.config.backupHost);
    });
  }

  private handleData(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);

    while (this.buffer.length >= 5) {
      const result = ReplicationProtocolSerializer.parseMessage(this.buffer);

      if (result === null) {
        break;
      }

      if (result.message.opcode === ReplicationOpcode.REPLICATE_ACK) {
        this.handleAck(result.message);
      }

      this.buffer = this.buffer.subarray(result.bytesConsumed);
    }
  }

  private handleAck(ack: ReplicateAckMessage): void {
    const pending = this.pendingAcks.shift();
    if (!pending) {
      return;
    }

    if (ack.status === ReplicationAckStatus.OK) {
      pending.resolve();
    } else {
      pending.reject(new Error(`Replication rejected for sequence ${ack.sequenceId}`));
    }
  }

  private handleConnectionError(err: Error): void {
    console.warn(`ReplicationManager: Connection error: ${err.message}`);
    this.updateMetricsFailure();
    this.connected = false;
    this.rejectAllPending(err);
    this.scheduleReconnect();
  }

  private handleConnectionClose(): void {
    if (this.connected) {
      console.warn('ReplicationManager: Connection closed unexpectedly');
      this.connected = false;
      this.rejectAllPending(new Error('Connection closed'));
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.connecting) {
      return;
    }

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;

      try {
        await this.connect();
      } catch (err) {
        console.warn(`ReplicationManager: Reconnect failed: ${(err as Error).message}`);
        this.scheduleReconnect();
      }
    }, this.config.reconnectIntervalMs);
  }

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingAcks) {
      pending.reject(err);
    }
    this.pendingAcks = [];
  }

  private updateMetricsSuccess(bytes: number): void {
    this.metrics = {
      ...this.metrics,
      entriesReplicated: this.metrics.entriesReplicated + 1,
      bytesReplicated: this.metrics.bytesReplicated + bytes,
      lastSuccessTime: Date.now(),
    };
  }

  private updateMetricsFailure(): void {
    this.metrics = {
      ...this.metrics,
      failedAttempts: this.metrics.failedAttempts + 1,
      lastFailureTime: Date.now(),
    };
  }

  private calculateLag(): number {
    if (this.pendingAcks.length === 0) {
      return 0;
    }

    const oldestPending = this.pendingAcks[0];
    if (!oldestPending) {
      return 0;
    }

    return Date.now() - oldestPending.entry.timestamp;
  }
}
