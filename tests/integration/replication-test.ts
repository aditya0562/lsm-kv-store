import * as http from 'http';
import * as fs from 'fs/promises';
import { ChildProcess, spawn } from 'child_process';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const BACKUP = {
  httpPort: 4200,
  tcpPort: 4201,
  replicationPort: 4202,
  dataDir: './data-repl-backup',
};

const PRIMARY = {
  httpPort: 4300,
  tcpPort: 4301,
  dataDir: './data-repl-primary',
  backupHost: 'localhost',
  backupPort: BACKUP.replicationPort,
};

// ---------------------------------------------------------------------------
// Console Output
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  bold: '\x1b[1m',
};

function section(title: string) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`${C.bold}${C.cyan}  ${title}${C.reset}`);
  console.log('═'.repeat(60));
}

function pass(msg: string) { console.log(`${C.green}  ✅ ${msg}${C.reset}`); }
function fail(msg: string) { console.log(`${C.red}  ❌ ${msg}${C.reset}`); }
function info(msg: string) { console.log(`${C.blue}  ℹ  ${msg}${C.reset}`); }
function warn(msg: string) { console.log(`${C.yellow}  ⚠  ${msg}${C.reset}`); }

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

interface TestResult { name: string; passed: boolean; }

const results: TestResult[] = [];

function assert(condition: boolean, name: string): boolean {
  results.push({ name, passed: condition });
  condition ? pass(name) : fail(name);
  return condition;
}

// ---------------------------------------------------------------------------
// HTTP Helper
// ---------------------------------------------------------------------------

interface HTTPResponse {
  status: number;
  body: Record<string, unknown>;
}

function request(port: number, method: string, urlPath: string, body?: unknown): Promise<HTTPResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, `http://localhost:${port}`);
    const payload = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        hostname: 'localhost',
        port,
        path: url.pathname + url.search,
        method,
        headers: payload
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
          : undefined,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const raw = Buffer.concat(chunks).toString('utf8');
          try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
          catch { resolve({ status: res.statusCode ?? 0, body: { raw } }); }
        });
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function primaryReq(method: string, path: string, body?: unknown) {
  return request(PRIMARY.httpPort, method, path, body);
}

function backupReq(method: string, path: string, body?: unknown) {
  return request(BACKUP.httpPort, method, path, body);
}

// ---------------------------------------------------------------------------
// Process Management
// ---------------------------------------------------------------------------

const projectRoot = path.resolve(__dirname, '../..');
const entryPoint = path.join(projectRoot, 'src/index.ts');

function spawnServer(name: string, args: string[]): ChildProcess {
  const child = spawn(
    'npx',
    ['ts-node', entryPoint, ...args],
    { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  child.stdout?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.log(`  ${C.yellow}[${name}]${C.reset} ${line}`);
    }
  });

  child.stderr?.on('data', (data: Buffer) => {
    const lines = data.toString().trim().split('\n');
    for (const line of lines) {
      console.log(`  ${C.red}[${name} ERR]${C.reset} ${line}`);
    }
  });

  return child;
}

function killProcess(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (!child.pid || child.killed) {
      resolve();
      return;
    }

    child.on('exit', () => resolve());
    child.kill('SIGTERM');

    setTimeout(() => {
      if (!child.killed) {
        child.kill('SIGKILL');
      }
      resolve();
    }, 5000);
  });
}

