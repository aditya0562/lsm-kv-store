import { LSMStore, LSMStoreDependencies } from './storage/LSMStore';
import { HTTPServer } from './server/HTTPServer';
import { TCPServer } from './server/TCPServer';
import { IReplicationStatusProvider } from './server/IReplicationStatusProvider';
import { 
  ReplicationManagerStatusAdapter, 
  ReplicationServerStatusAdapter,
} from './server/ReplicationStatusAdapter';
import { StorageConfig } from './common/Config';
import { CLIParser } from './cli/CLIParser';
import { 
  ReplicationRole, 
  ReplicationConfig,
  DEFAULT_CONNECTION_TIMEOUT_MS,
  DEFAULT_RECONNECT_INTERVAL_MS,
} from './replication/ReplicationTypes';
import { ReplicationManager, ReplicationManagerConfig } from './replication/ReplicationManager';
import { ReplicationServer, ReplicationServerConfig } from './replication/ReplicationServer';
import { IReplicationManager } from './replication/IReplicationManager';
import { IReplicationServer } from './replication/IReplicationServer';

interface Application {
  store: LSMStore;
  httpServer: HTTPServer;
  tcpServer: TCPServer;
  replicationManager: IReplicationManager | undefined;
  replicationServer: IReplicationServer | undefined;
}

function createReplicationManagerConfig(config: ReplicationConfig): ReplicationManagerConfig {
  if (!config.backupHost || !config.backupPort) {
    throw new Error('PRIMARY role requires backupHost and backupPort');
  }
  return {
    backupHost: config.backupHost,
    backupPort: config.backupPort,
    connectionTimeoutMs: config.connectionTimeoutMs ?? DEFAULT_CONNECTION_TIMEOUT_MS,
    reconnectIntervalMs: config.reconnectIntervalMs ?? DEFAULT_RECONNECT_INTERVAL_MS,
  };
}

function createReplicationServerConfig(config: ReplicationConfig): ReplicationServerConfig {
  if (!config.replicationPort) {
    throw new Error('BACKUP role requires replicationPort');
  }
  return {
    port: config.replicationPort,
  };
}

function createApplication(config: StorageConfig): Application {
  const role = config.replication?.role ?? ReplicationRole.STANDALONE;
  
  let replicationManager: IReplicationManager | undefined;
  let replicationServer: IReplicationServer | undefined;
  let replicationStatusProvider: IReplicationStatusProvider | undefined;
  let dependencies: LSMStoreDependencies | undefined;

  if (role === ReplicationRole.PRIMARY && config.replication) {
    const managerConfig = createReplicationManagerConfig(config.replication);
    replicationManager = new ReplicationManager(managerConfig);
    replicationStatusProvider = new ReplicationManagerStatusAdapter(replicationManager);
    dependencies = {
      onWALEntryAppended: (entry) => replicationManager!.replicate(entry),
    };
  }

  const store = new LSMStore(config, dependencies);

  if (role === ReplicationRole.BACKUP && config.replication) {
    const serverConfig = createReplicationServerConfig(config.replication);
    replicationServer = new ReplicationServer(
      serverConfig,
      (entry) => store.applyReplicatedEntry(entry)
    );
    replicationStatusProvider = new ReplicationServerStatusAdapter(replicationServer);
  }

  const httpServer = new HTTPServer(store, config.httpPort, { replicationStatusProvider });
  const tcpServer = new TCPServer(store, { port: config.tcpPort });

  return { store, httpServer, tcpServer, replicationManager, replicationServer };
}

async function startApplication(app: Application, config: StorageConfig): Promise<void> {
  await app.store.initialize();

  if (app.replicationManager) {
    try {
      await app.replicationManager.connect();
    } catch {
      console.warn('Initial backup connection failed — will retry in background');
    }
  }

  if (app.replicationServer) {
    await app.replicationServer.start();
  }

  await app.httpServer.start();
  await app.tcpServer.start();

  printStartupInfo(config, app);
}

async function shutdownApplication(app: Application): Promise<void> {
  console.log('\nShutting down gracefully...');

  await app.tcpServer.stop();
  await app.httpServer.stop();

  if (app.replicationManager) {
    await app.replicationManager.disconnect();
  }

  if (app.replicationServer) {
    await app.replicationServer.stop();
  }

  await app.store.close();
  console.log('Shutdown complete');
}

function printStartupInfo(config: StorageConfig, app: Application): void {
  const role = config.replication?.role ?? ReplicationRole.STANDALONE;
  
  console.log('Moniepoint KV Store - Ready!');
  console.log(`  Mode: ${role.toUpperCase()}`);
  console.log(`  HTTP API: http://localhost:${config.httpPort}`);
  console.log(`  TCP Streaming: localhost:${config.tcpPort}`);

  if (role === ReplicationRole.PRIMARY && config.replication) {
    console.log(`  Replicating to: ${config.replication.backupHost}:${config.replication.backupPort}`);
  }

  if (role === ReplicationRole.BACKUP && config.replication) {
    console.log(`  Replication port: ${config.replication.replicationPort}`);
  }
}

async function main(): Promise<void> {
  const parser = new CLIParser();
  const options = parser.parse();

  if (options.help) {
    CLIParser.printHelp();
    return;
  }

  const app = createApplication(options.config);

  const shutdown = async (): Promise<void> => {
    await shutdownApplication(app);
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await startApplication(app, options.config);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
