import * as http from 'http';
import * as fs from 'fs/promises';
import { LSMStore } from '../../src/storage/LSMStore';
import { HTTPServer } from '../../src/server/HTTPServer';
import { TCPServer } from '../../src/server/TCPServer';
import { TCPClient } from '../../src/server/TCPClient';
import { StorageConfig, SyncPolicy, DEFAULT_CONFIG } from '../../src/common/Config';

const TEST_CONFIG: StorageConfig = {
  ...DEFAULT_CONFIG,
  dataDir: './data-integration-test',
  memTableSizeLimit: 100 * 1024,
  syncPolicy: SyncPolicy.SYNC_EVERY_WRITE,
  httpPort: 4100,
  tcpPort: 4101,
  enableCompaction: false,
};

const BASE_URL = `http://localhost:${TEST_CONFIG.httpPort}`;

// ---------------------------------------------------------------------------
// Console Output
// ---------------------------------------------------------------------------

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
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

// ---------------------------------------------------------------------------
// HTTP Helper
// ---------------------------------------------------------------------------

interface HTTPResponse {
  status: number;
  body: Record<string, unknown>;
}

function request(method: string, path: string, body?: unknown): Promise<HTTPResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const payload = body ? JSON.stringify(body) : undefined;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
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
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: { raw } });
          }
        });
      },
    );

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Test Runner
// ---------------------------------------------------------------------------

interface TestResult {
  name: string;
  passed: boolean;
}

const results: TestResult[] = [];

function assert(condition: boolean, name: string): boolean {
  results.push({ name, passed: condition });
  condition ? pass(name) : fail(name);
  return condition;
}

// ---------------------------------------------------------------------------
// Server Lifecycle
// ---------------------------------------------------------------------------

let store: LSMStore;
let httpServer: HTTPServer;
let tcpServer: TCPServer;

async function startServer(): Promise<void> {
  store = new LSMStore(TEST_CONFIG);
  await store.initialize();
  httpServer = new HTTPServer(store, TEST_CONFIG.httpPort);
  tcpServer = new TCPServer(store, { port: TEST_CONFIG.tcpPort });
  await httpServer.start();
  await tcpServer.start();
}

async function stopServer(): Promise<void> {
  await tcpServer.stop();
  await httpServer.stop();
  await store.close();
}

