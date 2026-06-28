import type { HeightTile } from "./height-tile";
import encodeVectorTile, { GeomType } from "./vtpbf";
import type {
  PressureCenter,
  PressureCenterOptions,
  PressureCenterTile,
} from "./types";

const DEFAULT_EXTENT = 4096;
const DEFAULT_LAYER = "pressure-centers";
const DEFAULT_SMOOTHING_KM = 250;
const DEFAULT_MIN_PROMINENCE_HPA = 2;
const DEFAULT_LEVEL_STEP_HPA = 4;
const DEFAULT_ALGORITHM_VERSION = 2;
const EARTH_CIRCUMFERENCE_KM = 40075;
const MIN_VALID_PRESSURE = 800;
const MAX_VALID_PRESSURE = 1200;
const MIN_SAMPLE_RADIUS = 3;
const PLATEAU_EPSILON_HPA = 0.05;
const PROMINENCE_BUCKET_HPA = 0.5;
const MAX_DEBUG_REJECTED_PER_KIND = 320;
const MAX_DEBUG_PROBES = 1200;

type CandidateKind = "H" | "L";
type CandidateStatus = "accepted" | "rejected" | "probe";

interface Candidate {
  kind: CandidateKind;
  index: number;
  x: number;
  y: number;
  pressure: number;
  smoothPressure: number;
  prominence: number;
  saddlePressure: number;
  closedContourScore: number;
  closedLevels: number;
  enclosingLevel: number;
  areaKm2: number;
  confidence: number;
  status?: CandidateStatus;
  rejectReason?: string;
}

interface NormalizedOptions {
  pressureCenterLayer: string;
  extent: number;
  smoothingKm: number;
  minProminenceHpa: number;
  minClosedLevels: number;
  levelStepHpa: number;
  algorithmVersion: number;
  debugCandidates: boolean;
  debugDenseProbes: boolean;
}

interface ClosedContourResult {
  closedLevels: number;
  enclosingLevel: number;
  areaKm2: number;
  touchedBoundary: boolean;
}

interface FloodScratch {
  visited: Uint32Array;
  queue: Int32Array;
  stamp: number;
}

function normalizeOptions(options: PressureCenterOptions): NormalizedOptions {
  return {
    pressureCenterLayer: options.pressureCenterLayer || DEFAULT_LAYER,
    extent: options.extent || DEFAULT_EXTENT,
    smoothingKm: options.smoothingKm || DEFAULT_SMOOTHING_KM,
    minProminenceHpa: options.minProminenceHpa || DEFAULT_MIN_PROMINENCE_HPA,
    minClosedLevels: options.minClosedLevels || 1,
    levelStepHpa: options.levelStepHpa || DEFAULT_LEVEL_STEP_HPA,
    algorithmVersion: options.algorithmVersion || DEFAULT_ALGORITHM_VERSION,
    debugCandidates: options.debugCandidates === true,
    debugDenseProbes: options.debugDenseProbes === true,
  };
}

function isValidPressure(value: number): boolean {
  return (
    Number.isFinite(value) &&
    value > MIN_VALID_PRESSURE &&
    value < MAX_VALID_PRESSURE
  );
}

function pressureAt(data: Float32Array, width: number, x: number, y: number) {
  return data[y * width + x];
}

function setPressure(
  data: Float32Array,
  width: number,
  x: number,
  y: number,
  value: number,
) {
  data[y * width + x] = value;
}

function wrappedX(x: number, width: number) {
  return ((x % width) + width) % width;
}

function mercatorLatitudeAtY(y: number, height: number): number {
  const normalizedY = (y + 0.5) / height;
  const n = Math.PI - 2 * Math.PI * normalizedY;
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
}

function smoothingRadiusPixelsAtY(
  smoothingKm: number,
  width: number,
  height: number,
  y: number,
): number {
  const latitude = mercatorLatitudeAtY(y, height);
  const cosLatitude = Math.max(0.18, Math.cos((latitude * Math.PI) / 180));
  const kmPerPixel = (EARTH_CIRCUMFERENCE_KM * cosLatitude) / width;
  return Math.max(1, Math.round(smoothingKm / kmPerPixel));
}

