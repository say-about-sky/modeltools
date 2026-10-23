// 轻量 CPU 粒子池 + WebGL billboard 绘制（g3d-web 版）。
// 设计目标：无外部贴图、无纹理图集；程序生成径向贴图；支持 alpha / additive 两种混合。

const MAX_PARTICLES = 512;
const FLOATS_PER_VERTEX = 9; // position3 + uv2 + color4
const VERTICES_PER_PARTICLE = 6;
const FLOATS_PER_PARTICLE = FLOATS_PER_VERTEX * VERTICES_PER_PARTICLE;
const STRIDE_BYTES = FLOATS_PER_VERTEX * 4;

/**
 * 预设参数：
 *   count       每次触发数量
 *   life        寿命（秒）
 *   size0/size1 世界单位直径
 *   color0/1    RGBA
 *   forward     沿武器方向的初速度
 *   up          向上初速度
 *   spread      随机速度幅度
 *   gravity     正=向下，负=上浮
 *   drag        速度阻尼（1/秒）
 *   blend       'alpha' | 'add'
 *   posSpread   出生点随机幅度
 */
const PRESETS = {
  musket_muzzle: [
    {
      count: 1, life: 0.09, size0: 0.06, size1: 0.15,
      color0: [1.0, 0.95, 0.72, 1.0], color1: [1.0, 0.45, 0.10, 0.0],
      forward: 0, up: 0, spread: 0.03, gravity: 0, drag: 0,
      blend: 'add', posSpread: 0.012,
    },
    {
      count: 1, life: 0.18, size0: 0.09, size1: 0.24,
      color0: [1.0, 0.62, 0.22, 0.55], color1: [1.0, 0.20, 0.02, 0.0],
      forward: 0, up: 0.05, spread: 0.02, gravity: 0, drag: 0,
      blend: 'add', posSpread: 0.015,
    },
    {
      count: 5, life: 0.65, size0: 0.06, size1: 0.24,
      color0: [0.90, 0.87, 0.80, 0.65], color1: [0.50, 0.48, 0.45, 0.0],
      forward: 0.55, up: 0.28, spread: 0.24, gravity: -0.18, drag: 1.5,
      blend: 'alpha', posSpread: 0.025,
    },
    {
      count: 2, life: 0.16, size0: 0.012, size1: 0.004,
      color0: [1.0, 0.85, 0.40, 1.0], color1: [1.0, 0.20, 0.0, 0.0],
      forward: 1.2, up: 0.5, spread: 0.8, gravity: 4.5, drag: 0.6,
      blend: 'add', posSpread: 0.01,
    },
  ],
  musket_ignite: [
    {
      count: 2, life: 0.18, size0: 0.02, size1: 0.06,
      color0: [1.0, 0.65, 0.25, 1.0], color1: [0.8, 0.25, 0.05, 0.0],
      forward: 0, up: 0.25, spread: 0.08, gravity: -0.2, drag: 2,
      blend: 'add', posSpread: 0.006,
    },
  ],
  bow_release: [
    {
      count: 2, life: 0.25, size0: 0.02, size1: 0.06,
      color0: [0.78, 0.75, 0.68, 0.35], color1: [0.55, 0.52, 0.48, 0.0],
      forward: 0.4, up: 0.15, spread: 0.12, gravity: -0.05, drag: 2.2,
      blend: 'alpha', posSpread: 0.01,
    },
  ],
  melee_sparks: [
    {
      count: 7, life: 0.20, size0: 0.013, size1: 0.004,
      color0: [1.0, 0.92, 0.55, 1.0], color1: [1.0, 0.25, 0.05, 0.0],
      forward: 1.0, up: 1.0, spread: 1.4, gravity: 7.0, drag: 0.8,
      blend: 'add', posSpread: 0.012,
    },
    {
      count: 2, life: 0.30, size0: 0.02, size1: 0.05,
      color0: [0.7, 0.66, 0.58, 0.28], color1: [0.5, 0.48, 0.45, 0.0],
      forward: 0.3, up: 0.25, spread: 0.2, gravity: -0.05, drag: 2.0,
      blend: 'alpha', posSpread: 0.012,
    },
  ],
  cannon_muzzle: [
    {
      count: 1, life: 0.14, size0: 0.14, size1: 0.34,
      color0: [1.0, 0.88, 0.55, 1.0], color1: [1.0, 0.32, 0.05, 0.0],
      forward: 0, up: 0, spread: 0.04, gravity: 0, drag: 0,
      blend: 'add', posSpread: 0.02,
    },
    {
      count: 9, life: 0.85, size0: 0.10, size1: 0.38,
      color0: [0.72, 0.69, 0.64, 0.55], color1: [0.35, 0.33, 0.30, 0.0],
      forward: 0.9, up: 0.35, spread: 0.35, gravity: -0.2, drag: 1.2,
      blend: 'alpha', posSpread: 0.04,
    },
    {
      count: 3, life: 0.22, size0: 0.02, size1: 0.008,
      color0: [1.0, 0.8, 0.35, 1.0], color1: [1.0, 0.2, 0.0, 0.0],
      forward: 1.6, up: 0.8, spread: 1.0, gravity: 5.0, drag: 0.6,
      blend: 'add', posSpread: 0.02,
    },
  ],
};

