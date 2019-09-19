import { makeDepthTexture, makeTexture } from "./texture";

export function makeFramebuffer(params) {
  const {
    renderTargets, // RenderTargets object
    depth = false, // use depth buffer
    gl,
    linearFiltering = false, // linearly filter textures
    float = false, // use floating point texture
  } = params;

  const framebuffer = gl.createFramebuffer();
  let colorTexture;

  let width = 0;
  let height = 0;

  function bind() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
  }

  function unbind() {
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  function setSize(w, h) {
    this.bind();

    width = Math.floor(w);
    height = Math.floor(h);

    colorTexture = initSingleTexture(gl, width, height, float ? 'float' : 'byte', linearFiltering);

    if (depth) {
      const depthTexture = makeDepthTexture(gl, {
        width,
        height
      });
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, depthTexture.target, depthTexture.texture, 0);
    }

    this.unbind();
  }

  function copyToScreen() {
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, width, height, 0, 0, gl.drawingBufferWidth, gl.drawingBufferHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);
  }

  return {
    bind,
    copyToScreen,
    get height() {
      return height;
    },
    setSize,
    get texture() {
      return colorTexture;
    },
    unbind,
    get width() {
      return width;
    },
  };
}

function initSingleTexture(gl, width, height, storage, linearFiltering) {
  const texture = makeTexture(gl, {
    width,
    height,
    storage,
    minFilter: linearFiltering ? gl.LINEAR : gl.NEAREST,
    magFilter: linearFiltering ? gl.LINEAR : gl.NEAREST,
    channels: 4
  });
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, texture.target, texture.texture, 0);

  return texture;
}
