import { program } from "./webgl";
import { DENSITY_COLOUR_GLSL } from "./density-colours";
import { groupPalette } from "../palette";
import type { FeatureCoordinates, Settings, ViewData } from "../types";
import { projectionFrame, featurePlotOrigin, FEATURE_PLOT } from "./plot-geometry";

/** The six feature-space projections drawn as GPU points, plus the drift view. */
const vertex = `#version 300 es
precision highp float;
layout(location=0) in vec4 amplitudes;
layout(location=1) in uint ticks;
layout(location=2) in uint cell;
uniform int ax;uniform int ay;uniform float size;uniform int selected;uniform float opacity;uniform vec2 range;uniform float timeScale;
out vec4 shade;out float time;
float axis(int a){return a==4?time:amplitudes[a];}
const vec3 groupColors[31]=vec3[31](${groupPalette.map((c) => `vec3(${c.map((v) => `${v}.`).join(",")})`).join(",")});
vec3 palette(float c){int i=int(c);return i<31?groupColors[i]/255.:vec3(0.);}
void main(){
 time=float(ticks)*timeScale;
 float x=axis(ax),y=axis(ay);gl_Position=vec4(x*1.86-.93,y*1.86-.93,int(cell)==selected?-.5:0.,1.);gl_PointSize=size;
 bool hide=time<range.x||time>range.y;
 shade=vec4(palette(float(cell)),hide?0.:opacity);
}`;
const fragment = `#version 300 es
precision highp float;in vec4 shade;in float time;out vec4 outColor;void main(){if(shade.a==0.||distance(gl_PointCoord,vec2(.5))>.5)discard;outColor=shade;}`;
// Drift: accumulate (count, summed time) per pixel, then colour each pixel by its
// mean spike time, red at the start of the recording to green at the end.
const accumulate = `#version 300 es
precision highp float;uniform float unit;in vec4 shade;in float time;out vec4 sums;void main(){if(shade.a==0.||distance(gl_PointCoord,vec2(.5))>.5)discard;sums=vec4(unit,time*unit,0.,0.);}`;
const resolveVertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`;
const resolveFragment = `#version 300 es
precision highp float;uniform sampler2D sums;uniform float unit;uniform float total;uniform int mode;out vec4 c;
${DENSITY_COLOUR_GLSL}
void main(){
 vec2 s=texelFetch(sums,ivec2(gl_FragCoord.xy),0).rg/unit;
 if(s.r<.5)discard;
 float t=s.g/s.r;
 c=vec4(mode==1?vec3(1.-t,t,0.):densityColour(sqrt(s.r/max(1.,total)*1000.)),1.);
}`;
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
  sums: WebGLProgram | null = null;
  resolve: WebGLProgram | null = null;
  target: {
    texture: WebGLTexture;
    fbo: WebGLFramebuffer;
    w: number;
    h: number;
  } | null = null;
  empty: WebGLVertexArrayObject;
  private timed = false;
  private countFormat: number;
  private unit = 1;
  private countsFor: {
    key: string;
    points: FeatureCoordinates["values"];
  } | null = null;
  cache = new Map<
    string,
    {
      vao: WebGLVertexArrayObject;
      buffers: WebGLBuffer[];
      n: number;
      labels: Uint16Array;
      features: Uint8Array | Float32Array;
      timeScale: number;
    }
  >();
  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", {
      antialias: false,
      alpha: false,
      depth: true,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable. Enable hardware acceleration and reopen this page.");
    }
    this.gl = gl;
    this.p = program(gl, vertex, fragment);
    this.empty = gl.createVertexArray()!;
    // Use the same accumulation formats and fallback as the waveform renderer.
    const float = gl.getExtension("EXT_color_buffer_float");
    this.timed = !!(float && gl.getExtension("EXT_float_blend"));
    this.countFormat = this.timed ? gl.RG32F : float ? gl.R16F : gl.RGBA8;
    this.unit = float ? 1 : 1 / 255;
    this.sums = program(gl, vertex, accumulate);
    this.resolve = program(gl, resolveVertex, resolveFragment);
  }
  draw(
    data: ViewData,
    coordinates: FeatureCoordinates,
    s: Settings,
    selected: number,
    range: number[],
    axes: number[][],
    columns = 3,
  ) {
    const gl = this.gl;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const w = Math.round(this.canvas.clientWidth * dpr);
    const h = Math.round(this.canvas.clientHeight * dpr);
    if (w !== this.canvas.width || h !== this.canvas.height) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    const key = data.key;
    let cached = this.cache.get(key);
    if (!cached) {
      const vao = gl.createVertexArray()!;
      const buffers = [gl.createBuffer()!, gl.createBuffer()!, gl.createBuffer()!];
      gl.bindVertexArray(vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[0]);
      gl.bufferData(gl.ARRAY_BUFFER, coordinates.values, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(
        0,
        4,
        coordinates.values instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT,
        coordinates.values instanceof Uint8Array,
        0,
        0,
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[1]);
      gl.bufferData(gl.ARRAY_BUFFER, data.times, gl.STATIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribIPointer(1, 1, gl.UNSIGNED_INT, 0, 0);
      gl.bindBuffer(gl.ARRAY_BUFFER, buffers[2]);
      gl.bufferData(gl.ARRAY_BUFFER, data.labels, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribIPointer(2, 1, gl.UNSIGNED_SHORT, 0, 0);
      cached = {
        vao,
        buffers,
        n: data.labels.length,
        labels: data.labels,
        features: coordinates.values,
        timeScale: 1 / Math.max(1, data.times[data.times.length - 1] || 0),
      };
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
      if (cached.features !== coordinates.values) {
        gl.bindVertexArray(cached.vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, cached.buffers[0]);
        gl.bufferData(gl.ARRAY_BUFFER, coordinates.values, gl.STATIC_DRAW);
        gl.vertexAttribPointer(
          0,
          4,
          coordinates.values instanceof Uint8Array ? gl.UNSIGNED_BYTE : gl.FLOAT,
          coordinates.values instanceof Uint8Array,
          0,
          0,
        );
        cached.features = coordinates.values;
      }
      if (cached.labels !== data.labels) {
        gl.bindBuffer(gl.ARRAY_BUFFER, cached.buffers[2]);
        gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.labels);
        cached.labels = data.labels;
      }
    }
    const aggregate = s.renderMode === "density" || (s.renderMode === "drift" && this.timed);
    const countsKey = `${key}|${w}|${h}|${dpr}|${columns}|${range}`;
    const reuseCounts =
      aggregate &&
      this.countsFor?.key === countsKey &&
      this.countsFor.points === coordinates.values;
    const p = aggregate ? this.sums! : this.p;
    if (!reuseCounts) {
      gl.useProgram(p);
      gl.bindVertexArray(cached.vao);
      if (aggregate) {
        this.bindTarget(w, h);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.disable(gl.DEPTH_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
      } else {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        gl.clearColor(1, 1, 1, 1);
        gl.enable(gl.DEPTH_TEST);
        gl.depthFunc(gl.LEQUAL);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      }
      gl.enable(gl.SCISSOR_TEST);
      const u = (n: string) => gl.getUniformLocation(p, n);
      gl.uniform1f(u("size"), dpr); // Fixed at one CSS pixel.
      gl.uniform1f(u("opacity"), 1);
      if (aggregate) {
        gl.uniform1f(u("unit"), this.unit);
      }
      gl.uniform1i(u("selected"), selected);
      gl.uniform2f(u("range"), range[0], range[1]);
      gl.uniform1f(u("timeScale"), cached.timeScale);
      axes.forEach(([ax, ay], i) => {
        const origin = featurePlotOrigin(i, columns);
        const x = Math.round(origin.x * dpr);
        const y = Math.round(h - (origin.y + FEATURE_PLOT) * dpr);
        const hh = Math.round(FEATURE_PLOT * dpr);
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
      if (aggregate) {
        this.countsFor = { key: countsKey, points: coordinates.values };
      }
    }
    if (aggregate) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.disable(gl.DEPTH_TEST);
      gl.viewport(0, 0, w, h);
      gl.clearColor(1, 1, 1, 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      gl.disable(gl.BLEND);
      gl.useProgram(this.resolve!);
      gl.bindVertexArray(this.empty);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.target!.texture);
      gl.uniform1i(gl.getUniformLocation(this.resolve!, "sums"), 0);
      gl.uniform1i(gl.getUniformLocation(this.resolve!, "mode"), s.renderMode === "drift" ? 1 : 0);
      gl.uniform1f(gl.getUniformLocation(this.resolve!, "unit"), this.unit);
      // Point footprints cover far less of a projection than waveform traces.
      // Scale their count fraction accordingly, using the identical colour ramp.
      gl.uniform1f(gl.getUniformLocation(this.resolve!, "total"), data.n);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }
  /** The (count, summed time) float target for drift, matching the canvas size. */
  private bindTarget(w: number, h: number) {
    const gl = this.gl;
    if (!this.target || this.target.w !== w || this.target.h !== h) {
      if (this.target) {
        gl.deleteTexture(this.target.texture);
        gl.deleteFramebuffer(this.target.fbo);
      }
      const texture = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texStorage2D(gl.TEXTURE_2D, 1, this.countFormat, w, h);
      const fbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
        throw new Error("Feature density target is unavailable.");
      }
      this.countsFor = null;
      this.target = { texture, fbo, w, h };
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.target.fbo);
  }
  dispose() {
    const g = this.gl;
    for (const c of this.cache.values()) {
      c.buffers.forEach((b) => g.deleteBuffer(b));
      g.deleteVertexArray(c.vao);
    }
    if (this.target) {
      g.deleteTexture(this.target.texture);
      g.deleteFramebuffer(this.target.fbo);
    }
    g.deleteProgram(this.p);
    if (this.sums) {
      g.deleteProgram(this.sums);
    }
    if (this.resolve) {
      g.deleteProgram(this.resolve);
    }
    g.deleteVertexArray(this.empty);
  }
}
