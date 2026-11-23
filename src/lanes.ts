/**
 * Lane layout: decides which column each commit sits in and how lines connect.
 *
 * Walks commits newest → oldest (git --topo-order). `lanes[i]` holds the hash
 * lane i is waiting for (a parent of something above), or null if free.
 * Lane positions never shift; freed slots are reused.
 *
 * Each row is drawn in three kinds of line:
 *   pass: lane runs straight through the row (top → bottom)
 *   in:   from top of `lane` into this row's node
 *   out:  from this row's node to bottom of `lane`
 */

export type LineKind = 'pass' | 'in' | 'out';

export interface Line {
  kind: LineKind;
  lane: number;
  color: number;
}

export interface GraphRow {
  col: number;
  color: number;
  lines: Line[];
}

export interface LayoutCommit {
  hash: string;
  parents: string[];
}

/** Stateful so pages of commits can be added as the user scrolls. */
export class GraphLayout {
  private lanes: (string | null)[] = [];
  private colors: number[] = [];
  private nextColor = 0;

  add(commits: LayoutCommit[]): GraphRow[] {
    return commits.map((c) => this.place(c));
  }

  private place(c: LayoutCommit): GraphRow {
    const lines: Line[] = [];

    const incoming: number[] = [];
    this.lanes.forEach((h, i) => {
      if (h === c.hash) incoming.push(i);
    });

    // Lanes not involved with this commit just pass through.
    this.lanes.forEach((h, i) => {
      if (h !== null && !incoming.includes(i)) {
        lines.push({ kind: 'pass', lane: i, color: this.colors[i] });
      }
    });

    let col: number;
    if (incoming.length) {
      col = incoming[0];
    } else {
      // Branch tip: nothing above points here.
      col = this.freeSlot();
      this.colors[col] = this.newColor();
    }
    const color = this.colors[col];

    for (const i of incoming) {
      lines.push({ kind: 'in', lane: i, color: this.colors[i] });
      if (i !== col) this.lanes[i] = null; // merged into this node
    }

    const [first, ...rest] = c.parents;

    // First parent continues this lane, keeping the main line straight.
    this.lanes[col] = first ?? null;
    if (first) lines.push({ kind: 'out', lane: col, color });

    // Extra parents (merge): join a lane already waiting, or open a new one.
    for (const p of rest) {
      let k = this.lanes.indexOf(p);
      if (k === -1) {
        k = this.freeSlot();
        this.lanes[k] = p;
        this.colors[k] = this.newColor();
      }
      lines.push({ kind: 'out', lane: k, color: this.colors[k] });
    }

    this.trim();
    return { col, color, lines };
  }

  private freeSlot(): number {
    const i = this.lanes.indexOf(null);
    if (i !== -1) return i;
    this.lanes.push(null);
    this.colors.push(0);
    return this.lanes.length - 1;
  }

  private newColor(): number {
    return this.nextColor++;
  }

  private trim(): void {
    while (this.lanes.length && this.lanes[this.lanes.length - 1] === null) {
      this.lanes.pop();
      this.colors.pop();
    }
  }
}
