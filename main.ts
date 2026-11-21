// Sokoban solver for make.fun's sokoban-solver-01-run-20261121 bounty.
//
// Strategy (written from scratch for this bounty):
//   1. Split the level into independent rooms. The generator lays one
//      1-wide hallway across the board (the row the player starts on) with
//      1-4 rooms hanging off it, each opening through a single door cell.
//      A box pushed through a door can never come back, so every room is
//      solved on its own and the room solutions are stitched together with
//      plain walks along the hallway.
//   2. Solve each room with a push-based A* search: a state is the sorted
//      box positions plus the player cell; successors are pushes (the player
//      must be able to walk to the pushing square first). The heuristic is
//      the minimum-assignment sum of shortest-path distances from boxes to
//      goals, which is admissible, so A* returns a push-optimal room plan.
//      Dead states are pruned with precomputed dead squares (cells no box
//      can ever be pushed from to reach a goal) and 2x2 freeze blocks.
//   3. Stitch: walk to each room's door, run its pushes, walk back out to
//      the hallway, move on to the next room. The last room may use a plan
//      that leaves the player inside (no exit needed).
//   4. Everything is deterministic: fixed iteration orders, a binary heap
//      with an insertion counter for tie-breaking, and node-count budgets
//      (never wall-clock cutoffs) so two runs write identical bytes.
//
// Usage: node main.ts  (reads $MAKEFUN_INPUT_DIR/<id>/level.txt, default
// /input, and writes $MAKEFUN_OUTPUT_DIR/<id>/solution.txt, default
// /output). Node 22 type-stripping runs this file directly; only
// erasable TypeScript syntax is used.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// Four moves, fixed order everywhere so every search is deterministic.
const DX = [0, 0, -1, 1];
const DY = [-1, 1, 0, 0];
const CH = ['u', 'd', 'l', 'r'];

// Node-count budgets (deterministic; wall clock is never used to decide).
const OPT_BUDGET = 1_500_000;
const WEIGHTED_BUDGET = 4_000_000;

interface Level {
  w: number;
  h: number;
  wall: Uint8Array; // 1 = wall (or outside the level)
  goal: Uint8Array;
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const w = Math.max(...rows.map((r) => r.length));
  const h = rows.length;
  const wall = new Uint8Array(w * h).fill(1);
  const goal = new Uint8Array(w * h);
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const i = y * w + x;
      const c = row[x];
      if (c === '#') continue;
      wall[i] = 0;
      if (c === '.' || c === '*' || c === '+') goal[i] = 1;
      if (c === '$' || c === '*') boxes.push(i);
      if (c === '@' || c === '+') player = i;
    }
  });
  boxes.sort((a, b) => a - b);
  return { w, h, wall, goal, boxes, player };
}

// Breadth-first walk distances from `from` over cells where `pass[i]` is 1,
// returned as an Int32Array of -1 (unreached) or step counts.
function bfsDist(from: number, pass: Uint8Array, w: number, h: number): Int32Array {
  const dist = new Int32Array(w * h).fill(-1);
  const q = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  dist[from] = 0;
  q[qt++] = from;
  while (qh < qt) {
    const c = q[qh++];
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!pass[n] || dist[n] >= 0) continue;
      dist[n] = dist[c] + 1;
      q[qt++] = n;
    }
  }
  return dist;
}

// Shortest walk path (list of direction indices) from `from` to `to` over
// cells where `pass[i]` is 1, or null when unreachable. Deterministic: the
// fixed direction order above decides ties.
function walkPath(from: number, to: number, pass: Uint8Array, w: number, h: number): number[] | null {
  if (from === to) return [];
  const prev = new Int32Array(w * h).fill(-2);
  const q = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  prev[from] = -1;
  q[qt++] = from;
  while (qh < qt) {
    const c = q[qh++];
    if (c === to) break;
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!pass[n] || prev[n] !== -2) continue;
      prev[n] = c;
      q[qt++] = n;
    }
  }
  if (prev[to] === -2) return null;
  const path: number[] = [];
  let c = to;
  while (c !== from) {
    const p = prev[c];
    const dx = (c % w) - (p % w);
    const dy = ((c / w) | 0) - ((p / w) | 0);
    path.push(dx === 1 ? 3 : dx === -1 ? 2 : dy === 1 ? 1 : 0);
    c = p;
  }
  path.reverse();
  return path;
}

