import { makeFullscreenQuad } from './FullscreenQuad';
import { makeRayTracingShader, rayTracingRenderTargets } from './RayTracingShader';
import { makeToneMapShader } from './ToneMapShader';
import { makeFramebuffer } from './Framebuffer';
import { numberArraysEqual, clamp } from './util';
import { makeTileRender } from './TileRender';
import { LensCamera } from '../LensCamera';
import { makeTextureAllocator } from './TextureAllocator';
import { makeReprojectShader } from './ReprojectShader';
import * as THREE from 'three';
import noiseBase64 from './texture/noise';
import { PerspectiveCamera } from 'three';

// Important TODO: Refactor this file to get rid of duplicate and confusing code

export function makeRenderingPipeline({
    gl,
    optionalExtensions,
    scene,
    toneMappingParams,
    bounces, // number of global illumination bounces
  }) {

  let ready = false;

  const fullscreenQuad = makeFullscreenQuad(gl);

  const textureAllocator = makeTextureAllocator(gl);

  const rayTracingShader = makeRayTracingShader({bounces, fullscreenQuad, gl, optionalExtensions, scene, textureAllocator});

  const reprojectShader = makeReprojectShader({ fullscreenQuad, gl, textureAllocator });

  const toneMapShader = makeToneMapShader({
    fullscreenQuad, gl, optionalExtensions, textureAllocator, toneMappingParams
  });

  const noiseImage = new Image();
  noiseImage.src = noiseBase64;
  noiseImage.onload = () => {
    rayTracingShader.setNoise(noiseImage);
    ready = true;
  };

  const linearFiltering = optionalExtensions.OES_texture_float_linear;

  // full resolution buffer representing the rendered scene with HDR lighting
  let hdrBuffer = makeFramebuffer({
    gl,
    renderTarget: rayTracingRenderTargets,
  });

  let hdrPreviewBuffer = makeFramebuffer({
    gl,
    renderTarget: rayTracingRenderTargets,
  });

  let historyPreviewBuffer = makeFramebuffer({
    gl,
    renderTarget: rayTracingRenderTargets,
  });

  let reprojectPreviewBuffer = makeFramebuffer({
    gl,
    renderTarget: rayTracingRenderTargets,
  });

  let reprojectBuffer = makeFramebuffer({
    gl,
    renderTarget: rayTracingRenderTargets,
  });

  const clearToBlack = new Float32Array([0, 0, 0, 0]);

  const reprojectDecay = 0.98;
  const numSamplesToReproject = 64;

  // used to sample only a portion of the scene to the HDR Buffer to prevent the GPU from locking up from excessive computation
  const tileRender = makeTileRender(gl);

  const lastCamera = new PerspectiveCamera();

  // how many samples to render with uniform noise before switching to stratified noise
  const numUniformSamples = 6;

  // how many partitions of stratified noise should be created
  // higher number results in faster convergence over time, but with lower quality initial samples
  const strataCount = 6;

  let sampleCount = 0;

  let sampleRenderedCallback = () => {};

  rayTracingShader.setStrataCount(1);
  rayTracingShader.useStratifiedSampling(true);

  function clear() {
    sampleCount = 0;
    tileRender.reset();
  }

  function setPreviewBufferDimensions() {
    const aspectRatio = hdrBuffer.width / hdrBuffer.height;
    const desiredTimeForPreview = 17; // 60 fps
    const numPixelsForPreview = desiredTimeForPreview / tileRender.getTimePerPixel();
    const previewWidth = Math.round(clamp(Math.sqrt(numPixelsForPreview * aspectRatio), 1, hdrBuffer.width));
    const previewHeight = clamp(previewWidth / aspectRatio, 1, hdrBuffer.height);
    if (previewWidth !== hdrPreviewBuffer.width) {
      console.log(previewWidth, hdrPreviewBuffer.width)
      hdrPreviewBuffer.setSize(previewWidth, previewHeight);
      historyPreviewBuffer.setSize(previewWidth, previewHeight);
      reprojectPreviewBuffer.setSize(previewWidth, previewHeight);
    }
  }

  function areCamerasEqual(cam1, cam2) {
    return numberArraysEqual(cam1.matrixWorld.elements, cam2.matrixWorld.elements) &&
      cam1.aspect === cam2.aspect &&
      cam1.fov === cam2.fov &&
      cam1.focus === cam2.focus;
  }

  function clearBuffer(buffer) {
    hdrBuffer.bind();
    gl.clear(gl.COLOR_BUFFER_BIT);
    hdrBuffer.unbind();
  }

  function addSampleToBuffer(buffer) {
    buffer.bind();

    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);

    gl.clearBufferfv(gl.COLOR, rayTracingRenderTargets.location.normalAndMeshId, clearToBlack);
    gl.clearBufferfv(gl.COLOR, rayTracingRenderTargets.location.position, clearToBlack);

    gl.viewport(0, 0, buffer.width, buffer.height);
    rayTracingShader.draw();

    gl.disable(gl.BLEND);
    buffer.unbind();
  }

  function newSampleToBuffer(buffer) {
    buffer.bind();
    gl.viewport(0, 0, buffer.width, buffer.height);
    rayTracingShader.draw();
    buffer.unbind();
  }

  function toneMapToScreen(buffer) {
    gl.viewport(0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight);
    toneMapShader.draw(buffer.texture);
  }

  function renderTile(x, y, width, height) {
    gl.scissor(x, y, width, height);
    gl.enable(gl.SCISSOR_TEST);
    addSampleToBuffer(hdrBuffer);
    gl.disable(gl.SCISSOR_TEST);
  }

  function updateSeed() {
    if ( sampleCount === 1) {
      rayTracingShader.useStratifiedSampling(true);
      rayTracingShader.setStrataCount(1);
    } else if (sampleCount === numUniformSamples) {
      rayTracingShader.setStrataCount(strataCount);
    } else {
      rayTracingShader.nextSeed();
    }
  }

  function drawFull(camera) {
    if (!ready) {
      return;
    }

    const camerasEqual = areCamerasEqual(camera, lastCamera);

    if (!camerasEqual) {

      const temp = historyPreviewBuffer;
      historyPreviewBuffer = reprojectPreviewBuffer;
      reprojectPreviewBuffer = temp;

      let historyBuffer = sampleCount > 1 ? reprojectBuffer : historyPreviewBuffer;

      sampleCount = 1;

      clearBuffer(hdrBuffer);
      setPreviewBufferDimensions();

      rayTracingShader.setCamera(camera);
      updateSeed();
      newSampleToBuffer(hdrPreviewBuffer);

      reprojectShader.setPreviousCamera(lastCamera);
      reprojectShader.setBlendAmount(reprojectDecay);

      reprojectPreviewBuffer.bind();
      gl.viewport(0, 0, reprojectPreviewBuffer.width, reprojectPreviewBuffer.height);
      reprojectShader.draw(hdrPreviewBuffer.texture, historyBuffer.texture);
      reprojectPreviewBuffer.unbind();

      toneMapToScreen(reprojectPreviewBuffer);
    } else {
      sampleCount++;

      updateSeed();
      addSampleToBuffer(hdrBuffer);

      let reprojectAmount = reprojectDecay * (1 - sampleCount / numSamplesToReproject);
      reprojectAmount = clamp(reprojectAmount * reprojectAmount, 0, 1);
      reprojectShader.setBlendAmount(reprojectAmount);

      reprojectBuffer.bind();
      gl.viewport(0, 0, reprojectBuffer.width, reprojectBuffer.height);
      reprojectShader.draw(hdrBuffer.texture, historyPreviewBuffer.texture);
      reprojectBuffer.unbind();

      toneMapToScreen(reprojectBuffer);
    }

    lastCamera.copy(camera);
  }

  function setSize(w, h) {
    rayTracingShader.setSize(w, h);
    tileRender.setSize(w, h);
    hdrBuffer.setSize(w, h);
    reprojectBuffer.setSize(w, h);
    // historyBuffer.setSize(w, h);
    clear();
  }

  return {
    drawTile: drawFull,
    drawOffscreenTile: drawFull,
    drawFull,
    restartTimer: tileRender.restartTimer,
    setRenderTime: tileRender.setRenderTime,
    setSize,
    // hdrBufferToScreen,
    getTotalSamplesRendered() {
      return sampleCount;
    },
    set onSampleRendered(cb) {
      sampleRenderedCallback = cb;
    },
    get onSampleRendered() {
      return sampleRenderedCallback;
    }
  };
}