function gaussianKernel(radius: number): Float32Array {
  const sigma = Math.max(1, radius / 2);
  const kernel = new Float32Array(radius * 2 + 1);
  let sum = 0;
  for (let i = -radius; i <= radius; i++) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    sum += value;
  }
  for (let i = 0; i < kernel.length; i++) {
    kernel[i] /= sum;
  }
  return kernel;
}

function smoothPressure(tile: HeightTile, smoothingKm: number): Float32Array {
  const width = tile.width;
  const height = tile.height;
  const source = new Float32Array(width * height);
  const horizontal = new Float32Array(width * height);
  const output = new Float32Array(width * height);
  const kernels = new Map<number, Float32Array>();

  const kernelForRadius = (radius: number) => {
    let kernel = kernels.get(radius);
    if (!kernel) {
      kernel = gaussianKernel(radius);
      kernels.set(radius, kernel);
    }
    return kernel;
  };

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      source[y * width + x] = tile.get(x, y);
    }
  }

  // 中文注释：WebMercator 的地面分辨率随纬度变化，平滑半径按行修正，避免高纬系统被误抹平。
  for (let y = 0; y < height; y++) {
    const radius = smoothingRadiusPixelsAtY(smoothingKm, width, height, y);
    const kernel = kernelForRadius(radius);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let weight = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = wrappedX(x + k, width);
        const value = pressureAt(source, width, xx, y);
        if (!isValidPressure(value)) continue;
        const w = kernel[k + radius];
        sum += value * w;
        weight += w;
      }
      setPressure(horizontal, width, x, y, weight ? sum / weight : NaN);
    }
  }

  for (let y = 0; y < height; y++) {
    const radius = smoothingRadiusPixelsAtY(smoothingKm, width, height, y);
    const kernel = kernelForRadius(radius);
    for (let x = 0; x < width; x++) {
      let sum = 0;
      let weight = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = y + k;
        if (yy < 0 || yy >= height) continue;
        const value = pressureAt(horizontal, width, x, yy);
        if (!isValidPressure(value)) continue;
        const w = kernel[k + radius];
        sum += value * w;
        weight += w;
      }
      setPressure(output, width, x, y, weight ? sum / weight : NaN);
    }
  }

  return output;
}

function localRawPressure(
  tile: HeightTile,
  width: number,
  height: number,
  x: number,
  y: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dy = -1; dy <= 1; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -1; dx <= 1; dx++) {
      const value = tile.get(wrappedX(x + dx, width), yy);
      if (!isValidPressure(value)) continue;
      sum += value;
      count++;
    }
  }
  return count ? sum / count : tile.get(x, y);
}

function collectPlateauCandidate(
  tile: HeightTile,
  data: Float32Array,
  visited: Uint8Array,
  queue: Int32Array,
  width: number,
  height: number,
  startIndex: number,
  kind: CandidateKind,
): Candidate | undefined {
  if (visited[startIndex]) return undefined;
  const startPressure = data[startIndex];
  if (!isValidPressure(startPressure)) return undefined;

  const plateau: number[] = [];
  let head = 0;
  let tail = 0;
  let hasBetterNeighbor = false;
  let hasWorseNeighbor = false;
  let bestIndex = startIndex;
  let bestPressure = startPressure;
  queue[tail++] = startIndex;
  visited[startIndex] = 1;

  while (head < tail) {
    const index = queue[head++];
    const value = data[index];
    const x = index % width;
    const y = Math.floor(index / width);
    plateau.push(index);
    if (
      (kind === "H" && value > bestPressure) ||
      (kind === "L" && value < bestPressure)
    ) {
      bestPressure = value;
      bestIndex = index;
    }

    // 中文注释：候选扫描在全球网格上运行，邻居遍历避免创建临时数组，降低时间切换时的 GC 压力。
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= height) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const neighborIndex = yy * width + wrappedX(x + dx, width);
        const neighbor = data[neighborIndex];
        if (!isValidPressure(neighbor)) continue;
        if (Math.abs(neighbor - startPressure) <= PLATEAU_EPSILON_HPA) {
          if (!visited[neighborIndex]) {
            visited[neighborIndex] = 1;
            queue[tail++] = neighborIndex;
          }
        } else if (kind === "H") {
          hasBetterNeighbor ||= neighbor > startPressure + PLATEAU_EPSILON_HPA;
          hasWorseNeighbor ||= neighbor < startPressure - PLATEAU_EPSILON_HPA;
        } else {
          hasBetterNeighbor ||= neighbor < startPressure - PLATEAU_EPSILON_HPA;
          hasWorseNeighbor ||= neighbor > startPressure + PLATEAU_EPSILON_HPA;
        }
      }
    }
  }

  if (hasBetterNeighbor || !hasWorseNeighbor) return undefined;

  const x = bestIndex % width;
  const y = Math.floor(bestIndex / width);
  return {
    kind,
    index: bestIndex,
    x,
    y,
    pressure: localRawPressure(tile, width, height, x, y),
    smoothPressure: bestPressure,
    prominence: 0,
    saddlePressure: bestPressure,
    closedContourScore: 0,
    closedLevels: 0,
    enclosingLevel: 0,
    areaKm2: 0,
    confidence: plateau.length,
  };
}

