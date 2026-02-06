import * as http from 'http';
import { IStorageEngine } from '../interfaces/Storage';
import { IReplicationStatusProvider } from './IReplicationStatusProvider';

type RouteHandler = (req: ParsedRequest, res: ResponseHelper) => Promise<void>;

interface ParsedRequest {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

class ResponseHelper {
  private sent = false;

  constructor(private readonly res: http.ServerResponse) {}

  public status(code: number): this {
    this.res.statusCode = code;
    return this;
  }

  public json(data: unknown): void {
    if (this.sent) return;
    this.sent = true;
    this.res.setHeader('Content-Type', 'application/json');
    this.res.end(JSON.stringify(data));
  }
}

export interface HTTPServerDependencies {
  replicationStatusProvider?: IReplicationStatusProvider | undefined;
}

export class HTTPServer {
  private readonly store: IStorageEngine;
  private readonly port: number;
  private readonly replicationStatusProvider: IReplicationStatusProvider | undefined;
  private server: http.Server | null = null;
  private readonly routes: Route[] = [];

  constructor(store: IStorageEngine, port: number, dependencies?: HTTPServerDependencies) {
    this.store = store;
    this.port = port;
    this.replicationStatusProvider = dependencies?.replicationStatusProvider;
    this.registerRoutes();
  }

  private registerRoutes(): void {
    this.addRoute('GET', '/health', this.handleHealth.bind(this));
    this.addRoute('POST', '/put', this.handlePut.bind(this));
    this.addRoute('POST', '/batch-put', this.handleBatchPut.bind(this));
    this.addRoute('GET', '/get/:key', this.handleGet.bind(this));
    this.addRoute('DELETE', '/delete/:key', this.handleDelete.bind(this));
    this.addRoute('GET', '/range', this.handleRange.bind(this));
    this.addRoute('GET', '/replication/status', this.handleReplicationStatus.bind(this));
  }

