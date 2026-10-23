// g3dj 解析 + G3DArmy 运行时语义复刻（纯数据层，无 WebGL 依赖）。
//
// 对照源码：
//   A:\android\Age.of.History.3\G3DArmy\src\com\saysky\g3darmy\G3DArmyMin.java
//   libGDX  com.badlogic.gdx.graphics.g3d.loader.G3dModelLoader
//           com.badlogic.gdx.graphics.g3d.model.Model / Node / NodePart
//           com.badlogic.gdx.graphics.g3d.utils.BaseAnimationController
//
// 关键事实（已用真实 g3dj 与反编译源码核对）：
//   * nodes[].translation/rotation/scale 是骨骼的绑定局部变换；
//   * node.parts[].bones[] 的 TRS 组合出的是「绑定世界矩阵 C」（libGDX 加载时会取逆）；
//     蒙皮矩阵 = poseGlobal(bone) * inverse(C)；
//   * 动画 keytime 单位毫秒，libGDX 除以 1000；每条轨道独立保存 T/R/S 关键帧；
//   * 动画时长 = 所有（存在的骨骼）关键帧时间的最大值；
//   * 动画状态匹配 = G3DArmyMin.resolveAnim（关键词小写包含匹配）。

import {
  mat4Identity, mat4Multiply, mat4Compose, mat4Invert, mat4TransformPoint, quatSlerp,
} from './math.js';

export const STATE_KEYS = ['idle', 'move', 'battle', 'retreat'];
export const STATE_LABELS = {
  idle: '待机',
  move: '移动',
  battle: '战斗',
  retreat: '撤退',
};

// 与 G3DArmyMin 完全一致的关键词表
export const KW_IDLE = ['idle', 'stand', 'stay', 'rest', 'wait', 'breath'];
export const KW_MOVE = ['walk', 'run', 'move', 'march', 'jog', 'advance'];
export const KW_BATTLE = ['attack', 'battle', 'fight', 'hit', 'sword', 'combat', 'strike', 'shoot'];
export const KW_RETREAT = ['retreat', 'flee', 'run', 'escape', 'panic', 'away'];

const ATTR_COMPONENTS = {
  POSITION: 3,
  NORMAL: 3,
  COLOR: 4,
  COLORPACKED: 1,
  TANGENT: 4,
  BINORMAL: 3,
};

function attrComponents(name) {
  if (name.startsWith('TEXCOORD')) return 2;
  if (name.startsWith('BLENDWEIGHT')) return 2;
  return ATTR_COMPONENTS[name] || 0;
}

function vec3(v, def = [0, 0, 0]) {
  if (!Array.isArray(v) || v.length < 3) return def;
  return [v[0], v[1], v[2]];
}

function quat(v, def = [0, 0, 0, 1]) {
  if (!Array.isArray(v) || v.length < 4) return def;
  return [v[0], v[1], v[2], v[3]];
}

function maxAbsDiff(a, b) {
  let m = 0;
  for (let i = 0; i < 16; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (d > m) m = d;
  }
  return m;
}

function mat4IsIdentity(m, eps = 1e-3) {
  const id = mat4Identity();
  for (let i = 0; i < 16; i++) {
    if (Math.abs(m[i] - id[i]) > eps) return false;
  }
  return true;
}

function parseMeshAttributes(names, warnings, meshId) {
  const offsets = {
    position: -1, normal: -1, uv: -1, color: -1, colorPacked: false,
    weights: [],
  };
  let stride = 0;
  for (const raw of names) {
    const name = String(raw);
    const comps = attrComponents(name);
    if (comps <= 0) {
      warnings.push(`网格 ${meshId}: 未知顶点属性 ${name}（已忽略，可能导致 stride 错位）`);
      continue;
    }
    if (name === 'POSITION') offsets.position = stride;
    else if (name === 'NORMAL') offsets.normal = stride;
    else if (name === 'COLOR') offsets.color = stride;
    else if (name === 'COLORPACKED') { offsets.color = stride; offsets.colorPacked = true; }
    else if (name.startsWith('TEXCOORD')) {
      if (offsets.uv < 0) offsets.uv = stride; // 只用 TEXCOORD0
    } else if (name.startsWith('BLENDWEIGHT')) {
      offsets.weights.push(stride);
    }
    stride += comps;
  }
  if (offsets.weights.length > 8) {
    warnings.push(`网格 ${meshId}: 有 ${offsets.weights.length} 个 BLENDWEIGHT（libGDX 最多 8 个）`);
  }
  return { stride, offsets };
}

