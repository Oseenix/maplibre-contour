import AsyncCache from "./cache";
import defaultDecodeImage from "./decode-image";
import { HeightTile } from "./height-tile";
import generateIsolines from "./isolines";
import {
  encodeIndividualOptions,
  encodePressureCenterOptions,
  isAborted,
  withTimeout,
} from "./utils";
import {
  detectPressureCenters,
  encodePressureCenterTile,
} from "./pressure-centers";
import type {
  ContourTile,
  DecodeImageFunction,
  DemManager,
  DemManagerInitizlizationParameters,
  DemSourceSnapshot,
  DemTile,
  Encoding,
  FetchResponse,
  GetTileFunction,
  IndividualContourTileOptions,
  PressureCenter,
  PressureCenterOptions,
  PressureCenterTile,
} from "./types";
import encodeVectorTile, { GeomType } from "./vtpbf";
import { Timer } from "./performance";

const defaultGetTile: GetTileFunction = async (
  url: string,
  abortController: AbortController,
) => {
  const options: RequestInit = {
    signal: abortController.signal,
  };
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`Bad response: ${response.status} for ${url}`);
  }
  return {
    data: await response.blob(),
    expires: response.headers.get("expires") || undefined,
    cacheControl: response.headers.get("cache-control") || undefined,
  };
};

/**
 * Caches, decodes, and processes raster tiles in the current thread.
 */
export class LocalDemManager implements DemManager {
  tileCache: AsyncCache<string, FetchResponse>;
  parsedCache: AsyncCache<string, DemTile>;
  contourCache: AsyncCache<string, ContourTile>;
  pressureCenterCache: AsyncCache<string, PressureCenter[]>;
  pressureCenterTileCache: AsyncCache<string, PressureCenterTile>;
  activeSource: DemSourceSnapshot;
  sources: Map<string, DemSourceSnapshot>;
  encoding: Encoding;
  maxzoom: number;
  timeoutMs: number;
  loaded = Promise.resolve();
  decodeImage: DecodeImageFunction;
  getTile: GetTileFunction;

  constructor(options: DemManagerInitizlizationParameters) {
    this.tileCache = new AsyncCache(options.cacheSize);
    this.parsedCache = new AsyncCache(options.cacheSize);
    this.contourCache = new AsyncCache(options.cacheSize);
    this.pressureCenterCache = new AsyncCache(Math.max(8, options.cacheSize));
    this.pressureCenterTileCache = new AsyncCache(options.cacheSize);
    this.timeoutMs = options.timeoutMs;
    this.activeSource = options.source;
    this.sources = new Map([[options.source.key, options.source]]);
    this.encoding = options.encoding;
    this.maxzoom = options.maxzoom;
    this.decodeImage = options.decodeImage || defaultDecodeImage;
    this.getTile = options.getTile || defaultGetTile;
  }

