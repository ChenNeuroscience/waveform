import { groupPalette } from "./palette";
import type { Settings, ViewData } from "./types";
import {
  projectionFrame,
  featurePlotOrigin,
  FEATURE_PLOT,
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
 float x=axis(ax),y=axis(ay);gl_Position=vec4(x*1.86-.93,y*1.86-.93,int(cell)==selected?-.5:0.,1.);gl_PointSize=size;
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
      depth: true,
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
    // Keep the focused group's points in front without sorting or uploading
    // the population buffers again. Equal-depth groups retain their draw order.
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
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