/**
 * 解析 g3dj JSON。
 * @param {object} json 已 JSON.parse 的 g3dj
 * @param {{path:string, name?:string}} meta 模型相对根目录的路径
 */
export function parseG3dj(json, meta) {
  const warnings = [];
  const errors = [];
  const path = meta.path || '';
  const modelDir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const fileName = meta.name || path.split('/').pop() || 'model';

  const version = json.version;
  if (!Array.isArray(version)) {
    // 不能静默补默认值: libGDX G3dModelLoader.parseModel() 用 require("version")，
    // 缺失时真机加载整个模型失败（插件随后回退默认模型），而调试器仍能显示。
    errors.push('缺少顶层 version: [0, 1]（libGDX require("version")，真机将加载失败）');
  } else if (version[0] !== 0 || version[1] !== 1) {
    errors.push(`不支持的 g3dj 版本 ${version.join('.')}（libGDX 只接受 0.1）`);
  }

  // ---------------- 网格 ----------------
  const meshes = new Map();
  const primById = new Map();
  let totalVerts = 0;
  let totalTris = 0;
  for (const m of json.meshes || []) {
    const id = m.id || '';
    const layout = parseMeshAttributes(m.attributes || [], warnings, id);
    const verts = m.vertices || [];
    const vertexCount = layout.stride > 0 ? Math.floor(verts.length / layout.stride) : 0;
    if (layout.position < 0) warnings.push(`网格 ${id}: 缺少 POSITION 属性`);
    const primitives = [];
    for (const p of m.parts || []) {
      const indices = p.indices || [];
      let maxIndex = 0;
      for (let i = 0; i < indices.length; i++) if (indices[i] > maxIndex) maxIndex = indices[i];
      const IndexArray = maxIndex > 65535 ? Uint32Array : Uint16Array;
      const typed = new IndexArray(indices.length);
      for (let i = 0; i < indices.length; i++) typed[i] = indices[i];
      const prim = {
        id: p.id || `${id}_part${primitives.length}`,
        type: p.type || 'TRIANGLES',
        indices: typed,
        indexCount: typed.length,
      };
      if (prim.type !== 'TRIANGLES') {
        warnings.push(`网格 ${id}: 图元类型 ${prim.type} 未实现（调试器按 TRIANGLES 绘制）`);
      }
      primitives.push(prim);
      if (primById.has(prim.id)) {
        warnings.push(`meshpartid 重复：${prim.id}（libGDX 会取第一个）`);
      } else {
        primById.set(prim.id, { mesh: null, prim, meshId: id });
      }
      if (prim.type === 'TRIANGLES') totalTris += typed.length / 3;
    }
    const mesh = { id, attributes: m.attributes || [], ...layout, vertices: verts, vertexCount, primitives };
    meshes.set(id, mesh);
    totalVerts += vertexCount;
  }
  for (const entry of primById.values()) {
    entry.mesh = meshes.get(entry.meshId);
  }

  // ---------------- 材质 ----------------
  const materials = new Map();
  const textureFiles = new Set();
  for (const m of json.materials || []) {
    const id = m.id || '';
    let texture = null;
    for (const t of m.textures || []) {
      if ((t.type || '').toUpperCase() === 'DIFFUSE') {
        texture = t.filename || null;
        break;
      }
    }
    if (texture) textureFiles.add(texture);
    const diffuse = Array.isArray(m.diffuse) && m.diffuse.length >= 3
      ? [m.diffuse[0], m.diffuse[1], m.diffuse[2], m.diffuse.length >= 4 ? m.diffuse[3] : 1]
      : [1, 1, 1, 1];
    let emissive = Array.isArray(m.emissive) && m.emissive.length >= 3
      ? [m.emissive[0], m.emissive[1], m.emissive[2]] : [0, 0, 0];
    // G3DArmy buildFromData: 灰白自发光（如 cccccc）会加爆成纯白 → 归零
    {
      const mx = Math.max(emissive[0], emissive[1], emissive[2]);
      const mn = Math.min(emissive[0], emissive[1], emissive[2]);
      if (mx - mn < 0.02 && mx > 0.05) emissive = [0, 0, 0];
    }
    if (materials.has(id)) {
      warnings.push(`材质 id 重复：${id}（libGDX 取第一个）`);
    } else {
      materials.set(id, { id, diffuse, emissive, texture, textureUrl: null });
    }
  }
  if (!materials.size) {
    materials.set('', { id: '', diffuse: [1, 1, 1, 1], emissive: [0, 0, 0], texture: null, textureUrl: null });
  }

  // ---------------- 节点树 ----------------
  const nodeById = new Map();
  const roots = [];
  const parseNode = (n, parent) => {
    const id = n.id;
    if (!id) {
      errors.push('存在缺少 id 的节点');
      return null;
    }
    if (nodeById.has(id)) {
      warnings.push(`节点 id 重复：${id}（libGDX getNode 只会命中第一个）`);
    }
    const node = {
      id,
      t: vec3(n.translation),
      q: quat(n.rotation),
      s: Array.isArray(n.scale) && n.scale.length >= 3 ? [n.scale[0], n.scale[1], n.scale[2]] : [1, 1, 1],
      parent: parent || null,
      children: [],
      nodeParts: n.parts || [],
      bindLocal: mat4Identity(),
      bindGlobal: mat4Identity(),
    };
    nodeById.set(id, node);
    if (parent) parent.children.push(node); else roots.push(node);
    for (const c of n.children || []) parseNode(c, node);
    return node;
  };
  for (const n of json.nodes || []) parseNode(n, null);

  const computeBindGlobals = () => {
    const visit = (n) => {
      mat4Compose(n.bindLocal, n.t, n.q, n.s);
      if (n.parent) mat4Multiply(n.bindGlobal, n.parent.bindGlobal, n.bindLocal);
      else n.bindGlobal.set(n.bindLocal);
      for (const c of n.children) visit(c);
    };
    for (const r of roots) visit(r);
  };
  computeBindGlobals();
  // 保留一份绑定姿态世界矩阵（samplePose 会改写 node.bindGlobal），供 AI 诊断对比 pose↔rest。
  {
    const visit = (n) => {
      n.bindGlobalRest = new Float32Array(n.bindGlobal);
      for (const c of n.children) visit(c);
    };
    for (const r of roots) visit(r);
  }

  // ---------------- 节点部件（渲染单位） ----------------
  const parts = [];
  const referencedPrims = new Set();
  let maxPartBones = 0;
  let bindMaxError = 0;
  let bindWorst = null;
  for (const node of nodeById.values()) {
    if (!node.nodeParts || !node.nodeParts.length) continue;
    for (const np of node.nodeParts) {
      const meshPartId = np.meshpartid;
      const materialId = np.materialid || '';
      const entry = primById.get(meshPartId);
      if (!entry) {
        errors.push(`节点 ${node.id}: 找不到 meshpart ${meshPartId}`);
        continue;
      }
      const material = materials.get(materialId);
      if (!material) warnings.push(`节点 ${node.id}: 找不到材质 ${materialId}（用白色占位）`);
      const mat = material || materials.get('') || { id: '', diffuse: [1, 1, 1, 1], emissive: [0, 0, 0], texture: null, textureUrl: null };
      const boneDefs = np.bones || [];
      const bones = [];
      let partError = 0;
      let refD = null;   // 部件内第一骨的 (bindGlobal · inv(storedC)) 作为参考刚体变换
      for (const b of boneDefs) {
        const boneNode = nodeById.get(b.node);
        const bind = mat4Compose(mat4Identity(), vec3(b.translation), quat(b.rotation), Array.isArray(b.scale) ? [b.scale[0], b.scale[1], b.scale[2]] : [1, 1, 1]);
        const inv = mat4Invert(mat4Identity(), bind);
        if (!inv) {
          errors.push(`骨骼 ${b.node || '?'} 的绑定矩阵不可逆（部件 ${meshPartId}）`);
        }
        const bone = { node: boneNode || null, id: b.node || '', bind, invBind: inv || mat4Identity() };
        if (!boneNode) {
          errors.push(`节点 ${node.id}: 骨骼 ${b.node || '?'} 在节点树中不存在（libGDX 会崩溃）`);
        } else if (inv) {
          // 正确约定:同部件内每骨的 (boneWorld_bind · inv(B)) 必须是**同一个刚体变换 D**。
          //   单骨架 D=单位阵;骑手上挂(骑手 root 重挂到鞍骨、保留 standalone C)D=挂载矩阵,都合法。
          //   只有把 bones 误写成 inv(C) 时,各骨 D 才会互不一致 → 顶点炸开。故判"部件内一致"。
          const D = mat4Multiply(mat4Identity(), boneNode.bindGlobal, inv);
          if (!refD) refD = D;
          else partError = Math.max(partError, maxAbsDiff(D, refD));
        }
        bones.push(bone);
      }
      // G3DArmy isBodyPart：第一个 invBind 是单位阵 = 运行时挂件，不参与包围盒/阴影
      const isBody = !(bones.length && mat4IsIdentity(bones[0].invBind));
      if (partError > bindMaxError) {
        bindMaxError = partError;
        bindWorst = { node: node.id, meshPartId, error: partError };
      }
      if (partError > 1e-2) {
        warnings.push(`绑定帧各骨变换不一致：节点 ${node.id} / 部件 ${meshPartId.substring(0, 48)}… 最大差异 ${partError.toFixed(4)}（bones[] 很可能写成了 inv(C)）`);
      }
      maxPartBones = Math.max(maxPartBones, bones.length);
      referencedPrims.add(meshPartId);
      parts.push({
        node,
        mesh: entry.mesh,
        prim: entry.prim,
        material: mat,
        boneDefs,
        bones,
        boneCount: bones.length,
        isBody,
        bindError: partError,
        bindTransform: bones.length ? mat4Multiply(mat4Identity(), bones[0].node ? bones[0].node.bindGlobal : mat4Identity(), bones[0].invBind) : node.bindGlobal,
      });
    }
  }
  for (const [id, e] of primById) {
    if (!referencedPrims.has(id)) warnings.push(`网格部件没有被任何节点引用：${id}`);
  }

  // ---------------- 动画 ----------------
  const animations = [];
  for (const a of json.animations || []) {
    const tracks = [];
    let duration = 0;
    let shortTracks = 0;
    let minShortEnd = Infinity;
    let maxShortEnd = 0;
    for (const b of a.bones || []) {
      const node = nodeById.get(b.boneId);
      if (!node) {
        warnings.push(`动画 ${a.id || '?'}: 骨骼 ${b.boneId} 不存在（libGDX 会跳过该轨道）`);
        continue;
      }
      const tr = { times: [], values: [] };
      const ro = { times: [], values: [] };
      const sc = { times: [], values: [] };
      let unsorted = false;
      let prev = -Infinity;
      for (const kf of b.keyframes || []) {
        const kt = (kf.keytime || 0) / 1000;
        if (kt < prev) unsorted = true;
        prev = kt;
        if (Array.isArray(kf.translation) && kf.translation.length === 3) {
          tr.times.push(kt);
          tr.values.push([kf.translation[0], kf.translation[1], kf.translation[2]]);
        }
        if (Array.isArray(kf.rotation) && kf.rotation.length === 4) {
          ro.times.push(kt);
          ro.values.push([kf.rotation[0], kf.rotation[1], kf.rotation[2], kf.rotation[3]]);
        }
        if (Array.isArray(kf.scale) && kf.scale.length === 3) {
          sc.times.push(kt);
          sc.values.push([kf.scale[0], kf.scale[1], kf.scale[2]]);
        }
      }
      if (unsorted) warnings.push(`动画 ${a.id || '?'} / 骨骼 ${b.boneId}: 关键帧时间未排序（libGDX 二分查找会出错）`);
      if (!tr.times.length && !ro.times.length && !sc.times.length) continue;
      for (const comp of [tr, ro, sc]) {
        if (!comp.times.length) continue;
        const end = comp.times[comp.times.length - 1];
        if (end > duration) duration = end;
      }
      tracks.push({
        node,
        translation: tr.times.length ? tr : null,
        rotation: ro.times.length ? ro : null,
        scaling: sc.times.length ? sc : null,
      });
    }
    if (!tracks.length) continue;
    // 尾帧早于动画时长：libGDX 会回卷到第 1 段关键帧做外插（潜在扭曲）
    for (const track of tracks) {
      for (const comp of [track.translation, track.rotation, track.scaling]) {
        if (!comp || !comp.times.length) continue;
        const end = comp.times[comp.times.length - 1];
        if (end < duration - 1e-3) {
          shortTracks++;
          if (end < minShortEnd) minShortEnd = end;
          if (end > maxShortEnd) maxShortEnd = end;
        }
      }
    }
    // 源帧网格：所有轨道关键帧时间的并集（去重），用于「精确到帧」的进度条。
    // 有些模型（骑乘）不同轨道的尾帧不同，并集能覆盖整段动画（含只有 root 轨道的尾段）。
    const frameTimes = buildFrameTimes(tracks);
    animations.push({
      id: a.id || `anim${animations.length}`,
      duration,
      tracks,
      shortTracks,
      shortRange: shortTracks ? [minShortEnd, maxShortEnd] : null,
      frameTimes,
      sourceFps: estimateSourceFps(tracks, frameTimes),
    });
  }
  const animById = new Map();
  for (const a of animations) {
    if (animById.has(a.id)) warnings.push(`动画 id 重复：${a.id}（libGDX 取第一个）`);
    else animById.set(a.id, a);
  }

  // ---------------- 四态映射（G3DArmyMin.resolveAnim） ----------------
  const resolveAnim = (spec, keywords, fallback) => {
    if (spec === '-') return { id: null, source: 'disabled' };
    if (spec && spec.length) {
      return animById.has(spec)
        ? { id: spec, source: 'explicit' }
        : { id: fallback, source: 'fallback' };
    }
    if (keywords) {
      for (const anim of animations) {
        const low = anim.id.toLowerCase();
        for (const k of keywords) {
          if (low.includes(k)) return { id: anim.id, source: 'keyword' };
        }
      }
    }
    return { id: fallback, source: 'fallback' };
  };
  const firstId = animations.length ? animations[0].id : null;
  const base = resolveAnim('', null, firstId);
  const stateMap = {
    idle: resolveAnim('', KW_IDLE, base.id),
    move: resolveAnim('', KW_MOVE, base.id),
    battle: resolveAnim('', KW_BATTLE, base.id),
  };
  stateMap.retreat = resolveAnim('', KW_RETREAT, stateMap.move.id);
  for (const key of STATE_KEYS) {
    stateMap[key].fallback = stateMap[key].source === 'fallback' ? (stateMap[key].id || null) : null;
  }

  // ---------------- 绑定姿态包围盒 / 阴影锚点（G3DArmyMin.computeBodyBounds） ----------------
  const bounds = computeBodyBounds(parts, warnings);

  // ---------------- 纹理候选路径 ----------------
  const textureCandidates = (filename) => {
    const clean = String(filename).replace(/\\/g, '/');
    const base = clean.split('/').pop();
    const list = [];
    if (clean.startsWith('/')) {
      list.push(clean.slice(1));
    } else {
      // G3DArmy v4.2+：models/<类>/g3d/*.g3dj 的贴图在 models/<类>/png/，优先请求。
      if (modelDir.endsWith('/g3d/')) {
        list.push(modelDir.slice(0, -4) + 'png/' + base);
        list.push(modelDir + clean);
      } else {
        list.push(modelDir + clean);
      }
      if (clean.includes('/')) list.push(clean);
      list.push('png/' + base);
      list.push('textures/' + base);
      list.push(base);
    }
    // 去重
    return [...new Set(list)];
  };

  // ---------------- 统计 ----------------
  const jointNames = new Set();
  for (const p of parts) for (const b of p.bones) if (b.id) jointNames.add(b.id);
  const stats = {
    vertices: totalVerts,
    triangles: totalTris,
    meshes: meshes.size,
    parts: parts.length,
    nodes: nodeById.size,
    joints: jointNames.size,
    materials: materials.size,
    textures: textureFiles.size,
    animations: animations.length,
    maxPartBones,
    path,
  };

  return {
    id: json.id || fileName,
    path,
    fileName,
    modelDir,
    meshes,
    primById,
    materials,
    nodes: [...nodeById.values()],
    roots,
    nodeById,
    parts,
    animations,
    animById,
    states: stateMap,
    stats,
    bounds,
    textureFiles: [...textureFiles],
    textureCandidates,
    warnings,
    errors,
    checks: {
      bindMaxError,
      bindWorst,
      shortTrackTotal: animations.reduce((s, a) => s + a.shortTracks, 0),
    },
    bindGlobals: nodeById,
  };
}

