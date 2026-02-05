
import { MinHeap } from '../../common/MinHeap';
import { 
  MergeEntry, 
  HeapEntry, 
  IMergeSource, 
  KVPair,
} from './MergeIteratorTypes';
import { IMergeIterator } from './IMergeIterator';

class SourceWrapper implements IMergeSource {
  private readonly entries: MergeEntry[];
  private index: number = 0;

  constructor(entries: MergeEntry[]) {
    this.entries = entries;
  }

  next(): MergeEntry | null {
    if (this.index >= this.entries.length) {
      return null;
    }
    return this.entries[this.index++] ?? null;
  }
}

class AsyncSourceWrapper implements IMergeSource {
  private readonly iterator: AsyncIterator<MergeEntry>;
  private nextValue: MergeEntry | null = null;
  private exhausted: boolean = false;

  constructor(iterable: AsyncIterable<MergeEntry>) {
    this.iterator = iterable[Symbol.asyncIterator]();
  }

  async next(): Promise<MergeEntry | null> {
    if (this.exhausted) {
      return null;
    }

    const result = await this.iterator.next();
    if (result.done) {
      this.exhausted = true;
      return null;
    }

    return result.value;
  }
}

export interface MergeIteratorConfig {
  includeTombstones?: boolean;
}

export class MergeIterator implements IMergeIterator {
  private readonly sources: IMergeSource[];
  private readonly config: MergeIteratorConfig;
  private readonly heap: MinHeap<HeapEntry>;
  private initialized: boolean = false;

  /**
   * Create a MergeIterator from synchronous sources (MemTable entries).
   * 
   * @param sources - Array of sorted entry arrays
   * @param config - Optional configuration
   */
  constructor(sources: MergeEntry[][], config?: MergeIteratorConfig);
  
  /**
   * Create a MergeIterator from mixed sources.
   * 
   * @param sources - Array of IMergeSource implementations
   * @param config - Optional configuration
   */
  constructor(sources: IMergeSource[], config?: MergeIteratorConfig);
  
  constructor(
    sources: MergeEntry[][] | IMergeSource[], 
    config?: MergeIteratorConfig
  ) {
    this.config = config ?? {};
    
    if (sources.length > 0 && Array.isArray(sources[0])) {
      this.sources = (sources as MergeEntry[][]).map(arr => new SourceWrapper(arr));
    } else {
      this.sources = sources as IMergeSource[];
    }

    this.heap = new MinHeap<HeapEntry>(this.compareHeapEntries);
  }

  public static fromAsyncSources(
    sources: AsyncIterable<MergeEntry>[],
    config?: MergeIteratorConfig
  ): MergeIterator {
    const wrappedSources = sources.map(s => new AsyncSourceWrapper(s));
    return new MergeIterator(wrappedSources, config);
  }

  public static fromMixedSources(
    syncSources: MergeEntry[][],
    asyncSources: AsyncIterable<MergeEntry>[],
    config?: MergeIteratorConfig
  ): MergeIterator {
    const sources: IMergeSource[] = [
      ...syncSources.map(arr => new SourceWrapper(arr)),
      ...asyncSources.map(s => new AsyncSourceWrapper(s)),
    ];
    return new MergeIterator(sources, config);
  }

  public async *iterate(): AsyncIterable<KVPair> {
    await this.initializeHeap();

    while (!this.heap.isEmpty()) {
      const smallest = this.heap.extractMin()!;
      const currentKey = smallest.key;

      const winner = smallest;

      while (!this.heap.isEmpty() && this.heap.peek()!.key === currentKey) {
        const duplicate = this.heap.extractMin()!;
        await this.advanceSource(duplicate.sourceIndex);
      }

      await this.advanceSource(winner.sourceIndex);

      if (winner.deleted && !this.config.includeTombstones) {
        continue;
      }

      yield { key: winner.key, value: winner.value };
    }
  }

  private async initializeHeap(): Promise<void> {
    if (this.initialized) {
      return;
    }

    for (let i = 0; i < this.sources.length; i++) {
      await this.advanceSource(i);
    }

    this.initialized = true;
  }

  private async advanceSource(sourceIndex: number): Promise<void> {
    const source = this.sources[sourceIndex];
    if (!source) {
      return;
    }

    const entry = await source.next();
    if (entry !== null) {
      const heapEntry: HeapEntry = {
        ...entry,
        sourceIndex,
      };
      this.heap.insert(heapEntry);
    }
  }

  private compareHeapEntries = (a: HeapEntry, b: HeapEntry): number => {
    if (a.key < b.key) return -1;
    if (a.key > b.key) return 1;
    return a.sourceIndex - b.sourceIndex;
  };
}
