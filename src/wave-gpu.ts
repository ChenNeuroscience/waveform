import { program } from "./gpu";
import { cellRgb } from "./types";
import { WAVE_GAIN, WAVE_MARGIN, WAVE_SAMPLES, WAVE_SPAN, type WaveLayout } from "./plot-geometry";
/** A JS number as a GLSL float literal. */
const glsl = (n: number) => (Number.isInteger(n) ? `${n}.` : `${n}`);
// Raw 216-byte records live in an R8I texture array, 9 records per 1944-byte row and
// 2048 rows per layer (within WebGL2's guaranteed size limits). The shader reads the
// file's own layout, so no CPU transposition is needed. One layer is one batch.
const RECORD = 216;
const PER_ROW = 9;
const ROW_BYTES = PER_ROW * RECORD;
const LAYER_ROWS = 2048;
const PER_LAYER = PER_ROW * LAYER_ROWS;
const ORDER_WIDTH = 4096;
const SPIKES_PER_FRAME = 1 << 17;
const CACHE_BYTES = 192 << 20;
const lineVertex = `#version 300 es
precision highp float;precision highp int;precision highp isampler2DArray;precision highp usampler2D;
uniform isampler2DArray waves;uniform usampler2D order;uniform int base;uniform int channel;uniform float timeScale;
flat out float time;
void main(){
 int k=base+gl_InstanceID;int s=int(texelFetch(order,ivec2(k%${ORDER_WIDTH},k/${ORDER_WIDTH}),0).r);int r=s%${PER_LAYER};
 ivec3 at=ivec3((r%${PER_ROW})*${RECORD}+channel*54,r/${PER_ROW},s/${PER_LAYER});
 // Each channel block starts with the record's big-endian u32 timestamp.
 uint ticks=0u;for(int b=0;b<4;b++)ticks=ticks<<8|uint(texelFetch(waves,at+ivec3(b,0,0),0).r&255);
 time=float(ticks)*timeScale;
 float v=float(texelFetch(waves,at+ivec3(4+gl_VertexID,0,0),0).r)/128.;
 // Shared waveform frame geometry (plot-geometry.ts).
 float x=(float(channel)+${glsl(WAVE_MARGIN)}+${glsl(WAVE_SPAN)}*float(gl_VertexID)/${glsl(WAVE_SAMPLES - 1)})/4.;gl_Position=vec4(x*2.-1.,v*${glsl(WAVE_GAIN)},0.,1.);}`;
const lineFragment = `#version 300 es
precision highp float;uniform float unit;flat in float time;out vec4 c;void main(){c=vec4(unit,time*unit,0.,0.);}`;
const quadVertex = `#version 300 es
void main(){vec2 p=vec2((gl_VertexID<<1)&2,gl_VertexID&2);gl_Position=vec4(p*2.-1.,0.,1.);}`;
// Per-pixel (line count, summed spike time) becomes flag colour (any count), the
// original density palette, or drift: mean spike time, red (start) to green (end).
const FLAG = 0;
const DENSITY = 1;
const DRIFT = 2;
const quadFragment = `#version 300 es
precision highp float;uniform sampler2D counts;uniform vec2 origin;uniform vec3 rgb;uniform float unit;uniform float total;uniform int mode;out vec4 c;
vec3 palette(float count){return vec3(count>.5?(count>.75?4.-4.*count:4.*count-2.):(count>.25?2.-4.*count:4.*count),count<.5?2.*count:2.-2.*count,count);}
void main(){
 vec2 s=texelFetch(counts,ivec2(gl_FragCoord.xy-origin),0).rg/unit;
 if(s.x<.5){c=vec4(1.);return;}
 float t=s.y/s.x;
 c=vec4(mode==${DRIFT}?vec3(1.-t,t,0.):mode==${DENSITY}?palette(sqrt(s.x/max(1.,total)*10.)):rgb,1.);}`;