/** 所有轨道关键帧时间的并集（秒），去掉 0.1ms 内的重复值；不足 2 帧返回 null。 */
function buildFrameTimes(tracks) {
  const set = new Set();
  for (const track of tracks) {
    for (const comp of [track.translation, track.rotation, track.scaling]) {
      if (!comp) continue;
      for (const t of comp.times) set.add(t);
    }
  }
  const sorted = [...set].sort((a, b) => a - b);
  const out = [];
  for (const t of sorted) {
    if (!out.length || t - out[out.length - 1] > 1e-4) out.push(t);
  }
  return out.length >= 2 ? out : null;
}

/** 由轨道关键帧间隔估计源帧率（中位关键帧间隔；异常时回退 30fps）。
 * 不能用并集网格的间隔：骑乘模型骑手/马轨道可能是两套网格（如 33.2ms + 26.9ms），
 * 并集间隔中位数会变成 ~15ms（65fps），严重误导。
 */
function estimateSourceFps(tracks, times) {
  const deltas = [];
  for (const track of tracks) {
    for (const comp of [track.translation, track.rotation, track.scaling]) {
      if (!comp || !comp.times || comp.times.length < 2) continue;
      for (let i = 1; i < comp.times.length; i++) {
        const d = comp.times[i] - comp.times[i - 1];
        if (d > 1e-4 && d < 0.2) deltas.push(d);
      }
    }
  }
  if (!deltas.length) return 30;
  deltas.sort((a, b) => a - b);
  const med = deltas[Math.floor(deltas.length / 2)];
  if (med <= 1e-4 || med > 0.2) return 30;
  return 1 / med;
}