  private addRoute(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const patternStr = path.replace(/:(\w+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const pattern = new RegExp(`^${patternStr}$`);
    this.routes.push({ method, pattern, paramNames, handler });
  }

  private findRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, i) => {
          params[name] = decodeURIComponent(match[i + 1]!);
        });
        return { route, params };
      }
    }
    return null;
  }

  private async parseBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const maxSize = 10 * 1024 * 1024;

      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > maxSize) {
          reject(new Error('Request body too large'));
          return;
        }
        chunks.push(chunk);
      });

      req.on('end', () => {
        if (chunks.length === 0) {
          resolve({});
          return;
        }
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          resolve(body);
        } catch {
          reject(new Error('Invalid JSON'));
        }
      });

      req.on('error', reject);
    });
  }

  private parseQueryString(search: string): Record<string, string> {
    const query: Record<string, string> = {};
    if (!search) return query;
    const params = new URLSearchParams(search);
    params.forEach((value, key) => {
      query[key] = value;
    });
    return query;
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const responseHelper = new ResponseHelper(res);

    try {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
      const method = req.method || 'GET';
      const path = url.pathname;

      const found = this.findRoute(method, path);
      if (!found) {
        responseHelper.status(404).json({ error: 'Not found' });
        return;
      }

      let body: unknown = {};
      if (method === 'POST' || method === 'PUT') {
        body = await this.parseBody(req);
      }

      const parsedRequest: ParsedRequest = {
        method,
        path,
        params: found.params,
        query: this.parseQueryString(url.search),
        body,
      };

      await found.route.handler(parsedRequest, responseHelper);
    } catch (err) {
      console.error('Request error:', err);
      responseHelper.status(500).json({ error: 'Internal server error' });
    }
  }

  private async handleHealth(_req: ParsedRequest, res: ResponseHelper): Promise<void> {
    res.json({ status: 'ok', timestamp: Date.now() });
  }

  private async handlePut(req: ParsedRequest, res: ResponseHelper): Promise<void> {
    const body = req.body as Record<string, unknown>;
    const { key, value } = body;

    if (typeof key !== 'string' || key.length === 0) {
      res.status(400).json({ error: 'Invalid key: must be non-empty string' });
      return;
    }

    if (value === undefined || value === null) {
      res.status(400).json({ error: 'Invalid value: must not be null or undefined' });
      return;
    }

    await this.store.put(key, String(value));
    res.json({ success: true });
  }

  private async handleBatchPut(req: ParsedRequest, res: ResponseHelper): Promise<void> {
    const body = req.body as Record<string, unknown>;
    const { entries, keys, values } = body;

    let parsedEntries: Array<{ key: string; value: string }>;

    if (Array.isArray(entries)) {
      parsedEntries = [];
      for (let i = 0; i < entries.length; i++) {
        const entry = entries[i] as Record<string, unknown>;
        if (!entry || typeof entry.key !== 'string' || entry.key.length === 0) {
          res.status(400).json({ error: `Invalid key at index ${i}: must be non-empty string` });
          return;
        }
        if (entry.value === undefined || entry.value === null) {
          res.status(400).json({ error: `Invalid value at index ${i}: must not be null or undefined` });
          return;
        }
        parsedEntries.push({ key: entry.key, value: String(entry.value) });
      }
    } else if (Array.isArray(keys) && Array.isArray(values)) {
      if (keys.length !== values.length) {
        res.status(400).json({ error: 'Keys and values arrays must have the same length' });
        return;
      }
      parsedEntries = [];
      for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        const value = values[i];
        if (typeof key !== 'string' || key.length === 0) {
          res.status(400).json({ error: `Invalid key at index ${i}: must be non-empty string` });
          return;
        }
        if (value === undefined || value === null) {
          res.status(400).json({ error: `Invalid value at index ${i}: must not be null or undefined` });
          return;
        }
        parsedEntries.push({ key, value: String(value) });
      }
    } else {
      res.status(400).json({ error: 'Invalid request body: provide either "entries" array or "keys" and "values" arrays' });
      return;
    }

    if (parsedEntries.length === 0) {
      res.status(400).json({ error: 'No entries provided' });
      return;
    }

    const count = await this.store.batchPut(parsedEntries);
    res.json({ success: true, count });
  }

  private async handleGet(req: ParsedRequest, res: ResponseHelper): Promise<void> {
    const key = req.params.key;

    if (!key) {
      res.status(400).json({ error: 'Key parameter required' });
      return;
    }

    const value = await this.store.get(key);

    if (value === null) {
      res.status(404).json({ error: 'Key not found', key });
      return;
    }

    res.json({ key, value });
  }

  private async handleDelete(req: ParsedRequest, res: ResponseHelper): Promise<void> {
    const key = req.params.key;

    if (!key) {
      res.status(400).json({ error: 'Key parameter required' });
      return;
    }

    await this.store.delete(key);
    res.json({ success: true });
  }

  private async handleRange(req: ParsedRequest, res: ResponseHelper): Promise<void> {
    const { start, end, limit } = req.query;

    if (typeof start !== 'string' || start.length === 0) {
      res.status(400).json({ error: 'Invalid start: must be non-empty string' });
      return;
    }

    if (typeof end !== 'string' || end.length === 0) {
      res.status(400).json({ error: 'Invalid end: must be non-empty string' });
      return;
    }

    let parsedLimit = 100;
    if (limit !== undefined) {
      parsedLimit = parseInt(limit, 10);
      if (isNaN(parsedLimit) || parsedLimit < 1) {
        res.status(400).json({ error: 'Invalid limit: must be positive integer' });
        return;
      }
    }

    const results: Array<{ key: string; value: string }> = [];
    for await (const pair of this.store.readKeyRange(start, end, { limit: parsedLimit })) {
      results.push(pair);
    }

    res.json({ count: results.length, results });
  }

  private async handleReplicationStatus(_req: ParsedRequest, res: ResponseHelper): Promise<void> {
    if (!this.replicationStatusProvider) {
      res.json({
        enabled: false,
        message: 'Replication not configured (standalone mode)',
      });
      return;
    }

    const status = this.replicationStatusProvider.getReplicationStatus();
    res.json({
      enabled: true,
      state: status.state,
      metrics: status.metrics,
    });
  }

  public async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((err) => {
          console.error('Unhandled request error:', err);
          if (!res.writableEnded) {
            res.statusCode = 500;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        });
      });

      this.server.on('error', reject);

      this.server.listen(this.port, () => {
        console.log(`HTTP server listening on port ${this.port}`);
        resolve();
      });
    });
  }

  public async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          console.log('HTTP server stopped');
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}