// Reachable set from `from` over `pass` cells, with `blocked` cells treated
// as walls. Returned as a Uint8Array (1 = reachable).
function reachableSet(from: number, pass: Uint8Array, blocked: Uint8Array, w: number, h: number): Uint8Array {
  const seen = new Uint8Array(w * h);
  const q = new Int32Array(w * h);
  let qh = 0;
  let qt = 0;
  if (!pass[from] || blocked[from]) return seen;
  seen[from] = 1;
  q[qt++] = from;
  while (qh < qt) {
    const c = q[qh++];
    const cx = c % w;
    const cy = (c / w) | 0;
    for (let d = 0; d < 4; d++) {
      const nx = cx + DX[d];
      const ny = cy + DY[d];
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const n = ny * w + nx;
      if (!pass[n] || blocked[n] || seen[n]) continue;
      seen[n] = 1;
      q[qt++] = n;
    }
  }
  return seen;
}

interface Room {
  cells: number[]; // interior floor cells (door included, hallway excluded)
  cellSet: Uint8Array; // 1 for interior cells
  standable: Uint8Array; // interior cells + the entry hallway cell
  door: number; // interior cell adjacent to the hallway
  entry: number; // hallway cell adjacent to the door
  boxes: number[];
  goals: number[];
}

// Find the rooms of a level: connected components of floor off the hallway
// line through the player. Tries a horizontal hallway (the player's row)
// first, then a vertical one. Returns null when the split does not cover
// every box and goal exactly once.
function findRooms(level: Level): Room[] | null {
  const { w, h, wall, goal, boxes, player } = level;
  const px = player % w;
  const py = (player / w) | 0;
  for (const horizontal of [true, false]) {
    const onHall = (x: number, y: number): boolean => (horizontal ? y === py : x === px);
    const seen = new Uint8Array(w * h);
    const rooms: Room[] = [];
    let ok = true;
    for (let y = 0; y < h && ok; y++) {
      for (let x = 0; x < w && ok; x++) {
        const i = y * w + x;
        if (wall[i] || onHall(x, y) || seen[i]) continue;
        // Flood-fill one component.
        const comp: number[] = [];
        const q = [i];
        seen[i] = 1;
        while (q.length) {
          const c = q.pop() as number;
          comp.push(c);
          const cx = c % w;
          const cy = (c / w) | 0;
          for (let d = 0; d < 4; d++) {
            const nx = cx + DX[d];
            const ny = cy + DY[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const n = ny * w + nx;
            if (wall[n] || onHall(nx, ny) || seen[n]) continue;
            seen[n] = 1;
            q.push(n);
          }
        }
        const cellSet = new Uint8Array(w * h);
        for (const c of comp) cellSet[c] = 1;
        const rb = boxes.filter((b) => cellSet[b]);
        const rg = goalsIn(level, cellSet);
        if (rb.length === 0 || rb.length !== rg.length) {
          ok = false;
          break;
        }
        // The door is the one interior cell touching the hallway; the entry
        // is the hallway cell it touches.
        let door = -1;
        let entry = -1;
        for (const c of comp) {
          const cx = c % w;
          const cy = (c / w) | 0;
          for (let d = 0; d < 4; d++) {
            const nx = cx + DX[d];
            const ny = cy + DY[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (onHall(nx, ny) && !wall[ny * w + nx]) {
              door = c;
              entry = ny * w + nx;
            }
          }
        }
        if (door < 0) {
          ok = false;
          break;
        }
        const standable = new Uint8Array(cellSet);
        standable[entry] = 1;
        rooms.push({ cells: comp, cellSet, standable, door, entry, boxes: rb, goals: rg });
      }
    }
    if (!ok) continue;
    // Every box and goal must belong to exactly one room.
    const coveredBoxes = rooms.reduce((n, r) => n + r.boxes.length, 0);
    const coveredGoals = rooms.reduce((n, r) => n + r.goals.length, 0);
    let totalGoals = 0;
    for (let i = 0; i < w * h; i++) if (goal[i]) totalGoals++;
    if (coveredBoxes === boxes.length && coveredGoals === totalGoals) return rooms;
  }
  return null;
}

function goalsIn(level: Level, cellSet: Uint8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < level.w * level.h; i++) {
    if (level.goal[i] && cellSet[i]) out.push(i);
  }
  return out;
}

interface RoomPlan {
  moves: string; // full move string: enter, push, exit, ending at entry
  pushes: number;
  exitOk: boolean; // true when the plan ends with the player back at entry
}

// Dead squares: cells from which a box can never be pushed onto a goal.
// Reverse push-BFS from the goals: a box at q can be pushed to p (already
// live) when the player can stand at p - 2d (q = p - d).
function liveCells(room: Room, level: Level): Uint8Array {
  const { w, h } = level;
  const live = new Uint8Array(w * h);
  const q: number[] = [];
  for (const g of room.goals) {
    live[g] = 1;
    q.push(g);
  }
  while (q.length) {
    const p = q.pop() as number;
    const px = p % w;
    const py = (p / w) | 0;
    for (let d = 0; d < 4; d++) {
      const qx = px - DX[d];
      const qy = py - DY[d];
      const sx = px - 2 * DX[d];
      const sy = py - 2 * DY[d];
      if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const qc = qy * w + qx;
      const sc = sy * w + sx;
      if (!room.cellSet[qc] || live[qc]) continue;
      if (!room.standable[sc]) continue;
      live[qc] = 1;
      q.push(qc);
    }
  }
  return live;
}

// Minimum-assignment heuristic: the cheapest way to match boxes to distinct
// goals by shortest-path distance. Admissible: in any real solution each
// box travels at least its distance to the goal it ends on.
function heuristic(boxes: number[], goals: number[], distToGoal: Int32Array[]): number {
  const n = boxes.length;
  if (n === 0) return 0;
  // Cost matrix, with a large number where a box cannot reach a goal.
  const cost: number[][] = [];
  for (let i = 0; i < n; i++) {
    cost.push([]);
    for (let j = 0; j < n; j++) {
      const d = distToGoal[j][boxes[i]];
      cost[i][j] = d < 0 ? 1e9 : d;
    }
  }
  if (n <= 5) {
    // Exact minimum over all permutations.
    const perm = goals.map((_, j) => j);
    let best = 1e9;
    const rec = (k: number, sum: number): void => {
      if (sum >= best) return;
      if (k === n) {
        best = sum;
        return;
      }
      for (let j = k; j < n; j++) {
        const t = perm[k];
        perm[k] = perm[j];
        perm[j] = t;
        const c = cost[k][perm[k]];
        if (c < 1e9) rec(k + 1, sum + c);
        const t2 = perm[k];
        perm[k] = perm[j];
        perm[j] = t2;
      }
    };
    rec(0, 0);
    return best >= 1e9 ? 1e9 : best;
  }
  // Fallback for larger rooms: sum of per-box minima (still admissible).
  let sum = 0;
  for (let i = 0; i < n; i++) {
    let m = 1e9;
    for (let j = 0; j < n; j++) m = Math.min(m, cost[i][j]);
    if (m >= 1e9) return 1e9;
    sum += m;
  }
  return sum;
}

// Pack sorted box cells (< 256 each on these boards) plus the player cell
// into one number, usable as a Map key.
function packState(boxes: number[], player: number): number {
  let code = player;
  for (let i = boxes.length - 1; i >= 0; i--) code = code * 256 + boxes[i];
  return code;
}

function unpackBoxes(code: number, n: number): number[] {
  const boxes: number[] = [];
  let rest = code;
  for (let i = 0; i < n; i++) {
    boxes.push(rest % 256);
    rest = Math.floor(rest / 256); // packed codes exceed 2^31: never use | 0
  }
  return boxes;
}

interface PushStep {
  from: number; // cell the player pushes from
  dir: number; // direction index
}

interface SearchResult {
  pushes: PushStep[];
  expansions: number;
}

// Push-based A* over one room. Start: boxes as given, player at the entry
// hallway cell. `requireExit`: a goal state must also let the player walk
// back to the door with the boxes as walls. `weight`: 1 for optimal A*,
// above 1 for a faster weighted search. Returns null when the node budget
// runs out.
function searchRoom(
  room: Room,
  level: Level,
  live: Uint8Array,
  distToGoal: Int32Array[],
  requireExit: boolean,
  weight: number,
  budget: number,
): SearchResult | null {
  const { w, h } = level;
  const n = room.boxes.length;
  const goalSet = new Uint8Array(w * h);
  for (const g of room.goals) goalSet[g] = 1;

  // 2x2 blocks fully inside the room's bounding box, for freeze checks.
  let minX = w;
  let maxX = -1;
  let minY = h;
  let maxY = -1;
  for (const c of room.cells) {
    const x = c % w;
    const y = (c / w) | 0;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const blocks: number[][] = [];
  for (let y = minY; y < maxY; y++) {
    for (let x = minX; x < maxX; x++) {
      blocks.push([y * w + x, y * w + x + 1, (y + 1) * w + x, (y + 1) * w + x + 1]);
    }
  }

  const isSolved = (boxes: number[]): boolean => {
    for (const b of boxes) if (!goalSet[b]) return false;
    return true;
  };

  const canExit = (boxes: number[], player: number): boolean => {
    const blocked = new Uint8Array(w * h);
    for (const b of boxes) blocked[b] = 1;
    if (blocked[room.door]) return false;
    const reach = reachableSet(player, room.standable, blocked, w, h);
    return reach[room.door] === 1;
  };

  const isFrozen = (boxes: number[]): boolean => {
    const boxSet = new Uint8Array(w * h);
    for (const b of boxes) boxSet[b] = 1;
    for (const block of blocks) {
      let blockedCount = 0;
      let hasBoxOffGoal = false;
      for (const c of block) {
        if (level.wall[c] || boxSet[c]) {
          blockedCount++;
          if (boxSet[c] && !goalSet[c]) hasBoxOffGoal = true;
        }
      }
      if (blockedCount === 4 && hasBoxOffGoal) return true;
    }
    return false;
  };

  // State storage (parallel arrays, indexed by state id).
  const boxCode: number[] = [];
  const playerArr: number[] = [];
  const parent: number[] = [];
  const pushFrom: number[] = [];
  const pushDir: number[] = [];
  const gArr: number[] = [];
  const best = new Map<number, number>(); // packed state -> state id (best g)

  const startBoxes = [...room.boxes].sort((a, b) => a - b);
  const startCode = packState(startBoxes, room.entry);
  boxCode.push(startCode);
  playerArr.push(room.entry);
  parent.push(-1);
  pushFrom.push(-1);
  pushDir.push(-1);
  gArr.push(0);
  best.set(startCode, 0);

  // Binary heap of [f, h, counter, stateId], smallest first.
  const heap: number[][] = [];
  let counter = 0;
  const heapLess = (a: number[], b: number[]): boolean => {
    if (a[0] !== b[0]) return a[0] < b[0];
    if (a[1] !== b[1]) return a[1] < b[1];
    return a[2] < b[2];
  };
  const heapPush = (item: number[]): void => {
    heap.push(item);
    let i = heap.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i], heap[p])) break;
      const t = heap[i];
      heap[i] = heap[p];
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): number[] => {
    const top = heap[0];
    const last = heap.pop() as number[];
    if (heap.length > 0) {
      heap[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heapLess(heap[l], heap[m])) m = l;
        if (r < heap.length && heapLess(heap[r], heap[m])) m = r;
        if (m === i) break;
        const t = heap[i];
        heap[i] = heap[m];
        heap[m] = t;
        i = m;
      }
    }
    return top;
  };

  const h0 = heuristic(startBoxes, room.goals, distToGoal);
  if (h0 >= 1e9) return null;
  heapPush([weight * h0, h0, counter++, 0]);

  let expansions = 0;
  while (heap.length > 0) {
    const [, , , sid] = heapPop();
    const g = gArr[sid];
    const code = boxCode[sid];
    if (best.get(code) !== sid) continue; // superseded by a cheaper route
    const player = playerArr[sid];
    const boxes = unpackBoxes(code, n);
    if (isSolved(boxes)) {
      if (!requireExit || canExit(boxes, player)) {
        const pushes: PushStep[] = [];
        let s = sid;
        while (parent[s] >= 0) {
          pushes.push({ from: pushFrom[s], dir: pushDir[s] });
          s = parent[s];
        }
        pushes.reverse();
        return { pushes, expansions };
      }
      // Solved but the player cannot leave: keep expanding through this
      // state (push a box off a goal and back) to find an exitable plan.
    }
    if (++expansions > budget) return null;
    // Where the player can stand, with the boxes as walls.
    const blocked = new Uint8Array(w * h);
    for (const b of boxes) blocked[b] = 1;
    const reach = reachableSet(player, room.standable, blocked, w, h);
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi];
      const bx = b % w;
      const by = (b / w) | 0;
      for (let d = 0; d < 4; d++) {
        const fx = bx - DX[d];
        const fy = by - DY[d];
        const tx = bx + DX[d];
        const ty = by + DY[d];
        if (fx < 0 || fy < 0 || fx >= w || fy >= h) continue;
        if (tx < 0 || ty < 0 || tx >= w || ty >= h) continue;
        const from = fy * w + fx;
        const dest = ty * w + tx;
        if (!room.cellSet[dest]) continue; // never push a box out of the room
        if (blocked[dest]) continue;
        if (!reach[from]) continue;
        if (!live[dest]) continue; // box would land on a dead square
        const next = [...boxes];
        next[bi] = dest;
        next.sort((a, b2) => a - b2);
        if (isFrozen(next)) continue;
        const h1 = heuristic(next, room.goals, distToGoal);
        if (h1 >= 1e9) continue;
        const ng = g + 1;
        const ncode = packState(next, b);
        const prev = best.get(ncode);
        if (prev !== undefined && gArr[prev] <= ng) continue;
        const nid = boxCode.length;
        boxCode.push(ncode);
        playerArr.push(b);
        parent.push(sid);
        pushFrom.push(from);
        pushDir.push(d);
        gArr.push(ng);
        best.set(ncode, nid);
        heapPush([ng + weight * h1, h1, counter++, nid]);
      }
    }
  }
  return null;
}