/** 与 G3DArmyMin.computeBodyBounds 相同的两遍扫描（第一根骨骼变换 / 静态节点变换）。 */
function computeBodyBounds(parts, warnings) {
  if (!parts.length) return null;
  let any = false;
  let minY = Infinity, maxY = -Infinity;
  const p3 = [0, 0, 0];

  const forEachBodyVertex = (fn) => {
    for (const part of parts) {
      if (!part.isBody) continue;
      const m = part.bindTransform;
      const mesh = part.mesh;
      const stride = mesh.stride;
      const posOff = mesh.offsets.position;
      if (!mesh.vertices || posOff < 0 || stride <= 0) continue;
      const v = mesh.vertices;
      for (let k = posOff; k + 2 < v.length; k += stride) {
        mat4TransformPoint(p3, m, v[k], v[k + 1], v[k + 2]);
        fn(p3[0], p3[1], p3[2]);
      }
      any = true;
    }
  };

  forEachBodyVertex((x, y, z) => {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  });
  if (!any || !(maxY - minY > 1e-4)) {
    warnings.push('本体几何包围盒退化（所有部件的绑定变换都是单位阵？）');
    return null;
  }

  const ANCHOR_BAND = 0.12;
  const yLimit = minY + (maxY - minY) * ANCHOR_BAND;
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let sumX = 0, sumZ = 0, count = 0;
  forEachBodyVertex((x, y, z) => {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
    if (z < z0) z0 = z;
    if (z > z1) z1 = z;
    if (y <= yLimit) { sumX += x; sumZ += z; count++; }
  });
  if (x0 > x1 || z0 > z1) return null;
  let ax = count >= 6 ? sumX / count : (x0 + x1) * 0.5;
  let az = count >= 6 ? sumZ / count : (z0 + z1) * 0.5;
  const cx = (x0 + x1) * 0.5, cz = (z0 + z1) * 0.5;
  const limX = (x1 - x0) * 0.35, limZ = (z1 - z0) * 0.35;
  ax = cx + Math.max(-limX, Math.min(limX, ax - cx));
  az = cz + Math.max(-limZ, Math.min(limZ, az - cz));
  return {
    min: [x0, y0, z0],
    max: [x1, y1, z1],
    anchor: [ax, az],
    size: [x1 - x0, y1 - y0, z1 - z0],
  };
}

