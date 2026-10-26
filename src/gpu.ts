import { groupPalette } from "./palette";
import { cellRgb, type Settings, type ViewData } from "./types";
import {
  projectionFrame,
  featurePlotOrigin,
  FEATURE_PLOT,
  type WaveLayout,
} from "./plot-geometry";
const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 amplitudes;
layout(location=1) in float time;
layout(location=2) in uint cell;
uniform int ax;uniform int ay;uniform float size;uniform int selected;uniform bool isolate;uniform bool drift;uniform float opacity;uniform vec2 range;
out vec4 shade;
float axis(int a){return a==4?time:amplitudes[a];}
const vec3 groupColors[31]=vec3[31](${groupPalette.map((c) => `vec3(${c.map((v) => `${v}.`).join(",")})`).join(",")});
vec3 palette(float c){int i=int(c);return i<31?groupColors[i]/255.:vec3(0.);}
void main(){
 float x=axis(ax),y=axis(ay);gl_Position=vec4(x*1.86-.93,y*1.86-.93,0.,1.);gl_PointSize=size;
 bool hide=(isolate&&int(cell)!=selected)||time<range.x||time>range.y;
 vec3 rgb=palette(float(cell));if(drift)rgb=vec3(1.-time,time,0.);
 shade=vec4(rgb,hide?0.:opacity);
}`;
const fragment = `#version 300 es
precision highp float;in vec4 shade;out vec4 outColor;void main(){if(shade.a==0.||distance(gl_PointCoord,vec2(.5))>.5)discard;outColor=shade;}`;
function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(s) || "Shader compilation failed");
  return s;
}
export function program(gl: WebGL2RenderingContext, v: string, f: string) {
  const p = gl.createProgram()!;
  const a = shader(gl, gl.VERTEX_SHADER, v),
    b = shader(gl, gl.FRAGMENT_SHADER, f);
  gl.attachShader(p, a);
  gl.attachShader(p, b);
  gl.linkProgram(p);
  gl.deleteShader(a);
  gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) || "Shader link failed");
  return p;
}
export const projections = [
  [0, 1],
  [0, 2],
  [0, 3],
  [1, 2],
  [1, 3],
  [2, 3],
];
export class ClusterGPU {
  gl: WebGL2RenderingContext;
  p: WebGLProgram;
  cache = new Map<
    string,
    {
      vao: WebGLVertexArrayObject;
      buffers: WebGLBuffer[];
      n: number;
      labels: Uint16Array;
    }
  >();
  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      preserveDrawingBuffer: true,
    });
    if (!gl)
      throw new Error(
        "WebGL2 is unavailable. Enable hardware acceleration and reopen this page.",
      );
    this.gl = gl;
    this.p = program(gl, vertex, fragment);
  }
  draw(
    data: ViewData,
    s: Settings,
    selected: number,
    isolate: boolean,
    range: number[],
    axes: number[][],
    columns = 3,
  ) {
    const gl = this.gl,
      dpr = Math.min(2, devicePixelRatio || 1),
      w = Math.round(this.canvas.clientWidth * dpr),
      h = Math.round(this.canvas.clientHeight * dpr);
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const key = `${data.key}|${data.features.length}`;
    let cached = this.cache.get(key);
    if (!cached) {
      const vao = gl.createVertexArray()!,
        buffers = [gl.createBuffer()!, gl.createBuffer()!, gl.createBuffer()!];
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]);
      gl.bufferData(gl.ARRAY_BUFFER, data.features, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 4, gl.UNSIGNED_BYTE, true, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[1]);
      gl.bufferData(gl.ARRAY_BUFFER, data.times, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[2]);
      gl.bufferData(gl.ARRAY_BUFFER, data.labels, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 0, 0);
      cached = { vao, buffers, n: data.labels.length, labels: data.labels };
      this.cache.set(key, cached);
      if (this.cache.size > 4) {
        const first = this.cache.keys().next().value!;
        const old = this.cache.get(first)!;
        old.buffers.forEach((b) => gl.deleteBuffer(b));
        gl.deleteVertexArray(old.vao);
        this.cache.delete(first);
      }
    } else {
      this.cache.delete(key);
      this.cache.set(key, cached);
      if (cached.labels !== data.labels) {
        gl.bindBuffer(gl.ARRAY_BUFFER, cached.buffers[2]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.labels);
        cached.labels = data.labels;
      }
    }
    gl.useProgram(this.p);
    gl.bindVertexArray(cached.vao);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.SCISSOR_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const u = (n: string) => gl.getUniformLocation(this.p, n);
    gl.uniform1f(u("size"), s.pointSize * dpr);
    gl.uniform1f(u("opacity"), 1);
    gl.uniform1i(u("selected"), selected);
    gl.uniform1i(u("isolate"), isolate ? 1 : 0);
    gl.uniform1i(u("drift"), s.drift ? 1 : 0);
    gl.uniform2f(u("range"), range[0], range[1]);
    axes.forEach(([ax, ay], i) => {
      const origin = featurePlotOrigin(i, columns),
        x = Math.round(origin.x * dpr),
        y = Math.round(h - (origin.y + FEATURE_PLOT) * dpr),
        hh = Math.round(FEATURE_PLOT * dpr);
      const frame = projectionFrame(FEATURE_PLOT, FEATURE_PLOT);
      gl.viewport(
        x + frame.x * dpr,
        y + hh - (frame.y + frame.height) * dpr,
        frame.width * dpr,
        frame.height * dpr,
      );
      gl.scissor(
        x + frame.x * dpr,
        y + hh - (frame.y + frame.height) * dpr,
        frame.width * dpr,
        frame.height * dpr,
      );
      gl.uniform1i(u("ax"), ax);
      gl.uniform1i(u("ay"), ay);
      gl.drawArrays(gl.POINTS, 0, cached!.n);
    });
    gl.disable(gl.SCISSOR_TEST);
  }
  dispose() {
    const g = this.gl;
    for (const c of this.cache.values()) {
      c.buffers.forEach((b) => g.deleteBuffer(b));
      g.deleteVertexArray(c.vao);
    }
    g.deleteProgram(this.p);
  }
}
const waveVertex = `#version 300 es
precision highp float;precision highp isampler2D;
uniform isampler2D waves;uniform int width;uniform int channel;uniform int baseWave;uniform vec3 rgb;out vec4 shade;
void main(){int i=(gl_InstanceID+baseWave)*200+channel*50+gl_VertexID;float v=float(texelFetch(waves,ivec2(i%width,i/width),0).r)/128.;float x=(float(channel)+(float(gl_VertexID)/49.)*.84+.08)/4.;gl_Position=vec4(x*2.-1.,v*.78,0.,1.);shade=vec4(rgb,1.);}`;
const waveFragment = `#version 300 es
precision highp float;in vec4 shade;out vec4 c;void main(){c=shade;}`;
export function drawWaves(
  canvas: HTMLCanvasElement,
  data: ViewData,
  cell: number,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: true,
    preserveDrawingBuffer: true,
  });
  if (!gl) return () => {};
  canvas.width = Math.round(
    canvas.clientWidth * Math.min(2, devicePixelRatio || 1),
  );
  canvas.height = Math.round(
    canvas.clientHeight * Math.min(2, devicePixelRatio || 1),
  );
  const ids: number[] = [];
  for (let i = 0; i < data.waveLabels.length; i++)
    if (data.waveLabels[i] === cell) ids.push(i);
  const bytes = new Int8Array(
    Math.max(4096, Math.ceil((ids.length * 200) / 4096) * 4096),
  );
  ids.forEach((j, i) =>
    bytes.set(data.waves.subarray(j * 200, j * 200 + 200), i * 200),
  );
  const p = program(gl, waveVertex, waveFragment),
    texture = gl.createTexture()!,
    vao = gl.createVertexArray()!;
  gl.useProgram(p);
  gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8I,
    4096,
    bytes.length / 4096,
    0,
    gl.RED_INTEGER,
    gl.BYTE,
    bytes,
  );
  gl.uniform1i(gl.getUniformLocation(p, "width"), 4096);
  gl.uniform1i(gl.getUniformLocation(p, "waves"), 0);
  gl.uniform3fv(gl.getUniformLocation(p, "rgb"), cellRgb(cell));
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  for (let c = 0; c < 4; c++) {
    gl.uniform1i(gl.getUniformLocation(p, "channel"), c);
    gl.drawArraysInstanced(gl.LINE_STRIP, 0, 50, ids.length);
  }
  return () => {
    gl.deleteTexture(texture);
    gl.deleteProgram(p);
    gl.deleteVertexArray(vao);
  };
}
export function drawWaveOverview(
  canvas: HTMLCanvasElement,
  data: ViewData,
  cells: number[],
  columns: number,
  layout?: WaveLayout,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl) return () => {};
  const dpr = Math.min(2, devicePixelRatio || 1),
    rows = Math.ceil(cells.length / columns);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = rows * (layout?.rowStride || 120) * dpr;
  const records: number[] = [],
    ranges: { start: number; n: number }[] = [];
  for (const c of cells) {
    const start = records.length;
    for (let i = 0; i < data.waveLabels.length; i++)
      if (data.waveLabels[i] === c && records.length - start < 256)
        records.push(i);
    ranges.push({ start, n: records.length - start });
  }
  const bytes = new Int8Array(
    Math.max(4096, Math.ceil((records.length * 200) / 4096) * 4096),
  );
  records.forEach((id, i) =>
    bytes.set(data.waves.subarray(id * 200, id * 200 + 200), i * 200),
  );
  const p = program(gl, waveVertex, waveFragment),
    texture = gl.createTexture()!,
    vao = gl.createVertexArray()!;
  gl.useProgram(p);
  gl.bindVertexArray(vao);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R8I,
    4096,
    bytes.length / 4096,
    0,
    gl.RED_INTEGER,
    gl.BYTE,
    bytes,
  );
  gl.uniform1i(gl.getUniformLocation(p, "width"), 4096);
  gl.uniform1i(gl.getUniformLocation(p, "waves"), 0);
  gl.clearColor(1, 1, 1, 1);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
  cells.forEach((cell, i) => {
    const col = i % columns,
      row = Math.floor(i / columns),
      stride = (layout?.tileStride || canvas.clientWidth / columns) * dpr,
      w = (layout?.waveWidth || canvas.clientWidth / columns) * dpr,
      h = (layout?.waveHeight || 120) * dpr,
      rowStride = (layout?.rowStride || 120) * dpr;
    gl.viewport(
      col * stride + (layout?.inset || 0) * dpr,
      canvas.height - row * rowStride - h - (layout?.top || 0) * dpr,
      w,
      h,
    );
    gl.uniform1i(gl.getUniformLocation(p, "baseWave"), ranges[i].start);
    gl.uniform3fv(gl.getUniformLocation(p, "rgb"), cellRgb(cell));
    for (let c = 0; c < 4; c++) {
      gl.uniform1i(gl.getUniformLocation(p, "channel"), c);
      gl.drawArraysInstanced(gl.LINE_STRIP, 0, 50, ranges[i].n);
    }
  });
  return () => {
    gl.deleteTexture(texture);
    gl.deleteProgram(p);
    gl.deleteVertexArray(vao);
  };
}
