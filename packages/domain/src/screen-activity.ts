/**
 * Where something happens on a screen recording. Frames are compared a few
 * times a second; cells of the picture that change locally (a dialog opens,
 * text appears, a panel updates) become events with a rectangle. A zoom aimed
 * at such an event has a reason; a zoom aimed at nothing is a guess.
 *
 * Changes that touch much of the picture (a scroll, a scene change, a video
 * playing) say nothing about where to look and are ignored.
 */

export interface ActivityTarget {
  /** Source time of the first and last change. */
  startUs: number;
  endUs: number;
  /** Where it happens, as fractions of the frame. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Larger means more change, for longer. */
  score: number;
}

export interface ActivityOptions {
  /** Grid of cells the picture is divided into. */
  columns?: number;
  rows?: number;
  /** A pixel counts as changed above this brightness difference. */
  pixelThreshold?: number;
  /** A cell is active when this share of its pixels changed. */
  cellShare?: number;
  /** Frames with more active cells than this share of the grid are ignored. */
  globalShare?: number;
  /** Events further apart than this in time are separate. */
  gapUs?: number;
  /** Shortest event worth reporting. */
  minimumUs?: number;
  /** Largest share of the picture an event may cover. */
  maximumArea?: number;
}

const defaults = {
  columns: 16,
  rows: 9,
  pixelThreshold: 24,
  cellShare: 0.04,
  globalShare: 0.4,
  gapUs: 700_000,
  minimumUs: 400_000,
  maximumArea: 0.45,
};

interface Open {
  startPair: number;
  lastPair: number;
  /** Per cell: how many compared pairs it was active in. */
  counts: Uint16Array;
  minColumn: number;
  maxColumn: number;
  minRow: number;
  maxRow: number;
  activePairs: number;
}

/**
 * Finds activity events in grayscale frames (`width`×`height` bytes each),
 * `frameUs` apart. Events are returned in time order.
 */
export function findActivityTargets(
  frames: readonly Uint8Array[],
  width: number,
  height: number,
  frameUs: number,
  options: ActivityOptions = {},
): ActivityTarget[] {
  const config = { ...defaults, ...options };
  const { columns, rows } = config;
  const cellWidth = Math.floor(width / columns);
  const cellHeight = Math.floor(height / rows);
  if (cellWidth < 1 || cellHeight < 1) return [];
  const pixelsPerCell = cellWidth * cellHeight;
  const events: ActivityTarget[] = [];
  let open: Open | null = null;

  const close = () => {
    if (!open) return;
    const current: Open = open;
    open = null;
    // Cells active in at least two pairs (or in all of a brief event)
    // describe the event; a single flicker does not.
    const needed = Math.min(2, current.activePairs);
    let minColumn = columns;
    let maxColumn = -1;
    let minRow = rows;
    let maxRow = -1;
    let weight = 0;
    for (let cell = 0; cell < columns * rows; cell++) {
      if (current.counts[cell]! < needed) continue;
      const column = cell % columns;
      const row = Math.floor(cell / columns);
      minColumn = Math.min(minColumn, column);
      maxColumn = Math.max(maxColumn, column);
      minRow = Math.min(minRow, row);
      maxRow = Math.max(maxRow, row);
      weight += current.counts[cell]!;
    }
    if (maxColumn < 0) return;
    const startUs = (current.startPair + 1) * frameUs;
    const endUs = (current.lastPair + 1) * frameUs;
    const area =
      ((maxColumn - minColumn + 1) * (maxRow - minRow + 1)) / (columns * rows);
    if (endUs - startUs + frameUs < config.minimumUs) return;
    if (current.activePairs < 3) return;
    if (area > config.maximumArea) return;
    events.push({
      startUs,
      endUs,
      x: minColumn / columns,
      y: minRow / rows,
      width: (maxColumn - minColumn + 1) / columns,
      height: (maxRow - minRow + 1) / rows,
      score: weight,
    });
  };

  for (let pair = 0; pair + 1 < frames.length; pair++) {
    const before = frames[pair]!;
    const after = frames[pair + 1]!;
    const active: number[] = [];
    for (let row = 0; row < rows; row++)
      for (let column = 0; column < columns; column++) {
        let changed = 0;
        for (let y = row * cellHeight; y < (row + 1) * cellHeight; y++) {
          const base = y * width + column * cellWidth;
          for (let x = 0; x < cellWidth; x++)
            if (
              Math.abs(after[base + x]! - before[base + x]!) >
              config.pixelThreshold
            )
              changed++;
        }
        if (changed / pixelsPerCell >= config.cellShare)
          active.push(row * columns + column);
      }
    if (active.length === 0) continue;
    // A change across much of the picture is not a place to look.
    if (active.length > columns * rows * config.globalShare) {
      close();
      continue;
    }
    if (open && (pair - open.lastPair) * frameUs > config.gapUs) close();
    if (open) {
      // Activity far from the event so far starts a new event.
      const o: Open = open;
      const near = active.some((cell) => {
        const column = cell % columns;
        const row = Math.floor(cell / columns);
        return (
          column >= o.minColumn - 2 &&
          column <= o.maxColumn + 2 &&
          row >= o.minRow - 2 &&
          row <= o.maxRow + 2
        );
      });
      if (!near) close();
    }
    if (!open)
      open = {
        startPair: pair,
        lastPair: pair,
        counts: new Uint16Array(columns * rows),
        minColumn: columns,
        maxColumn: -1,
        minRow: rows,
        maxRow: -1,
        activePairs: 0,
      };
    const current: Open = open;
    current.lastPair = pair;
    current.activePairs++;
    for (const cell of active) {
      current.counts[cell]!++;
      const column = cell % columns;
      const row = Math.floor(cell / columns);
      current.minColumn = Math.min(current.minColumn, column);
      current.maxColumn = Math.max(current.maxColumn, column);
      current.minRow = Math.min(current.minRow, row);
      current.maxRow = Math.max(current.maxRow, row);
    }
  }
  close();
  return events;
}

/** A zoom aimed at a target: where to centre and how far to magnify. */
export function zoomForTarget(target: ActivityTarget): {
  centerX: number;
  centerY: number;
  scale: number;
} {
  const centerX = target.x + target.width / 2;
  const centerY = target.y + target.height / 2;
  // Fit the target with a margin; small targets are not magnified past 2.4x.
  const fit = 0.8 / Math.max(target.width, target.height);
  const scale = Math.min(2.4, Math.max(1.3, Math.round(fit * 10) / 10));
  return {
    centerX: Math.round(centerX * 1000) / 1000,
    centerY: Math.round(centerY * 1000) / 1000,
    scale,
  };
}