// ---------------- 动画采样（BaseAnimationController） ----------------
function firstKeyframeIndexAtTime(times, time) {
  const lastIndex = times.length - 1;
  // 逐字复刻 libGDX：时间超出最后关键帧时返回 0（随后会做外插）
  if (lastIndex <= 0 || time < times[0] || time > times[lastIndex]) return 0;
  let min = 0, max = lastIndex;
  while (min < max) {
    const i = (min + max) >> 1;
    if (time > times[i + 1]) min = i + 1;
    else if (time < times[i]) max = i - 1;
    else return i;
  }
  return min;
}

function sampleVector(out, comp, time, fallback, clampEnd) {
  if (!comp || comp.times.length === 0) {
    out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2];
    return out;
  }
  const times = comp.times;
  if (clampEnd) {
    if (time <= times[0]) { out[0] = comp.values[0][0]; out[1] = comp.values[0][1]; out[2] = comp.values[0][2]; return out; }
    if (time >= times[times.length - 1]) {
      const v = comp.values[comp.values.length - 1];
      out[0] = v[0]; out[1] = v[1]; out[2] = v[2];
      return out;
    }
  }
  let i = firstKeyframeIndexAtTime(times, time);
  const a = comp.values[i];
  out[0] = a[0]; out[1] = a[1]; out[2] = a[2];
  if (++i < comp.values.length) {
    const b = comp.values[i];
    const t = (time - times[i - 1]) / (times[i] - times[i - 1]);
    const inv = 1 - t;
    out[0] = a[0] * inv + b[0] * t;
    out[1] = a[1] * inv + b[1] * t;
    out[2] = a[2] * inv + b[2] * t;
  }
  return out;
}

