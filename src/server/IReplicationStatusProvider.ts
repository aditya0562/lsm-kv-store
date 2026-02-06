import { ReplicationState, ReplicationMetrics } from '../replication/ReplicationTypes';

export interface ReplicationStatus {
  readonly state: ReplicationState;
  readonly metrics: ReplicationMetrics;
}

export interface IReplicationStatusProvider {
  getReplicationStatus(): ReplicationStatus;
}