function findExtremaCandidates(
  tile: HeightTile,
  smoothed: Float32Array,
): Candidate[] {
  const width = tile.width;
  const height = tile.height;
  const candidates: Candidate[] = [];

  for (const kind of ["H", "L"] as CandidateKind[]) {
    const visited = new Uint8Array(width * height);
    const queue = new Int32Array(width * height);
    for (let y = 1; y < height - 1; y++) {
      for (let x = 0; x < width; x++) {
        const candidate = collectPlateauCandidate(
          tile,
          smoothed,
          visited,
          queue,
          width,
          height,
          y * width + x,
          kind,
        );
        if (candidate) candidates.push(candidate);
      }
    }
  }

  return candidates;
}

function buildPressureBuckets(data: Float32Array): {
  buckets: number[][];
  minPressure: number;
  maxPressure: number;
} {
  const bucketCount =
    Math.ceil(
      (MAX_VALID_PRESSURE - MIN_VALID_PRESSURE) / PROMINENCE_BUCKET_HPA,
    ) + 1;
  const buckets = Array.from({ length: bucketCount }, () => [] as number[]);
  let minPressure = Infinity;
  let maxPressure = -Infinity;

  for (let index = 0; index < data.length; index++) {
    const value = data[index];
    if (!isValidPressure(value)) continue;
    const bucket = Math.min(
      bucketCount - 1,
      Math.max(
        0,
        Math.floor((value - MIN_VALID_PRESSURE) / PROMINENCE_BUCKET_HPA),
      ),
    );
    buckets[bucket].push(index);
    minPressure = Math.min(minPressure, value);
    maxPressure = Math.max(maxPressure, value);
  }

  return { buckets, minPressure, maxPressure };
}