// Turn a push list into the full move string for one room: walk to each
// pushing square, push, and finally walk back out to the entry cell.
function pushesToMoves(room: Room, level: Level, pushes: PushStep[]): string | null {
  const { w, h } = level;
  let player = room.entry;
  const boxes = [...room.boxes].sort((a, b) => a - b);
  let out = '';
  // Walkable cells: the room plus the entry, minus the boxes (walking
  // through a box would push it, which the plan does not account for).
  const walkPass = (): Uint8Array => {
    const pass = new Uint8Array(room.standable);
    for (const b of boxes) pass[b] = 0;
    return pass;
  };
  for (const p of pushes) {
    const walk = walkPath(player, p.from, walkPass(), w, h);
    // The walk must not push a box: boxes are walls in this BFS, and the
    // search that produced the push already proved reachability.
    if (walk === null) return null;
    for (const d of walk) {
      out += CH[d];
      player += DY[d] * w + DX[d];
    }
    const boxCell = p.from + DY[p.dir] * w + DX[p.dir];
    const dest = boxCell + DY[p.dir] * w + DX[p.dir];
    const bi = boxes.indexOf(boxCell);
    if (bi < 0) return null;
    boxes[bi] = dest;
    boxes.sort((a, b) => a - b);
    out += CH[p.dir];
    player = boxCell;
  }
  // Walk back out through the door to the entry hallway cell.
  const exitWalk = walkPath(player, room.door, walkPass(), w, h);
  if (exitWalk === null) return null;
  for (const d of exitWalk) {
    out += CH[d];
    player += DY[d] * w + DX[d];
  }
  // Step from the door into the hallway entry cell (skipped when the
  // fallback path uses the player's start as both door and entry).
  if (room.door !== room.entry) {
    const edx = (room.entry % w) - (room.door % w);
    const edy = ((room.entry / w) | 0) - ((room.door / w) | 0);
    const stepDir = edx === 1 ? 3 : edx === -1 ? 2 : edy === 1 ? 1 : 0;
    out += CH[stepDir];
  }
  return out;
}

