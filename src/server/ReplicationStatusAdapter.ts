import { IReplicationStatusProvider, ReplicationStatus } from './IReplicationStatusProvider';
import { IReplicationManager } from '../replication/IReplicationManager';
import { IReplicationServer } from '../replication/IReplicationServer';

export class ReplicationManagerStatusAdapter implements IReplicationStatusProvider {
  constructor(private readonly manager: IReplicationManager) {}

  public getReplicationStatus(): ReplicationStatus {
    return {
      state: this.manager.getState(),
      metrics: this.manager.getMetrics(),
    };
  }
}

export class ReplicationServerStatusAdapter implements IReplicationStatusProvider {
  constructor(private readonly server: IReplicationServer) {}

  public getReplicationStatus(): ReplicationStatus {
    return {
      state: this.server.getState(),
      metrics: this.server.getMetrics(),
    };
  }
}