function computeSaddleProminence(
  data: Float32Array,
  width: number,
  height: number,
  candidates: Candidate[],
  kind: CandidateKind,
) {
  const parent = new Int32Array(data.length);
  const rank = new Uint8Array(data.length);
  const active = new Uint8Array(data.length);
  const peakIdByRoot = new Int32Array(data.length);
  const candidateAtPixel = new Int32Array(data.length);
  parent.fill(-1);
  peakIdByRoot.fill(-1);
  candidateAtPixel.fill(-1);

  const kindCandidates = candidates
    .map((candidate, id) => ({ candidate, id }))
    .filter(({ candidate }) => candidate.kind === kind);
  for (const { candidate, id } of kindCandidates) {
    candidateAtPixel[candidate.index] = id;
  }

  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== index) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };

  const strongerCandidateId = (a: number, b: number): number => {
    const pressureA = candidates[a].smoothPressure;
    const pressureB = candidates[b].smoothPressure;
    if (kind === "H") return pressureA >= pressureB ? a : b;
    return pressureA <= pressureB ? a : b;
  };

  const merge = (a: number, b: number, saddlePressure: number) => {
    let rootA = find(a);
    let rootB = find(b);
    if (rootA === rootB) return;

    const peakA = peakIdByRoot[rootA];
    const peakB = peakIdByRoot[rootB];
    let survivingPeak = peakA >= 0 ? peakA : peakB;
    if (peakA >= 0 && peakB >= 0 && peakA !== peakB) {
      survivingPeak = strongerCandidateId(peakA, peakB);
      const weakerPeak = survivingPeak === peakA ? peakB : peakA;
      const weaker = candidates[weakerPeak];
      if (weaker.prominence === 0) {
        weaker.saddlePressure = saddlePressure;
        weaker.prominence =
          kind === "H"
            ? weaker.smoothPressure - saddlePressure
            : saddlePressure - weaker.smoothPressure;
      }
    }

    if (rank[rootA] < rank[rootB]) {
      const tmp = rootA;
      rootA = rootB;
      rootB = tmp;
    }
    parent[rootB] = rootA;
    if (rank[rootA] === rank[rootB]) rank[rootA]++;
    peakIdByRoot[rootA] = survivingPeak;
  };

  const { buckets, minPressure, maxPressure } = buildPressureBuckets(data);
  const start = kind === "H" ? buckets.length - 1 : 0;
  const end = kind === "H" ? -1 : buckets.length;
  const step = kind === "H" ? -1 : 1;

  for (let bucketIndex = start; bucketIndex !== end; bucketIndex += step) {
    const bucket = buckets[bucketIndex];
    const level = MIN_VALID_PRESSURE + bucketIndex * PROMINENCE_BUCKET_HPA;
    for (const index of bucket) {
      active[index] = 1;
      parent[index] = index;
      peakIdByRoot[index] = candidateAtPixel[index];
    }
    for (const index of bucket) {
      const x = index % width;
      const y = Math.floor(index / width);
      const left = y * width + wrappedX(x - 1, width);
      const right = y * width + wrappedX(x + 1, width);
      if (y > 0 && active[index - width]) merge(index, index - width, level);
      if (y < height - 1 && active[index + width]) {
        merge(index, index + width, level);
      }
      if (active[left]) merge(index, left, level);
      if (active[right]) merge(index, right, level);
    }
  }

  for (const { candidate } of kindCandidates) {
    if (candidate.prominence > 0) continue;
    candidate.saddlePressure = kind === "H" ? minPressure : maxPressure;
    candidate.prominence =
      kind === "H"
        ? candidate.smoothPressure - candidate.saddlePressure
        : candidate.saddlePressure - candidate.smoothPressure;
  }
}

function candidateCellAreaKm2(
  width: number,
  height: number,
  y: number,
): number {
  const latitude = mercatorLatitudeAtY(y, height);
  const cosLatitude = Math.max(0.01, Math.cos((latitude * Math.PI) / 180));
  const kmPerPixel = (EARTH_CIRCUMFERENCE_KM * cosLatitude) / width;
  return kmPerPixel * kmPerPixel;
}

function firstClosedLevel(
  candidate: Candidate,
  options: NormalizedOptions,
): number {
  const step = options.levelStepHpa;
  if (candidate.kind === "H") {
    const level = Math.floor((candidate.smoothPressure - 0.01) / step) * step;
    return Math.min(level, candidate.smoothPressure - 0.25);
  }
  const level = Math.ceil((candidate.smoothPressure + 0.01) / step) * step;
  return Math.max(level, candidate.smoothPressure + 0.25);
}