async function cleanData(): Promise<void> {
  await fs.rm(TEST_CONFIG.dataDir, { recursive: true, force: true }).catch(() => {});
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// HTTP API Tests
// ---------------------------------------------------------------------------

async function testHealthCheck(): Promise<void> {
  section('Health Check');
  const res = await request('GET', '/health');
  assert(res.status === 200, 'GET /health returns 200');
  assert(res.body.status === 'ok', 'Response contains status: ok');
}

async function testPutAndGet(): Promise<void> {
  section('PUT & GET');

  const putRes = await request('POST', '/put', { key: 'user:1', value: 'Alice' });
  assert(putRes.status === 200, 'PUT user:1=Alice returns 200');
  assert(putRes.body.success === true, 'PUT response has success: true');

  const getRes = await request('GET', '/get/user:1');
  assert(getRes.status === 200, 'GET user:1 returns 200');
  assert(getRes.body.value === 'Alice', 'GET user:1 returns Alice');

  const missingRes = await request('GET', '/get/nonexistent');
  assert(missingRes.status === 404, 'GET nonexistent key returns 404');
}

async function testUpdate(): Promise<void> {
  section('UPDATE (overwrite existing key)');

  await request('POST', '/put', { key: 'user:1', value: 'Alice Updated' });
  const res = await request('GET', '/get/user:1');
  assert(res.body.value === 'Alice Updated', 'GET returns updated value');
}

async function testDelete(): Promise<void> {
  section('DELETE');

  await request('POST', '/put', { key: 'user:del', value: 'ToBeDeleted' });

  const beforeDel = await request('GET', '/get/user:del');
  assert(beforeDel.status === 200, 'Key exists before delete');

  const delRes = await request('DELETE', '/delete/user:del');
  assert(delRes.status === 200, 'DELETE returns 200');

  const afterDel = await request('GET', '/get/user:del');
  assert(afterDel.status === 404, 'Key returns 404 after delete');
}

async function testBatchPut(): Promise<void> {
  section('Batch PUT');

  const entries = [];
  for (let i = 1; i <= 50; i++) {
    entries.push({ key: `batch:${String(i).padStart(3, '0')}`, value: `Val-${i}` });
  }

  const res = await request('POST', '/batch-put', { entries });
  assert(res.status === 200, 'POST /batch returns 200');
  assert(res.body.count === 50, 'Batch PUT reports 50 entries written');

  const first = await request('GET', '/get/batch:001');
  const last = await request('GET', '/get/batch:050');
  assert(first.body.value === 'Val-1', 'First batch entry readable');
  assert(last.body.value === 'Val-50', 'Last batch entry readable');
}

async function testRangeQuery(): Promise<void> {
  section('Range Query');

  for (let i = 1; i <= 30; i++) {
    await request('POST', '/put', { key: `rng:${String(i).padStart(3, '0')}`, value: `R-${i}` });
  }

  const rangeRes = await request('GET', '/range?start=rng:005&end=rng:015');
  assert(rangeRes.status === 200, 'GET /range returns 200');
  const items = rangeRes.body.results as Array<{ key: string; value: string }>;
  assert(Array.isArray(items), 'Response contains results array');
  assert(items.length === 11, `Range [005..015] returns 11 entries (got ${items.length})`);

  let sorted = true;
  for (let i = 1; i < items.length; i++) {
    if (items[i]!.key < items[i - 1]!.key) { sorted = false; break; }
  }
  assert(sorted, 'Range results are sorted');

  const limitRes = await request('GET', '/range?start=rng:001&end=rng:030&limit=5');
  const limitItems = limitRes.body.results as Array<{ key: string; value: string }>;
  assert(limitItems.length === 5, `Range with limit=5 returns 5 entries (got ${limitItems.length})`);
}

async function testFlushAndReadBack(): Promise<void> {
  section('Flush to SSTable & Read Back');

  const bigValue = 'x'.repeat(50);
  const count = 2500;
  info(`Writing ${count} entries to trigger MemTable flush...`);

  for (let i = 0; i < count; i++) {
    await request('POST', '/put', {
      key: `flush:${String(i).padStart(5, '0')}`,
      value: bigValue + i,
    });
  }

  await sleep(500);

  const res = await request('GET', '/get/flush:00100');
  assert(res.status === 200, 'Entry readable after flush');
  assert((res.body.value as string).endsWith('100'), 'Entry has correct value after flush');

  const rangeRes = await request('GET', '/range?start=flush:00000&end=flush:00010');
  const flushedItems = rangeRes.body.results as Array<{ key: string; value: string }>;
  assert(flushedItems.length === 11, `Range across flushed data returns 11 entries (got ${flushedItems.length})`);
}

async function testInputValidation(): Promise<void> {
  section('Input Validation');

  const noKey = await request('POST', '/put', { value: 'nokey' });
  assert(noKey.status === 400, 'PUT without key returns 400');

  const noValue = await request('POST', '/put', { key: 'k' });
  assert(noValue.status === 400, 'PUT without value returns 400');

  const emptyBatch = await request('POST', '/batch-put', { entries: [] });
  assert(emptyBatch.status === 400, 'Batch with empty entries returns 400');
}

// ---------------------------------------------------------------------------
// TCP Streaming Tests
// ---------------------------------------------------------------------------

async function testTCPStreaming(): Promise<void> {
  section('TCP Streaming (via TCPClient)');

  const client = new TCPClient({ host: 'localhost', port: TEST_CONFIG.tcpPort });
  await client.connect();
  assert(client.isConnected(), 'TCPClient connected');

  const entryCount = 100;
  info(`Streaming ${entryCount} puts over TCP...`);

  const written = await client.streamPut(
    Array.from({ length: entryCount }, (_, i) => ({
      key: `tcp:${String(i).padStart(4, '0')}`,
      value: `TcpVal-${i}`,
    })),
  );
  assert(written === entryCount, `streamPut wrote ${entryCount} entries`);

  await client.endStream();
  assert(!client.isConnected(), 'TCPClient disconnected after endStream');

  const first = await request('GET', '/get/tcp:0000');
  const last = await request('GET', '/get/tcp:0099');
  assert(first.body.value === 'TcpVal-0', 'First TCP entry readable via HTTP');
  assert(last.body.value === 'TcpVal-99', 'Last TCP entry readable via HTTP');

  const rangeRes = await request('GET', '/range?start=tcp:0000&end=tcp:0099');
  const tcpItems = rangeRes.body.results as Array<{ key: string; value: string }>;
  assert(tcpItems.length === 100, `Range query over TCP data returns 100 (got ${tcpItems.length})`);
}

// ---------------------------------------------------------------------------
// Persistence Test
// ---------------------------------------------------------------------------

async function testPersistence(): Promise<void> {
  section('Persistence (restart simulation)');

  await request('POST', '/put', { key: 'persist:1', value: 'survives-restart' });
  await request('POST', '/put', { key: 'persist:2', value: 'also-survives' });

  info('Stopping server...');
  await stopServer();

  info('Restarting server...');
  await startServer();

  const res1 = await request('GET', '/get/persist:1');
  const res2 = await request('GET', '/get/persist:2');
  assert(res1.body.value === 'survives-restart', 'Key 1 survives restart');
  assert(res2.body.value === 'also-survives', 'Key 2 survives restart');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log(`\n${'█'.repeat(60)}`);
  console.log(`${C.bold}${C.cyan}  MONIEPOINT KV STORE — INTEGRATION TESTS${C.reset}`);
  console.log('█'.repeat(60));

  await cleanData();
  await startServer();
  info(`Server running — HTTP :${TEST_CONFIG.httpPort}  TCP :${TEST_CONFIG.tcpPort}`);

  try {
    await testHealthCheck();
    await testPutAndGet();
    await testUpdate();
    await testDelete();
    await testBatchPut();
    await testRangeQuery();
    await testInputValidation();
    await testFlushAndReadBack();
    await testTCPStreaming();
    await testPersistence();
  } catch (err) {
    fail(`Unexpected error: ${(err as Error).message}`);
    console.error(err);
  }

  await stopServer();
  await cleanData();

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
    console.log(`  ${C.bold}${C.green}ALL TESTS PASSED${C.reset}`);
    console.log(`  ${'🎉'.repeat(15)}\n`);
  }
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