  fetchTile(
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<FetchResponse> {
    return this.fetchTileForSource(
      this.activeSource,
      z,
      x,
      y,
      parentAbortController,
      timer,
    );
  }

  private tileUrl(source: DemSourceSnapshot, z: number, x: number, y: number) {
    return source.urlPattern
      .replace("{z}", z.toString())
      .replace("{x}", x.toString())
      .replace("{y}", y.toString());
  }

  private fetchTileForSource(
    source: DemSourceSnapshot,
    z: number,
    x: number,
    y: number,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<FetchResponse> {
    const url = this.tileUrl(source, z, x, y);
    timer?.useTile(url);
    return this.tileCache.get(
      url,
      (_, childAbortController) => {
        timer?.fetchTile(url);
        const mark = timer?.marker("fetch");
        return withTimeout(
          this.timeoutMs,
          this.getTile(url, childAbortController).finally(() => mark?.()),
          childAbortController,
        );
      },
      parentAbortController,
    );
  }
  fetchAndParseTile(
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<DemTile> {
    return this.fetchAndParseTileForSource(
      this.activeSource,
      z,
      x,
      y,
      abortController,
      timer,
    );
  }

  private fetchAndParseTileForSource(
    source: DemSourceSnapshot,
    z: number,
    x: number,
    y: number,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<DemTile> {
    const url = this.tileUrl(source, z, x, y);

    timer?.useTile(url);

    return this.parsedCache.get(
      url,
      async (_, childAbortController) => {
        const response = await this.fetchTileForSource(
          source,
          z,
          x,
          y,
          childAbortController,
          timer,
        );
        if (isAborted(childAbortController)) throw new Error("canceled");
        const promise = this.decodeImage(
          response.data,
          this.encoding,
          childAbortController,
        );
        const mark = timer?.marker("decode");
        const result = await promise;
        mark?.();
        return result;
      },
      abortController,
    );
  }

  private async fetchDemForSource(
    source: DemSourceSnapshot,
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<HeightTile> {
    const zoom = Math.min(z - (options.overzoom || 0), this.maxzoom);
    const subZ = z - zoom;
    const div = 1 << subZ;
    const newX = Math.floor(x / div);
    const newY = Math.floor(y / div);

    const tile = await this.fetchAndParseTileForSource(
      source,
      zoom,
      newX,
      newY,
      abortController,
      timer,
    );

    return HeightTile.fromRawDem(tile).split(subZ, x % div, y % div);
  }

  fetchContourTile(
    z: number,
    x: number,
    y: number,
    options: IndividualContourTileOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<ContourTile> {
    const {
      levels,
      multiplier = 1,
      buffer = 1,
      extent = 4096,
      contourLayer = "contours",
      elevationKey = "ele",
      levelKey = "level",
      subsampleBelow = 100,
    } = options;

    // no levels means less than min zoom with levels specified
    if (!levels || levels.length === 0) {
      return Promise.resolve({ arrayBuffer: new ArrayBuffer(0) });
    }
    const source = this.activeSource;
    const key = [source.key, z, x, y, encodeIndividualOptions(options)].join(
      "/",
    );
    return this.contourCache.get(
      key,
      async (_, childAbortController) => {
        const max = 1 << z;
        const neighborPromises: (Promise<HeightTile> | undefined)[] = [];
        for (let iy = y - 1; iy <= y + 1; iy++) {
          for (let ix = x - 1; ix <= x + 1; ix++) {
            neighborPromises.push(
              iy < 0 || iy >= max
                ? undefined
                : this.fetchDemForSource(
                    source,
                    z,
                    (ix + max) % max,
                    iy,
                    options,
                    childAbortController,
                    timer,
                  ),
            );
          }
        }
        const neighbors = await Promise.all(neighborPromises);
        let virtualTile = HeightTile.combineNeighbors(neighbors);
        if (!virtualTile || isAborted(childAbortController)) {
          return { arrayBuffer: new Uint8Array().buffer };
        }
        const mark = timer?.marker("isoline");

        if (virtualTile.width >= subsampleBelow) {
          virtualTile = virtualTile.materialize(2);
        } else {
          while (virtualTile.width < subsampleBelow) {
            virtualTile = virtualTile.subsamplePixelCenters(2).materialize(2);
          }
        }

        virtualTile = virtualTile
          .averagePixelCentersToGrid()
          .scaleElevation(multiplier)
          .materialize(1);

        const isolines = generateIsolines(
          levels[0],
          virtualTile,
          extent,
          buffer,
        );

        mark?.();
        const result = encodeVectorTile({
          extent,
          layers: {
            [contourLayer]: {
              features: Object.entries(isolines).map(([eleString, geom]) => {
                const ele = Number(eleString);
                return {
                  type: GeomType.LINESTRING,
                  geometry: geom,
                  properties: {
                    [elevationKey]: ele,
                    [levelKey]: Math.max(
                      ...levels.map((l, i) => (ele % l === 0 ? i : 0)),
                    ),
                  },
                };
              }),
            },
          },
        });
        mark?.();

        return { arrayBuffer: result.slice().buffer };
      },
      parentAbortController,
    );
  }

  private async fetchWorldPressureTileForSource(
    source: DemSourceSnapshot,
    abortController: AbortController,
    timer?: Timer,
  ): Promise<HeightTile> {
    const zoom = this.maxzoom;
    const tileCount = 1 << zoom;
    const tiles = new Array<DemTile>(tileCount * tileCount);
    const jobs: { x: number; y: number; index: number }[] = [];

    for (let y = 0; y < tileCount; y++) {
      for (let x = 0; x < tileCount; x++) {
        jobs.push({ x, y, index: y * tileCount + x });
      }
    }

    let cursor = 0;
    const workerCount = Math.min(8, jobs.length);
    const workers = Array.from({ length: workerCount }, async () => {
      while (cursor < jobs.length) {
        if (isAborted(abortController)) throw new Error("canceled");
        const job = jobs[cursor++];
        tiles[job.index] = await this.fetchAndParseTileForSource(
          source,
          zoom,
          job.x,
          job.y,
          abortController,
          timer,
        );
      }
    });
    // 中文注释：世界压力场只为当前时间片拼一次；有限并发能加快切换时间，同时避免瞬时请求过载。
    await Promise.all(workers);

    const first = tiles[0];
    const tileWidth = first.width;
    const tileHeight = first.height;
    const width = tileWidth * tileCount;
    const height = tileHeight * tileCount;
    const data = new Float32Array(width * height);

    // 中文注释：把低 zoom pressure tiles 拼成一个连续世界网格，H/L 检测只对该时间片运行一次。
    tiles.forEach((tile, tileIndex) => {
      const tx = tileIndex % tileCount;
      const ty = Math.floor(tileIndex / tileCount);
      for (let y = 0; y < tileHeight; y++) {
        for (let x = 0; x < tileWidth; x++) {
          const worldX = tx * tileWidth + x;
          const worldY = ty * tileHeight + y;
          data[worldY * width + worldX] = tile.data[y * tileWidth + x];
        }
      }
    });

    return new HeightTile(width, height, (x, y) => {
      if (y < 0 || y >= height) return NaN;
      const wrappedX = ((x % width) + width) % width;
      return data[y * width + wrappedX];
    });
  }

  private fetchPressureCentersForSource(
    source: DemSourceSnapshot,
    options: PressureCenterOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<PressureCenter[]> {
    const optionsKey = encodePressureCenterOptions(options);
    const key = [source.key, "pressure-centers", optionsKey].join("/");

    return this.pressureCenterCache.get(
      key,
      async (_, childAbortController) => {
        const tile = await this.fetchWorldPressureTileForSource(
          source,
          childAbortController,
          timer,
        );
        if (isAborted(childAbortController)) throw new Error("canceled");
        const mark = timer?.marker("isoline");
        const centers = detectPressureCenters(tile, 0, options);
        mark?.();
        return centers;
      },
      parentAbortController,
    );
  }

  preloadPressureCenters(
    source: DemSourceSnapshot,
    options: PressureCenterOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<void> {
    this.sources.set(source.key, source);
    // 中文注释：预热只填充指定 source 的 H/L 缓存，不切换当前 activeSource，避免影响可见图层请求。
    return this.fetchPressureCentersForSource(
      source,
      options,
      parentAbortController,
      timer,
    ).then(() => undefined);
  }

  fetchPressureCenterTile(
    z: number,
    x: number,
    y: number,
    options: PressureCenterOptions,
    parentAbortController: AbortController,
    timer?: Timer,
  ): Promise<PressureCenterTile> {
    const source = this.activeSource;
    const key = [
      source.key,
      "pressure-center-tile",
      z,
      x,
      y,
      encodePressureCenterOptions(options),
    ].join("/");

    return this.pressureCenterTileCache.get(
      key,
      async (_, childAbortController) => {
        const centers = await this.fetchPressureCentersForSource(
          source,
          options,
          childAbortController,
          timer,
        );
        return encodePressureCenterTile(centers, z, x, y, options);
      },
      parentAbortController,
    );
  }

  setSource(source: DemSourceSnapshot): boolean {
    if (this.activeSource.key === source.key) {
      return false;
    }
    this.sources.set(source.key, source);
    this.activeSource = source;
    return true;
  }

  /** Updates the DEM tile URL pattern */
  updateUrl(url: string): void {
    this.setSource({ key: url, urlPattern: url });
  }
}