// Solve one room. Returns both the cheapest plan (which may strand the
// player inside) and the cheapest plan that ends with the player back at
// the entry, so the caller can pick per room order.
function solveRoom(
  room: Room,
  level: Level,
): { opt: RoomPlan | null; exit: RoomPlan | null } {
  const { w, h } = level;
  const live = liveCells(room, level);
  const distToGoal: Int32Array[] = room.goals.map((g) => bfsDist(g, room.standable, w, h));

  const toPlan = (res: SearchResult | null, exitOk: boolean): RoomPlan | null => {
    if (res === null) return null;
    const moves = pushesToMoves(room, level, res.pushes);
    if (moves === null) return null;
    return { moves, pushes: res.pushes.length, exitOk };
  };

  // Cheapest plan, exit not required.
  let optRes = searchRoom(room, level, live, distToGoal, false, 1, OPT_BUDGET);
  if (optRes === null) optRes = searchRoom(room, level, live, distToGoal, false, 2, WEIGHTED_BUDGET);
  const opt = toPlan(optRes, false);
  // Recompute exit feasibility directly: replay pushes to get the final
  // boxes and player, then test the walk out.
  const exitOf = (res: SearchResult | null): boolean => {
    if (res === null) return false;
    const boxes = [...room.boxes].sort((a, b) => a - b);
    let player = room.entry;
    for (const p of res.pushes) {
      const boxCell = p.from + DY[p.dir] * w + DX[p.dir];
      const dest = boxCell + DY[p.dir] * w + DX[p.dir];
      const bi = boxes.indexOf(boxCell);
      if (bi < 0) return false;
      boxes[bi] = dest;
      boxes.sort((a, b) => a - b);
      player = boxCell;
    }
    const blocked = new Uint8Array(w * h);
    for (const b of boxes) blocked[b] = 1;
    if (blocked[room.door]) return false;
    const reach = reachableSet(player, room.standable, blocked, w, h);
    return reach[room.door] === 1;
  };
  if (opt !== null && exitOf(optRes)) opt.exitOk = true;

  // Cheapest plan that ends with the player able to leave.
  let exitRes = searchRoom(room, level, live, distToGoal, true, 1, OPT_BUDGET);
  if (exitRes === null) exitRes = searchRoom(room, level, live, distToGoal, true, 2, WEIGHTED_BUDGET);
  const exit = toPlan(exitRes, true);
  return { opt, exit };
}