function sampleQuat(out, comp, time, fallback, clampEnd) {
  if (!comp || comp.times.length === 0) {
    out[0] = fallback[0]; out[1] = fallback[1]; out[2] = fallback[2]; out[3] = fallback[3];
    return out;
  }
  const times = comp.times;
  if (clampEnd) {
    if (time <= times[0]) { out.splice(0, 4, ...comp.values[0]); return out; }
    if (time >= times[times.length - 1]) { out.splice(0, 4, ...comp.values[comp.values.length - 1]); return out; }
  }
  let i = firstKeyframeIndexAtTime(times, time);
  out[0] = comp.values[i][0]; out[1] = comp.values[i][1]; out[2] = comp.values[i][2]; out[3] = comp.values[i][3];
  if (++i < comp.values.length) {
    const t = (time - times[i - 1]) / (times[i] - times[i - 1]);
    quatSlerp(out, out, comp.values[i], t);
  }
  return out;
}

const tmpT = [0, 0, 0];
const tmpQ = [0, 0, 0, 1];
const tmpS = [1, 1, 1];

/**
 * 计算某一动画在某时刻的姿势。
 * 返回 { animatedNodes:Set, globalByNode:Map(nodeId → mat4) }。
 * 未被动画的节点使用绑定局部 TRS —— 与「每个状态一个独立 ModelInstance」的游戏行为一致。
 */