interface Entry {
  texture: WebGLTexture;
  fbo: WebGLFramebuffer;
  drawn: number;
  total: number;
}
interface Scene {
  data: {
    key: string;
    waveSlots: number;
    waveOrder: Uint32Array;
    waveStarts: Uint32Array;
    waveHashes: Uint32Array;
    times: Uint32Array;
  };
  cells: number[];
  layout: WaveLayout;
  density: boolean;
  /** Mean spike time per pixel; drawn only where float blending is available. */
  drift: boolean;
  readyKey: string;
}
export type LoadBatch = (asset: string, first: number, count: number) => Promise<Uint8Array>;
/** Full-population waveform tiles in one WebGL2 context. Each cell's line counts are
 * rendered once, in budgeted per-frame batches, into a texture cached by the hash of
 * its resident spike set; frames only composite those textures into tile viewports. */
export class WaveGPU {
  gl: WebGL2RenderingContext;
  lines!: WebGLProgram;
  quad!: WebGLProgram;
  vao!: WebGLVertexArrayObject;
  waves: WebGLTexture | null = null;
  order: WebGLTexture | null = null;
  unit = 1;
  countFormat: number = 0;
  bytesPerPixel = 4;
  /** Whether cache textures hold summed spike times (needed for drift). */
  timed = false;
  asset = "";
  loaded = false;
  loading = 0;
  orderData: Uint32Array | null = null;
  cache = new Map<string, Entry>();
  cacheSize = "";
  scene: Scene | null = null;
  frame = 0;
  done = "";
  constructor(
    public canvas: HTMLCanvasElement,
    public load: LoadBatch,
    public onReady: (key: string) => void,
  ) {
    const gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      preserveDrawingBuffer: true,
    });
    if (!gl) {
      throw new Error("WebGL2 is unavailable. Enable hardware acceleration and reopen this page.");
    }
    this.gl = gl;
    canvas.addEventListener("webglcontextlost", this.lost);
    canvas.addEventListener("webglcontextrestored", this.restored);
    this.init();
  }
  private init() {
    const gl = this.gl;
    this.lines = program(gl, lineVertex, lineFragment);
    this.quad = program(gl, quadVertex, quadFragment);
    this.vao = gl.createVertexArray()!;
    // Exact float counts and summed times need float blending; otherwise counts
    // saturate earlier (half float at 2048, bytes at 255) and drift is not drawn.
    // Flag colouring only needs count > 0.
    const float = gl.getExtension("EXT_color_buffer_float");
    this.timed = !!(float && gl.getExtension("EXT_float_blend"));
    if (this.timed) {
      [this.countFormat, this.unit, this.bytesPerPixel] = [gl.RG32F, 1, 8];
    } else if (float) {
      [this.countFormat, this.unit, this.bytesPerPixel] = [gl.R16F, 1, 2];
    } else {
      [this.countFormat, this.unit, this.bytesPerPixel] = [gl.RGBA8, 1 / 255, 4];
    }
  }
  private lost = (e: Event) => {
    e.preventDefault();
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.loading++;
  };
  private restored = () => {
    this.cache.clear();
    this.waves = this.order = this.orderData = null;
    this.asset = "";
    this.done = "";
    this.init();
    if (this.scene) {
      this.update(this.scene);
    }
  };
  update(scene: Scene) {
    const gl = this.gl;
    const { data } = scene;
    this.scene = scene;
    if (data.key !== this.asset) {
      this.reset(data.key, data.waveSlots);
    }
    if (data.waveOrder !== this.orderData && this.order) {
      const rows = Math.max(1, Math.ceil(data.waveSlots / ORDER_WIDTH));
      const padded = new Uint32Array(rows * ORDER_WIDTH);
      padded.set(data.waveOrder);
      gl.bindTexture(gl.TEXTURE_2D, this.order);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        ORDER_WIDTH,
        rows,
        gl.RED_INTEGER,
        gl.UNSIGNED_INT,
        padded,
      );
      this.orderData = data.waveOrder;
    }
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = `${Math.round(scene.layout.waveWidth * dpr)}x${Math.round(scene.layout.waveHeight * dpr)}`;
    if (size !== this.cacheSize) {
      this.clearCache();
      this.cacheSize = size;
    }
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(
      Math.ceil(scene.cells.length / scene.layout.columns) * scene.layout.rowStride * dpr,
    );
    this.tick();
  }
  dispose() {
    cancelAnimationFrame(this.frame);
    this.loading++;
    this.canvas.removeEventListener("webglcontextlost", this.lost);
    this.canvas.removeEventListener("webglcontextrestored", this.restored);
    const gl = this.gl;
    this.clearCache();
    gl.deleteTexture(this.waves);
    gl.deleteTexture(this.order);
    gl.deleteProgram(this.lines);
    gl.deleteProgram(this.quad);
    gl.deleteVertexArray(this.vao);
  }
  private reset(asset: string, slots: number) {
    const gl = this.gl;
    this.clearCache();
    gl.deleteTexture(this.waves);
    gl.deleteTexture(this.order);
    this.waves = this.order = this.orderData = null;
    this.asset = asset;
    this.loaded = false;
    const token = ++this.loading;
    if (!slots) {
      return;
    }
    const layers = Math.ceil(slots / PER_LAYER);
    this.waves = texture(gl, gl.TEXTURE_2D_ARRAY);
    gl.texStorage3D(gl.TEXTURE_2D_ARRAY, 1, gl.R8I, ROW_BYTES, LAYER_ROWS, layers);
    this.order = texture(gl, gl.TEXTURE_2D);
    gl.texStorage2D(
      gl.TEXTURE_2D,
      1,
      gl.R32UI,
      ORDER_WIDTH,
      Math.max(1, Math.ceil(slots / ORDER_WIDTH)),
    );
    (async () => {
      for (let layer = 0; layer < layers; layer++) {
        const first = layer * PER_LAYER;
        const count = Math.min(PER_LAYER, slots - first);
        const bytes = await this.load(asset, first, count);
        if (token !== this.loading) {
          return;
        }
        const rows = Math.ceil(count / PER_ROW);
        let data = new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
        if (data.length < rows * ROW_BYTES) {
          const padded = new Int8Array(rows * ROW_BYTES);
          padded.set(data);
          data = padded;
        }
        gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.waves);
        gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
        gl.texSubImage3D(
          gl.TEXTURE_2D_ARRAY,
          0,
          0,
          0,
          layer,
          ROW_BYTES,
          rows,
          1,
          gl.RED_INTEGER,
          gl.BYTE,
          data,
        );
      }
      this.loaded = true;
      this.tick();
    })().catch(() => {});
  }
  private clearCache() {
    for (const entry of this.cache.values()) {
      this.release(entry);
    }
    this.cache.clear();
    this.done = "";
  }
  private release(entry: Entry) {
    this.gl.deleteFramebuffer(entry.fbo);
    this.gl.deleteTexture(entry.texture);
  }
  private key(cell: number) {
    const { waveStarts: starts, waveHashes: hashes } = this.scene!.data;
    const total = starts[cell + 1] - starts[cell];
    return total ? `${total}:${hashes[cell * 2]}:${hashes[cell * 2 + 1]}` : null;
  }
  private entry(key: string, total: number, [w, h]: number[]) {
    let entry = this.cache.get(key);
    if (entry) {
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry;
    }
    const gl = this.gl;
    const t = texture(gl, gl.TEXTURE_2D);
    gl.texStorage2D(gl.TEXTURE_2D, 1, this.countFormat, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, t, 0);
    gl.viewport(0, 0, w, h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    entry = { texture: t, fbo, drawn: 0, total };
    this.cache.set(key, entry);
    return entry;
  }
  private evict(keep: Set<string>, [w, h]: number[]) {
    const limit = Math.max(keep.size, Math.floor(CACHE_BYTES / (w * h * this.bytesPerPixel)));
    for (const [key, entry] of this.cache) {
      if (this.cache.size <= limit) {
        break;
      }
      if (keep.has(key)) {
        continue;
      }
      this.release(entry);
      this.cache.delete(key);
    }
  }
  private schedule() {
    this.frame ||= requestAnimationFrame(() => {
      this.frame = 0;
      this.tick();
    });
  }
  /** Render up to SPIKES_PER_FRAME spikes of unfinished visible cells, then composite. */
  private tick() {
    const gl = this.gl;
    const scene = this.scene;
    if (!scene || gl.isContextLost()) {
      return;
    }
    const { cells, layout, data } = scene;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = this.cacheSize.split("x").map(Number);
    const keys = cells.map((c) => (this.loaded ? this.key(c) : null));
    if (!(size[0] > 0 && size[1] > 0)) {
      return;
    }
    let budget = SPIKES_PER_FRAME;
    let complete = this.loaded || !data.waveSlots;
    if (this.loaded) {
      // Create/touch cache entries before binding samplers: allocating a texture
      // binds it to the active unit, which would displace the order texture.
      const entries = cells.map((cell, i) =>
        keys[i]
          ? this.entry(keys[i], data.waveStarts[cell + 1] - data.waveStarts[cell], size)
          : null,
      );
      gl.useProgram(this.lines);
      gl.bindVertexArray(this.vao);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D_ARRAY, this.waves);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.order);
      const u = (n: string) => gl.getUniformLocation(this.lines, n);
      gl.uniform1i(u("waves"), 0);
      gl.uniform1i(u("order"), 1);
      gl.uniform1f(u("unit"), this.unit);
      gl.uniform1f(u("timeScale"), 1 / Math.max(1, data.times[data.times.length - 1] || 0));
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.viewport(0, 0, size[0], size[1]);
      cells.forEach((cell, i) => {
        const entry = entries[i];
        if (!entry) {
          return;
        }
        const total = entry.total;
        if (entry.drawn >= total) {
          return;
        }
        if (budget > 0) {
          const n = Math.min(budget, total - entry.drawn);
          gl.bindFramebuffer(gl.FRAMEBUFFER, entry.fbo);
          gl.viewport(0, 0, size[0], size[1]);
          gl.uniform1i(u("base"), data.waveStarts[cell] + entry.drawn);
          for (let c = 0; c < 4; c++) {
            gl.uniform1i(u("channel"), c);
            gl.drawArraysInstanced(gl.LINE_STRIP, 0, 50, n);
          }
          entry.drawn += n;
          budget -= n;
        }
        if (entry.drawn < total) {
          complete = false;
        }
      });
      gl.disable(gl.BLEND);
      this.evict(new Set(keys.filter((k) => k !== null)), size);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(1, 1, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.quad);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    const u = (n: string) => gl.getUniformLocation(this.quad, n);
    gl.uniform1i(u("counts"), 0);
    gl.uniform1f(u("unit"), this.unit);
    gl.uniform1i(u("mode"), scene.drift && this.timed ? DRIFT : scene.density ? DENSITY : FLAG);
    cells.forEach((cell, i) => {
      const entry = keys[i] && this.cache.get(keys[i]);
      if (!entry) {
        return;
      }
      const x = Math.round(((i % layout.columns) * layout.tileStride + layout.inset) * dpr);
      const y =
        this.canvas.height -
        Math.round((Math.floor(i / layout.columns) * layout.rowStride + (layout.top || 0)) * dpr) -
        size[1];
      gl.viewport(x, y, size[0], size[1]);
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform2f(u("origin"), x, y);
      gl.uniform3fv(u("rgb"), cellRgb(cell));
      gl.uniform1f(u("total"), entry.drawn);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    });
    // While records are still loading, the loader's final tick resumes rendering.
    if (!complete) {
      if (this.loaded) {
        this.schedule();
      }
    } else if (this.done !== scene.readyKey) {
      this.onReady((this.done = scene.readyKey));
    }
  }
}
function texture(gl: WebGL2RenderingContext, target: number) {
  const t = gl.createTexture()!;
  gl.bindTexture(target, t);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  return t;
}
