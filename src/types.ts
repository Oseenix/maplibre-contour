import type Actor from "./actor";
import type { Timer } from "./performance";
import type WorkerDispatch from "./worker-dispatch";

/** Scheme used to map pixel rgb values elevations. */
export type Encoding = "terrarium" | "mapbox";
export interface IsTransferrable {
  transferrables: Transferable[];
}
/** A decoded `raster-rgb` image. */
export interface DemTile {
  width: number;
  height: number;
  /** elevation values in row-major order */
  data: Float32Array;
}
export interface TransferrableDemTile extends DemTile, IsTransferrable {}
/** A rendered contour tile */
export interface ContourTile {
  /** Encoded mapbox vector tile bytes */
  arrayBuffer: ArrayBuffer;
}
export interface TransferrableContourTile
  extends ContourTile,
    IsTransferrable {}

/** A rendered pressure-center point vector tile. */
export interface PressureCenterTile {
  /** Encoded mapbox vector tile bytes */
  arrayBuffer: ArrayBuffer;
}
export interface TransferrablePressureCenterTile
  extends PressureCenterTile,
    IsTransferrable {}

export type PressureCenterKind = "H" | "L";

export interface PressureCenter {
  /** Center kind: high pressure or low pressure. */
  kind: PressureCenterKind;
  /** Whether this point is an accepted center, rejected candidate, or debug probe. */
  status?: "accepted" | "rejected" | "probe";
  /** Rejection reason when status is rejected. */
  rejectReason?: string;
  /** Normalized world x coordinate in [0, 1). */
  x: number;
  /** Normalized world y coordinate in [0, 1). */
  y: number;
  /** Raw pressure at the center, in hPa. */
  pressure: number;
  /** Smoothed pressure used by the detector, in hPa. */
  smoothPressure?: number;
  /** Pressure-system prominence relative to the separating saddle, in hPa. */
  prominence: number;
  /** Collision priority and diagnostic score. */
  confidence: number;
  /** Near-closed contour angular coverage score in [0, 1]. */
  closedContourScore: number;
  /** Estimated separating saddle pressure, in hPa. */
  saddlePressure: number;
  /** Number of enclosing isobar levels confirmed by topology flood fill. */
  closedLevels?: number;
  /** First enclosing isobar level, in hPa. */
  enclosingLevel?: number;
  /** Approximate enclosed area, in square kilometers. */
  areaKm2?: number;
  /** Algorithm version that produced this feature. */
  algorithmVersion: number;
}

export interface FetchResponse {
  data: Blob;
  expires?: string;
  cacheControl?: string;
}

export interface DemSourceSnapshot {
  key: string;
  urlPattern: string;
}

/** Parameters to use when creating a contour vector tile from raw elevation data */
export interface ContourTileOptions {
  /** Factor to scale the elevation meters by to support different units (default 1 for meters) */
  multiplier?: number;
  /**
   * Request `raster-dem` tiles from lower zoom levels to generate the contour vector tile.
   *
   * The default value is 0, which means to generate a contour vector tile at z10, it gets
   * the z10 `raster-dem` tile plus its 8 neighbors
   *
   * Setting to 1 requests a z9 tile and uses one quadrant of it so that it only needs up to 3
   * neighboring tiles to get the neighboring elevation data. It also improves performance with
   * 512x512 or larger `raster-dem` tiles.
   */
  overzoom?: number;
  /** Key for the elevation property to set on each contour line. */
  elevationKey?: string;
  /** Key for the "level" property to set on each contour line. Minor lines have level=0, major have level=1 */
  levelKey?: string;
  /** Name of the vector tile layer to put contour lines in */
  contourLayer?: string;
  /** Grid size of the vector tile (default 4096) */
  extent?: number;
  /** How many pixels to generate on each tile into the neighboring tile to reduce rendering artifacts */
  buffer?: number;
  /** When overzooming tiles, subsample to scale up to at least this size to make the contour lines smoother at higher zooms. */
  subsampleBelow?: number;
}