export function samplePose(asset, animation, time, options = {}) {
  const clampEnd = !!options.clampEnd;
  const animated = new Set();
  if (animation) {
    for (const track of animation.tracks) {
      animated.add(track.node);
      sampleVector(tmpT, track.translation, time, track.node.t, clampEnd);
      sampleQuat(tmpQ, track.rotation, time, track.node.q, clampEnd);
      sampleVector(tmpS, track.scaling, time, track.node.s, clampEnd);
      mat4Compose(track.node.bindLocal, tmpT, tmpQ, tmpS);
    }
  }
  for (const node of asset.nodes) {
    if (animated.has(node)) continue;
    mat4Compose(node.bindLocal, node.t, node.q, node.s);
  }
  // 计算全局矩阵（按父→子）
  const visit = (n) => {
    if (n.parent) mat4Multiply(n.bindGlobal, n.parent.bindGlobal, n.bindLocal);
    else n.bindGlobal.set(n.bindLocal);
    for (const c of n.children) visit(c);
  };
  for (const r of asset.roots) visit(r);
  return animated;
}

/**
 * CPU 蒙皮：返回部件每个顶点在当前 pose 下的模型空间坐标（Float32Array, xyz）。
 * 与 shader 的 u_worldTrans 无关；诊断时再乘 renderer.lastWorld 投影。
 */