// Replay a move string on a level; returns the push count when the replay
// is legal and ends solved, else null.
function replay(level: Level, moves: string): number | null {
  const { w, h, wall } = level;
  const box = new Uint8Array(w * h);
  for (const b of level.boxes) box[b] = 1;
  let player = level.player;
  let pushes = 0;
  for (let k = 0; k < moves.length; k++) {
    const c = moves[k].toLowerCase();
    const d = c === 'u' ? 0 : c === 'd' ? 1 : c === 'l' ? 2 : c === 'r' ? 3 : -1;
    if (d < 0) return null;
    const next = player + DY[d] * w + DX[d];
    if (wall[next]) return null;
    if (box[next]) {
      const beyond = next + DY[d] * w + DX[d];
      if (wall[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < w * h; i++) {
    if (box[i] && !level.goal[i]) return null;
  }
  return pushes;
}

function solveLevel(text: string): string {
  const level = parseLevel(text);
  const rooms = findRooms(level);
  if (rooms === null) {
    // Fallback: treat the whole level as one room (only feasible small).
    const all = new Uint8Array(level.w * level.h);
    for (let i = 0; i < level.w * level.h; i++) if (!level.wall[i]) all[i] = 1;
    const whole: Room = {
      cells: [],
      cellSet: all,
      standable: all,
      door: level.player,
      entry: level.player,
      boxes: [...level.boxes],
      goals: [],
    };
    for (let i = 0; i < level.w * level.h; i++) if (level.goal[i]) whole.goals.push(i);
    for (let i = 0; i < level.w * level.h; i++) if (!level.wall[i]) whole.cells.push(i);
    const { opt } = solveRoom(whole, level);
    if (opt === null) return '';
    const moves = opt.moves;
    return replay(level, moves) === null ? '' : moves;
  }

  // Solve every room both ways.
  const plans = rooms.map((room) => solveRoom(room, level));
  for (const p of plans) {
    if (p.opt === null && p.exit === null) return '';
  }

  // Order rooms: rooms that cannot be exited must come last (at most one
  // such room is expected); otherwise nearest door first from the player.
  const order = rooms.map((_, i) => i);
  const noExit = order.filter((i) => plans[i].exit === null);
  const withExit = order.filter((i) => plans[i].exit !== null);
  // Greedy nearest-first over the exitable rooms, then the no-exit rooms.
  const ordered: number[] = [];
  let cur = level.player;
  const remaining = [...withExit];
  while (remaining.length > 0) {
    let bestI = 0;
    let bestD = Infinity;
    for (let k = 0; k < remaining.length; k++) {
      const d = Math.abs((rooms[remaining[k]].entry % level.w) - (cur % level.w));
      if (d < bestD) {
        bestD = d;
        bestI = k;
      }
    }
    ordered.push(remaining[bestI]);
    cur = rooms[remaining[bestI]].entry;
    remaining.splice(bestI, 1);
  }
  ordered.push(...noExit);

  // Stitch: walk the hallway to each room, run its plan, walk out.
  let moves = '';
  let player = level.player;
  const globalBoxes = [...level.boxes].sort((a, b) => a - b);
  for (let oi = 0; oi < ordered.length; oi++) {
    const ri = ordered[oi];
    const room = rooms[ri];
    const last = oi === ordered.length - 1;
    // Use the exit plan unless this is the last room and the cheaper
    // unconstrained plan exists (the player need not leave at the end).
    let plan = plans[ri].exit;
    if (last && plans[ri].opt !== null) {
      if (plan === null || plans[ri].opt.pushes < plan.pushes) plan = plans[ri].opt;
    }
    if (plan === null) plan = plans[ri].opt;
    if (plan === null) return '';
    // Walk to the room's entry cell (boxes are walls).
    const pass = new Uint8Array(level.w * level.h);
    for (let i = 0; i < level.w * level.h; i++) pass[i] = level.wall[i] ? 0 : 1;
    for (const b of globalBoxes) pass[b] = 0;
    pass[room.entry] = 1;
    const walk = walkPath(player, room.entry, pass, level.w, level.h);
    if (walk === null) return '';
    for (const d of walk) {
      moves += CH[d];
      player += DY[d] * level.w + DX[d];
    }
    moves += plan.moves;
    player = room.entry;
    // Update the global boxes: this room's boxes are now on its goals.
    for (const b of room.boxes) {
      const gi = globalBoxes.indexOf(b);
      if (gi >= 0) globalBoxes.splice(gi, 1);
    }
    for (const g of room.goals) globalBoxes.push(g);
    globalBoxes.sort((a, b) => a - b);
  }
  return replay(level, moves) === null ? '' : moves;
}

for (const id of readdirSync(I).sort()) {
  const moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'));
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
