import { HeightTile } from "./height-tile";
import { detectPressureCenters } from "./pressure-centers";

function syntheticPressureTile(
  width: number,
  height: number,
  valueAt: (x: number, y: number) => number,
): HeightTile {
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      data[y * width + x] = valueAt(x, y);
    }
  }
  return new HeightTile(width, height, (x, y) => {
    if (x < 0 || x >= width || y < 0 || y >= height) return NaN;
    return data[y * width + x];
  });
}

describe("pressure center detection", () => {
  const options = {
    smoothingKm: 80,
    minProminenceHpa: 1,
    nearClosedAngleDeg: 280,
    pressureCenterLayer: "pressure-centers",
    algorithmVersion: 1,
  };

  it("detects a closed high pressure center", () => {
    const cx = 48;
    const cy = 48;
    const tile = syntheticPressureTile(96, 96, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      return 1010 + Math.max(0, 12 - d * 0.35);
    });

    const centers = detectPressureCenters(tile, 0, options);

    expect(centers.some((center) => center.kind === "H")).toBe(true);
    expect(centers.some((center) => center.kind === "L")).toBe(false);
  });

  it("detects a closed low pressure center", () => {
    const cx = 44;
    const cy = 50;
    const tile = syntheticPressureTile(96, 96, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      return 1010 - Math.max(0, 12 - d * 0.35);
    });

    const centers = detectPressureCenters(tile, 0, options);

    expect(centers.some((center) => center.kind === "L")).toBe(true);
    expect(centers.some((center) => center.kind === "H")).toBe(false);
  });

  it("rejects an open trough without a closed low center", () => {
    const tile = syntheticPressureTile(96, 96, (x, y) => {
      const trough = Math.abs(x - 48) * 0.08;
      return 1000 + trough + y * 0.01;
    });

    const centers = detectPressureCenters(tile, 0, options);

    expect(centers).toHaveLength(0);
  });

  it("keeps two low centers when the separating saddle is strong enough", () => {
    const tile = syntheticPressureTile(112, 96, (x, y) => {
      const d1 = Math.hypot(x - 35, y - 48);
      const d2 = Math.hypot(x - 76, y - 48);
      const lowDepth = Math.max(
        Math.max(0, 15 - d1 * 0.55),
        Math.max(0, 15 - d2 * 0.55),
      );
      return 1018 - lowDepth;
    });

    const centers = detectPressureCenters(tile, 0, options);
    const lows = centers.filter((center) => center.kind === "L");

    expect(lows).toHaveLength(2);
  });

  it("detects a flat-topped closed high pressure plateau", () => {
    const cx = 48;
    const cy = 48;
    const tile = syntheticPressureTile(96, 96, (x, y) => {
      const d = Math.hypot(x - cx, y - cy);
      return d < 5 ? 1024 : 1024 - Math.min(12, (d - 5) * 0.45);
    });

    const centers = detectPressureCenters(tile, 0, options);

    expect(centers.some((center) => center.kind === "H")).toBe(true);
  });

  it("uses dense probes to explain pressure-gradient regions without H/L centers", () => {
    const tile = syntheticPressureTile(96, 96, (x, y) => {
      return 1000 + x * 0.08 + y * 0.01;
    });

    const centers = detectPressureCenters(tile, 0, {
      ...options,
      debugCandidates: true,
      debugDenseProbes: true,
    });

    expect(centers.some((center) => center.status === "accepted")).toBe(false);
    expect(
      centers.some((center) => center.rejectReason === "not_pressure_center"),
    ).toBe(true);
  });
});