async function waitForReady(port: number, label: string, timeoutMs = 15000): Promise<boolean> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      const res = await request(port, 'GET', '/health');
      if (res.status === 200) return true;
    } catch {
      // server not up yet
    }
    await sleep(300);
  }

  warn(`${label} did not become ready within ${timeoutMs}ms`);
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanData(): Promise<void> {
  await fs.rm(PRIMARY.dataDir, { recursive: true, force: true }).catch(() => {});
  await fs.rm(BACKUP.dataDir, { recursive: true, force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

async function testStartup(): Promise<boolean> {
  section('Startup — Both Servers');

  const backupReady = await waitForReady(BACKUP.httpPort, 'Backup');
  assert(backupReady, 'Backup server is ready');

  if (!backupReady) return false;

  info('Backup ready — now starting primary...');
  globalPrimaryProc = spawnServer('PRIMARY', primaryArgs());

  const primaryReady = await waitForReady(PRIMARY.httpPort, 'Primary');
  assert(primaryReady, 'Primary server is ready');

  if (!primaryReady) return false;

  await sleep(1000);
  return true;
}

async function testReplicationStatus(): Promise<void> {
  section('Replication Status');

  const primaryStatus = await primaryReq('GET', '/replication/status');
  assert(primaryStatus.status === 200, 'Primary /replication/status returns 200');
  assert(primaryStatus.body.enabled === true, 'Primary reports replication enabled');

  const state = primaryStatus.body.state as Record<string, unknown>;
  assert(state?.role === 'primary', 'Primary reports role: primary');
  assert(state?.connected === true, 'Primary reports connected: true');

  const backupStatus = await backupReq('GET', '/replication/status');
  assert(backupStatus.status === 200, 'Backup /replication/status returns 200');
  assert(backupStatus.body.enabled === true, 'Backup reports replication enabled');

  const backupState = backupStatus.body.state as Record<string, unknown>;
  assert(backupState?.role === 'backup', 'Backup reports role: backup');
}

async function testSingleKeyReplication(): Promise<void> {
  section('Single Key Replication');

  await primaryReq('POST', '/put', { key: 'repl:1', value: 'Hello from primary' });
  await sleep(200);

  const backupRes = await backupReq('GET', '/get/repl:1');
  assert(backupRes.status === 200, 'Key replicated to backup');
  assert(backupRes.body.value === 'Hello from primary', 'Backup has correct value');
}

async function testMultipleKeysReplication(): Promise<void> {
  section('Multiple Keys Replication');

  for (let i = 1; i <= 20; i++) {
    await primaryReq('POST', '/put', { key: `multi:${String(i).padStart(3, '0')}`, value: `V-${i}` });
  }

  await sleep(500);

  let allFound = true;
  for (let i = 1; i <= 20; i++) {
    const res = await backupReq('GET', `/get/multi:${String(i).padStart(3, '0')}`);
    if (res.status !== 200 || res.body.value !== `V-${i}`) {
      allFound = false;
      break;
    }
  }

  assert(allFound, 'All 20 keys replicated correctly to backup');
}

async function testDeleteReplication(): Promise<void> {
  section('Delete Replication');

  await primaryReq('POST', '/put', { key: 'del:target', value: 'to-be-deleted' });
  await sleep(200);

  const beforeDel = await backupReq('GET', '/get/del:target');
  assert(beforeDel.status === 200, 'Key exists on backup before delete');

  await primaryReq('DELETE', '/delete/del:target');
  await sleep(200);

  const afterDel = await backupReq('GET', '/get/del:target');
  assert(afterDel.status === 404, 'Key deleted on backup after primary delete');
}

async function testBatchReplication(): Promise<void> {
  section('Batch PUT Replication');

  const entries = Array.from({ length: 30 }, (_, i) => ({
    key: `batch-r:${String(i + 1).padStart(3, '0')}`,
    value: `BatchVal-${i + 1}`,
  }));

  await primaryReq('POST', '/batch-put', { entries });
  await sleep(500);

  const first = await backupReq('GET', '/get/batch-r:001');
  const last = await backupReq('GET', '/get/batch-r:030');
  assert(first.body.value === 'BatchVal-1', 'First batch entry replicated');
  assert(last.body.value === 'BatchVal-30', 'Last batch entry replicated');
}

async function testRangeConsistency(): Promise<void> {
  section('Range Query Consistency');

  const primaryRange = await primaryReq('GET', '/range?start=multi:001&end=multi:020');
  const backupRange = await backupReq('GET', '/range?start=multi:001&end=multi:020');

  const pResults = primaryRange.body.results as Array<{ key: string; value: string }>;
  const bResults = backupRange.body.results as Array<{ key: string; value: string }>;

  assert(pResults.length === bResults.length, `Range count matches: primary=${pResults.length} backup=${bResults.length}`);

  let allMatch = true;
  for (let i = 0; i < pResults.length; i++) {
    if (pResults[i]!.key !== bResults[i]!.key || pResults[i]!.value !== bResults[i]!.value) {
      allMatch = false;
      break;
    }
  }

  assert(allMatch, 'All range entries match between primary and backup');
}

async function testReconnection(): Promise<boolean> {
  section('Reconnection After Backup Restart');

  let backupProc: ChildProcess | null = null;

  info('Stopping backup...');
  backupProc = globalBackupProc;
  await killProcess(backupProc!);
  await sleep(1000);

  const statusDown = await primaryReq('GET', '/replication/status');
  const stateDown = statusDown.body.state as Record<string, unknown>;
  assert(stateDown?.connected === false, 'Primary detects backup is down');

  info('Restarting backup...');
  globalBackupProc = spawnServer('BACKUP', backupArgs());
  const backupReady = await waitForReady(BACKUP.httpPort, 'Backup (restarted)', 20000);
  assert(backupReady, 'Backup restarted successfully');

  if (!backupReady) return false;

  info('Waiting for primary to reconnect...');
  let reconnected = false;
  for (let attempt = 0; attempt < 20; attempt++) {
    await sleep(500);
    const statusUp = await primaryReq('GET', '/replication/status');
    const stateUp = statusUp.body.state as Record<string, unknown>;
    if (stateUp?.connected === true) {
      reconnected = true;
      break;
    }
  }

  assert(reconnected, 'Primary reconnected to backup');

  if (!reconnected) return false;

  await primaryReq('POST', '/put', { key: 'after-reconnect', value: 'post-restart' });
  await sleep(300);

  const res = await backupReq('GET', '/get/after-reconnect');
  assert(res.body.value === 'post-restart', 'Key written after reconnect is replicated');

  return true;
}

// ---------------------------------------------------------------------------
// Argument Builders
// ---------------------------------------------------------------------------

function backupArgs(): string[] {
  return [
    `--role=backup`,
    `--replication-port=${BACKUP.replicationPort}`,
    `--http-port=${BACKUP.httpPort}`,
    `--tcp-port=${BACKUP.tcpPort}`,
    `--data-dir=${BACKUP.dataDir}`,
    `--sync-policy=sync`,
  ];
}

function primaryArgs(): string[] {
  return [
    `--role=primary`,
    `--backup-host=${PRIMARY.backupHost}`,
    `--backup-port=${PRIMARY.backupPort}`,
    `--http-port=${PRIMARY.httpPort}`,
    `--tcp-port=${PRIMARY.tcpPort}`,
    `--data-dir=${PRIMARY.dataDir}`,
    `--sync-policy=sync`,
  ];
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

let globalBackupProc: ChildProcess;
let globalPrimaryProc: ChildProcess;

async function main(): Promise<void> {
  console.log(`\n${'█'.repeat(60)}`);
  console.log(`${C.bold}${C.cyan}  MONIEPOINT KV STORE — REPLICATION TESTS${C.reset}`);
  console.log('█'.repeat(60));

  await cleanData();

  info('Starting backup server...');
  globalBackupProc = spawnServer('BACKUP', backupArgs());

  try {
    const ready = await testStartup();
    if (!ready) {
      fail('Servers failed to start — aborting remaining tests');
      return;
    }

    await testReplicationStatus();
    await testSingleKeyReplication();
    await testMultipleKeysReplication();
    await testDeleteReplication();
    await testBatchReplication();
    await testRangeConsistency();
    await testReconnection();
  } catch (err) {
    fail(`Unexpected error: ${(err as Error).message}`);
    console.error(err);
  }

  section('Teardown');
  info('Stopping primary...');
  await killProcess(globalPrimaryProc);
  info('Stopping backup...');
  await killProcess(globalBackupProc);
  await cleanData();
  info('Cleanup complete');

  section('SUMMARY');
  let passed = 0;
  let failed = 0;
  for (const r of results) {
    r.passed ? passed++ : failed++;
  }
  console.log(`\n  Total: ${results.length}  |  ${C.green}Passed: ${passed}${C.reset}  |  ${C.red}Failed: ${failed}${C.reset}`);

  if (failed > 0) {
    console.log(`\n  ${C.red}Failed tests:${C.reset}`);
    for (const r of results) {
      if (!r.passed) fail(r.name);
    }
    process.exit(1);
  } else {
    console.log(`\n  ${'🎉'.repeat(15)}`);
    console.log(`  ${C.bold}${C.green}ALL REPLICATION TESTS PASSED${C.reset}`);
    console.log(`  ${'🎉'.repeat(15)}\n`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  killProcess(globalPrimaryProc).then(() => killProcess(globalBackupProc)).then(() => process.exit(1));
});