function floodClosedContour(
  data: Float32Array,
  width: number,
  height: number,
  candidate: Candidate,
  level: number,
  scratch: FloodScratch,
): { closed: boolean; touchedBoundary: boolean; areaCells: number } {
  scratch.stamp++;
  if (scratch.stamp >= 4294967294) {
    scratch.visited.fill(0);
    scratch.stamp = 1;
  }

  const accepts = (value: number) =>
    isValidPressure(value) &&
    (candidate.kind === "H" ? value >= level : value <= level);

  if (!accepts(data[candidate.index])) {
    return { closed: false, touchedBoundary: false, areaCells: 0 };
  }

  let head = 0;
  let tail = 0;
  let touchedBoundary = false;
  const maxAreaBeforeOpen = Math.floor(width * height * 0.45);
  scratch.queue[tail++] = candidate.index;
  scratch.visited[candidate.index] = scratch.stamp;
  const maybePush = (neighbor: number) => {
    if (neighbor < 0 || scratch.visited[neighbor] === scratch.stamp) return;
    if (!accepts(data[neighbor])) return;
    scratch.visited[neighbor] = scratch.stamp;
    scratch.queue[tail++] = neighbor;
  };

  while (head < tail) {
    const index = scratch.queue[head++];
    const x = index % width;
    const y = Math.floor(index / width);
    if (y === 0 || y === height - 1) touchedBoundary = true;
    if (tail > maxAreaBeforeOpen) {
      return { closed: false, touchedBoundary: true, areaCells: tail };
    }

    if (y > 0) maybePush(index - width);
    if (y < height - 1) maybePush(index + width);
    maybePush(y * width + wrappedX(x - 1, width));
    maybePush(y * width + wrappedX(x + 1, width));
  }

  return { closed: !touchedBoundary, touchedBoundary, areaCells: tail };
}

function validateClosedContours(
  data: Float32Array,
  width: number,
  height: number,
  candidate: Candidate,
  options: NormalizedOptions,
  scratch: FloodScratch,
): ClosedContourResult {
  const step = options.levelStepHpa;
  const firstLevel = firstClosedLevel(candidate, options);
  const direction = candidate.kind === "H" ? -1 : 1;
  const maxAttempts = Math.max(4, options.minClosedLevels + 3);
  let closedLevels = 0;
  let enclosingLevel = 0;
  let areaKm2 = 0;
  let touchedBoundary = false;

  // 中文注释：闭合验证用连通域拓扑，不再用径向采样近似；开放槽/脊会连到边界而被拒绝。
  for (let i = 0; i < maxAttempts; i++) {
    const level = firstLevel + direction * step * i;
    const offset = Math.abs(candidate.smoothPressure - level);
    if (offset > Math.max(step, candidate.prominence + step * 0.5)) break;
    const result = floodClosedContour(
      data,
      width,
      height,
      candidate,
      level,
      scratch,
    );
    touchedBoundary ||= result.touchedBoundary;
    if (result.closed) {
      closedLevels++;
      if (!enclosingLevel) enclosingLevel = level;
      if (!areaKm2) {
        areaKm2 =
          result.areaCells * candidateCellAreaKm2(width, height, candidate.y);
      }
      if (closedLevels >= options.minClosedLevels) break;
    }
  }

  return { closedLevels, enclosingLevel, areaKm2, touchedBoundary };
}

