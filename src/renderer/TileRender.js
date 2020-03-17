import { clamp, avgValue } from './util';
import { MinimumRayTracingPerformance, OkRayTracingPerformance, GoodRayTracingPerformance, ExcellentRayTracingPerformance, DynamicRayTracingPerformance } from '../constants';
// TileRender is based on the concept of a compute shader's work group.

// Sampling the scene with the RayTracingRenderer can be very slow (<1 fps).
// This overworks the GPU and tends to lock up the OS, making it unresponsive.

// To fix this, we can split the screen into smaller tiles, and sample the scene one tile at a time
// The tile size is set such that each tile takes approximatly a constant amount of time to render.

// Since the render time of a tile is dependent on the device, we find the desired tile dimensions by measuring
// the time it takes to render an arbitrarily-set tile size and adjusting the size according to the benchmark.

export function makeTileRender(gl, performanceLevel) {
  const desiredMsPerTile = 21;
  const overridePixelsPerMs = pixelsPerMsFromPerformanceLevel(performanceLevel);

  let currentTile = -1;
  let numTiles = 1;

  let tileWidth;
  let tileHeight;

  let columns;
  let rows;

  let width = 0;
  let height = 0;

  let totalElapsedMs;
  // initial number of pixels per rendered tile
  // based on correlation between system performance and max supported render buffer size
  // adjusted dynamically according to system performance
  let pixelsPerTile = overridePixelsPerMs ? (overridePixelsPerMs * desiredMsPerTile) : pixelsPerTileEstimate(gl);
  // let avgPixelsPerMs;
  // let lastTenPixelsPerMs = [];

  function reset() {
    currentTile = -1;
    totalElapsedMs = NaN;
    // lastTenPixelsPerMs = [];
  }

  function setSize(w, h) {
    width = w;
    height = h;
    reset();
    calcTileDimensions();
  }

  function calcTileDimensions() {
    const aspectRatio = width / height;

    // quantize the width of the tile so that it evenly divides the entire window
    tileWidth = Math.ceil(width / Math.round(width / Math.sqrt(pixelsPerTile * aspectRatio)));
    tileHeight = Math.ceil(tileWidth / aspectRatio);

    columns = Math.ceil(width / tileWidth);
    rows = Math.ceil(height / tileHeight);
    numTiles = columns * rows;
  }

  function updatePixelsPerTile() {
    const msPerTile = totalElapsedMs / numTiles;
    // const pixelsPerMs = pixelsPerTile / msPerTile;
    // lastTenPixelsPerMs.push(pixelsPerMs);
    // avgPixelsPerMs = avgValue(lastTenPixelsPerMs);
    // console.log("AVG PIXELS PER MS:",avgPixelsPerMs);
    const error = desiredMsPerTile - msPerTile;

     // tweak to find balance. higher = faster convergence, lower = less fluctuations to microstutters
    const strength = 5000;

    // sqrt prevents massive fluctuations in pixelsPerTile for the occasional stutter
    pixelsPerTile += strength * Math.sign(error) * Math.sqrt(Math.abs(error));
    pixelsPerTile = clamp(pixelsPerTile, 8192, width * height);
  }

  function nextTile(elapsedFrameMs) {
    currentTile++;
    totalElapsedMs += elapsedFrameMs;

    if (currentTile % numTiles === 0) {
      if (totalElapsedMs && !overridePixelsPerMs) {
        updatePixelsPerTile();
        calcTileDimensions();
      }

      totalElapsedMs = 0;
      currentTile = 0;
    }

    const isLastTile = currentTile === numTiles - 1;

    const x = currentTile % columns;
    const y = Math.floor(currentTile / columns) % rows;

    return {
      x: x * tileWidth,
      y: y * tileHeight,
      tileWidth,
      tileHeight,
      isFirstTile: currentTile === 0,
      isLastTile,
    };
  }

  return {
    nextTile,
    reset,
    setSize,
  };
}

function pixelsPerMsFromPerformanceLevel(performanceLevel) {
  switch (performanceLevel) {
    case MinimumRayTracingPerformance:
      return 1000;
    case OkRayTracingPerformance:
      return 10000;
    case GoodRayTracingPerformance:
      return 50000;
    case ExcellentRayTracingPerformance:
      return 100000;
    case DynamicRayTracingPerformance:
      return null;
  }
}

function pixelsPerTileEstimate(gl) {
  const maxRenderbufferSize = gl.getParameter(gl.MAX_RENDERBUFFER_SIZE);

  if (maxRenderbufferSize <= 8192) {
    return 200000;
  } else if (maxRenderbufferSize === 16384) {
    return 400000;
  } else if (maxRenderbufferSize >= 32768) {
    return 600000;
  }
}
