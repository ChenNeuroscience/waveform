import { program } from "./gpu";
import type { WaveLayout } from "./plot-geometry";
const vertex = `#version 300 es
precision highp float;out vec2 uv;void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);uv=p;gl_Position=vec4(p*2.-1.,0.,1.);}`;
const fragment = `#version 300 es
precision highp float;precision highp usampler2D;in vec2 uv;uniform usampler2D density;uniform usampler2D sampleCounts;uniform int cells;uniform int columns;uniform vec2 extent;uniform float tileStride;uniform float rowStride;uniform float waveWidth;uniform float waveHeight;uniform float inset;uniform float top;out vec4 color;
vec3 palette(float count){return vec3(count>.5?(count>.75?4.-4.*count:4.*count-2.):(count>.25?2.-4.*count:4.*count),count<.5?2.*count:2.-2.*count,count);}
void main(){
 vec2 p=vec2(uv.x,1.-uv.y)*extent;
 int column=int(floor(p.x/tileStride)); int row=int(floor(p.y/rowStride)); int cell=row*columns+column;
 vec2 local=vec2(mod(p.x,tileStride)-inset,mod(p.y,rowStride)-top);
 if(column>=columns||cell>=cells||local.x<0.||local.x>=waveWidth||local.y<0.||local.y>=waveHeight){color=vec4(1.);return;}
 ivec2 xy=ivec2(local.x/waveWidth*512.,float(cell*128)+local.y/waveHeight*128.);
 float count=float(texelFetch(density,xy,0).r);color=count==0.?vec4(1.):vec4(palette(sqrt(count/max(1.,float(texelFetch(sampleCounts,ivec2(0,cell),0).r))*10.)),1.);
}`;
export function drawDensity(
  canvas: HTMLCanvasElement,
  data: Uint16Array,
  cells: number,
  layout: WaveLayout,
  samples: Uint32Array,
) {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    preserveDrawingBuffer: true,
  });
  if (!gl || !cells) return () => {};
  const dpr = Math.min(2, devicePixelRatio || 1);
  canvas.width = canvas.clientWidth * dpr;
  canvas.height = Math.ceil(cells / layout.columns) * layout.rowStride * dpr;
  const p = program(gl, vertex, fragment),
    texture = gl.createTexture()!,
    sampleTexture = gl.createTexture()!,
    vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  gl.useProgram(p);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R16UI,
    512,
    cells * 128,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_SHORT,
    data,
  );
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, sampleTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.R32UI,
    1,
    cells,
    0,
    gl.RED_INTEGER,
    gl.UNSIGNED_INT,
    samples,
  );
  gl.uniform1i(gl.getUniformLocation(p, "sampleCounts"), 1);
  gl.uniform1i(gl.getUniformLocation(p, "density"), 0);
  gl.uniform1i(gl.getUniformLocation(p, "cells"), cells);
  gl.uniform1i(gl.getUniformLocation(p, "columns"), layout.columns);
  gl.uniform2f(
    gl.getUniformLocation(p, "extent"),
    canvas.clientWidth,
    Math.ceil(cells / layout.columns) * layout.rowStride,
  );
  for (const name of [
    "tileStride",
    "rowStride",
    "waveWidth",
    "waveHeight",
    "inset",
    "top",
  ] as const)
    gl.uniform1f(gl.getUniformLocation(p, name), layout[name] || 0);
  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.disable(gl.BLEND);
  gl.disable(gl.SCISSOR_TEST);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  return () => {
    gl.deleteTexture(texture);
    gl.deleteTexture(sampleTexture);
    gl.deleteVertexArray(vao);
    gl.deleteProgram(p);
  };
}
