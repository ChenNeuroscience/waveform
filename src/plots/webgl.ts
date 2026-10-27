/** WebGL2 shader compilation helpers shared by the plot renderers. */

function shader(gl: WebGL2RenderingContext, type: number, source: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, source);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(s) || "Shader compilation failed");
  }
  return s;
}
export function program(gl: WebGL2RenderingContext, v: string, f: string) {
  const p = gl.createProgram()!;
  const a = shader(gl, gl.VERTEX_SHADER, v);
  const b = shader(gl, gl.FRAGMENT_SHADER, f);
  gl.attachShader(p, a);
  gl.attachShader(p, b);
  gl.linkProgram(p);
  gl.deleteShader(a);
  gl.deleteShader(b);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "Shader link failed");
  }
  return p;
}