/** 运行时 anim_events.json 用 "#RRGGBB" 字符串；GPU 顶点色必须是 [r,g,b,a] 数值。 */
function parseColor(value, fallbackAlpha = 1) {
  if (Array.isArray(value)) {
    return [
      Number(value[0]) || 0,
      Number(value[1]) || 0,
      Number(value[2]) || 0,
      value.length > 3 ? (Number(value[3]) || 0) : fallbackAlpha,
    ];
  }
  if (typeof value === 'string') {
    const s = value.trim();
    if (s.startsWith('#')) {
      const hex = s.slice(1);
      if (hex.length === 6 || hex.length === 8) {
        const r = parseInt(hex.slice(0, 2), 16) / 255;
        const g = parseInt(hex.slice(2, 4), 16) / 255;
        const b = parseInt(hex.slice(4, 6), 16) / 255;
        const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : fallbackAlpha;
        return [r, g, b, a];
      }
    }
    const m = s.match(/rgba?\(([^)]+)\)/i);
    if (m) {
      const parts = m[1].split(',').map((x) => Number(x.trim()));
      const scale = s.toLowerCase().startsWith('rgb(') ? 1 / 255 : 1;
      const a = parts.length > 3 ? parts[3] : fallbackAlpha;
      return [(parts[0] || 0) * scale, (parts[1] || 0) * scale, (parts[2] || 0) * scale, a];
    }
  }
  return [1, 1, 1, fallbackAlpha];
}

function compile(gl, type, src, label) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error(`粒子 ${label} 着色器编译失败: ${log}`);
  }
  return sh;
}

function createProgram(gl) {
  const vs = `attribute vec3 a_position;
attribute vec2 a_uv;
attribute vec4 a_color;
uniform mat4 u_projView;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  v_uv = a_uv;
  v_color = a_color;
  gl_Position = u_projView * vec4(a_position, 1.0);
}`;
  const fs = `precision mediump float;
uniform sampler2D u_tex;
varying vec2 v_uv;
varying vec4 v_color;
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  gl_FragColor = vec4(v_color.rgb, v_color.a * t.a);
}`;
  const v = compile(gl, gl.VERTEX_SHADER, vs, 'vertex');
  const f = compile(gl, gl.FRAGMENT_SHADER, fs, 'fragment');
  const p = gl.createProgram();
  gl.attachShader(p, v);
  gl.attachShader(p, f);
  gl.linkProgram(p);
  gl.deleteShader(v);
  gl.deleteShader(f);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(p);
    gl.deleteProgram(p);
    throw new Error(`粒子着色器链接失败: ${log}`);
  }
  return p;
}

export class ParticleSystem {
  constructor(gl, log = () => {}) {
    this.gl = gl;
    this.log = log;
    this.prog = createProgram(gl);
    this.attrs = {
      position: gl.getAttribLocation(this.prog, 'a_position'),
      uv: gl.getAttribLocation(this.prog, 'a_uv'),
      color: gl.getAttribLocation(this.prog, 'a_color'),
    };
    this.uniforms = {
      projView: gl.getUniformLocation(this.prog, 'u_projView'),
      tex: gl.getUniformLocation(this.prog, 'u_tex'),
    };
    this.vbo = gl.createBuffer();
    this.verts = new Float32Array(MAX_PARTICLES * FLOATS_PER_PARTICLE);
    this.tex = this.createRadialTexture(64);
    this.particles = [];
    this.emitted = 0;
    this.alive = 0;
  }