function localPressureRange(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
  radius: number,
): number {
  let min = Infinity;
  let max = -Infinity;
  for (let dy = -radius; dy <= radius; dy++) {
    const yy = y + dy;
    if (yy < 0 || yy >= height) continue;
    for (let dx = -radius; dx <= radius; dx++) {
      const value = pressureAt(data, width, wrappedX(x + dx, width), yy);
      if (!isValidPressure(value)) continue;
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }
  return Number.isFinite(min) && Number.isFinite(max) ? max - min : 0;
}

function dominantCurvatureKind(
  data: Float32Array,
  width: number,
  height: number,
  x: number,
  y: number,
): CandidateKind {
  const c = pressureAt(data, width, x, y);
  const xx =
    pressureAt(data, width, wrappedX(x - 1, width), y) -
    2 * c +
    pressureAt(data, width, wrappedX(x + 1, width), y);
  const yy =
    y > 0 && y < height - 1
      ? pressureAt(data, width, x, y - 1) -
        2 * c +
        pressureAt(data, width, x, y + 1)
      : 0;
  return xx + yy < 0 ? "H" : "L";
}

function makeDenseProbes(
  tile: HeightTile,
  smoothed: Float32Array,
  options: NormalizedOptions,
): Candidate[] {
  if (!options.debugCandidates || !options.debugDenseProbes) return [];
  const width = tile.width;
  const height = tile.height;
  const radius = Math.max(
    MIN_SAMPLE_RADIUS,
    smoothingRadiusPixelsAtY(options.smoothingKm, width, height, height / 2),
  );
  const step = Math.max(8, Math.round(radius * 0.85));
  const rangeRadius = Math.max(3, Math.round(radius * 0.6));
  const probes: Candidate[] = [];

  for (let y = radius; y < height - radius; y += step) {
    for (let x = 0; x < width; x += step) {
      const smoothPressure = pressureAt(smoothed, width, x, y);
      const pressure = tile.get(x, y);
      if (!isValidPressure(smoothPressure) || !isValidPressure(pressure))
        continue;
      const range = localPressureRange(
        smoothed,
        width,
        height,
        x,
        y,
        rangeRadius,
      );
      if (range < options.minProminenceHpa * 0.5) continue;
      probes.push({
        kind: dominantCurvatureKind(smoothed, width, height, x, y),
        index: y * width + x,
        x,
        y,
        pressure,
        smoothPressure,
        prominence: range,
        saddlePressure: smoothPressure,
        closedContourScore: 0,
        closedLevels: 0,
        enclosingLevel: 0,
        areaKm2: 0,
        confidence: range,
        status: "probe",
        rejectReason: "not_pressure_center",
      });
      if (probes.length >= MAX_DEBUG_PROBES) return probes;
    }
  }

  return probes;
}

function classifyCandidates(
  tile: HeightTile,
  smoothed: Float32Array,
  options: NormalizedOptions,
): { accepted: Candidate[]; rejected: Candidate[]; probes: Candidate[] } {
  const width = tile.width;
  const height = tile.height;
  const candidates = findExtremaCandidates(tile, smoothed);
  computeSaddleProminence(smoothed, width, height, candidates, "H");
  computeSaddleProminence(smoothed, width, height, candidates, "L");

  const accepted: Candidate[] = [];
  const rejected: Candidate[] = [];
  const rejectedCount: Record<CandidateKind, number> = { H: 0, L: 0 };
  const scratch: FloodScratch = {
    visited: new Uint32Array(width * height),
    queue: new Int32Array(width * height),
    stamp: 0,
  };

  const pushRejected = (candidate: Candidate) => {
    if (!options.debugCandidates) return;
    if (rejectedCount[candidate.kind] >= MAX_DEBUG_REJECTED_PER_KIND) return;
    rejectedCount[candidate.kind] += 1;
    rejected.push(candidate);
  };

  for (const candidate of candidates) {
    if (!isValidPressure(candidate.pressure)) {
      candidate.status = "rejected";
      candidate.rejectReason = "invalid_pressure";
      pushRejected(candidate);
      continue;
    }

    if (candidate.prominence < options.minProminenceHpa) {
      candidate.status = "rejected";
      candidate.rejectReason =
        candidate.saddlePressure === candidate.smoothPressure
          ? "weak_prominence"
          : "merged_by_saddle";
      candidate.confidence = Math.max(0, candidate.prominence);
      pushRejected(candidate);
      continue;
    }

    const closed = validateClosedContours(
      smoothed,
      width,
      height,
      candidate,
      options,
      scratch,
    );
    candidate.closedLevels = closed.closedLevels;
    candidate.enclosingLevel = closed.enclosingLevel;
    candidate.areaKm2 = closed.areaKm2;
    candidate.closedContourScore =
      closed.closedLevels / Math.max(1, options.minClosedLevels);

    if (closed.closedLevels < options.minClosedLevels) {
      candidate.status = "rejected";
      candidate.rejectReason = closed.touchedBoundary
        ? "open_contour"
        : "boundary_leak";
      candidate.confidence =
        candidate.prominence * 10 + candidate.closedContourScore * 20;
      pushRejected(candidate);
      continue;
    }

    candidate.status = "accepted";
    candidate.confidence =
      candidate.prominence * 20 +
      candidate.closedLevels * 30 +
      Math.min(30, Math.log10(Math.max(1, candidate.areaKm2)) * 8);
    accepted.push(candidate);
  }

  return {
    accepted,
    rejected,
    probes: makeDenseProbes(tile, smoothed, options),
  };
}

function toPressureCenter(
  candidate: Candidate,
  tile: HeightTile,
  options: NormalizedOptions,
): PressureCenter {
  return {
    kind: candidate.kind,
    status: candidate.status || "accepted",
    rejectReason: candidate.rejectReason,
    x: candidate.x / tile.width,
    y: candidate.y / Math.max(1, tile.height - 1),
    pressure: candidate.pressure,
    smoothPressure: candidate.smoothPressure,
    prominence: candidate.prominence,
    confidence: candidate.confidence,
    closedContourScore: candidate.closedContourScore,
    closedLevels: candidate.closedLevels,
    enclosingLevel: candidate.enclosingLevel,
    areaKm2: candidate.areaKm2,
    saddlePressure: candidate.saddlePressure,
    algorithmVersion: options.algorithmVersion,
  };
}

export function detectPressureCenters(
  tile: HeightTile,
  _sourceZoom: number,
  rawOptions: PressureCenterOptions,
): PressureCenter[] {
  const options = normalizeOptions(rawOptions);
  const smoothed = smoothPressure(tile, options.smoothingKm);
  const { accepted, rejected, probes } = classifyCandidates(
    tile,
    smoothed,
    options,
  );
  const acceptedCenters = accepted.map((candidate) =>
    toPressureCenter(candidate, tile, options),
  );
  const rejectedCenters = options.debugCandidates
    ? rejected.map((candidate) => toPressureCenter(candidate, tile, options))
    : [];
  const probeCenters =
    options.debugCandidates && options.debugDenseProbes
      ? probes.map((candidate) => toPressureCenter(candidate, tile, options))
      : [];

  return [...acceptedCenters, ...rejectedCenters, ...probeCenters];
}

function centerIntersectsTile(
  center: PressureCenter,
  z: number,
  x: number,
  y: number,
): boolean {
  const scale = 1 << z;
  const tileMinX = x / scale;
  const tileMaxX = (x + 1) / scale;
  const tileMinY = y / scale;
  const tileMaxY = (y + 1) / scale;
  return (
    center.x >= tileMinX &&
    center.x < tileMaxX &&
    center.y >= tileMinY &&
    center.y < tileMaxY
  );
}

function centerToTileGeometry(
  center: PressureCenter,
  z: number,
  x: number,
  y: number,
  extent: number,
): number[][] {
  const scale = 1 << z;
  const localX = center.x * scale - x;
  const localY = center.y * scale - y;
  return [[Math.round(localX * extent), Math.round(localY * extent)]];
}

function rounded(value: number | undefined, digits = 1): number {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round((value || 0) * scale) / scale;
}

export function encodePressureCenterTile(
  allCenters: PressureCenter[],
  z: number,
  x: number,
  y: number,
  rawOptions: PressureCenterOptions,
): PressureCenterTile {
  const options = normalizeOptions(rawOptions);
  const features = allCenters
    .filter((center) => centerIntersectsTile(center, z, x, y))
    .map((center) => ({
      type: GeomType.POINT,
      geometry: centerToTileGeometry(center, z, x, y, options.extent),
      properties: {
        kind: center.kind,
        status: center.status || "accepted",
        rejectReason: center.rejectReason || "",
        pressure: rounded(center.pressure),
        smoothPressure: rounded(center.smoothPressure),
        prominence: rounded(center.prominence),
        confidence: Math.round(center.confidence),
        closedContourScore: rounded(center.closedContourScore, 2),
        closedLevels: center.closedLevels || 0,
        enclosingLevel: rounded(center.enclosingLevel),
        areaKm2: Math.round(center.areaKm2 || 0),
        saddlePressure: rounded(center.saddlePressure),
        algorithmVersion: center.algorithmVersion,
      },
    }));

  const tile = encodeVectorTile({
    extent: options.extent,
    layers: {
      [options.pressureCenterLayer]: {
        features,
      },
    },
  });

  return { arrayBuffer: tile.slice().buffer };
}