export function computePartPositions(part, out = null) {
  const mesh = part.mesh;
  const count = mesh.vertexCount;
  const need = Math.max(0, count * 3);
  if (!out && part._posePositions && part._posePositions.length === need) out = part._posePositions;
  const dst = out || new Float32Array(need);
  part._posePositions = dst;
  const src = mesh.vertices;
  const stride = mesh.stride;
  const posOff = mesh.offsets.position;
  if (!src || posOff < 0 || stride <= 0) return dst;

  if (part.bones.length) {
    const palette = part._palette || (part._palette = part.bones.map(() => new Float32Array(16)));
    for (let bi = 0; bi < part.bones.length; bi++) {
      const b = part.bones[bi];
      mat4Multiply(palette[bi], b.node ? b.node.bindGlobal : mat4Identity(), b.invBind);
    }
    const wOffs = mesh.offsets.weights;
    for (let vi = 0; vi < count; vi++) {
      const base = vi * stride;
      const px = src[base + posOff];
      const py = src[base + posOff + 1];
      const pz = src[base + posOff + 2];
      let x = 0, y = 0, z = 0;
      for (let wi = 0; wi < wOffs.length; wi++) {
        const off = wOffs[wi];
        const idx = Math.round(src[base + off]);
        const w = src[base + off + 1];
        if (!w) continue;
        const m = palette[idx];
        if (!m) continue;
        x += w * (m[0] * px + m[4] * py + m[8] * pz + m[12]);
        y += w * (m[1] * px + m[5] * py + m[9] * pz + m[13]);
        z += w * (m[2] * px + m[6] * py + m[10] * pz + m[14]);
      }
      dst[vi * 3] = x;
      dst[vi * 3 + 1] = y;
      dst[vi * 3 + 2] = z;
    }
  } else {
    const m = part.node.bindGlobal;
    for (let vi = 0; vi < count; vi++) {
      const base = vi * stride;
      const px = src[base + posOff];
      const py = src[base + posOff + 1];
      const pz = src[base + posOff + 2];
      dst[vi * 3] = m[0] * px + m[4] * py + m[8] * pz + m[12];
      dst[vi * 3 + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
      dst[vi * 3 + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
    }
  }
  return dst;
}

/** 绑定姿态下部件顶点位置（用 part.bindTransform；与 G3DArmy 包围盒同一参考）。
 *  首次计算后缓存在 part._bindPositions（模型/部件静态数据，不随动画帧变化）。 */
export function computePartBindPositions(part) {
  const mesh = part.mesh;
  const count = mesh.vertexCount;
  const need = Math.max(0, count * 3);
  if (part._bindPositions && part._bindPositions.length === need) return part._bindPositions;
  const out = new Float32Array(need);
  part._bindPositions = out;
  const src = mesh.vertices;
  const stride = mesh.stride;
  const posOff = mesh.offsets.position;
  if (!src || posOff < 0 || stride <= 0) return out;
  const m = part.bindTransform;
  for (let vi = 0; vi < count; vi++) {
    const base = vi * stride;
    const px = src[base + posOff];
    const py = src[base + posOff + 1];
    const pz = src[base + posOff + 2];
    out[vi * 3] = m[0] * px + m[4] * py + m[8] * pz + m[12];
    out[vi * 3 + 1] = m[1] * px + m[5] * py + m[9] * pz + m[13];
    out[vi * 3 + 2] = m[2] * px + m[6] * py + m[10] * pz + m[14];
  }
  return out;
}

/** 计算某部件的骨骼调色板：palette[i] = poseGlobal(bone) * inverse(bindWorld)。 */
export function computePalette(part, out = null) {
  const n = part.bones.length;
  const palette = out || new Float32Array(Math.max(16, n * 16));
  for (let i = 0; i < n; i++) {
    const bone = part.bones[i];
    const global = bone.node ? bone.node.bindGlobal : mat4Identity();
    const m = palette.subarray(i * 16, i * 16 + 16);
    mat4Multiply(m, global, bone.invBind);
  }
  return palette;
}