  createRadialTexture(size) {
    const gl = this.gl;
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const dx = (x - (size - 1) * 0.5) / (size * 0.5);
        const dy = (y - (size - 1) * 0.5) / (size * 0.5);
        const d = Math.hypot(dx, dy);
        let a = 1 - d;
        if (a < 0) a = 0;
        a = a * a;
        const i = (y * size + x) * 4;
        data[i] = 255;
        data[i + 1] = 255;
        data[i + 2] = 255;
        data[i + 3] = Math.round(a * 255);
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  clear() {
    this.particles.length = 0;
    this.alive = 0;
  }

  /** 在世界坐标 pos 处、沿 dir 方向发射一组预设。 */
  emit(presetName, anchor, options = {}) {
    const defs = options.defs !== undefined ? options.defs : PRESETS[presetName];
    if (!defs || !defs.length || !anchor || !anchor.pos) return 0;
    const dir = anchor.dir || [0, 0, -1];
    const base = options.atGrip ? anchor.grip || anchor.pos : anchor.pos;
    const scale = options.scale || 1;
    let spawned = 0;
    for (const def of defs) {
      // 运行时预设用 hex 字符串；内建预设用 [r,g,b,a] 数组。
      // alpha 混合的 smoke 默认半透明，其余（flash/glow/spark）不透明，且末帧淡出。
      const alpha0 = (def.kind === 'smoke' && def.blend !== 'add') ? 0.60 : 1.0;
      const c0 = parseColor(def.color0, alpha0);
      const c1 = parseColor(def.color1, 0.0);
      for (let i = 0; i < def.count; i++) {
        if (this.particles.length >= MAX_PARTICLES) break;
        const posSpread = def.posSpread || 0;
        const px = base[0] + (Math.random() * 2 - 1) * posSpread;
        const py = base[1] + (Math.random() * 2 - 1) * posSpread;
        const pz = base[2] + (Math.random() * 2 - 1) * posSpread;
        const spread = def.spread || 0;
        const rvx = (Math.random() * 2 - 1) * spread;
        const rvy = (Math.random() * 2 - 1) * spread;
        const rvz = (Math.random() * 2 - 1) * spread;
        const fw = def.forward || 0;
        const life = def.life * (0.8 + Math.random() * 0.4);
        this.particles.push({
          x: px, y: py, z: pz,
          vx: dir[0] * fw + rvx,
          vy: dir[1] * fw + (def.up || 0) + rvy,
          vz: dir[2] * fw + rvz,
          age: 0,
          life,
          s0: def.size0 * scale * (0.85 + Math.random() * 0.3),
          s1: def.size1 * scale,
          c0,
          c1,
          gravity: def.gravity || 0,
          drag: def.drag || 0,
          blend: def.blend || 'alpha',
        });
        spawned++;
      }
    }
    this.emitted += spawned;
    return spawned;
  }

  update(dt) {
    if (!(dt > 0) || !this.particles.length) return;
    let w = 0;
    for (let i = 0; i < this.particles.length; i++) {
      const p = this.particles[i];
      p.age += dt;
      if (p.age >= p.life) continue;
      const damp = p.drag > 0 ? Math.exp(-p.drag * dt) : 1;
      p.vx *= damp;
      p.vy *= damp;
      p.vz *= damp;
      p.vy -= p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      this.particles[w++] = p;
    }
    this.particles.length = w;
    this.alive = w;
  }

  /** 在给定相机下绘制（世界空间 billboard）。 */
  draw(projView, eye, target) {
    const gl = this.gl;
    const n = this.particles.length;
    this.alive = n;
    if (!n) return;

    // 相机右/上向量（正交相机方向固定）
    let fx = target[0] - eye[0];
    let fy = target[1] - eye[1];
    let fz = target[2] - eye[2];
    const fl = Math.hypot(fx, fy, fz) || 1;
    fx /= fl; fy /= fl; fz /= fl;
    let rx = fy * 0 - fz * 1;
    let ry = fz * 0 - fx * 0;
    let rz = fx * 1 - fy * 0;
    let rl = Math.hypot(rx, ry, rz);
    if (rl < 1e-6) { rx = 1; ry = 0; rz = 0; rl = 1; }
    rx /= rl; ry /= rl; rz /= rl;
    const ux = ry * fz - rz * fy;
    const uy = rz * fx - rx * fz;
    const uz = rx * fy - ry * fx;

    let alphaCount = 0;
    let addCount = 0;
    // 先 alpha，后 additive；这样 smoke 在闪光后面
    for (let pass = 0; pass < 2; pass++) {
      const wantAdd = pass === 1;
      for (const p of this.particles) {
        if ((p.blend === 'add') !== wantAdd) continue;
        const t = Math.min(1, p.age / p.life);
        const s = p.s0 + (p.s1 - p.s0) * t;
        const half = s * 0.5;
        const cr = p.c0[0] + (p.c1[0] - p.c0[0]) * t;
        const cg = p.c0[1] + (p.c1[1] - p.c0[1]) * t;
        const cb = p.c0[2] + (p.c1[2] - p.c0[2]) * t;
        const ca = p.c0[3] + (p.c1[3] - p.c0[3]) * t;
        const x = p.x, y = p.y, z = p.z;
        const ox = rx * half, oy = ry * half, oz = rz * half;
        const ux2 = ux * half, uy2 = uy * half, uz2 = uz * half;
        const base = (alphaCount + addCount) * FLOATS_PER_PARTICLE;
        this.writeQuad(base, x, y, z, ox, oy, oz, ux2, uy2, uz2, cr, cg, cb, ca);
        if (wantAdd) addCount++; else alphaCount++;
      }
    }
    const total = alphaCount + addCount;
    if (!total) return;

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, total * FLOATS_PER_PARTICLE), gl.DYNAMIC_DRAW);
    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.uniforms.projView, false, projView);
    gl.uniform1i(this.uniforms.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);

    const stride = STRIDE_BYTES;
    if (this.attrs.position >= 0) {
      gl.enableVertexAttribArray(this.attrs.position);
      gl.vertexAttribPointer(this.attrs.position, 3, gl.FLOAT, false, stride, 0);
    }
    if (this.attrs.uv >= 0) {
      gl.enableVertexAttribArray(this.attrs.uv);
      gl.vertexAttribPointer(this.attrs.uv, 2, gl.FLOAT, false, stride, 12);
    }
    if (this.attrs.color >= 0) {
      gl.enableVertexAttribArray(this.attrs.color);
      gl.vertexAttribPointer(this.attrs.color, 4, gl.FLOAT, false, stride, 20);
    }

    const depthOn = gl.isEnabled(gl.DEPTH_TEST);
    const cullOn = gl.isEnabled(gl.CULL_FACE);
    const blendOn = gl.isEnabled(gl.BLEND);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
    gl.enable(gl.BLEND);
    gl.depthMask(false);

    if (alphaCount > 0) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.drawArrays(gl.TRIANGLES, 0, alphaCount * VERTICES_PER_PARTICLE);
    }
    if (addCount > 0) {
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.drawArrays(gl.TRIANGLES, alphaCount * VERTICES_PER_PARTICLE, addCount * VERTICES_PER_PARTICLE);
    }

    gl.depthMask(true);
    if (depthOn) gl.enable(gl.DEPTH_TEST); else gl.disable(gl.DEPTH_TEST);
    if (cullOn) gl.enable(gl.CULL_FACE); else gl.disable(gl.CULL_FACE);
    if (!blendOn) gl.disable(gl.BLEND);
  }

  writeQuad(base, x, y, z, ox, oy, oz, ux2, uy2, uz2, r, g, b, a) {
    const v = this.verts;
    const corners = [
      [-1, -1, 0, 0],
      [1, -1, 1, 0],
      [1, 1, 1, 1],
      [-1, -1, 0, 0],
      [1, 1, 1, 1],
      [-1, 1, 0, 1],
    ];
    for (let i = 0; i < 6; i++) {
      const c = corners[i];
      const o = base + i * FLOATS_PER_VERTEX;
      v[o] = x + ox * c[0] + ux2 * c[1];
      v[o + 1] = y + oy * c[0] + uy2 * c[1];
      v[o + 2] = z + oz * c[0] + uz2 * c[1];
      v[o + 3] = c[2];
      v[o + 4] = c[3];
      v[o + 5] = r;
      v[o + 6] = g;
      v[o + 7] = b;
      v[o + 8] = a;
    }
  }

  dispose() {
    const gl = this.gl;
    if (this.vbo) gl.deleteBuffer(this.vbo);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.prog) gl.deleteProgram(this.prog);
    this.vbo = null;
    this.tex = null;
    this.prog = null;
    this.particles.length = 0;
  }
}

export { PRESETS as PARTICLE_PRESETS };
