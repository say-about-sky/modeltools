// WebGL 渲染器：复刻 G3DArmyMin 的模型渲染管线。
//
// 对照 G3DArmyMin：
//   * 正交相机：position(0, 0.886*worldH, 1.136*worldH) → lookAt(0, 0.432*worldH, 0)
//   * 自动适配：高/最大边缩放到 worldH*fitPct，脚底贴地、水平居中
//   * 光照：ambient(0.52,0.49,0.44) + directional(0.85,0.79,0.66) dir(-0.9,-1.3,-0.7)
//   * 蒙皮：poseGlobal(bone) * inverse(bindWorld)（u_bones）
//   * 顶点色：脚底 AO（0.5 → 1.0，pow(t,1.3)）
//   * 接触阴影：径向渐变 quad（(1-d)^2*0.42），锚点=脚底 12% 高度带均值
//   * 染色：diffuse = base + (tint-base)*strength，跳过 head/skin 材质
//   * 程序化兜底动作：待机呼吸 / 移动起伏 / 战斗突刺 / 撤退碎步+前倾

import {
  mat4Identity, mat4Multiply, mat4Translation, mat4Scaling, mat4RotationY,
  mat4RotationEuler, mat4LookAt, mat4Ortho, mat4TransformPoint, clamp,
} from './math.js';
import { samplePose } from './g3dj.js';
import { ParticleSystem } from './particles.js';
import {
  detectWeapon, eventListFor, computeAttackAnchor, crossed, weaponLabel,
} from './anim_events.js';

// G3DArmyMin.init() 的环境光照
export const AMBIENT = [0.52, 0.49, 0.44];
export const LIGHT_COLOR = [0.85, 0.79, 0.66];
export const LIGHT_DIR = (() => {
  // 环境里的方向 (-0.9,-1.3,-0.7)；DefaultShader 中 lightDir = -direction
  const x = 0.9, y = 1.3, z = 0.7;
  const l = Math.hypot(x, y, z);
  return [x / l, y / l, z / l];
})();

export const G3D_DEFAULTS = {
  worldH: 2.2,
  fitPct: 0.85,
  fitByMax: false,
  feetDark: 0.5,
  tintStrength: 0.45,
  tintSkip: ['head', 'skin'],
  shadowScale: 1,
  shadowCore: 0.6,
  anchorBand: 0.12,
  modelYaw: 0,
};

const STRIDE_FLOATS = 28; // pos3 normal3 uv2 idx4 w4 idx4 w4 color4
const STRIDE_BYTES = STRIDE_FLOATS * 4;

function isPowerOfTwo(v) {
  return (v & (v - 1)) === 0;
}

function rgbaFromHex(hex) {
  const h = hex.replace('#', '');
  return [
    parseInt(h.slice(0, 2), 16) / 255,
    parseInt(h.slice(2, 4), 16) / 255,
    parseInt(h.slice(4, 6), 16) / 255,
  ];
}

export class Renderer {
  constructor(canvas, log = () => {}) {
    this.canvas = canvas;
    this.log = log;
    const opts = {
      alpha: false,
      antialias: true,
      depth: true,
      stencil: false,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
      premultipliedAlpha: false,
    };
    const gl = canvas.getContext('webgl2', opts) || canvas.getContext('webgl', opts);
    if (!gl) {
      throw new Error('浏览器不支持 WebGL');
    }
    this.gl = gl;
    this.isWebGL2 = typeof WebGL2RenderingContext !== 'undefined' && gl instanceof WebGL2RenderingContext;

    const maxVectors = gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS) || 128;
    this.maxBonesByLimit = Math.max(12, Math.floor((maxVectors - 12) / 4));
    this.log('info', `WebGL${this.isWebGL2 ? '2' : '1'} · MAX_VERTEX_UNIFORM_VECTORS=${maxVectors} · 骨骼上限=${this.maxBonesByLimit}`);

    this.programs = new Map();
    this.asset = null;
    this.gpu = null;
    this.textureCache = new Map();
    this.whiteTex = this.createSolidTexture([255, 255, 255, 255]);
    this.shadowTex = this.createShadowTexture();
    this.grid = this.createGrid();
    this.lineBuf = gl.createBuffer();
    this.lineData = new Float32Array(0);
    this.lineProgram = this.createLineProgram();
    this.shadowProgram = this.createShadowProgram();
    this.drawStats = { calls: 0, triangles: 0 };
    this.poseAnimated = new Set();
    this.feetDark = G3D_DEFAULTS.feetDark;
    // 最近一帧的投影/世界矩阵（AI 诊断用来做 CPU 投影与 ASCII 轮廓）
    this.lastProjView = new Float32Array(16);
    this.lastWorld = new Float32Array(16);
    this.lastCanvas = { drawW: 1, drawH: 1, cssW: 1, cssH: 1 };
    this.lastCamera = null;

