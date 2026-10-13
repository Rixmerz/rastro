// The water level: a queue served shallowest-first, so every branch of the
// site advances one level before any goes deeper, whichever worker asks.

export interface FloodItem {
  /** State the element lives in (`S3`). */
  state: string;
  /** Element key within that state; absent for the seed visit. */
  key?: string;
  depth: number;
  /** Times this item was requeued after its worker died. */
  retries: number;
}

export function itemId(item: Pick<FloodItem, 'state' | 'key'>): string {
  return `${item.state}::${item.key ?? ''}`;
}

export class Frontier {
  private readonly levels = new Map<number, FloodItem[]>();
  private readonly seen = new Set<string>();

  /** Adds an item unless the same (state, key) was ever queued. */
  push(item: FloodItem): boolean {
    const id = itemId(item);
    if (this.seen.has(id)) return false;
    this.seen.add(id);
    this.enqueue(item);
    return true;
  }

  /** Puts back an item that was taken but not finished. */
  requeue(item: FloodItem): void {
    this.enqueue({ ...item, retries: item.retries + 1 });
  }

  /** Puts back an item that was taken and never started. */
  putBack(item: FloodItem): void {
    this.enqueue(item);
  }

  private enqueue(item: FloodItem): void {
    const level = this.levels.get(item.depth);
    if (level) level.push(item);
    else this.levels.set(item.depth, [item]);
  }

  /** The shallowest item, preferring one in `preferState` at that same depth
   * (a worker already standing in that state skips reaching it). Items whose
   * `eligible` is false are left in place. */
  pop(preferState?: string, eligible: (item: FloodItem) => boolean = () => true): FloodItem | undefined {
    for (const depth of [...this.levels.keys()].sort((a, b) => a - b)) {
      const level = this.levels.get(depth)!;
      let index = preferState === undefined ? -1 : level.findIndex((i) => i.state === preferState && eligible(i));
      if (index === -1) index = level.findIndex(eligible);
      if (index === -1) continue;
      const [item] = level.splice(index, 1);
      if (level.length === 0) this.levels.delete(depth);
      return item;
    }
    return undefined;
  }

  get size(): number {
    let n = 0;
    for (const level of this.levels.values()) n += level.length;
    return n;
  }

  /** The shallowest queued depth, or undefined when empty. */
  get level(): number | undefined {
    const depths = [...this.levels.keys()];
    return depths.length === 0 ? undefined : Math.min(...depths);
  }

  /** Removes and returns every item matching `pred`. */
  drain(pred: (item: FloodItem) => boolean = () => true): FloodItem[] {
    const out: FloodItem[] = [];
    for (const [depth, level] of this.levels) {
      const keep = level.filter((i) => !pred(i));
      out.push(...level.filter(pred));
      if (keep.length === 0) this.levels.delete(depth);
      else this.levels.set(depth, keep);
    }
    return out;
  }
}