export interface GlobalContourTileOptions extends ContourTileOptions {
  /**
   * Map from zoom level to the `[minor, major]` elevation distance between contour lines.
   *
   * Contour lines without an entry will use the threshold for the next lower zoom.
   *
   * The `level` tag on each contour line will have an integer that corresponds to the largest index in
   * this array that the elevation is a multiple of.
   */
  thresholds: { [n: number]: number | number[] };
}

export interface IndividualContourTileOptions extends ContourTileOptions {
  levels: number[];
}

export interface PressureCenterOptions {
  /** Name of the vector tile layer that contains H/L point features. */
  pressureCenterLayer?: string;
  /** Grid size of the vector tile (default 4096). */
  extent?: number;
  /** Gaussian smoothing scale used for synoptic pressure-system recognition. */
  smoothingKm?: number;
  /** Minimum pressure prominence required for a valid H/L system. */
  minProminenceHpa?: number;
  /** Minimum number of closed or near-closed levels around a system center. */
  minClosedLevels?: number;
  /** Angular coverage required for near-closed isobar validation. */
  nearClosedAngleDeg?: number;
  /** Main isobar step used for closed-contour validation. */
  levelStepHpa?: number;
  /** Bumps cache keys when the detector changes. */
  algorithmVersion?: number;
  /** Include rejected H/L candidates for map debugging. */
  debugCandidates?: boolean;
  /** Include dense diagnostic probes for areas that are not pressure extrema. */
  debugDenseProbes?: boolean;
}

export interface Image {
  width: number;
  height: number;
  data: Uint8Array;
}

export type TimingCategory = "main" | "worker" | "fetch" | "decode" | "isoline";

/** Performance profile for a tile request */
export interface Timing {
  /** The "virtual" tile url using the protocol ID registered with maplibre */
  url: string;
  /** Timing origin that all marks are relative to. */
  origin: number;
  /** Overall duration of the request */
  duration: number;
  /** Time spent fetching all resources, or `undefined` if they were cached */
  fetch?: number;
  /** Time spent decoding all raster-rgb images, or `undefined` if it was cached */
  decode?: number;
  /** Time spent generating isolines and rendering the vector tile, or `undefined` if it was cached */
  process?: number;
  wait: number;
  /** Number of tiles used for generation, even if they were cached */
  tilesUsed: number;
  /** Map from category (fetch, main, isoline) to list of start/end timestamps */
  marks: {
    [key in TimingCategory]?: number[][];
  };
  /** Detailed timing for all resources actually fetched (not cached) to generate this tile */
  resources: PerformanceResourceTiming[];
  /** If the tile failed with an error */
  error?: boolean;
}

/**
 * Holds cached tile state, and exposes `fetchContourTile` which fetches the necessary
 * tiles and returns an encoded contour vector tiles.
 */
export interface DemManager {
  loaded: Promise<any>;
  fetchTile(
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<FetchResponse>;
  fetchAndParseTile(
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<DemTile>;
  fetchContourTile(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<ContourTile>;
  fetchPressureCenterTile(
    z: number,
    x: number,
    y: number,
    options: PressureCenterOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<PressureCenterTile>;
  preloadPressureCenters(
    source: DemSourceSnapshot,
    options: PressureCenterOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<void>;
  /** Switches to a DEM tile source and returns false when the active source is unchanged */
  setSource(source: DemSourceSnapshot): boolean;
  /** Updates the DEM tile URL pattern */
  updateUrl(url: string): void;
}

export type GetTileFunction = (
  url: string,
  abortController: AbortController,
) => Promise<FetchResponse>;

export type DecodeImageFunction = (
  blob: Blob,
  encoding: Encoding,
  abortController: AbortController,
) => Promise<DemTile>;

export type DemManagerRequiredInitializationParameters = {
  source: DemSourceSnapshot;
  cacheSize: number;
  encoding: Encoding;
  maxzoom: number;
  timeoutMs: number;
};

export type DemManagerInitizlizationParameters =
  DemManagerRequiredInitializationParameters & {
    decodeImage?: DecodeImageFunction;
    getTile?: GetTileFunction;
    actor?: Actor<WorkerDispatch>;
  };

export type InitMessage = DemManagerRequiredInitializationParameters & {
  managerId: number;
};