    // 攻击粒子（EU5 animsm 事件时间 + 武器尖端锚点）
    try {
      this.particles = new ParticleSystem(gl, log);
    } catch (e) {
      this.particles = null;
      this.log('error', `粒子系统初始化失败: ${e.message || e}`);
    }
    this.weapon = 'none';
    this.lastParticleEvent = null;
    this.lastEventEmit = new Map();
    // 每个循环只触发一次：暂停/拖动时间轴时 prevTime 可能不变，
    // 仅靠 crossed() 会每帧重复发射（表现为粒子一直循环）。
    this.lastStateId = null;
    this.loopCount = 0;
    this.emittedCycles = new Set();
  }

  // ---------------------------------------------------------------- shader

  createMainProgram(maxBones) {
    const gl = this.gl;
    const vs = `#define MAX_BONES ${maxBones}
attribute vec3 a_position;
attribute vec3 a_normal;
attribute vec2 a_texCoord0;
attribute vec4 a_boneIndex0;
attribute vec4 a_boneWeight0;
attribute vec4 a_boneIndex1;
attribute vec4 a_boneWeight1;
attribute vec4 a_color;

uniform mat4 u_worldTrans;
uniform mat4 u_projViewTrans;
uniform mat4 u_bones[MAX_BONES];
uniform int u_skinned;
uniform vec3 u_ambientLight;
uniform vec3 u_lightColor;
uniform vec3 u_lightDir;

varying vec4 v_color;
varying vec2 v_texCoord0;
varying vec3 v_lightDiffuse;

void main() {
  mat4 skinning;
  if (u_skinned == 1) {
    skinning = mat4(0.0);
    skinning += a_boneWeight0.x * u_bones[int(a_boneIndex0.x)];
    skinning += a_boneWeight0.y * u_bones[int(a_boneIndex0.y)];
    skinning += a_boneWeight0.z * u_bones[int(a_boneIndex0.z)];
    skinning += a_boneWeight0.w * u_bones[int(a_boneIndex0.w)];
    skinning += a_boneWeight1.x * u_bones[int(a_boneIndex1.x)];
    skinning += a_boneWeight1.y * u_bones[int(a_boneIndex1.y)];
    skinning += a_boneWeight1.z * u_bones[int(a_boneIndex1.z)];
    skinning += a_boneWeight1.w * u_bones[int(a_boneIndex1.w)];
  } else {
    skinning = mat4(1.0);
  }
  vec4 pos = u_worldTrans * skinning * vec4(a_position, 1.0);
  gl_Position = u_projViewTrans * pos;
  vec3 normal = normalize((u_worldTrans * skinning * vec4(a_normal, 0.0)).xyz);
  float ndl = clamp(dot(normal, u_lightDir), 0.0, 1.0);
  v_lightDiffuse = u_ambientLight + u_lightColor * ndl;
  v_texCoord0 = a_texCoord0;
  v_color = a_color;
}`;
    const fs = `precision highp float;
varying vec4 v_color;
varying vec2 v_texCoord0;
varying vec3 v_lightDiffuse;

uniform sampler2D u_diffuseTexture;
uniform vec4 u_diffuseColor;
uniform vec3 u_emissive;
uniform float u_useTexture;
uniform float u_white;

void main() {
  vec4 tex = vec4(1.0);
  if (u_useTexture > 0.5 && u_white < 0.5) {
    tex = texture2D(u_diffuseTexture, v_texCoord0);
  }
  vec4 diffuse = u_white > 0.5 ? vec4(1.0) : tex * u_diffuseColor * v_color;
  gl_FragColor = vec4(diffuse.rgb * v_lightDiffuse + u_emissive, 1.0);
}`;
    const prog = this.linkProgram(vs, fs, `main(MAX_BONES=${maxBones})`);
    const p = {
      prog,
      attrs: {
        position: gl.getAttribLocation(prog, 'a_position'),
        normal: gl.getAttribLocation(prog, 'a_normal'),
        uv: gl.getAttribLocation(prog, 'a_texCoord0'),
        idx0: gl.getAttribLocation(prog, 'a_boneIndex0'),
        w0: gl.getAttribLocation(prog, 'a_boneWeight0'),
        idx1: gl.getAttribLocation(prog, 'a_boneIndex1'),
        w1: gl.getAttribLocation(prog, 'a_boneWeight1'),
        color: gl.getAttribLocation(prog, 'a_color'),
      },
      uniforms: {
        world: gl.getUniformLocation(prog, 'u_worldTrans'),
        projView: gl.getUniformLocation(prog, 'u_projViewTrans'),
        bones: gl.getUniformLocation(prog, 'u_bones'),
        skinned: gl.getUniformLocation(prog, 'u_skinned'),
        diffuseTexture: gl.getUniformLocation(prog, 'u_diffuseTexture'),
        diffuseColor: gl.getUniformLocation(prog, 'u_diffuseColor'),
        emissive: gl.getUniformLocation(prog, 'u_emissive'),
        ambient: gl.getUniformLocation(prog, 'u_ambientLight'),
        lightColor: gl.getUniformLocation(prog, 'u_lightColor'),
        lightDir: gl.getUniformLocation(prog, 'u_lightDir'),
        useTexture: gl.getUniformLocation(prog, 'u_useTexture'),
        white: gl.getUniformLocation(prog, 'u_white'),
      },
      maxBones,
      boneScratch: new Float32Array(maxBones * 16),
    };
    // 预先填充单位阵（未使用的槽位）
    for (let i = 0; i < maxBones; i++) {
      const m = mat4Identity();
      p.boneScratch.set(m, i * 16);
    }
    return p;
  }

  getMainProgram(maxBones) {
    const need = Math.max(12, maxBones);
    if (!this.programs.has(need)) {
      if (need > this.maxBonesByLimit) {
        throw new Error(`部件需要 ${need} 根骨骼，超过本机 uniform 上限（${this.maxBonesByLimit}）`);
      }
      this.programs.set(need, this.createMainProgram(need));
    }
    return this.programs.get(need);
  }

  createShadowProgram() {
    const gl = this.gl;
    const vs = `attribute vec3 a_position;
attribute vec2 a_texCoord0;
uniform mat4 u_worldTrans;
uniform mat4 u_projViewTrans;
varying vec2 v_uv;
void main() {
  gl_Position = u_projViewTrans * u_worldTrans * vec4(a_position, 1.0);
  v_uv = a_texCoord0;
}`;
    const fs = `precision highp float;
varying vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
void main() {
  vec4 t = texture2D(u_tex, v_uv);
  gl_FragColor = vec4(0.0, 0.0, 0.0, t.a * u_opacity);
}`;
    const prog = this.linkProgram(vs, fs, 'shadow');
    return {
      prog,
      attrs: {
        position: gl.getAttribLocation(prog, 'a_position'),
        uv: gl.getAttribLocation(prog, 'a_texCoord0'),
      },
      uniforms: {
        world: gl.getUniformLocation(prog, 'u_worldTrans'),
        projView: gl.getUniformLocation(prog, 'u_projViewTrans'),
        tex: gl.getUniformLocation(prog, 'u_tex'),
        opacity: gl.getUniformLocation(prog, 'u_opacity'),
      },
    };
  }

  createLineProgram() {
    const gl = this.gl;
    const vs = `attribute vec3 a_position;
attribute vec3 a_color;
uniform mat4 u_projViewTrans;
varying vec3 v_color;
void main() {
  gl_Position = u_projViewTrans * vec4(a_position, 1.0);
  gl_PointSize = 5.0;
  v_color = a_color;
}`;
    const fs = `precision highp float;
varying vec3 v_color;
uniform float u_alpha;
void main() {
  gl_FragColor = vec4(v_color, u_alpha);
}`;
    const prog = this.linkProgram(vs, fs, 'line');
    return {
      prog,
      attrs: {
        position: gl.getAttribLocation(prog, 'a_position'),
        color: gl.getAttribLocation(prog, 'a_color'),
      },
      uniforms: {
        projView: gl.getUniformLocation(prog, 'u_projViewTrans'),
        alpha: gl.getUniformLocation(prog, 'u_alpha'),
      },
    };
  }

  linkProgram(vsSource, fsSource, label) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type);
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(s);
        gl.deleteShader(s);
        throw new Error(`${label} 着色器编译失败: ${log}`);
      }
      return s;
    };
    const vs = compile(gl.VERTEX_SHADER, vsSource);
    const fs = compile(gl.FRAGMENT_SHADER, fsSource);
    const p = gl.createProgram();
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(p);
      gl.deleteProgram(p);
      throw new Error(`${label} 着色器链接失败: ${log}`);
    }
    return p;
  }

  // ---------------------------------------------------------------- textures

  createSolidTexture(rgba) {
    const gl = this.gl;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(rgba));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /** 与 G3DArmyMin.buildSoftShadow 相同的 64x64 径向渐变（alpha=(1-d)^2*0.42）。 */
  createShadowTexture() {
    const gl = this.gl;
    const S = 64;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const dx = (x - (S - 1) * 0.5) / (S * 0.5);
        const dy = (y - (S - 1) * 0.5) / (S * 0.5);
        const d = Math.hypot(dx, dy);
        let a = 1 - d;
        if (a < 0) a = 0;
        const i = (y * S + x) * 4;
        data[i] = 0;
        data[i + 1] = 0;
        data[i + 2] = 0;
        data[i + 3] = Math.round(a * a * 0.42 * 255);
      }
    }
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, S, S, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  async resolveTexture(asset, filename) {
    const candidates = asset.textureCandidates(filename);
    for (const rel of candidates) {
      const url = '/files/' + rel.split('/').map(encodeURIComponent).join('/');
      if (this.textureCache.has(url)) {
        const cached = this.textureCache.get(url);
        return cached instanceof Promise ? cached : cached;
      }
      const promise = (async () => {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        let bitmap;
        if (typeof createImageBitmap === 'function') {
          bitmap = await createImageBitmap(blob);
        } else {
          const objUrl = URL.createObjectURL(blob);
          bitmap = await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = reject;
            img.src = objUrl;
          });
          URL.revokeObjectURL(objUrl);
        }
        const gl = this.gl;
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false); // 与 libGDX 一致：不翻转 V
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
        const w = bitmap.width || bitmap.naturalWidth;
        const h = bitmap.height || bitmap.naturalHeight;
        const isPot = isPowerOfTwo(w) && isPowerOfTwo(h);
        let wrap = gl.REPEAT;
        if (!isPot && !this.isWebGL2) {
          wrap = gl.CLAMP_TO_EDGE;
          this.log('warn', `贴图 ${filename}: ${w}x${h} 非 2 的幂，WebGL1 下改用 CLAMP_TO_EDGE（libGDX 的 REPEAT 在 GLES2 上会不完整）`);
        }
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        if (bitmap.close) bitmap.close();
        return { tex, url, width: w, height: h };
      })();
      this.textureCache.set(url, promise);
      const result = await promise;
      if (result) {
        this.textureCache.set(url, result);
        return result;
      }
      this.textureCache.delete(url);
    }
    return null;
  }

  /** 重新加载模型前清空贴图缓存（贴图文件可能已被重新生成）。 */
  clearTextureCache() {
    const gl = this.gl;
    for (const cached of this.textureCache.values()) {
      if (!(cached instanceof Promise)) gl.deleteTexture(cached.tex);
    }
    this.textureCache.clear();
  }

  async loadMaterialTextures(asset) {
    const jobs = [];
    for (const mat of asset.materials.values()) {
      if (!mat.texture) continue;
      jobs.push((async () => {
        try {
          const result = await this.resolveTexture(asset, mat.texture);
          if (result) {
            mat.textureObj = result.tex;
            mat.textureSize = [result.width, result.height];
            this.log('ok', `贴图 ${mat.texture} → ${result.width}x${result.height}`);
          } else {
            mat.textureObj = this.whiteTex;
            this.log('warn', `贴图缺失：${mat.texture}（用占位白贴图，与 G3DArmy 一致）`);
          }
        } catch (e) {
          mat.textureObj = this.whiteTex;
          this.log('warn', `贴图加载失败：${mat.texture}（${e.message || e}）`);
        }
      })());
    }
    await Promise.all(jobs);
    return jobs.length;
  }

  // ---------------------------------------------------------------- model upload

  setModel(asset) {
    const gl = this.gl;
    this.disposeGpu();
    this.asset = asset;
    // G3DArmy runtime 的 animSet 优先（WW1 步枪/机枪等自定义 profile）。
    const rt = asset && asset.runtime;
    const rtWeapon = rt && rt.animSet && rt.animEvents && (rt.animEvents.weapons || {})[rt.animSet]
      ? rt.animSet
      : null;
    this.weapon = rtWeapon || detectWeapon(asset);
    this.lastParticleEvent = null;
    this.lastEventEmit.clear();
    this.lastStateId = null;
    this.loopCount = 0;
    this.emittedCycles.clear();
    if (this.particles) this.particles.clear();
    this.log('info', `攻击粒子武器识别: ${weaponLabel(this.weapon)}`);
    const program = this.getMainProgram(asset.stats.maxPartBones);

    // G3DArmy stripUniformVertexColors：全网格同一值的顶点色（转换器哨兵值）直接剥离
    const uniformColor = new Map();
    for (const mesh of asset.meshes.values()) {
      uniformColor.set(mesh.id, this.isUniformVertexColor(mesh));
    }

    // 脚底 AO 的全局 Y 范围（G3DArmy applyVerticalShade 在所有网格上统计）
    let minY = Infinity, maxY = -Infinity;
    for (const mesh of asset.meshes.values()) {
      const posOff = mesh.offsets.position;
      if (posOff < 0) continue;
      const v = mesh.vertices;
      for (let k = posOff; k + 2 < v.length; k += mesh.stride) {
        const y = v[k + 1];
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
    const aoRange = maxY - minY > 1e-3 ? { minY, h: maxY - minY } : null;

    const gpuMeshes = new Map();
    for (const mesh of asset.meshes.values()) {
      if (!mesh.vertexCount || mesh.offsets.position < 0) continue;
      const vertexCount = mesh.vertexCount;
      const data = new Float32Array(vertexCount * STRIDE_FLOATS);
      const src = mesh.vertices;
      const stride = mesh.stride;
      const posOff = mesh.offsets.position;
      const normOff = mesh.offsets.normal;
      const uvOff = mesh.offsets.uv;
      const rawColorOff = mesh.offsets.color;
      const colorOff = uniformColor.get(mesh.id) ? -1 : rawColorOff;
      const weightOffs = mesh.offsets.weights.slice(0, 8);

      for (let vi = 0; vi < vertexCount; vi++) {
        const s = vi * stride;
        const d = vi * STRIDE_FLOATS;
        data[d] = src[s + posOff];
        data[d + 1] = src[s + posOff + 1];
        data[d + 2] = src[s + posOff + 2];
        if (normOff >= 0) {
          data[d + 3] = src[s + normOff];
          data[d + 4] = src[s + normOff + 1];
          data[d + 5] = src[s + normOff + 2];
        } else {
          data[d + 4] = 1;
        }
        if (uvOff >= 0) {
          data[d + 6] = src[s + uvOff];
          data[d + 7] = src[s + uvOff + 1];
        }
        // 骨骼索引/权重：最多 8 个影响
        for (let wi = 0; wi < weightOffs.length && wi < 8; wi++) {
          const off = weightOffs[wi];
          const boneIndex = Math.round(src[s + off]);
          const weight = src[s + off + 1];
          const group = wi >> 2;
          const lane = wi & 3;
          const idxBase = d + 8 + group * 8;       // idx0 at +8, idx1 at +16
          const wBase = d + 12 + group * 8;        // w0 at +12, w1 at +20
          data[idxBase + lane] = boneIndex;
          data[wBase + lane] = weight;
        }
        // 颜色：真实顶点色优先；否则脚底 AO
        let r = 1, g = 1, b = 1, a = 1;
        if (colorOff >= 0) {
          if (mesh.offsets.colorPacked) {
            const f32 = new Float32Array(1);
            const u32 = new Uint32Array(f32.buffer);
            f32[0] = src[s + colorOff];
            [r, g, b, a] = this.decodePacked(u32[0]);
          } else {
            r = src[s + colorOff]; g = src[s + colorOff + 1];
            b = src[s + colorOff + 2]; a = src[s + colorOff + 3];
          }
        } else if (aoRange) {
          const t = clamp((src[s + posOff + 1] - aoRange.minY) / aoRange.h, 0, 1);
          const k = this.feetDark + (1 - this.feetDark) * Math.pow(t, 1.3);
          r = g = b = k;
        }
        data[d + 24] = r; data[d + 25] = g; data[d + 26] = b; data[d + 27] = a;
      }

      const vbo = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);

      const indexBuffers = new Map();
      for (const prim of mesh.primitives) {
        const ibo = gl.createBuffer();
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibo);
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, prim.indices, gl.STATIC_DRAW);
        indexBuffers.set(prim.id, {
          ibo,
          type: prim.indices instanceof Uint32Array ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT,
          count: prim.indexCount,
          uint32: prim.indices instanceof Uint32Array,
        });
      }
      gpuMeshes.set(mesh.id, { vbo, vertexCount, indexBuffers });
    }

    // 每部件调色板缓冲 + 索引范围校验
    const gpuParts = [];
    for (const part of asset.parts) {
      const gm = gpuMeshes.get(part.mesh.id);
      if (!gm) continue;
      const ib = gm.indexBuffers.get(part.prim.id);
      if (!ib) continue;
      if (ib.uint32 && !this.isWebGL2 && !gl.getExtension('OES_element_index_uint')) {
        this.log('error', `部件 ${part.prim.id}: 使用 32 位索引，但当前 WebGL1 缺少 OES_element_index_uint`);
        continue;
      }
      // 检查权重索引是否越界（逐顶点，仅报告一次）
      if (part.bones.length) {
        const mesh = part.mesh;
        const src = mesh.vertices;
        const order = mesh.offsets.weights;
        let bad = 0, badWeight = 0, minWeight = Infinity, maxWeight = -Infinity;
        for (let v = 0; v < mesh.vertexCount; v++) {
          const s = v * mesh.stride;
          let sum = 0;
          for (let wi = 0; wi < order.length; wi++) {
            const bi = Math.round(src[s + order[wi]]);
            const w = src[s + order[wi] + 1];
            if (w > 0) {
              if (bi < 0 || bi >= part.bones.length) bad++;
              sum += w;
            }
          }
          if (sum < minWeight) minWeight = sum;
          if (sum > maxWeight) maxWeight = sum;
          if (Math.abs(sum - 1) > 0.01) badWeight++;
        }
        if (bad) this.log('error', `部件 ${part.prim.id}: ${bad} 个权重引用了不存在的骨骼（骨骼数=${part.bones.length}）`);
        if (badWeight) this.log('warn', `部件 ${part.prim.id}: ${badWeight}/${mesh.vertexCount} 个顶点权重和 != 1（范围 ${minWeight.toFixed(3)}..${maxWeight.toFixed(3)}）`);
      }
      const palette = new Float32Array(program.maxBones * 16);
      for (let i = 0; i < program.maxBones; i++) {
        palette.set(mat4Identity(), i * 16);
      }
      gpuParts.push({
        part,
        vbo: gm.vbo,
        ibo: ib.ibo,
        indexType: ib.type,
        indexCount: ib.count,
        palette,
      });
    }

    this.gpu = { meshes: gpuMeshes, parts: gpuParts };
    this.poseAnimated.clear();
    return {
      parts: gpuParts.length,
      bones: program.maxBones,
    };
  }

  decodePacked(bits) {
    // libGDX ColorPacked(ABGR8888) → RGBA
    return [
      (bits & 0xff) / 255,
      ((bits >>> 8) & 0xff) / 255,
      ((bits >>> 16) & 0xff) / 255,
      ((bits >>> 24) & 0xff) / 255,
    ];
  }

  /** 网格的顶点色是否全网格同一个值（与 G3DArmy stripUniformVertexColors 同义）。 */
  isUniformVertexColor(mesh) {
    const off = mesh.offsets.color;
    if (off < 0 || !mesh.vertexCount) return false;
    const comps = mesh.offsets.colorPacked ? 1 : 4;
    const src = mesh.vertices;
    const stride = mesh.stride;
    const first = [];
    for (let c = 0; c < comps; c++) first.push(src[off + c]);
    for (let v = 1; v < mesh.vertexCount; v++) {
      const base = v * stride + off;
      for (let c = 0; c < comps; c++) {
        if (Object.is(src[base + c], first[c]) === false) return false;
      }
    }
    return true;
  }

  disposeGpu() {
    const gl = this.gl;
    if (!this.gpu) return;
    for (const gm of this.gpu.meshes.values()) {
      gl.deleteBuffer(gm.vbo);
      for (const ib of gm.indexBuffers.values()) gl.deleteBuffer(ib.ibo);
    }
    this.gpu = null;
  }

  // ---------------------------------------------------------------- draw helpers

  createGrid() {
    const gl = this.gl;
    const verts = [];
    const colors = [];
    const R = 3.0, step = 0.25;
    const minor = [0.22, 0.24, 0.28];
    const major = [0.30, 0.33, 0.38];
    for (let i = -R; i <= R + 1e-6; i += step) {
      const c = Math.abs(i) < 1e-6 ? major : minor;
      // 沿 X
      verts.push(-R, 0, i, R, 0, i);
      colors.push(...c, ...c);
      // 沿 Z
      verts.push(i, 0, -R, i, 0, R);
      colors.push(...c, ...c);
    }
    // 坐标轴：X 红 / Z 蓝
    verts.push(0, 0, 0, 1.2, 0, 0);
    colors.push(0.85, 0.25, 0.25, 0.85, 0.25, 0.25);
    verts.push(0, 0, 0, 0, 0, 1.2);
    colors.push(0.3, 0.45, 0.9, 0.3, 0.45, 0.9);
    const data = new Float32Array(verts.length + colors.length);
    // 交错：pos3 + color3
    for (let i = 0, vp = 0, cp = 0; i < verts.length / 3; i++) {
      data[i * 6] = verts[vp++]; data[i * 6 + 1] = verts[vp++]; data[i * 6 + 2] = verts[vp++];
      data[i * 6 + 3] = colors[cp++]; data[i * 6 + 4] = colors[cp++]; data[i * 6 + 5] = colors[cp++];
    }
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return { buf, count: data.length / 6 };
  }

  uploadLines(positions, colors, targetBuf = this.lineBuf) {
    const gl = this.gl;
    const vertices = positions.length / 3;
    const need = vertices * 6;
    if (this.lineData.length < need) {
      this.lineData = new Float32Array(Math.max(need, this.lineData.length * 2, 1024));
    }
    const buf = this.lineData;
    for (let i = 0; i < vertices; i++) {
      buf[i * 6] = positions[i * 3];
      buf[i * 6 + 1] = positions[i * 3 + 1];
      buf[i * 6 + 2] = positions[i * 3 + 2];
      buf[i * 6 + 3] = colors[i * 3];
      buf[i * 6 + 4] = colors[i * 3 + 1];
      buf[i * 6 + 5] = colors[i * 3 + 2];
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, targetBuf);
    gl.bufferData(gl.ARRAY_BUFFER, buf.subarray(0, need), gl.DYNAMIC_DRAW);
    return vertices;
  }

  bindAttribute(loc, size, stride, offset) {
    if (loc < 0) return;
    const gl = this.gl;
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
  }

  // ---------------------------------------------------------------- render

  /**
   * @param {object} view {
   *   stateId: 'idle'|'move'|'battle'|'retreat', animId, time, playing,
   *   facingDeg, worldH, fitPct, fitByMax, zoom, azimuth, elevation,
   *   tint: null|[r,g,b], tintStrength, feetDark, shadow, grid, skeleton, white,
   *   clampTrackEnd, animT
   * }
   */
  /**
   * AI 放置矩阵：position/rotation/scale 围绕 pivot（默认脚底中心）变换。
   * 单位是自动适配后的场景单位；rotation 为 XYZ 欧拉角（度）。
   */
  placementMatrix(placement) {
    if (!placement) return mat4Identity();
    if (Array.isArray(placement.matrix) && placement.matrix.length === 16) {
      return Float32Array.from(placement.matrix);
    }
    const vec = (v, def) => Array.isArray(v) && v.length >= 3
      ? [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0]
      : def;
    const pos = vec(placement.position, [0, 0, 0]);
    const rot = vec(placement.rotation, [0, 0, 0]);
    const s = placement.scale;
    const scale = typeof s === 'number'
      ? [s, s, s]
      : (Array.isArray(s) && s.length >= 3 ? [Number(s[0]) || 0, Number(s[1]) || 0, Number(s[2]) || 0] : [1, 1, 1]);
    const pivot = vec(placement.pivot, [0, 0, 0]);
    const m = mat4Multiply(mat4Identity(), mat4Translation(pos[0], pos[1], pos[2]), mat4Translation(pivot[0], pivot[1], pivot[2]));
    const r = mat4RotationEuler(mat4Identity(), rot[0], rot[1], rot[2]);
    mat4Multiply(m, m, r);
    mat4Multiply(m, m, mat4Scaling(scale[0], scale[1], scale[2]));
    mat4Multiply(m, m, mat4Translation(-pivot[0], -pivot[1], -pivot[2]));
    return m;
  }

  render(asset, view) {
    const gl = this.gl;
    const canvas = this.canvas;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, w, h);
    gl.clearColor(0.075, 0.082, 0.10, 1);
    gl.clearDepth(1);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
    gl.frontFace(gl.CCW);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    this.drawStats = { calls: 0, triangles: 0 };

    // 粒子每帧推进；关闭时清空，避免重新打开时残留旧粒子
    if (this.particles) {
      if (view.particles === false) this.particles.clear();
      this.particles.update(view.dt || 0);
    }

    const worldH = Math.max(0.5, view.worldH || G3D_DEFAULTS.worldH);
    const aspect = w / h;
    const zoom = view.zoom || 1;
    const halfH = worldH * 0.5 * zoom;
    const halfW = halfH * aspect;

    // G3DArmy 的正交相机（默认方位）；azimuth/elevation 仅供调试
    const target = [0, 0.432 * worldH, 0];
    const base = [0, 0.886 * worldH, 1.136 * worldH];
    let eye = base;
    if ((view.azimuth || 0) !== 0 || (view.elevation || 0) !== 0) {
      const vx = base[0] - target[0];
      const vy = base[1] - target[1];
      const vz = base[2] - target[2];
      const radius = Math.hypot(vx, vy, vz);
      let theta = Math.atan2(vx, vz) + (view.azimuth || 0) * Math.PI / 180;
      let phi = Math.asin(vy / radius) + (view.elevation || 0) * Math.PI / 180;
      phi = Math.max(-1.35, Math.min(1.35, phi));
      eye = [
        target[0] + radius * Math.sin(theta) * Math.cos(phi),
        target[1] + radius * Math.sin(phi),
        target[2] + radius * Math.cos(theta) * Math.cos(phi),
      ];
    }
    const viewM = mat4LookAt(mat4Identity(), eye, target, [0, 1, 0]);
    const projM = mat4Ortho(mat4Identity(), -halfW, halfW, -halfH, halfH, 0.1, 100);
    const projView = mat4Multiply(mat4Identity(), projM, viewM);
    this.lastProjView.set(projView);
    this.lastCanvas = {
      drawW: w, drawH: h,
      cssW: Math.max(1, canvas.clientWidth), cssH: Math.max(1, canvas.clientHeight),
    };
    this.lastCamera = { worldH, zoom, eye: [...eye], target: [...target], aspect };

    if (view.grid) {
      this.drawGrid(projView);
    }

    if (!asset || !this.gpu) {
      this.drawStats.calls = 0;
      return this.drawStats;
    }

    // ---- 姿势 ----
    const anim = asset.animById.get(view.animId) || null;
    this.poseAnimated = samplePose(asset, anim, view.time || 0, {
      clampEnd: !!view.clampTrackEnd,
    });

    // ---- 自动适配（G3DArmyMin.buildModelSet） ----
    const bounds = asset.bounds;
    let fitScale = 1, dx = 0, dy = 0, dz = 0;
    let bbox = null;
    if (bounds) {
      const hgt = bounds.size[1];
      const wid = Math.max(bounds.size[0], bounds.size[2]);
      const ref = view.fitByMax ? Math.max(hgt, wid) : hgt;
      if (ref > 1e-3) {
        const pct = clamp(view.fitPct || G3D_DEFAULTS.fitPct, 0.1, 1.2);
        fitScale = worldH * pct / ref;
        dx = -(bounds.min[0] + bounds.max[0]) * 0.5 * fitScale;
        dy = -bounds.min[1] * fitScale;
        dz = -(bounds.min[2] + bounds.max[2]) * 0.5 * fitScale;
      }
      bbox = bounds;
    }

    // world = fit(T*S) * procT * Ry(facing)
    const fitTranslate = mat4Translation(dx, dy, dz);
    const fitScaleM = mat4Scaling(fitScale, fitScale, fitScale);
    const world = mat4Multiply(mat4Identity(), fitTranslate, fitScaleM);

    const st = view.stateId || 'idle';
    const animOwned = !!anim;
    const invFit = fitScale !== 0 ? 1 / fitScale : 1;
    let procY = 0, procX = 0, procZ = 0;
    if (!animOwned) {
      const t = view.animT || 0;
      if (st === 'battle') {
        const rad = (view.facingDeg || 0) * Math.PI / 180;
        const jabPh = t * 4.2;
        const jab = Math.max(0, Math.sin(jabPh));
        const k = 0.16 * jab * jab;
        procX = Math.sin(rad) * k * invFit;
        procZ = Math.cos(rad) * k * invFit;
      } else if (st === 'retreat') {
        procY = 0.07 * Math.abs(Math.sin(t * 9.5)) * invFit;
      } else if (st === 'move') {
        procY = 0.06 * Math.abs(Math.sin(t * 7)) * invFit;
      } else {
        procY = 0.012 * Math.sin(t * 1.9) * invFit;
      }
    }
    if (procX || procY || procZ) {
      const procT = mat4Translation(procX, procY, procZ);
      mat4Multiply(world, world, procT);
    }
    const deg = (view.facingDeg || 0) + G3D_DEFAULTS.modelYaw;
    if (deg !== 0) {
      const rot = mat4RotationY(deg);
      mat4Multiply(world, world, rot);
    }
    if (!animOwned && st === 'retreat') {
      // 16° 前倾（绕 X 轴；libGDX Matrix4.rotate(X, 16)）
      const rad = 16 * Math.PI / 180;
      const c = Math.cos(rad), s = Math.sin(rad);
      const r = mat4Identity();
      r[5] = c; r[6] = s; r[9] = -s; r[10] = c;
      mat4Multiply(world, world, r);
    }
    // AI 放置：整个模型（含骨架/配件/粒子锚点）的外层变换
    let placement = null;
    if (view.placement) {
      placement = this.placementMatrix(view.placement);
      mat4Multiply(world, placement, world);
    }
    this.lastWorld.set(world);

    // ---- 攻击粒子：按 EU5 animsm 的绝对时间事件触发 ----
    const activeWeapon = view.particleWeapon && view.particleWeapon !== 'auto'
      ? view.particleWeapon
      : this.weapon;
    if (this.particles && view.particles !== false && activeWeapon !== 'none') {
      const now = view.time || 0;
      const prev = view.prevTime != null ? view.prevTime : now;
      const duration = anim ? anim.duration : 0;
      // G3DArmy v4.5+：进入战斗的首次 tick 只补 t≈0 的事件，
      // 不把随机起始相位之前的历史事件一次性补发（短战斗会看不到枪口）。
      const firstTick = view.stateId !== this.lastStateId;
      if (firstTick) {
        this.lastStateId = view.stateId;
        this.loopCount = 0;
        this.emittedCycles.clear();
        this.lastEventEmit.clear();
      }
      if (now < prev - 1e-6) this.loopCount += 1;
      const events = eventListFor(asset, view.stateId, activeWeapon, duration);
      for (const ev of events) {
        const key = `${activeWeapon}:${ev.index}`;
        const cycleKey = `${key}:${this.loopCount}`;
        const already = this.emittedCycles.has(cycleKey);
        const hit = !already && crossed(prev, now, ev.t, duration);
        const last = this.lastEventEmit.get(key);
        // 深链/截图直接落在事件附近时也补一发；同一循环内不重复。
        // firstTick 不补历史事件（与游戏端 tickBattle(prev<0) 一致）。
        const near = !firstTick && !already && !hit && Math.abs(now - ev.t) < 0.25
          && (last == null || Math.abs(last - now) > 0.5);
        if (!hit && !near) continue;
        const anchor = computeAttackAnchor(asset, world, activeWeapon);
        if (!anchor) continue;
        this.particles.emit(ev.preset, anchor, {
          atGrip: ev.preset === 'musket_ignite',
          defs: ev.defs,
        });
        const preAge = near && !hit ? Math.max(0, now - ev.t) : 0;
        if (preAge > 0) this.particles.update(preAge);
        this.emittedCycles.add(cycleKey);
        this.lastEventEmit.set(key, now);
        this.lastParticleEvent = {
          weapon: activeWeapon,
          preset: ev.preset,
          eventTime: ev.t,
          atTime: now,
          anchor: anchor.pos.slice(),
        };
      }
    }

    // ---- 绘制本体 ----
    const program = this.getMainProgram(asset.stats.maxPartBones);
    gl.useProgram(program.prog);
    gl.uniformMatrix4fv(program.uniforms.projView, false, projView);
    gl.uniform3fv(program.uniforms.ambient, AMBIENT);
    gl.uniform3fv(program.uniforms.lightColor, LIGHT_COLOR);
    gl.uniform3fv(program.uniforms.lightDir, LIGHT_DIR);
    gl.uniform1f(program.uniforms.white, view.white ? 1 : 0);
    gl.uniform1i(program.uniforms.diffuseTexture, 0);
    gl.activeTexture(gl.TEXTURE0);

    const tintColor = view.tint ? view.tint : null;
    const tintStrength = view.tintStrength != null ? view.tintStrength : G3D_DEFAULTS.tintStrength;
    const skipTokens = G3D_DEFAULTS.tintSkip;

    for (const gp of this.gpu.parts) {
      const part = gp.part;
      // ModelInstance：静态部件 world = instance * node.global；蒙皮部件只用 instance
      if (part.bones.length === 0) {
        const partWorld = mat4Multiply(mat4Identity(), world, part.node.bindGlobal);
        gl.uniformMatrix4fv(program.uniforms.world, false, partWorld);
      } else {
        gl.uniformMatrix4fv(program.uniforms.world, false, world);
      }
      // 调色板
      const nBones = part.bones.length;
      if (nBones > 0) {
        const pal = gp.palette;
        for (let i = 0; i < nBones; i++) {
          const bone = part.bones[i];
          const global = bone.node ? bone.node.bindGlobal : mat4Identity();
          const m = pal.subarray(i * 16, i * 16 + 16);
          mat4Multiply(m, global, bone.invBind);
        }
        gl.uniformMatrix4fv(program.uniforms.bones, false, pal);
        gl.uniform1i(program.uniforms.skinned, 1);
      } else {
        gl.uniform1i(program.uniforms.skinned, 0);
      }

      // 材质
      const mat = part.material;
      let r = mat.diffuse[0], g = mat.diffuse[1], b = mat.diffuse[2], a = mat.diffuse[3];
      if (tintColor && !this.tintSkip(mat.id, skipTokens)) {
        const s = clamp(tintStrength, 0, 1);
        r = r + (tintColor[0] - r) * s;
        g = g + (tintColor[1] - g) * s;
        b = b + (tintColor[2] - b) * s;
      }
      gl.uniform4f(program.uniforms.diffuseColor, r, g, b, a);
      gl.uniform3fv(program.uniforms.emissive, mat.emissive || [0, 0, 0]);
      const useTex = mat.textureObj ? 1 : 0;
      gl.uniform1f(program.uniforms.useTexture, useTex);
      if (useTex) {
        gl.bindTexture(gl.TEXTURE_2D, mat.textureObj);
      } else {
        gl.bindTexture(gl.TEXTURE_2D, this.whiteTex);
      }

      // 顶点 / 索引
      gl.bindBuffer(gl.ARRAY_BUFFER, gp.vbo);
      const loc = program.attrs;
      const stride = STRIDE_BYTES;
      this.bindAttribute(loc.position, 3, stride, 0);
      this.bindAttribute(loc.normal, 3, stride, 12);
      this.bindAttribute(loc.uv, 2, stride, 24);
      this.bindAttribute(loc.idx0, 4, stride, 32);
      this.bindAttribute(loc.w0, 4, stride, 48);
      this.bindAttribute(loc.idx1, 4, stride, 64);
      this.bindAttribute(loc.w1, 4, stride, 80);
      this.bindAttribute(loc.color, 4, stride, 96);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gp.ibo);
      gl.drawElements(gl.TRIANGLES, gp.indexCount, gp.indexType, 0);
      this.drawStats.calls++;
      this.drawStats.triangles += gp.indexCount / 3;
    }

    // ---- 接触阴影（G3DArmy renderAll） ----
    if (view.shadow && bbox) {
      this.drawShadow(projView, bbox, fitScale, dx, dz, deg, placement);
    }

    // ---- 骨架线框 / 高亮 ----
    if (view.skeleton) {
      this.drawSkeleton(projView, world, view);
    }

    // ---- 攻击粒子（最后画，保证在模型/阴影之上） ----
    if (this.particles && view.particles !== false) {
      this.particles.draw(projView, eye, target);
      this.drawStats.particles = this.particles.alive;
    }

    return this.drawStats;
  }

  tintSkip(id, tokens) {
    if (!id) return false;
    const low = id.toLowerCase();
    return tokens.some((t) => low.includes(t));
  }

  drawGrid(projView) {
    const gl = this.gl;
    const p = this.lineProgram;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.projView, false, projView);
    gl.uniform1f(p.uniforms.alpha, 0.5);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.grid.buf);
    this.bindAttribute(p.attrs.position, 3, 24, 0);
    this.bindAttribute(p.attrs.color, 3, 24, 12);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawArrays(gl.LINES, 0, this.grid.count);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawShadow(projView, bbox, fitScale, dx, dz, deg, placement = null) {
    const gl = this.gl;
    const p = this.shadowProgram;
    const ax = bbox.anchor[0], az = bbox.anchor[1];
    const rad = deg * Math.PI / 180;
    const c = Math.cos(rad), s = Math.sin(rad);
    const axm = ax * fitScale, azm = az * fitScale;
    let shx = axm * c + azm * s + dx;
    let shy = 0;
    let shz = -axm * s + azm * c + dz;
    let placementScale = 1;
    if (placement) {
      const out = [0, 0, 0];
      mat4TransformPoint(out, placement, shx, shy, shz);
      shx = out[0]; shy = out[1]; shz = out[2];
      // 非均匀缩放取最大轴，保持接触阴影近似尺寸
      const m = placement;
      placementScale = Math.max(
        Math.hypot(m[0], m[1], m[2]),
        Math.hypot(m[4], m[5], m[6]),
        Math.hypot(m[8], m[9], m[10]),
      ) || 1;
    }
    const worldWidth = Math.max(bbox.size[0], bbox.size[2]) * fitScale * placementScale;
    let ss = worldWidth / 1.24;
    ss = ss < 0.75 ? 0.75 : (ss > 2.6 ? 2.6 : ss);
    ss *= G3D_DEFAULTS.shadowScale;

    // 阴影 quad（-0.62..0.62；双面）
    const r = 0.62;
    const verts = new Float32Array([
      -r, 0, -r, 0, 0,
      r, 0, -r, 1, 0,
      r, 0, r, 1, 1,
      -r, 0, -r, 0, 0,
      r, 0, r, 1, 1,
      -r, 0, r, 0, 1,
    ]);
    const buf = this.shadowQuadBuf || (this.shadowQuadBuf = gl.createBuffer());
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.DYNAMIC_DRAW);
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.projView, false, projView);
    gl.uniform1i(p.uniforms.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.shadowTex);
    this.bindAttribute(p.attrs.position, 3, 20, 0);
    this.bindAttribute(p.attrs.uv, 2, 20, 12);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.disable(gl.CULL_FACE);
    const drawOne = (scale, y, opacity) => {
      const m = mat4Multiply(mat4Identity(), mat4Translation(shx, shy + y, shz), mat4Scaling(scale, 1, scale));
      gl.uniformMatrix4fv(p.uniforms.world, false, m);
      gl.uniform1f(p.uniforms.opacity, opacity);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      this.drawStats.calls++;
    };
    drawOne(ss, 0.012, 0.75);
    drawOne(ss * G3D_DEFAULTS.shadowCore, 0.006, 1.0);
    gl.enable(gl.CULL_FACE);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
  }

  drawSkeleton(projView, world, view = {}) {
    const gl = this.gl;
    if (!this.asset) return;
    const mode = view.skeletonMode || 'all';
    const selected = new Set(Array.isArray(view.skeletonBones) ? view.skeletonBones : []);
    const bad = new Set(Array.isArray(view.skeletonBadBones) ? view.skeletonBadBones : []);
    const animated = this.poseAnimated;
    const shouldDrawBone = (node, parent) => {
      if (mode === 'animated') return animated.has(node) || animated.has(parent);
      if (mode === 'selected') return !selected.size || selected.has(node.id) || selected.has(parent.id);
      if (mode === 'problems') return !bad.size || bad.has(node.id) || bad.has(parent.id);
      return true;
    };
    const colorOf = (node) => {
      if (selected.has(node.id)) return [1.0, 0.92, 0.2];
      if (bad.has(node.id)) return [1.0, 0.16, 0.10];
      return animated.has(node) ? [1.0, 0.62, 0.2] : [0.35, 0.8, 0.9];
    };
    const positions = [];
    const colors = [];
    const points = [];
    const pointColors = [];
    const p3 = [0, 0, 0];
    const pushPoint = (m) => {
      mat4TransformPoint(p3, world, m[12], m[13], m[14]);
      return [p3[0], p3[1], p3[2]];
    };
    for (const node of this.asset.nodes) {
      const parent = node.parent;
      if (!parent || !shouldDrawBone(node, parent)) continue;
      const a = pushPoint(parent.bindGlobal);
      const b = pushPoint(node.bindGlobal);
      positions.push(...a, ...b);
      const color = colorOf(node);
      colors.push(...color, ...color);
      points.push(...b);
      pointColors.push(...color);
    }
    if (!positions.length) return;
    const count = this.uploadLines(new Float32Array(positions), new Float32Array(colors));
    const pointCount = points.length / 3;
    if (!this.skeletonPointBuf) this.skeletonPointBuf = gl.createBuffer();
    this.uploadLines(new Float32Array(points), new Float32Array(pointColors), this.skeletonPointBuf);
    const p = this.lineProgram;
    gl.useProgram(p.prog);
    gl.uniformMatrix4fv(p.uniforms.projView, false, projView);
    gl.uniform1f(p.uniforms.alpha, 0.95);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.disable(gl.DEPTH_TEST);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.lineBuf);
    this.bindAttribute(p.attrs.position, 3, 24, 0);
    this.bindAttribute(p.attrs.color, 3, 24, 12);
    gl.drawArrays(gl.LINES, 0, count);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.skeletonPointBuf);
    this.bindAttribute(p.attrs.position, 3, 24, 0);
    this.bindAttribute(p.attrs.color, 3, 24, 12);
    gl.drawArrays(gl.POINTS, 0, pointCount);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
  }

  dispose() {
    const gl = this.gl;
    this.disposeGpu();
    for (const p of this.programs.values()) gl.deleteProgram(p.prog);
    this.programs.clear();
    for (const cached of this.textureCache.values()) {
      if (!(cached instanceof Promise)) gl.deleteTexture(cached.tex);
    }
    this.textureCache.clear();
    if (this.whiteTex) gl.deleteTexture(this.whiteTex);
    if (this.shadowTex) gl.deleteTexture(this.shadowTex);
    if (this.grid) gl.deleteBuffer(this.grid.buf);
    if (this.shadowQuadBuf) gl.deleteBuffer(this.shadowQuadBuf);
    if (this.lineBuf) gl.deleteBuffer(this.lineBuf);
    if (this.skeletonPointBuf) gl.deleteBuffer(this.skeletonPointBuf);
    if (this.particles) this.particles.dispose();
    gl.deleteProgram(this.lineProgram.prog);
    gl.deleteProgram(this.shadowProgram.prog);
  }
}

export { rgbaFromHex };
