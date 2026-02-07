# Integration Test Plan

## 1. API & TCP Tests (`npm run test:api`)

Runs a single server instance (HTTP :4100, TCP :4101) with a small MemTable (100KB) to trigger flushes.

| # | Section | Test | What it verifies |
|---|---------|------|------------------|
| 1 | Health Check | GET /health returns 200 | Server is alive |
| 2 | | Response contains status: ok | Correct response shape |
| 3 | PUT & GET | PUT user:1=Alice returns 200 | Basic write |
| 4 | | PUT response has success: true | Correct response shape |
| 5 | | GET user:1 returns 200 | Basic read |
| 6 | | GET user:1 returns Alice | Correct value returned |
| 7 | | GET nonexistent key returns 404 | Missing key handling |
| 8 | UPDATE | GET returns updated value | Overwrite semantics |
| 9 | DELETE | Key exists before delete | Pre-condition |
| 10 | | DELETE returns 200 | Delete operation |
| 11 | | Key returns 404 after delete | Tombstone semantics |
| 12 | Batch PUT | POST /batch-put returns 200 | Batch write (50 entries) |
| 13 | | Batch PUT reports 50 entries written | Correct count |
| 14 | | First batch entry readable | Batch data integrity |
| 15 | | Last batch entry readable | Batch data integrity |
| 16 | Range Query | GET /range returns 200 | Range scan works |
| 17 | | Response contains results array | Correct response shape |
| 18 | | Range [005..015] returns 11 entries | Inclusive bounds |
| 19 | | Range results are sorted | Sort order preserved |
| 20 | | Range with limit=5 returns 5 entries | Limit enforcement |
| 21 | Input Validation | PUT without key returns 400 | Missing key rejected |
| 22 | | PUT without value returns 400 | Missing value rejected |
| 23 | | Batch with empty entries returns 400 | Empty batch rejected |
| 24 | Flush & Read Back | Entry readable after flush | SSTable read path works |
| 25 | | Entry has correct value after flush | Data integrity post-flush |
| 26 | | Range across flushed data returns 11 | Merge iterator across SSTables + MemTable |
| 27 | TCP Streaming | TCPClient connected | TCP connection established |
| 28 | | streamPut wrote 100 entries | Streaming write with ACKs |
| 29 | | TCPClient disconnected after endStream | Clean disconnect |
| 30 | | First TCP entry readable via HTTP | TCP data visible through HTTP |
| 31 | | Last TCP entry readable via HTTP | TCP data visible through HTTP |
| 32 | | Range query over TCP data returns 100 | Full dataset integrity |
| 33 | Persistence | Key 1 survives restart | WAL replay after shutdown |
| 34 | | Key 2 survives restart | SSTable + WAL recovery |

**Total: 34 tests**

---

## 2. Replication Tests (`npm run test:replication`)

Spawns two separate server processes — a PRIMARY (HTTP :4300) and a BACKUP (HTTP :4200, replication :4202).

| # | Section | Test | What it verifies |
|---|---------|------|------------------|
| 1 | Startup | Backup server is ready | Backup starts and listens |
| 2 | | Primary server is ready | Primary starts and connects to backup |
| 3 | Replication Status | Primary /replication/status returns 200 | Status endpoint works |
| 4 | | Primary reports replication enabled | Correct config |
| 5 | | Primary reports role: primary | Role identification |
| 6 | | Primary reports connected: true | Connection established |
| 7 | | Backup /replication/status returns 200 | Status endpoint works |
| 8 | | Backup reports replication enabled | Correct config |
| 9 | | Backup reports role: backup | Role identification |
| 10 | Single Key | Key replicated to backup | Basic replication works |
| 11 | | Backup has correct value | Data integrity |
| 12 | Multiple Keys | All 20 keys replicated correctly | Sustained replication (20 sequential writes) |
| 13 | Delete | Key exists on backup before delete | Pre-condition |
| 14 | | Key deleted on backup after primary delete | Tombstone replication |
| 15 | Batch PUT | First batch entry replicated | Batch replication (30 entries) |
| 16 | | Last batch entry replicated | Batch replication |
| 17 | Range Consistency | Range count matches primary=20 backup=20 | Both sides have same data count |
| 18 | | All range entries match | Byte-for-byte consistency |
| 19 | Reconnection | Primary detects backup is down | Disconnect detection |
| 20 | | Backup restarted successfully | Process restart works |
| 21 | | Primary reconnected to backup | Auto-reconnect after backup restart |
| 22 | | Key written after reconnect is replicated | Replication resumes after reconnect |

**Total: 22 tests**

---

## Running

```bash
npm run test:api           # HTTP + TCP integration (34 tests, ~30s)
npm run test:replication   # Replication integration (22 tests, ~45s)
```
