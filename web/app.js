// 调试器 UI：模型列表 / 四态动画 / 视角 / 渲染开关 / 自检日志 / AI 诊断。
import { Renderer, G3D_DEFAULTS, rgbaFromHex } from './renderer.js';
import {
  parseG3dj, STATE_KEYS, STATE_LABELS,
  computePartPositions, computePartBindPositions, samplePose,
} from './g3dj.js';
import { mat4Identity, mat4Multiply, mat4TransformPoint } from './math.js';
import { UnitStateMachine, UNIT_STATE_NAMES, DISPLAY_STATE } from './unit_state_machine.js';
import {
  pickRuntimeRule as pickRuntimeRuleV47,
  runtimeRuleKeys as runtimeRuleKeysV47,
  runtimeGroupOptions as runtimeGroupOptionsV47,
  weaponFamilyFromSig,
  animSetList,
} from './runtime_rules.js';
import { initLayoutDrawers } from './layout_drawers.js';

const $ = (sel) => document.querySelector(sel);
const el = {
  search: $('#model-search'),
  tabs: $('#group-tabs'),
  tabsCount: $('#tabs-count'),
  list: $('#model-list'),
  count: $('#model-count'),
  root: $('#status-root'),
  prev: $('#btn-prev'),
  next: $('#btn-next'),
  reload: $('#btn-reload'),
  title: $('#hud-model'),
  path: $('#hud-path'),
  hudAnim: $('#hud-anim'),
  hudTime: $('#hud-time'),
  hudFps: $('#hud-fps'),
  hudDraw: $('#hud-draw'),
  stage: $('#stage'),
  canvas: $('#view'),
  empty: $('#stage-empty'),
  loading: $('#stage-loading'),
  loadingText: $('#loading-text'),
  err: $('#err-overlay'),
  errText: $('#err-text'),
  log: $('#log'),
  logClear: $('#log-clear'),
  logCopy: $('#log-copy'),
  report: $('#btn-report'),
  aiRun: $('#btn-ai'),
  aiScan: $('#btn-ai-scan'),
  aiPanel: $('#ai-panel'),
  aiSummary: $('#ai-summary'),
  aiReport: $('#ai-report'),
  aiCopy: $('#ai-copy'),
  aiClose: $('#ai-close'),
  stateButtons: $('#state-buttons'),
  override: $('#anim-override'),
  animCount: $('#anim-count'),
  play: $('#btn-play'),
  restart: $('#btn-restart'),
  stepBack: $('#btn-step-back'),
  step: $('#btn-step'),
  scrub: $('#scrub'),
  frameLabel: $('#frame-label'),
  timeLabel: $('#time-label'),
  frameRate: $('#frame-rate'),
  speed: $('#speed'),
  speedVal: $('#speed-val'),
  clamp: $('#chk-clamp'),
  stateNote: $('#state-note'),
  facing: $('#facing'),
  facingVal: $('#facing-val'),
  facingReset: $('#btn-facing-reset'),
  zoom: $('#zoom'),
  zoomVal: $('#zoom-val'),
  azimuth: $('#azimuth'),
  azimuthVal: $('#azimuth-val'),
  elevation: $('#elevation'),
  elevationVal: $('#elevation-val'),
  cameraReset: $('#btn-camera-reset'),
  fitpct: $('#fitpct'),
  fitpctVal: $('#fitpct-val'),
  fitmax: $('#chk-fitmax'),
  transformStats: $('#transform-stats'),
  transformBadge: $('#transform-badge'),
  transformRef: $('#transform-ref'),
  transformCustomRow: $('#transform-custom-row'),
  transformRefX: $('#transform-ref-x'),
  transformRefY: $('#transform-ref-y'),
  transformRefZ: $('#transform-ref-z'),
  transformRefApply: $('#btn-transform-ref-apply'),
  transformCx: $('#transform-cx'),
  transformCy: $('#transform-cy'),
  transformCz: $('#transform-cz'),
  transformScale: $('#transform-scale'),
  transformReset: $('#btn-transform-reset'),
  undoBtn: $('#btn-undo'),
  redoBtn: $('#btn-redo'),
  refMarker: $('#chk-ref-marker'),
  worldh: $('#worldh'),
  tintMode: $('#tint-mode'),
  tintColor: $('#tint-color'),
  tintStrength: $('#tint-strength'),
  tintStrengthVal: $('#tint-strength-val'),
  footdark: $('#footdark'),
  footdarkVal: $('#footdark-val'),
  shadow: $('#chk-shadow'),
  skeleton: $('#chk-skeleton'),
  skeletonMode: $('#skeleton-mode'),
  grid: $('#chk-grid'),
  white: $('#chk-white'),
  particles: $('#chk-particles'),
  particleWeapon: $('#particle-weapon'),
  particleNote: $('#particle-note'),
  vfxBadge: $('#vfx-badge'),
  eu5sm: $('#chk-eu5-sm'),
  eu5State: $('#eu5-state'),
  smRandom: $('#chk-sm-random'),
  smAuto: $('#chk-sm-auto'),
  smNote: $('#sm-note'),
  stats: $('#stats'),
  checkBadge: $('#check-badge'),
  warnList: $('#warn-list'),
  runtimePanel: $('#runtime-panel'),
  runtimeBadge: $('#runtime-badge'),
  runtimeNote: $('#runtime-note'),
  runtimeRule: $('#runtime-rule'),
  runtimeGroup: $('#runtime-group'),
  runtimeCiv: $('#runtime-civ'),
  runtimeLevel: $('#runtime-level'),
  runtimeAid: $('#runtime-aid'),
  runtimeReligion: $('#runtime-religion'),
  runtimeReligionGroup: $('#runtime-religion-group'),
};

const TINT_PRESETS = {
  none: null,
  player: [0.33, 0.58, 0.30],
  enemy: [0.62, 0.26, 0.22],
  ally: [0.32, 0.46, 0.66],
  neutral: [0.62, 0.58, 0.50],
};

const BASE_GROUP_ORDER = ['foot', 'mounted', 'artillery', 'ship', 'tank', 'mech', 'logistics', 'mg', 'vehicle', 'runtime', 'library'];
const CATEGORY_LABEL = {
  foot: '步兵', mounted: '骑兵', cavalry: '骑兵', artillery: '炮兵', ship: '船只',
  tank: '坦克', mech: '机械化', logistics: '后勤', mg: '机枪', vehicle: '车辆',
  runtime: '零件', library: '库', unit: '部件', preview: '预览', default: '其他',
  zz: '测试',
};
const PROJECT_LABEL = { default: '默认', combos: '默认' };
const PLACEMENT_DEFAULTS = {
  position: [0, 0, 0],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  pivot: [0, 0, 0],
};

function projectLabel(project) {
  if (!project || project === 'default' || project === 'combos') return '默认';
  if (PROJECT_LABEL[project]) return PROJECT_LABEL[project];
  // G3DArmy 项目标签本身含 "/"（age3mudels/G3DArmy、ww1models/G3DArmy），保持原样。
  if (project.includes('/')) return project;
  const preview = project.match(/^preview[_-](.+)$/i);
  if (preview) return `${projectLabel(preview[1])} 预览`;
  if (/^[a-z]{2,6}\d*$/i.test(project)) return project.toUpperCase();
  return project.charAt(0).toUpperCase() + project.slice(1);
}

function splitGroup(group) {
  if (!group || !group.includes('/')) return ['', group || ''];
  const at = group.lastIndexOf('/');
  return [group.slice(0, at), group.slice(at + 1)];
}

function groupLabel(group) {
  if (!group) return '其他';
  if (!group.includes('/')) return CATEGORY_LABEL[group] || projectLabel(group);
  const [project, category] = splitGroup(group);
  const pl = projectLabel(project);
  if (!category || category === 'default') return pl;
  return `${pl} · ${CATEGORY_LABEL[category] || category}`;
}

function groupSortKey(group) {
  if (group === 'all') return [0, '', ''];
  if (!group.includes('/')) {
    const i = BASE_GROUP_ORDER.indexOf(group);
    if (i >= 0) return [1, String(i).padStart(2, '0'), group];
    return [2, group, ''];
  }
  const [project, category] = splitGroup(group);
  return [2, project, category];
}

function compareGroups(a, b) {
  const ka = groupSortKey(a);
  const kb = groupSortKey(b);
  return (ka[0] - kb[0]) || ka[1].localeCompare(kb[1]) || ka[2].localeCompare(kb[2]);
}

const app = {
  models: [],
  filtered: [],
  asset: null,
  path: null,
  group: 'all',
  search: '',
  state: 'idle',
  overrides: { idle: '', move: '', battle: '', retreat: '' },
  times: { idle: 0, move: 0, battle: 0, retreat: 0 },
  proceduralT: 0,
  playing: true,
  speed: 1,
  facing: 180,
  zoom: 1,
  azimuth: 0,
  elevation: 0,
  fitPct: G3D_DEFAULTS.fitPct,
  fitByMax: false,
  worldH: G3D_DEFAULTS.worldH,
  tintMode: 'none',
  tintStrength: G3D_DEFAULTS.tintStrength,
  feetDark: G3D_DEFAULTS.feetDark,
  shadow: true,
  skeleton: false,
  skeletonMode: 'all',
  skeletonBones: [],
  skeletonBadBones: [],
  placement: {
    position: [0, 0, 0],
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    pivot: [0, 0, 0],
  },
  grid: false,
  white: false,
  clampTrackEnd: false,
  fps: 0,
  frameRate: 'auto', // 'auto' = 动画源关键帧网格；数字 = 固定 fps
  loadToken: 0,
  shot: false,
  deepState: null,
  deepTime: null,
  deepFrame: null,
  autoDiag: false,
  runtimeData: null,
  runtimeInfo: null,
  runtimeSelection: null,
  particles: true,
  particleWeapon: 'auto',
  // 摆放面板的相对定位基准：'center'（包围盒中心）| 'feetCenter'（脚底中心）| 'custom'（脱绑自定义）
  transformRef: 'center',
  // 自定义参考点在**模型空间**的局部坐标（脱绑 bbox：只由用户设定，之后随模型一起动）
  transformCustomLocal: null,
  // 参考点高亮（默认关闭）
  refMarker: false,
  // 3D 视图选中模型（悬停/点击高亮轮廓，选中后可拖动摆放）
  selected: false,
  dt: 0,
  prevTimes: { idle: 0, move: 0, battle: 0, retreat: 0 },
  eu5sm: false,
  unitState: 1,
  smRandom: false,
  smAuto: false,
  smAutoT: 0,
  sm: null,
};

let renderer = null;
let frameCount = 0;
let fpsTime = performance.now();
let lastHud = 0;

// ---------------------------------------------------------------- log

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function log(level, msg) {
  const line = document.createElement('div');
  line.className = `line ${level}`;
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = nowStamp();
  const s = document.createElement('span');
  s.textContent = msg;
  line.append(t, s);
  const atBottom = el.log.scrollTop + el.log.clientHeight >= el.log.scrollHeight - 24;
  el.log.appendChild(line);
  while (el.log.childElementCount > 600) el.log.removeChild(el.log.firstChild);
  if (atBottom) el.log.scrollTop = el.log.scrollHeight;
}

function separator(title) {
  const d = document.createElement('div');
  d.className = 'line sep';
  d.textContent = `──── ${title} ────`;
  el.log.appendChild(d);
  el.log.scrollTop = el.log.scrollHeight;
}

function showError(e) {
  const msg = e && e.stack ? e.stack : String(e);
  el.errText.textContent = msg;
  el.err.classList.remove('hidden');
}

function hideError() {
  el.err.classList.add('hidden');
}

// ---------------------------------------------------------------- formatting

const nf = new Intl.NumberFormat('zh-CN');
const fmt = (n) => nf.format(Math.round(n || 0));

function groupOf(path) {
  const parts = path.split('/');
  if (parts[0] === 'combos' && parts[1]) return parts[1];
  if (parts[0] === 'runtime' || parts[0] === 'library') return parts[0];
  if (parts.length > 2) return `${parts[0]}/${parts[1]}`;
  if (parts.length > 1) return parts[0];
  return '-';
}

function nameOf(path) {
  const f = path.split('/').pop() || path;
  return f.replace(/\.g3dj$/i, '');
}

function shortPath(path, max = 52) {
  if (!path) return '';
  return path.length <= max ? path : '…' + path.slice(-(max - 1));
}

// ---------------------------------------------------------------- model list

async function loadModelIndex() {
  try {
    const res = await fetch('/api/models');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    app.models = (data.models || []).map((m) => ({
      ...m,
      project: m.project || '',
      category: m.category || '',
      group: m.group || groupOf(m.path),
      name: m.name || nameOf(m.path),
      mtimeMs: m.mtime_ms || 0,
    }));
    const projects = [...new Set(app.models.map((m) => m.project).filter(Boolean))];
    const projectText = projects.length > 1 ? ` · ${projects.length} 个项目` : '';
    el.root.textContent = `根目录: ${data.root || '?'} · ${app.models.length} 个 g3dj${projectText}`;
    el.root.title = data.root || '';
    if (app.group !== 'all' && !app.models.some((m) => m.group === app.group)) app.group = 'all';
    renderGroupTabs();
    refreshList();
    updateRuntimeUI();
    // 初始模型：?model= > #hash > 第一个
    const params = new URLSearchParams(location.search);
    let initial = params.get('model') || '';
    if (!initial && location.hash) {
      try { initial = decodeURIComponent(location.hash.slice(1)); } catch { initial = ''; }
    }
    if (initial) {
      const found = app.models.find((m) => m.path === initial || m.path.endsWith('/' + initial));
      if (found) { await selectModel(found.path); return; }
      log('warn', `URL 指定的模型不存在: ${initial}`);
    }
    if (app.models.length) {
      // 首次打开优先展示默认项目的步兵（人形，最直观）；没有再用列表第一个
      const preferred = app.models.find((m) => m.group === 'foot')
        || app.models.find((m) => m.category === 'foot')
        || app.models[0];
      await selectModel(preferred.path);
    }
  } catch (e) {
    log('error', `模型列表加载失败: ${e.message || e}`);
    showError(e);
  }
}

function renderGroupTabs() {
  const groups = [...new Set(app.models.map((m) => m.group).filter(Boolean))];
  groups.sort(compareGroups);
  el.tabs.innerHTML = '';
  const add = (group, label) => {
    const b = document.createElement('button');
    b.className = 'tab' + (app.group === group ? ' active' : '');
    b.dataset.group = group;
    b.textContent = label;
    el.tabs.appendChild(b);
  };
  add('all', `全部 ${app.models.length}`);
  for (const g of groups) {
    const n = app.models.filter((m) => m.group === g).length;
    add(g, `${groupLabel(g)} ${n}`);
  }
  if (el.tabsCount) el.tabsCount.textContent = `${groups.length + 1} 个`;
}

function refreshList() {
  const q = app.search.trim().toLowerCase();
  app.filtered = app.models.filter((m) => {
    if (app.group !== 'all' && m.group !== app.group) return false;
    if (!q) return true;
    return [m.name, m.path, m.group, m.project, m.category].filter(Boolean).join(' ').toLowerCase().includes(q);
  });
  app.filtered.sort((a, b) => {
    const ga = groupSortKey(a.group);
    const gb = groupSortKey(b.group);
    if (ga[0] !== gb[0]) return ga[0] - gb[0];
    const c = ga[1].localeCompare(gb[1]);
    if (c) return c;
    const d = ga[2].localeCompare(gb[2]);
    if (d) return d;
    return a.name.localeCompare(b.name);
  });
  el.count.textContent = String(app.filtered.length);
  el.list.innerHTML = '';
  for (const m of app.filtered) {
    const item = document.createElement('div');
    item.className = 'model-item' + (m.path === app.path ? ' active' : '');
    item.dataset.path = m.path;
    item.title = m.path;
    const top = document.createElement('div');
    top.className = 'mi-top';
    const name = document.createElement('span');
    name.className = 'mi-name';
    name.textContent = m.name;
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = groupLabel(m.group);
    top.append(name, chip);
    const sub = document.createElement('div');
    sub.className = 'mi-sub';
    sub.textContent = m.size ? `${(m.size / 1024).toFixed(0)} KB` : '';
    item.append(top, sub);
    item.addEventListener('click', () => selectModel(m.path));
    el.list.appendChild(item);
  }
}

function updateActiveItem() {
  for (const item of el.list.children) {
    item.classList.toggle('active', item.dataset.path === app.path);
  }
}

// ---------------------------------------------------------------- runtime mounting

function fileUrl(path) {
  return '/files/' + String(path).split('/').map(encodeURIComponent).join('/');
}

async function fetchJsonFile(path) {
  const res = await fetch(fileUrl(path));
  if (!res.ok) throw new Error(`HTTP ${res.status} ${path}`);
  return await res.json();
}

// ---------------------------------------------------------------- G3DArmy v4.9 规则
// 选型/挂件解析逻辑已移到 runtime_rules.js（与 G3DArmyPlugin v4.9.14 同步，选择语义同 v4.7.0）：
//   unitSelect 宗教块数组 + unitgroup 文化组兜底 + civilization 顶层 unitSelect/shipSelect。

function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isShipModel(model) {
  const category = String(model?.category || '').toLowerCase();
  const name = String(model?.name || '').toLowerCase();
  return category === 'ship' || name.startsWith('ship_');
}

/**
 * G3DArmy v4.4：武器决定动画。
 * 若武器族与 combo 自身 animSet 不同，读取 models/assembly.json 的 animDonors，
 * 把 donor 的动画轨道按 boneId 重绑到目标模型（只取动画，不建 donor 网格）。
 */
async function applyRuntimeAnimDonor(json, runtime, mounted, path) {
  if (!runtime.assembly || !runtime.info.main || !mounted.length) return null;
  const comboId = nameOf(path);
  const combos = runtime.assembly.combos || {};
  const combo = combos[comboId] || {};
  const signature = mounted.map((m) => m.part).join(';');
  const family = weaponFamilyFromSig(signature);
  if (!family) return null;
  const own = animSetList(combo.animSet);
  if (own.includes(family)) return null;
  // 与插件一致：rig 缺省时取 rigs[0]；两者都没有 = 不借动画（不默认 foot）。
  const rig = combo.rig || (Array.isArray(combo.rigs) ? combo.rigs[0] : null);
  if (!rig) return null;
  const donor = runtime.assembly.animDonors?.[rig]?.[family];
  if (!donor || donor === comboId) return null;
  const donorPath = `${runtime.info.main}/${donor}.g3dj`;
  let donorJson;
  try {
    donorJson = await fetchJsonFile(donorPath);
  } catch (e) {
    return { donor, family, rig, error: e.message || String(e), animations: 0 };
  }
  const targetIds = collectNodeIds(json);
  const animations = (donorJson.animations || []).map((anim) => ({
    ...anim,
    bones: (anim.bones || []).filter((bone) => targetIds.has(bone.boneId)),
  })).filter((anim) => anim.bones.length);
  if (!animations.length) {
    return { donor, family, rig, error: 'donor animation has no matching bones', animations: 0 };
  }
  json.animations = animations;
  return { donor, family, rig, path: donorPath, animations: animations.length };
}


function collectNodeIds(json) {
  const ids = new Set();
  const visit = (n) => {
    if (!n) return;
    if (n.id != null) ids.add(n.id);
    for (const c of n.children || []) visit(c);
  };
  for (const n of json.nodes || []) visit(n);
  return ids;
}

function findPartNode(nodes) {
  for (const n of nodes || []) {
    if (n && Array.isArray(n.parts) && n.parts.length) return n;
    const child = findPartNode(n?.children);
    if (child) return child;
  }
  return null;
}

function safeSlug(value) {
  const s = String(value || 'part').replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '');
  return s.slice(0, 36) || 'part';
}

function runtimeBoneAlias(name) {
  const s = String(name || '').replace(/^@/, '');
  return ({
    wea: 'Unit_Wea_Right_Hand01',
    left: 'Unit_Base_Rig_LeftHand',
    spine1: 'Unit_Base_Rig_Spine1',
    spine2: 'Unit_Base_Rig_Spine2',
  })[s.toLowerCase()] || s;
}

/**
 * 把 runtime part 的网格/材质/节点合并进目标 g3dj JSON。
 * runtime part 的绑定骨 invBind=单位阵（G3DArmy 的 runtime attachment 约定），
 * 把骨骼名改成目标骨架骨名后，renderer 会自动用目标骨动画矩阵驱动它。
 */
/**
 * G3DArmy v4.0 strip：combo 自身 bake 的武器/盾先删掉，再由 attachments 运行时挂载。
 * 否则 web 会同时显示 baked musket 和 runtime bow。
 */
function applyRuntimeStrip(json, comboId, strip, warnings) {
  if (!strip) return null;
  const prefixes = strip.combos || [];
  const tokens = (strip.tokens || []).map((s) => String(s).toLowerCase()).filter(Boolean);
  if (!tokens.length || !prefixes.some((p) => comboId.startsWith(String(p)))) return null;
  const hit = (value) => {
    const s = String(value || '').toLowerCase();
    return tokens.some((t) => s.includes(t));
  };
  const primIds = new Set();
  const matIds = new Set();
  let removed = 0;
  const visit = (nodes) => {
    for (const node of nodes || []) {
      if (Array.isArray(node.parts)) {
        const keep = [];
        for (const part of node.parts) {
          if (hit(part.meshpartid) || hit(part.materialid)) {
            removed++;
            if (part.meshpartid) primIds.add(part.meshpartid);
            if (part.materialid) matIds.add(part.materialid);
          } else {
            keep.push(part);
          }
        }
        node.parts = keep;
      }
      visit(node.children);
    }
  };
  visit(json.nodes);
  if (removed) {
    json.meshes = (json.meshes || []).filter((mesh) => {
      mesh.parts = (mesh.parts || []).filter((part) => !primIds.has(part.id));
      return mesh.parts.length > 0;
    });
    json.materials = (json.materials || []).filter((mat) => !matIds.has(mat.id));
    warnings.push(`strip: combo ${comboId} 删除了 ${removed} 个 baked 部件`);
  }
  return { removed, prims: [...primIds], materials: [...matIds] };
}

function mergeRuntimePart(json, partJson, partName, targetBone, runtime, seq, warnings, nodeIds) {
  const source = findPartNode(partJson.nodes);
  if (!source || !Array.isArray(source.parts) || !source.parts.length) {
    warnings.push(`${partName}: 没有带 parts 的节点`);
    return null;
  }
  const prefix = `rt_${seq}_${safeSlug(partName)}_`;
  const primMap = new Map();
  for (const mesh of partJson.meshes || []) {
    const oldMeshId = mesh.id || `mesh${seq}`;
    mesh.id = prefix + oldMeshId;
    for (const prim of mesh.parts || []) {
      const oldPrimId = prim.id || oldMeshId + '_part';
      prim.id = prefix + oldPrimId;
      primMap.set(oldPrimId, prim.id);
    }
  }
  for (const mat of partJson.materials || []) {
    mat.id = prefix + (mat.id || 'mat');
    for (const texture of mat.textures || []) {
      if (!texture.filename) continue;
      const base = String(texture.filename).replace(/\\/g, '/').split('/').pop();
      const texDir = runtime.info.partsPng || runtime.info.parts;
      texture.filename = `/${texDir}/${base}`;
    }
  }
  const newParts = [];
  for (const srcPart of source.parts) {
    const meshpartid = primMap.get(srcPart.meshpartid) || (prefix + srcPart.meshpartid);
    let mappedAll = true;
    const bones = (srcPart.bones || []).map((bone, index) => {
      let mapped = targetBone;
      if (!mapped) {
        // G3DArmy 的 skin 挂件：按 part 自带 bone 名匹配目标骨架，不强行改挂单骨
        mapped = bone.node && nodeIds.has(bone.node) ? bone.node : null;
      }
      if (!mapped) mappedAll = false;
      if (index > 0 && targetBone) warnings.push(`${partName}: 多个骨骼（${srcPart.bones.length}），全部改挂到 ${targetBone}`);
      return { ...bone, node: mapped };
    }).filter((bone) => bone.node);
    if (!bones.length || !mappedAll) {
      warnings.push(`${partName}: 目标骨骼不匹配（${targetBone || 'skin 同名骨'}）`);
      continue;
    }
    newParts.push({
      ...srcPart,
      meshpartid,
      materialid: srcPart.materialid ? prefix + srcPart.materialid : '',
      bones,
    });
  }
  if (!newParts.length) return null;
  json.meshes = (json.meshes || []).concat(partJson.meshes || []);
  json.materials = (json.materials || []).concat(partJson.materials || []);
  json.nodes = (json.nodes || []);
  json.nodes.push({ id: prefix + 'node', parts: newParts });
  return { part: partName, bone: targetBone || 'skin', parts: newParts.length };
}

async function loadRuntimeData(path) {
  const res = await fetch('/api/runtime?model=' + encodeURIComponent(path));
  if (!res.ok) throw new Error(`G3DArmy API HTTP ${res.status}`);
  const info = await res.json();
  if (!info.enabled) return { info, available: false };
  if (!info.available) return { info, available: false };
  const attachments = await fetchJsonFile(info.attachments);
  let unitSelect = null;
  if (info.unitSelect) {
    try {
      unitSelect = await fetchJsonFile(info.unitSelect);
    } catch (e) {
      // unitSelect 只是辅助选规则，缺失时仍可按类别挂载
    }
  }
  let override = null;
  if (info.override) {
    try {
      override = await fetchJsonFile(info.override);
    } catch (e) {
      override = null;
    }
  }
  let index = null;
  if (info.index) {
    try {
      index = await fetchJsonFile(info.index);
    } catch (e) {
      index = null;
    }
  }
  let assembly = null;
  if (info.assembly) {
    try {
      assembly = await fetchJsonFile(info.assembly);
    } catch (e) {
      assembly = null;
    }
  }
  // G3DArmy v4.5: anim_events.json 与 assembly.json 同属 base 目录；
  // 按 combo 名取 animSet（如 ww1_rifle / ww1_mg），供攻击粒子使用。
  // 直接以 .../G3DArmy 为 root 时 info.base 为空字符串，仍应读取根目录的 anim_events.json。
  let animEvents = null;
  const animEventsPath = info.base
    ? `${info.base}/anim_events.json`
    : 'anim_events.json';
  try {
    animEvents = await fetchJsonFile(animEventsPath);
  } catch (e) {
    animEvents = null;
  }
  const combo = nameOf(path);
  const comboDef = assembly && assembly.combos && assembly.combos[combo]
    ? assembly.combos[combo]
    : null;
  // animSet 可能是字符串或数组（如 ["musket_r", "horse"]）；攻击事件按列表逐个查。
  const animSet = comboDef ? (comboDef.animSet ?? null) : null;
  const comboGroup = comboDef ? (comboDef.group ?? null) : null;
  // v4.2+: setting.json（渲染窗口/适配/染色；g3d-web 只用其中与模型外观相关的键）。
  let setting = null;
  const settingPath = info.base ? `${info.base}/setting.json` : 'setting.json';
  try {
    setting = await fetchJsonFile(settingPath);
  } catch (e) {
    setting = null;
  }
  // v4.5: civilization/<tag>.json；文件不存在时忽略，不影响全局规则。
  const civs = {};
  for (const [tag, civPath] of Object.entries(info.civs || {})) {
    try {
      civs[tag] = await fetchJsonFile(civPath);
    } catch (e) {
      // 单个文明覆盖损坏不应阻断整个 runtime
    }
  }
  return {
    info, available: true, attachments, unitSelect, override, civs, index, assembly,
    animEvents, animSet, comboGroup, setting, partCache: new Map(),
  };
}

function normalizeRuntimeToken(token) {
  if (token == null) return '';
  if (isObject(token)) {
    const part = String(token.part || '').trim();
    const bone = String(token.bone || '').trim();
    return part ? (bone ? `${part}@${bone}` : part) : '';
  }
  return String(token).trim();
}

async function mergeRuntimeIntoJson(json, path, runtime) {
  const model = app.models.find((m) => m.path === path);
  const picked = pickRuntimeRuleV47(runtime, model, app.runtimeSelection);
  const warnings = [];
  const mounted = [];
  const comboId = nameOf(path);
  // strip 是全局 attachments.json 的属性，即使没有挂件规则也要执行
  const stripped = applyRuntimeStrip(json, comboId, runtime.attachments?.strip, warnings);
  const tokens = (picked?.tokens || []).map(normalizeRuntimeToken).filter(Boolean);
  const nodeIds = collectNodeIds(json);
  let seq = 0;
  for (const raw of tokens) {
    const at = raw.lastIndexOf('@');
    const partName = at > 0 ? raw.slice(0, at).trim() : raw;
    const entry = runtime.index?.parts?.[partName] || {};
    let targetBone = at > 0 ? runtimeBoneAlias(raw.slice(at + 1).trim()) : null;
    const mountMode = entry.mount?.mode || 'official';
    // G3DArmy 的 skin 挂件按 part 自带骨名匹配目标骨架，不把 mount.bone 当单骨覆盖。
    if (!targetBone && entry.mount?.bone && mountMode !== 'skin') {
      targetBone = runtimeBoneAlias(entry.mount.bone);
    }
    if (!targetBone && mountMode !== 'skin') {
      warnings.push(`${partName}: 没有 @bone，且 parts/index 没有 mount.bone`);
      continue;
    }
    if (targetBone && !nodeIds.has(targetBone)) {
      warnings.push(`${partName}: 目标骨骼 ${targetBone} 不在模型中`);
      continue;
    }
    const file = entry.file || `${partName}.g3dj`;
    const partPath = `${runtime.info.parts}/${file}`;
    try {
      let partJson = runtime.partCache.get(partPath);
      if (!partJson) {
        partJson = await fetchJsonFile(partPath);
        runtime.partCache.set(partPath, partJson);
      }
      // 同一个 part 可挂多次（不同序号/骨骼），先克隆再改 id
      const cloned = JSON.parse(JSON.stringify(partJson));
      const mountedPart = mergeRuntimePart(json, cloned, partName, targetBone, runtime, ++seq, warnings, nodeIds);
      if (mountedPart) mounted.push(mountedPart);
    } catch (e) {
      warnings.push(`${partName}: 加载失败 ${e.message || e}`);
    }
  }
  if (!picked) warnings.push('没有匹配的 G3DArmy 规则');
  else if (!picked.entry && picked.tokens.length === 0) {
    warnings.push(`${picked.ruleKey}: attachments 中没有该兵种规则（仅按 loadSelect 识别）`);
  }
  const info = {
    ...runtime.info,
    available: true,
    ruleKey: picked?.ruleKey || null,
    typeName: picked?.typeName || null,
    group: app.runtimeSelection?.group || picked?.group || null,
    level: app.runtimeSelection?.level ?? picked?.level ?? 0,
    aId: app.runtimeSelection?.aId ?? picked?.aId ?? null,
    unitName: picked?.unitName || null,
    religion: app.runtimeSelection?.religion || picked?.religion || null,
    religionGroup: app.runtimeSelection?.religionGroup ?? picked?.religionGroup ?? null,
    civ: picked?.civ || app.runtimeSelection?.civ || null,
    scope: picked?.scope || 'none',
    pickReason: picked?.reason || 'none',
    ship: !!picked?.ship,
    tokens,
    mounted,
    // 与插件一致：挂件签名（"件名@骨;…"）+ combo 的 animSet/group 决定攻击事件表。
    attachSig: mounted.map((m) => (m.bone ? `${m.part}@${m.bone}` : m.part)).join(';'),
    animSet: runtime.animSet ?? null,
    comboGroup: runtime.comboGroup ?? null,
    stripped,
    warnings,
  };
  try {
    info.animDonor = await applyRuntimeAnimDonor(json, runtime, mounted, path);
  } catch (e) {
    warnings.push(`动画 donor 失败: ${e.message || e}`);
    info.animDonor = null;
  }
  return { json, info };
}

function fillSelect(select, options, value) {
  const values = options.slice();
  if (value && !values.includes(value)) values.push(value);
  select.innerHTML = '';
  for (const v of values) {
    const opt = document.createElement('option');
    opt.value = v.value ?? v;
    opt.textContent = v.label ?? v;
    select.appendChild(opt);
  }
  select.value = value ?? '';
}

function updateRuntimeUI() {
  if (!el.runtimePanel) return;
  const info = app.runtimeInfo;
  const disableAll = (on) => {
    for (const node of [el.runtimeRule, el.runtimeGroup, el.runtimeCiv, el.runtimeLevel, el.runtimeAid, el.runtimeReligion, el.runtimeReligionGroup]) {
      if (node) node.disabled = on;
    }
  };
  if (!info) {
    el.runtimeBadge.textContent = '无配置';
    el.runtimeNote.textContent = '当前模型没有找到 G3DArmy 配置（loadSelect / attachments）';
    el.runtimeRule.innerHTML = '';
    el.runtimeGroup.innerHTML = '';
    if (el.runtimeCiv) el.runtimeCiv.innerHTML = '';
    disableAll(true);
    return;
  }
  if (!info.available) {
    el.runtimeBadge.textContent = '无配置';
    el.runtimeNote.textContent = '当前模型附近没有找到 G3DArmy 资源目录';
    el.runtimeRule.innerHTML = '';
    el.runtimeGroup.innerHTML = '';
    if (el.runtimeCiv) el.runtimeCiv.innerHTML = '';
    disableAll(true);
    return;
  }

  const model = app.models.find((m) => m.path === app.path) || null;
  const ship = isShipModel(model);
  const keys = runtimeRuleKeysV47(app.runtimeData, info.civ || null, ship);
  const selectedRule = info.ruleKey || keys[0] || '';
  fillSelect(el.runtimeRule, keys, selectedRule);
  el.runtimeRule.disabled = !keys.length;

  // v4.5：文明 tag 覆盖；空选项 = 只用全局配置
  const civs = Object.entries(app.runtimeData?.civs || {})
    .filter(([, value]) => !value || value.enabled !== false)
    .map(([tag]) => tag);
  fillSelect(el.runtimeCiv, ['', ...civs], info.civ || '');
  el.runtimeCiv.disabled = !civs.length;

  // v4.7：group 选项来自 unitgroup 文化组表 + 条目内的 group 键（religion 块条件也会列出）
  const groups = runtimeGroupOptionsV47(app.runtimeData, info.civ || null, ship);
  fillSelect(el.runtimeGroup, ['', ...groups], info.group || '');
  el.runtimeGroup.disabled = !groups.length;

  if (el.runtimeLevel) {
    el.runtimeLevel.value = info.level == null || info.level === '' ? '' : String(info.level);
    el.runtimeLevel.disabled = false;
  }
  if (el.runtimeAid) {
    el.runtimeAid.value = info.aId == null || info.aId === '' ? '' : String(info.aId);
    el.runtimeAid.disabled = false;
  }
  if (el.runtimeReligion) {
    el.runtimeReligion.value = info.religion == null ? '' : String(info.religion);
    el.runtimeReligion.disabled = false;
  }
  if (el.runtimeReligionGroup) {
    el.runtimeReligionGroup.value = info.religionGroup == null ? '' : String(info.religionGroup);
    el.runtimeReligionGroup.disabled = false;
  }

  const count = info.mounted?.length || 0;
  el.runtimeBadge.textContent = count ? `已挂载 ${count}` : '无挂载';
  const animSets = animSetList(info.animSet);
  const prof = renderer ? renderer.weaponProfile : null;
  const parts = [
    info.ruleKey || '—',
    info.civ ? `civ:${info.civ}` : 'global',
    info.group ? `group:${info.group}` : '',
    info.level != null ? `lv:${info.level}` : '',
    info.aId != null ? `aID:${info.aId}` : '',
    info.religion ? `rel:${info.religion}` : '',
    info.religionGroup != null ? `relg:${info.religionGroup}` : '',
    animSets.length ? `animSet:${animSets.join(',')}` : '',
    `攻击表:${prof || '无'}`,
  ].filter(Boolean).join(' / ');
  if (count) {
    el.runtimeNote.textContent = `${parts}（${info.pickReason || 'auto'}）：${info.mounted.map((m) => `${m.part}@${m.bone}`).join(', ')}`;
  } else {
    const stripNote = info.stripped?.removed ? `；strip 移除 ${info.stripped.removed} 个 baked 部件` : '';
    el.runtimeNote.textContent = `${parts}（${info.pickReason || 'auto'}）没有可挂载 token${stripNote}`;
  }
  for (const w of info.warnings || []) log('warn', `G3DArmy: ${w}`);
}

// ---------------------------------------------------------------- model loading

async function selectModel(path, force = false) {
  if (!force && path === app.path && app.asset) return;
  const token = ++app.loadToken;
  el.loading.classList.remove('hidden');
  el.loadingText.textContent = '加载 g3dj…';
  hideError();
  try {
    const url = '/files/' + path.split('/').map(encodeURIComponent).join('/');
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText} (${url})`);
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (e) {
      throw new Error(`g3dj JSON 解析失败: ${e.message}`);
    }
    let runtimeInfo = null;
    let runtime = null;
    app.runtimeData = null;
    app.runtimeInfo = null;
    el.loadingText.textContent = '解析 G3DArmy 装配…';
    try {
      runtime = await loadRuntimeData(path);
      if (token !== app.loadToken) return;
      app.runtimeData = runtime;
      if (runtime?.available) {
        const merged = await mergeRuntimeIntoJson(json, path, runtime);
        if (token !== app.loadToken) return;
        runtimeInfo = merged.info;
        json = merged.json;
      } else if (runtime?.info) {
        runtimeInfo = runtime.info;
      }
    } catch (e) {
      if (token !== app.loadToken) return;
      app.runtimeData = null;
      runtimeInfo = null;
      log('warn', `G3DArmy 装配跳过: ${e.message || e}`);
    }
    const t0 = performance.now();
    const asset = parseG3dj(json, { path, name: nameOf(path) });
    asset.runtime = runtimeInfo;
    if (asset.runtime && runtime?.available) {
      asset.runtime.animEvents = runtime.animEvents;
      asset.runtime.animSet = runtime.animSet;
    }
    app.runtimeInfo = runtimeInfo;
    if (token !== app.loadToken) return;
    const tParse = performance.now() - t0;

    if (!renderer) throw new Error('WebGL 渲染器未初始化');
    if (force) renderer.clearTextureCache();
    renderer.feetDark = app.feetDark;
    renderer.setModel(asset);
    app.asset = asset;
    app.path = path;
    for (const k of STATE_KEYS) {
      app.times[k] = 0;
      app.prevTimes[k] = 0;
    }
    app.proceduralT = 0;
    app.sm = createUnitStateMachine('Idle');
    if (app.eu5sm) {
      const snap = app.sm.snapshot();
      app.state = snap.displayState;
      app.times[app.state] = snap.time;
    }

    // 长模型（马/象/船）自动按最大边适配；玩家可随时取消勾选回到 G3DArmy 的 height 默认
    if (asset.bounds) {
      const longModel = Math.max(asset.bounds.size[0], asset.bounds.size[2]) > asset.bounds.size[1] * 1.05;
      app.fitByMax = longModel;
      el.fitmax.checked = longModel;
    } else {
      app.fitByMax = false;
      el.fitmax.checked = false;
    }

    el.empty.classList.add('hidden');
    el.err.classList.add('hidden');
    // v4.2+: setting.json 的适配设置（与游戏一致）；缺键时保留上面的长模型自动判定。
    const setting = runtime && runtime.available ? runtime.setting : null;
    let settingNote = null;
    if (setting) {
      const pct = Number(setting.modelFitPct);
      if (Number.isFinite(pct) && pct > 0) {
        app.fitPct = Math.max(0.1, Math.min(1.2, pct));
        el.fitpct.value = String(app.fitPct);
        el.fitpctVal.textContent = app.fitPct.toFixed(2);
      }
      if (setting.modelFitBy === 'max' || setting.modelFitBy === 'height') {
        app.fitByMax = setting.modelFitBy === 'max';
        el.fitmax.checked = app.fitByMax;
      }
      // v4.9.2：阴影三项（含核心烘焙）
      if (renderer) {
        renderer.setShadowStyle({
          scale: setting.shadowScale,
          core: setting.shadowCore,
          bake: setting.shadowBake,
        });
      }
      settingNote = `setting.json：modelFitPct=${setting.modelFitPct ?? '—'} · modelFitBy=${setting.modelFitBy ?? '—'}`
        + ` · modelYaw=${setting.modelYaw ?? '—'} · tint=${setting.tint ?? '—'}/${setting.tintStrength ?? '—'}`
        + ` · shadowBake=${setting.shadowBake ?? '—'} · nearFar=${setting.nearFar ?? '—'}`;
    }
    el.title.textContent = asset.id || asset.fileName;
    el.path.textContent = shortPath(path, 70);
    el.path.title = path;
    el.animCount.textContent = `${asset.animations.length} 个动画`;

    updateActiveItem();
    rebuildOverrideOptions();
    updateStateUI();
    updateStats();
    updateHud(true);
    updateRuntimeUI();
    // 换模型后旧的选中态已经没有意义（轮廓高亮跟着上一个模型走）。
    setSelected(false, { silent: true });
    // 撤销栈是模型相关（自定义参考点存的是模型空间坐标），换模型就清空。
    clearHistory();

    separator(`加载 ${asset.fileName}`);
    log('ok', `模型加载完成 ${tParse.toFixed(0)}ms：顶点 ${fmt(asset.stats.vertices)} · 三角 ${fmt(asset.stats.triangles)} · 部件 ${asset.stats.parts} · 骨骼节点 ${asset.stats.joints}/${asset.stats.nodes} · 单部件最多 ${asset.stats.maxPartBones} 骨 · 动画 ${asset.animations.length}`);
    if (settingNote) log('info', settingNote);
    if (runtimeInfo) {
      if (!runtimeInfo.available) {
        log('info', 'G3DArmy: 当前模型没有找到装配配置');
      } else if (runtimeInfo.mounted?.length) {
        log('ok', `G3DArmy 装配 ${runtimeInfo.mounted.length} 件：${runtimeInfo.ruleKey}${runtimeInfo.group ? ' / ' + runtimeInfo.group : ''} · ${runtimeInfo.mounted.map((m) => `${m.part}@${m.bone}`).join(', ')}`);
        const ad = runtimeInfo.animDonor;
        if (ad) {
          if (ad.error) log('warn', `G3DArmy 武器动画 donor ${ad.donor} 失败: ${ad.error}`);
          else log('info', `G3DArmy 武器动画 donor=${ad.donor} family=${ad.family} tracks=${ad.animations}`);
        }
        if (runtimeInfo.stripped?.removed) {
          log('info', `G3DArmy strip：删除 ${runtimeInfo.stripped.removed} 个 baked 武器/盾部件`);
        }
      } else if (runtimeInfo.ruleKey) {
        log('info', `G3DArmy: 规则 ${runtimeInfo.ruleKey} 没有装配 token`);
      }
    }
    const frameInfoText = asset.animations.slice(0, 4).map((a) =>
      `${a.id}:${a.frameTimes ? a.frameTimes.length : 0}帧@${a.sourceFps.toFixed(2)}fps`).join(' · ');
    if (frameInfoText) log('info', `源帧网格：${frameInfoText}`);
    log('info', `自动适配：包围盒 ${asset.bounds ? asset.bounds.size.map((v) => v.toFixed(2)).join(' × ') : '（无）'} · 阴影锚点 ${asset.bounds ? asset.bounds.anchor.map((v) => v.toFixed(2)).join(', ') : '—'} · 适配维度=${app.fitByMax ? '最大边(长模型)' : '高度(G3DArmy 默认)'}`);
    if (asset.checks.bindMaxError > 1e-4) {
      const lvl = asset.checks.bindMaxError > 1e-2 ? 'error' : 'warn';
      log(lvl, `绑定矩阵自检：最大误差 ${asset.checks.bindMaxError.toFixed(6)}${asset.checks.bindWorst ? `（${asset.checks.bindWorst.node} / ${asset.checks.bindWorst.meshPartId}）` : ''}`);
    } else {
      log('ok', '绑定矩阵自检：bones[] 与节点树绑定世界矩阵一致');
    }
    const shortTotal = asset.checks.shortTrackTotal;
    if (shortTotal) {
      log('warn', `检测到 ${shortTotal} 条轨道尾帧早于动画时长；严格模式下 libGDX 会回卷第一段并外插（可勾选“尾帧钳制”对比）`);
    }
    for (const e of asset.errors) log('error', e);
    for (const w of asset.warnings.slice(0, 10)) log('warn', w);
    if (asset.warnings.length > 10) log('warn', `…还有 ${asset.warnings.length - 10} 条警告（点击“管线自检”查看全部）`);

    renderer.loadMaterialTextures(asset).then((n) => {
      if (n) log('info', `材质贴图：${n} 张（缺失时使用占位白贴图）`);
    });

    // 一次性应用 URL 的 state/t/frame（深链 / 截图定位；frame 优先于 t）
    const deepState = app.deepState;
    const deepTime = app.deepTime;
    const deepFrame = app.deepFrame;
    app.deepState = null;
    app.deepTime = null;
    app.deepFrame = null;
    if (deepState && STATE_KEYS.includes(deepState)) {
      app.state = deepState;
    }
    updateStateUI();
    if (deepFrame != null) {
      const info = frameInfo(app.state);
      if (info.valid) setFrame(deepFrame);
      app.playing = false;
    } else if (deepTime != null) {
      const dur = durationOf(app.state);
      if (dur > 0) app.times[app.state] = ((deepTime % dur) + dur) % dur;
      app.playing = false;
    }
    app.prevTimes[app.state] = app.times[app.state] || 0;
    if (app.sm) {
      app.sm.state = Object.keys(DISPLAY_STATE).find((k) => DISPLAY_STATE[k] === app.state) || 'Idle';
      app.sm.time = app.times[app.state] || 0;
    }
    updateScrub();
    updatePlayButton();
    updateHud(true);
    if (app.autoDiag) {
      app.autoDiag = false;
      showAiReport(diagnose());
    }
    el.loading.classList.add('hidden');
    history.replaceState(null, '', '#' + encodeURIComponent(path));
  } catch (e) {
    if (token === app.loadToken) {
      log('error', `模型加载失败: ${e.message || e}`);
      el.loading.classList.add('hidden');
      if (!app.asset) showError(e);
    }
  }
}

// ---------------------------------------------------------------- animation states

function mappedAnimId(state) {
  if (!app.asset) return null;
  const override = app.overrides[state];
  if (override) return override;
  return app.asset.states[state] ? app.asset.states[state].id : null;
}

function mappedSource(state) {
  if (!app.asset) return '';
  if (app.overrides[state]) return 'override';
  return app.asset.states[state] ? app.asset.states[state].source : '';
}

function animationOf(state) {
  const id = mappedAnimId(state);
  return (id && app.asset) ? (app.asset.animById.get(id) || null) : null;
}

function durationOf(state) {
  const anim = animationOf(state);
  return anim ? anim.duration : 0;
}

/** 为当前 asset 建一个最小 EU5 状态机。 */
function createUnitStateMachine(state = 'Idle') {
  return new UnitStateMachine({
    getDuration: (displayState) => durationOf(displayState),
    randomPhase: app.smRandom,
    state,
    unitState: app.unitState,
    onStateChange: (to, from, info) => {
      const display = DISPLAY_STATE[to] || 'idle';
      app.state = display;
      app.times[display] = info.time || 0;
      app.prevTimes[display] = 0;
      updateStateUI();
      updateHud(true);
      log('info', `EU5 SM ${from} → ${to}（UnitState=${UNIT_STATE_NAMES[app.unitState]} · 显示=${display}）`);
    },
  });
}

function rebuildOverrideOptions() {
  el.override.innerHTML = '';
  const follow = document.createElement('option');
  follow.value = '';
  follow.textContent = '跟随 G3DArmy 映射';
  el.override.appendChild(follow);
  if (!app.asset) return;
  for (const anim of app.asset.animations) {
    const opt = document.createElement('option');
    opt.value = anim.id;
    opt.textContent = `${anim.id}（${anim.duration.toFixed(2)}s）`;
    el.override.appendChild(opt);
  }
  el.override.value = app.overrides[app.state] || '';
}

function updateStateUI() {
  const buttons = el.stateButtons.querySelectorAll('.state-btn');
  for (const btn of buttons) {
    const key = btn.dataset.state;
    const id = mappedAnimId(key);
    btn.classList.toggle('active', key === app.state);
    const st = app.asset && app.asset.states[key];
    const fallback = st && st.source === 'fallback' && !app.overrides[key];
    btn.classList.toggle('fallback', !!fallback);
    const span = btn.querySelector('.state-anim');
    if (!id) span.textContent = '程序化动作';
    else span.textContent = id + (fallback ? '（回退）' : '');
    btn.title = fallback ? `G3DArmy 未匹配到关键词，回退到 ${id}` : (id || '该状态没有可用动画');
  }
  el.override.value = app.overrides[app.state] || '';

  if (!app.asset) {
    el.stateNote.textContent = '';
    return;
  }
  const lines = [];
  for (const k of STATE_KEYS) {
    const st = app.asset.states[k];
    const id = mappedAnimId(k);
    if (!id) lines.push(`${STATE_LABELS[k]} → 程序化动作（无动画）`);
    else if (app.overrides[k]) lines.push(`${STATE_LABELS[k]} → ${id}（手动覆盖）`);
    else if (st && st.source === 'fallback') lines.push(`${STATE_LABELS[k]} → ${id}（关键词未命中，回退）`);
    else lines.push(`${STATE_LABELS[k]} → ${id}（${st && st.source === 'keyword' ? '关键词匹配' : '默认'}）`);
  }
  let note = lines.join('\n');
  if (app.asset.checks.shortTrackTotal) {
    note += `\n⚠ ${app.asset.checks.shortTrackTotal} 条轨道尾帧早于动画时长，严格模式尾段会外插。`;
  }
  el.stateNote.textContent = note;
  el.stateNote.classList.toggle('warn', !!app.asset.checks.shortTrackTotal);
}

// ---------------------------------------------------------------- playback

function advance(dt) {
  if (!app.asset) return;
  app.proceduralT += dt;
  if (app.proceduralT > 1000) app.proceduralT -= 1000;

  // EU5 状态机模式：由 UnitState 驱动状态，SM 的 time 就是当前动画时间
  if (app.eu5sm && app.sm) {
    const before = app.sm.snapshot();
    app.sm.update(dt, app.unitState);
    const after = app.sm.snapshot();
    app.state = after.displayState;
    app.times[after.displayState] = after.time;
    app.prevTimes[after.displayState] = before.displayState === after.displayState ? before.time : 0;
    return;
  }

  for (const k of STATE_KEYS) {
    const id = mappedAnimId(k);
    if (!id) continue;
    const anim = app.asset.animById.get(id);
    if (!anim || anim.duration <= 0) continue;
    app.prevTimes[k] = app.times[k];
    let t = app.times[k] + dt * app.speed;
    t %= anim.duration;
    if (t < 0) t += anim.duration;
    app.times[k] = t;
  }
}

function resetPlayback() {
  for (const k of STATE_KEYS) {
    app.times[k] = 0;
    app.prevTimes[k] = 0;
  }
  app.proceduralT = 0;
  if (app.sm) {
    app.sm.reset('Idle', app.unitState);
    app.state = app.sm.snapshot().displayState;
    app.times[app.state] = app.sm.snapshot().time;
  }
  updateScrub();
  updateStateUI();
  updateHud(true);
}

function updatePlayButton() {
  el.play.textContent = app.playing ? '⏸ 暂停' : '▶ 播放';
}

/**
 * 当前状态的帧信息。
 * - auto：使用动画所有关键帧时间的并集（源帧），帧索引与 g3dj 的关键帧严格对应；
 * - 固定 fps：按 duration*fps 取整生成帧网格，时间 = frame/fps。
 */
function frameInfo(state = app.state) {
  const anim = animationOf(state);
  const dur = anim ? anim.duration : 0;
  if (dur <= 0) {
    return { valid: false, mode: 'none', frames: 0, frame: 0, t: 0, duration: 0, fps: 0, frameTimes: null };
  }
  let t = app.times[state] || 0;
  if (t < 0) t = 0;
  if (t > dur) t = dur;

  if (app.frameRate === 'auto' && anim && Array.isArray(anim.frameTimes) && anim.frameTimes.length >= 2) {
    const times = anim.frameTimes;
    // 二分查找最后一个 <= t 的源帧
    let lo = 0, hi = times.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (times[mid] <= t + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    return {
      valid: true, mode: 'auto', frames: times.length, frame: lo, t,
      duration: dur, fps: anim.sourceFps || 30, frameTimes: times, frameTime: times[lo],
    };
  }

  const fps = app.frameRate === 'auto' ? 30 : (Number(app.frameRate) || 30);
  const frames = Math.max(1, Math.ceil(dur * fps - 1e-6));
  let frame = Math.floor(t * fps + 1e-6);
  if (frame >= frames) frame = frames - 1;
  if (frame < 0) frame = 0;
  return {
    valid: true, mode: 'fixed', frames, frame, t,
    duration: dur, fps, frameTimes: null, frameTime: frame / fps,
  };
}

/** 跳到指定帧（auto=源关键帧时间；固定模式=frame/fps）。 */
function setFrame(frame) {
  const info = frameInfo(app.state);
  if (!info.valid) return;
  const f = Math.max(0, Math.min(info.frames - 1, Math.round(frame)));
  let t = info.mode === 'auto' ? info.frameTimes[f] : f / info.fps;
  if (t >= info.duration) t = Math.max(0, info.duration - 1e-6);
  app.times[app.state] = t;
  app.prevTimes[app.state] = t;
  if (app.sm) {
    app.sm.state = Object.keys(DISPLAY_STATE).find((k) => DISPLAY_STATE[k] === app.state) || 'Idle';
    app.sm.time = t;
  }
  updateScrub();
}

/** 单帧步进（暂停并吸附到帧）。 */
function stepFrame(delta) {
  app.playing = false;
  updatePlayButton();
  const info = frameInfo(app.state);
  if (!info.valid) {
    const fps = app.frameRate === 'auto' ? 30 : (Number(app.frameRate) || 30);
    app.proceduralT = Math.max(0, app.proceduralT + delta / fps);
    return;
  }
  setFrame(info.frame + delta);
}

function updateScrub() {
  const info = frameInfo(app.state);
  if (!info.valid) {
    el.scrub.disabled = true;
    el.scrub.min = '0';
    el.scrub.max = '0';
    el.scrub.value = '0';
    el.frameLabel.textContent = '帧 — / —';
    el.timeLabel.textContent = '无动画';
    return;
  }
  el.scrub.disabled = false;
  el.scrub.min = '0';
  el.scrub.max = String(Math.max(0, info.frames - 1));
  el.scrub.step = '1';
  el.scrub.value = String(info.frame);
  el.frameLabel.textContent = `帧 ${info.frame} / ${info.frames - 1}`;
  const fpsText = info.mode === 'auto' ? `源 ${info.fps.toFixed(2)}fps` : `${info.fps}fps`;
  el.timeLabel.textContent = `${info.t.toFixed(3)} / ${info.duration.toFixed(3)}s · ${fpsText}`;
}

// ---------------------------------------------------------------- view

function currentTint() {
  if (app.tintMode === 'custom') return rgbaFromHex(el.tintColor.value);
  return TINT_PRESETS[app.tintMode] || null;
}

function buildView() {
  return {
    stateId: app.state,
    animId: mappedAnimId(app.state),
    time: app.times[app.state] || 0,
    playing: app.playing,
    facingDeg: app.facing,
    worldH: app.worldH,
    fitPct: app.fitPct,
    fitByMax: app.fitByMax,
    zoom: app.zoom,
    azimuth: app.azimuth,
    elevation: app.elevation,
    tint: currentTint(),
    tintStrength: app.tintStrength,
    feetDark: app.feetDark,
    shadow: app.shadow,
    grid: app.grid,
    skeleton: app.skeleton,
    skeletonMode: app.skeletonMode,
    skeletonBones: app.skeletonBones,
    skeletonBadBones: app.skeletonBadBones || [],
    placement: app.placement,
    selected: !!app.selected,
    // 参考点高亮：传模型空间的参考点，renderer 用本帧 world 变换成场景坐标画黑白小球
    refLocal: app.refMarker ? currentRefLocal() : null,
    white: app.white,
    clampTrackEnd: app.clampTrackEnd,
    animT: app.proceduralT,
    dt: app.dt,
    prevTime: app.prevTimes[app.state] || 0,
    particles: app.particles,
    particleWeapon: app.particleWeapon,
  };
}

// ---------------------------------------------------------------- stats / checks

function updateStats() {
  if (!app.asset) {
    el.stats.innerHTML = '<div class="k">—</div><div class="v">—</div>';
    el.checkBadge.textContent = '—';
    el.checkBadge.className = 'badge';
    el.warnList.innerHTML = '';
    updateTransformPanel({ blur: true });
    return;
  }
  const a = app.asset;
  const rows = [
    ['顶点', fmt(a.stats.vertices)],
    ['三角形', fmt(a.stats.triangles)],
    ['网格 / 部件', `${a.stats.meshes} / ${a.stats.parts}`],
    ['节点 / 骨骼', `${a.stats.nodes} / ${a.stats.joints}`],
    ['单部件最多骨骼', `${a.stats.maxPartBones}`],
    ['动画', `${a.stats.animations}`],
    ['材质 / 贴图', `${a.stats.materials} / ${a.stats.textures}`],
    ['绑定矩阵误差', a.checks.bindMaxError.toFixed(6)],
  ];
  el.stats.innerHTML = rows.map(([k, v], i) => {
    let cls = 'v';
    if (i === rows.length - 1) cls += a.checks.bindMaxError > 1e-2 ? ' bad' : ' ok';
    return `<div class="k">${k}</div><div class="${cls}">${v}</div>`;
  }).join('');

  const hasErr = a.errors.length > 0;
  const hasWarn = a.warnings.length > 0 || a.checks.shortTrackTotal > 0 || a.checks.bindMaxError > 1e-2;
  el.checkBadge.textContent = hasErr ? `错误 ${a.errors.length}` : (hasWarn ? '警告' : '通过');
  el.checkBadge.className = 'badge ' + (hasErr ? 'bad' : (hasWarn ? 'warn' : 'ok'));

  const items = [];
  for (const e of a.errors) items.push({ level: 'error', text: e });
  for (const w of a.warnings) items.push({ level: 'warn', text: w });
  if (a.checks.bindMaxError > 1e-2) {
    items.push({ level: 'error', text: `绑定矩阵误差 ${a.checks.bindMaxError.toFixed(4)}：bones[] 可能写成了 inv(C)` });
  }
  if (a.checks.shortTrackTotal) {
    items.push({ level: 'warn', text: `${a.checks.shortTrackTotal} 条轨道尾帧早于动画时长（严格模式会外插）` });
  }
  el.warnList.innerHTML = '';
  for (const it of items.slice(0, 80)) {
    const d = document.createElement('div');
    d.className = 'warn-item' + (it.level === 'error' ? ' error' : '');
    d.textContent = it.text;
    el.warnList.appendChild(d);
  }
  updateTransformPanel({ blur: true });
}

/**
 * 摆放面板的参考点（相对定位基准）：
 *   center     包围盒中心（bbox 推导）
 *   feetCenter 脚底中心 = 包围盒最下方一层的中心（bbox 推导）
 *   custom     自定义：与模型几何**脱绑**，局部坐标由用户设定（默认沿用切换前的点），
 *              之后只随模型整体移动/旋转/缩放，不再跟着动画包围盒漂移。
 * `local` 是模型空间坐标；`get()` 返回场景绝对坐标。
 */
const TRANSFORM_REFS = {
  center: { label: '包围盒中心', local: (m) => m.localCenter || [0, 0, 0], get: (m) => m.center },
  feetCenter: { label: '脚底中心', local: (m) => m.localFeetCenter || [0, 0, 0], get: (m) => m.feetCenter || m.center },
  custom: { label: '自定义', local: () => app.transformCustomLocal || [0, 0, 0], get: (m) => customRefPoint(m) },
};

/** 自定义参考点（模型空间局部坐标 → 场景绝对坐标）。 */
function customRefPoint(m = renderer && renderer.lastModel) {
  if (!m || !renderer || !renderer.lastWorld) return null;
  const local = app.transformCustomLocal || [0, 0, 0];
  const out = [0, 0, 0];
  mat4TransformPoint(out, renderer.lastWorld, local[0], local[1], local[2]);
  return out;
}

function transformRefKey() {
  return TRANSFORM_REFS[app.transformRef] ? app.transformRef : 'center';
}

/** 当前参考点的场景绝对坐标（模型姿势变化时自动重算）。 */
function transformRefPoint(m = renderer && renderer.lastModel) {
  if (!m) return null;
  return TRANSFORM_REFS[transformRefKey()].get(m);
}

/** 当前参考点在模型空间的局部坐标（参考点高亮小球用；custom 未设定时返回 null）。 */
function currentRefLocal(m = renderer && renderer.lastModel) {
  if (!m) return null;
  if (transformRefKey() === 'custom') {
    return app.transformCustomLocal ? [...app.transformCustomLocal] : null;
  }
  return [...TRANSFORM_REFS[transformRefKey()].local(m)];
}

/**
 * 摆放 / 缩放面板（属性页）。改的是**模型本身**的变换，不是相机：
 *   参考点   = 下拉选的相对定位基准（包围盒中心 / 脚底中心），显示其世界坐标（场景绝对坐标）；
 *   缩放     = 自动适配(fitScale) × 摆放缩放(placement.scale)。
 * 编辑参考点 = 平移 placement.position，让该参考点落到输入值；
 * 编辑缩放   = 等比乘 placement.scale 让「总缩放」等于输入值。
 */
function updateTransformPanel(opts = {}) {
  if (!el.transformStats) return;
  const m = renderer && renderer.lastModel;
  const fields = [el.transformCx, el.transformCy, el.transformCz, el.transformScale];
  // 结构化改动（切换参考点 / 复位 / 应用 / 换模型）时先让输入框失焦，否则旧焦点会挡住新值。
  if (opts.blur && fields.includes(document.activeElement)) document.activeElement.blur();
  const active = document.activeElement;
  const setInput = (node, value) => {
    if (!node || node === active) return; // 正在输入时不覆盖
    node.value = value;
  };
  const fmt3 = (v) => (Math.abs(v) < 5e-4 ? '0.000' : v.toFixed(3));
  if (el.transformRef && el.transformRef.value !== transformRefKey()) {
    el.transformRef.value = transformRefKey();
  }
  if (!app.asset || !m) {
    el.transformStats.innerHTML = '<div class="k">参考点</div><div class="v">—</div>'
      + '<div class="k">缩放</div><div class="v">—</div>';
    setInput(el.transformCx, '');
    setInput(el.transformCy, '');
    setInput(el.transformCz, '');
    setInput(el.transformScale, '');
    return;
  }
  const ref = transformRefPoint(m);
  setInput(el.transformCx, fmt3(ref[0]));
  setInput(el.transformCy, fmt3(ref[1]));
  setInput(el.transformCz, fmt3(ref[2]));
  setInput(el.transformScale, m.scale.toPrecision(4));
  // 自定义参考点的坐标输入就在下拉同一行；只在「自定义」时出现。
  const isCustom = transformRefKey() === 'custom';
  if (el.transformCustomRow) el.transformCustomRow.hidden = !isCustom;
  if (isCustom) {
    setInput(el.transformRefX, fmt3(ref[0]));
    setInput(el.transformRefY, fmt3(ref[1]));
    setInput(el.transformRefZ, fmt3(ref[2]));
  }
  const size = m.size || [0, 0, 0];
  const customLocal = app.transformCustomLocal;
  const rows = [
    ['参考点', TRANSFORM_REFS[transformRefKey()].label],
    ...(isCustom && customLocal
      ? [['参考点局部坐标', customLocal.map(fmt3).join(', ')]]
      : []),
    ['包围盒中心', m.center.map(fmt3).join(', ')],
    ['脚底中心', (m.feetCenter || m.center).map(fmt3).join(', ')],
    ['总缩放', `×${m.scale.toPrecision(4)}`],
    ['自动适配 × 摆放', `×${m.fitScale.toPrecision(4)} · ×${m.placementScale.toPrecision(4)}`],
    ['尺寸（场景单位）', size.map((v) => v.toFixed(2)).join(' × ')],
    ['摆放偏移 position', app.placement.position.map(fmt3).join(', ')],
  ];
  el.transformStats.innerHTML = rows
    .map(([k, v]) => `<div class="k">${k}</div><div class="v mono">${v}</div>`)
    .join('');
  if (el.transformBadge) {
    const d = PLACEMENT_DEFAULTS;
    const moved = app.placement.position.some((v, i) => Math.abs(v - d.position[i]) > 1e-6)
      || app.placement.scale.some((v, i) => Math.abs(v - d.scale[i]) > 1e-6)
      || app.placement.rotation.some((v, i) => Math.abs(v - d.rotation[i]) > 1e-6)
      || !!app.placement.matrix;
    el.transformBadge.textContent = moved ? '已改模型' : (isCustom ? '自定义参考点' : 'G3DArmy 默认');
    el.transformBadge.className = 'badge ' + (moved ? 'warn' : '');
  }
}

/**
 * 把参考点平移到给定场景绝对坐标（改模型，不是镜头）：
 * 参考点与模型刚性绑定（局部偏移固定），所以平移 placement.position 即可让参考点跟随输入值。
 */
function translateRefTo(want) {
  const m = renderer && renderer.lastModel;
  const curRef = transformRefPoint(m);
  if (!app.asset || !m || !curRef) return false;
  if (want.some((v) => !Number.isFinite(v))) return false;
  if (want.every((v, i) => Math.abs(v - curRef[i]) < 5e-4)) return false;
  const cur = clonePlacement(app.placement);
  const delta = want.map((v, i) => v - curRef[i]);
  setModelPlacement({
    ...cur,
    position: cur.position.map((v, i) => v + delta[i]),
    matrix: null,
  });
  return { delta, want };
}

/** 把当前参考点平移到输入的场景绝对坐标（改模型，不是镜头）。 */
function applyTransformRef() {
  const want = [el.transformCx, el.transformCy, el.transformCz].map((n) => Number(n?.value));
  const moved = translateRefTo(want);
  if (!moved) return;
  log('info', `${TRANSFORM_REFS[transformRefKey()].label} → [${moved.want.map((v) => v.toFixed(3)).join(', ')}]`
    + `（平移 ${moved.delta.map((v) => (v >= 0 ? '+' : '') + v.toFixed(3)).join(', ')}，改的是模型本身）`);
  updateTransformPanel({ blur: true });
}

/** 下拉里「自定义」那一行：把输入的场景坐标设为参考点并移动模型。 */
function applyCustomRefPoint() {
  const want = [el.transformRefX, el.transformRefY, el.transformRefZ].map((n) => Number(n?.value));
  if (want.some((v) => !Number.isFinite(v))) {
    log('warn', '自定义参考点需要完整的 x / y / z 场景坐标');
    return;
  }
  if (transformRefKey() !== 'custom') setTransformRef('custom');
  const moved = translateRefTo(want);
  if (moved) {
    log('info', `自定义参考点 → [${want.map((v) => v.toFixed(3)).join(', ')}]`
      + `（平移 ${moved.delta.map((v) => (v >= 0 ? '+' : '') + v.toFixed(3)).join(', ')}，改的是模型本身）`);
  }
  updateTransformPanel({ blur: true });
}

/**
 * 切换参考点预设。center / feetCenter 只换基准（不改模型）；
 * custom 与模型几何脱绑：立刻把当前参考点的**局部坐标**冻结下来当自定义点（模型不动），
 * 之后这个点只随模型整体移动/旋转/缩放，不再跟随动画包围盒漂移。
 */
function setTransformRef(key) {
  const m = renderer && renderer.lastModel;
  const next = TRANSFORM_REFS[key] ? key : 'center';
  if (next !== transformRefKey()) beginEdit('切换参考点');
  if (next === 'custom' && m && !app.transformCustomLocal) {
    const from = TRANSFORM_REFS[transformRefKey()].local(m);
    app.transformCustomLocal = [from[0], from[1], from[2]];
  }
  app.transformRef = next;
  if (el.transformRef) el.transformRef.value = next;
  updateTransformPanel({ blur: true });
  const p = transformRefPoint(m);
  if (p) {
    const localNote = next === 'custom' && app.transformCustomLocal
      ? `局部 [${app.transformCustomLocal.map((v) => v.toFixed(3)).join(', ')}] → `
      : '';
    log('info', `摆放参考点 = ${TRANSFORM_REFS[next].label}（${localNote}场景绝对坐标 [${p.map((v) => v.toFixed(3)).join(', ')}]）`);
  }
}

/** 直接设定自定义参考点的局部坐标（API 用；会移动模型让该点落在原场景位置之外）。 */
function setCustomRefLocal(local) {
  const v = cloneVec3(local, [0, 0, 0]);
  beginEdit('自定义参考点');
  app.transformCustomLocal = v;
  app.transformRef = 'custom';
  if (el.transformRef) el.transformRef.value = 'custom';
  updateTransformPanel({ blur: true });
  return getModelMetrics();
}

/** 把「总缩放」改成输入值（等比乘 placement.scale，改的是模型本身）。 */
function applyTransformScale() {
  const m = renderer && renderer.lastModel;
  const want = Number(el.transformScale?.value);
  if (!app.asset || !m || !(want > 0) || !(m.scale > 0)) return;
  const k = want / m.scale;
  // 面板显示只有 4 位有效数字：差在显示精度内就当作没改，避免 focus/blur 抖动。
  if (Math.abs(k - 1) < 1e-3) return;
  scaleModel(k);
  log('info', `模型缩放 ×${want.toPrecision(4)}（自动适配 ×${m.fitScale.toPrecision(4)} × 摆放 ×${(m.placementScale * k).toPrecision(4)}；围绕脚底缩放）`);
  updateTransformPanel({ blur: true });
}

/** 参考点 / 缩放的 API 版（供 AI 脚本读取，和面板同口径）。 */
function getModelMetrics() {
  const m = renderer && renderer.lastModel;
  if (!m) return null;
  const refKey = transformRefKey();
  return {
    schema: 'g3d-web-model-metrics/1',
    ref: refKey,
    refPoint: r3v(TRANSFORM_REFS[refKey].get(m)),
    refLocal: refKey === 'custom'
      ? (app.transformCustomLocal ? r3v(app.transformCustomLocal) : null)
      : r3v(TRANSFORM_REFS[refKey].local(m)),
    center: r3v(m.center),
    feetCenter: r3v(m.feetCenter || m.center),
    feet: r3v(m.feet),
    scale: r3(m.scale),
    fitScale: r3(m.fitScale),
    placementScale: r3(m.placementScale),
    size: m.size ? r3v(m.size) : null,
    placement: clonePlacement(app.placement),
    marker: !!app.refMarker,
    units: 'scene (worldH=视口世界高度)',
  };
}

function report() {
  if (!app.asset) {
    log('warn', '尚未加载模型');
    return;
  }
  const a = app.asset;
  separator(`管线自检：${a.fileName}`);
  log('info', `路径: ${a.path}`);
  log('info', `统计: 顶点 ${fmt(a.stats.vertices)} · 三角 ${fmt(a.stats.triangles)} · 网格 ${a.stats.meshes} · 节点部件 ${a.stats.parts} · 节点 ${a.stats.nodes} · 蒙皮骨骼 ${a.stats.joints} · 单部件最多 ${a.stats.maxPartBones} 骨`);
  log('info', `包围盒: ${a.bounds ? a.bounds.min.map((v) => v.toFixed(3)).join(', ') + ' → ' + a.bounds.max.map((v) => v.toFixed(3)).join(', ') : '无'}`);
  log('info', `阴影锚点(脚底 12% 带): ${a.bounds ? a.bounds.anchor.map((v) => v.toFixed(3)).join(', ') : '无'}`);
  if (a.checks.bindMaxError > 1e-4) {
    log(a.checks.bindMaxError > 1e-2 ? 'error' : 'warn',
      `绑定矩阵: 最大误差 ${a.checks.bindMaxError.toFixed(8)}` +
      (a.checks.bindWorst ? ` · 最差 ${a.checks.bindWorst.node}/${a.checks.bindWorst.meshPartId}` : '') +
      '（>0.01 通常意味着 bones[] 写成了 inv(C)）');
  } else {
    log('ok', '绑定矩阵: bones[] 与节点树绑定世界矩阵一致');
  }
  log('info', `四态映射: ${STATE_KEYS.map((k) => `${STATE_LABELS[k]}=${mappedAnimId(k) || '程序化'}`).join(' · ')}`);
  for (const anim of a.animations) {
    log(anim.shortTracks ? 'warn' : 'info',
      `动画 ${anim.id}: 时长 ${anim.duration.toFixed(3)}s · 轨道 ${anim.tracks.length}` +
      (anim.shortTracks ? ` · ⚠ ${anim.shortTracks} 条轨道尾帧 ${anim.shortRange[0].toFixed(3)}..${anim.shortRange[1].toFixed(3)}s` : ''));
  }
  if (a.errors.length) {
    log('error', `硬错误 ${a.errors.length}:`);
    for (const e of a.errors) log('error', '  · ' + e);
  }
  if (a.warnings.length) {
    log('warn', `警告 ${a.warnings.length}:`);
    for (const w of a.warnings) log('warn', '  · ' + w);
  }
  if (!a.errors.length && !a.warnings.length) log('ok', '没有发现结构性问题');
  log('info', `渲染: 状态=${app.state} · 动画=${mappedAnimId(app.state) || '程序化动作'} · 尾帧钳制=${app.clampTrackEnd ? '开' : '关(严格 libGDX)'}`);
}

// ---------------------------------------------------------------- AI 诊断（无视觉通道）

const DIAG_SCHEMA = 'g3d-web.diagnose/1';
const GRID_CHARS = '123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

function r3(v) { return Math.round((Number(v) || 0) * 1000) / 1000; }
function r3v(v) { return [r3(v[0]), r3(v[1]), r3(v[2])]; }

/** p' = M * p（列主序 4x4，只取平移部分）。 */
function mat4Point(m, p) {
  return [
    m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12],
    m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13],
    m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14],
  ];
}

function aabbFromPositions(pos) {
  let x0 = Infinity, y0 = Infinity, z0 = Infinity;
  let x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  let nan = false;
  for (let i = 0; i + 2 < pos.length; i += 3) {
    const x = pos[i], y = pos[i + 1], z = pos[i + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nan = true; continue; }
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
    if (z < z0) z0 = z; if (z > z1) z1 = z;
  }
  if (nan || x0 > x1) return { nan, min: [0, 0, 0], max: [0, 0, 0], size: [0, 0, 0], center: [0, 0, 0] };
  return {
    nan: false,
    min: [r3(x0), r3(y0), r3(z0)],
    max: [r3(x1), r3(y1), r3(z1)],
    size: [r3(x1 - x0), r3(y1 - y0), r3(z1 - z0)],
    center: [r3((x0 + x1) * 0.5), r3((y0 + y1) * 0.5), r3((z0 + z1) * 0.5)],
  };
}

/** 三角形边长相对绑定姿态的拉伸/压缩统计——直接检测“模型扭曲/爆炸”。 */
function computeEdgeDistortion(part, cur, bind, maxTriangles = 4000) {
  const idx = part.prim.indices;
  const triCount = Math.floor(idx.length / 3);
  const step = Math.max(1, Math.ceil(triCount / maxTriangles));
  const deforms = part._deformScratch || (part._deformScratch = []);
  deforms.length = 0;
  let bad = 0, sampled = 0, collapsed = 0;
  let maxDeform = 1, maxStretch = 1, minSquash = 1;
  let maxDisp = 0, maxDispVertex = -1;
  let nonFinite = false;

  // 绑定姿态整体尺度是静态数据，缓存一次；避免每帧重新扫描全部绑定顶点。
  let bindStats = part._bindStats;
  if (!bindStats) {
    let bMinX = Infinity, bMinY = Infinity, bMinZ = Infinity;
    let bMaxX = -Infinity, bMaxY = -Infinity, bMaxZ = -Infinity;
    let bNonFinite = false;
    for (let v = 0; v + 2 < bind.length; v += 3) {
      const x = bind[v], y = bind[v + 1], z = bind[v + 2];
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { bNonFinite = true; continue; }
      if (x < bMinX) bMinX = x; if (x > bMaxX) bMaxX = x;
      if (y < bMinY) bMinY = y; if (y > bMaxY) bMaxY = y;
      if (z < bMinZ) bMinZ = z; if (z > bMaxZ) bMaxZ = z;
    }
    const bindScale = Math.max(bMaxX - bMinX, bMaxY - bMinY, bMaxZ - bMinZ, 0);
    bindStats = { minEdge: Math.max(1e-3, bindScale * 0.002), nonFinite: bNonFinite };
    part._bindStats = bindStats;
  }
  const minEdge = bindStats.minEdge;
  if (bindStats.nonFinite) nonFinite = true;

  for (let v = 0; v + 2 < cur.length; v += 3) {
    const x = cur[v], y = cur[v + 1], z = cur[v + 2];
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) { nonFinite = true; continue; }
    const bx = bind[v], by = bind[v + 1], bz = bind[v + 2];
    if (!Number.isFinite(bx) || !Number.isFinite(by) || !Number.isFinite(bz)) continue;
    const d = Math.hypot(x - bx, y - by, z - bz);
    if (d > maxDisp) { maxDisp = d; maxDispVertex = v / 3; }
  }

  // 每个顶点的 dominant bone（权重最大者），用于指出“哪根骨骼在撕模型”
  const dominant = new Int16Array(Math.max(0, Math.floor(cur.length / 3))).fill(-1);
  if (part.bones.length) {
    const wOffs = part.mesh.offsets.weights;
    const src = part.mesh.vertices;
    const stride = part.mesh.stride;
    for (let vi = 0; vi < dominant.length; vi++) {
      let best = -1, bestW = 0;
      const base = vi * stride;
      for (let wi = 0; wi < wOffs.length; wi++) {
        const off = wOffs[wi];
        const bi = Math.round(src[base + off]);
        const w = src[base + off + 1];
        if (w > bestW && bi >= 0 && bi < part.bones.length) { bestW = w; best = bi; }
      }
      dominant[vi] = best;
    }
  }
  const badBones = new Map();
  const addBone = (vi) => {
    const bi = vi >= 0 && vi < dominant.length ? dominant[vi] : -1;
    if (bi >= 0) badBones.set(bi, (badBones.get(bi) || 0) + 1);
  };

  const edges = [[0, 1], [1, 2], [2, 0]];
  for (let tri = 0; tri < triCount; tri += step) {
    const ia = idx[tri * 3], ib = idx[tri * 3 + 1], ic = idx[tri * 3 + 2];
    let triMax = 1;
    for (const [e0, e1] of edges) {
      const i0 = e0 === 0 ? ia : (e0 === 1 ? ib : ic);
      const i1 = e1 === 0 ? ia : (e1 === 1 ? ib : ic);
      const b0x = bind[i0 * 3], b0y = bind[i0 * 3 + 1], b0z = bind[i0 * 3 + 2];
      const b1x = bind[i1 * 3], b1y = bind[i1 * 3 + 1], b1z = bind[i1 * 3 + 2];
      if (![b0x, b0y, b0z, b1x, b1y, b1z].every(Number.isFinite)) { nonFinite = true; continue; }
      const bd = Math.hypot(b1x - b0x, b1y - b0y, b1z - b0z);
      if (bd < minEdge) continue;
      const c0x = cur[i0 * 3], c0y = cur[i0 * 3 + 1], c0z = cur[i0 * 3 + 2];
      const c1x = cur[i1 * 3], c1y = cur[i1 * 3 + 1], c1z = cur[i1 * 3 + 2];
      if (![c0x, c0y, c0z, c1x, c1y, c1z].every(Number.isFinite)) { nonFinite = true; continue; }
      const cd = Math.hypot(c1x - c0x, c1y - c0y, c1z - c0z);
      const ratio = cd / bd;
      if (!Number.isFinite(ratio) || ratio > 1e6) { nonFinite = true; continue; }
      // 完全压扁（cd=0）在收帆等场景可能是设计行为：记为极端 squash，但不要把 Infinity 写进 JSON
      if (ratio <= 1e-6) collapsed++;
      const deform = ratio > 1 ? ratio : (ratio > 1e-6 ? 1 / ratio : 1e6);
      if (ratio > maxStretch) maxStretch = ratio;
      if (ratio < minSquash) minSquash = ratio;
      if (deform > triMax) triMax = deform;
      if (deform > maxDeform) maxDeform = deform;
    }
    deforms.push(triMax);
    sampled++;
    if (triMax > 2.5) {
      bad++;
      addBone(ia); addBone(ib); addBone(ic);
    }
  }

  deforms.sort((a, b) => a - b);
  const p99 = deforms.length ? deforms[Math.min(deforms.length - 1, Math.floor(deforms.length * 0.99))] : 1;
  const badBonesTop = [...badBones.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([index, count]) => ({
      index,
      id: part.bones[index] ? part.bones[index].id : null,
      node: part.bones[index] && part.bones[index].node ? part.bones[index].node.id : null,
      count,
    }));
  // 全量顶点的 dominant bone 使用率：说明这个部件主要由哪些骨骼驱动
  const usage = new Map();
  for (let vi = 0; vi < dominant.length; vi++) {
    const bi = dominant[vi];
    if (bi >= 0) usage.set(bi, (usage.get(bi) || 0) + 1);
  }
  const boneUsage = [...usage.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([index, count]) => ({
      index,
      id: part.bones[index] ? part.bones[index].id : null,
      node: part.bones[index] && part.bones[index].node ? part.bones[index].node.id : null,
      count,
      pct: r3((count / Math.max(1, dominant.length)) * 100),
    }));
  const usedBones = [...usage.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([index]) => (part.bones[index] ? part.bones[index].id : null))
    .filter(Boolean);
  let maxDispBone = null;
  if (maxDispVertex >= 0) {
    const bi = dominant[maxDispVertex];
    if (bi >= 0) {
      const bone = part.bones[bi];
      let weight = 0;
      const wOffs = part.mesh.offsets.weights;
      const src = part.mesh.vertices;
      const base = maxDispVertex * part.mesh.stride;
      for (let wi = 0; wi < wOffs.length; wi++) {
        const off = wOffs[wi];
        if (Math.round(src[base + off]) === bi) weight += src[base + off + 1];
      }
      maxDispBone = {
        index: bi,
        id: bone ? bone.id : null,
        node: bone && bone.node ? bone.node.id : null,
        weight: r3(weight),
        disp: r3(maxDisp),
      };
    }
  }
  return {
    nan: nonFinite,
    nonFinite,
    sampled,
    bad,
    collapsed,
    badPct: sampled ? (bad / sampled) * 100 : 0,
    maxDeform,
    p99Deform: p99,
    maxStretch,
    minSquash,
    maxVertexDisp: maxDisp,
    badBones: badBonesTop,
    boneUsage,
    usedBones,
    maxDispBone,
  };
}

function makeProjector() {
  if (!renderer) return null;
  const cssW = renderer.lastCanvas.cssW || 1;
  const cssH = renderer.lastCanvas.cssH || 1;
  const mvp = mat4Multiply(mat4Identity(), renderer.lastProjView, renderer.lastWorld);
  return (x, y, z) => {
    const cx = mvp[0] * x + mvp[4] * y + mvp[8] * z + mvp[12];
    const cy = mvp[1] * x + mvp[5] * y + mvp[9] * z + mvp[13];
    const cz = mvp[2] * x + mvp[6] * y + mvp[10] * z + mvp[14];
    const cw = mvp[3] * x + mvp[7] * y + mvp[11] * z + mvp[15];
    if (!Number.isFinite(cx) || !Number.isFinite(cy) || !Number.isFinite(cz) || Math.abs(cw) < 1e-9) return null;
    const nx = cx / cw, ny = cy / cw, nz = cz / cw;
    return { x: (nx * 0.5 + 0.5) * cssW, y: (1 - (ny * 0.5 + 0.5)) * cssH, z: nz, cssW, cssH };
  };
}

function rasterizePart(part, screen, cssW, cssH, cols, rows, grid, depth, ch) {
  const idx = part.prim.indices;
  if (!idx || part.prim.type !== 'TRIANGLES') return;
  for (let t = 0; t + 2 < idx.length; t += 3) {
    const ia = idx[t], ib = idx[t + 1], ic = idx[t + 2];
    const ax = screen[ia * 3], ay = screen[ia * 3 + 1], az = screen[ia * 3 + 2];
    const bx = screen[ib * 3], by = screen[ib * 3 + 1], bz = screen[ib * 3 + 2];
    const cx = screen[ic * 3], cy = screen[ic * 3 + 1], cz = screen[ic * 3 + 2];
    if (![ax, ay, az, bx, by, bz, cx, cy, cz].every(Number.isFinite)) continue;
    const minX = Math.min(ax, bx, cx), maxX = Math.max(ax, bx, cx);
    const minY = Math.min(ay, by, cy), maxY = Math.max(ay, by, cy);
    if (maxX < 0 || minX > cssW || maxY < 0 || minY > cssH) continue;
    const x0 = Math.max(0, Math.floor(minX / cssW * cols));
    const x1 = Math.min(cols - 1, Math.ceil(maxX / cssW * cols));
    const y0 = Math.max(0, Math.floor(minY / cssH * rows));
    const y1 = Math.min(rows - 1, Math.ceil(maxY / cssH * rows));
    const den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy);
    if (Math.abs(den) < 1e-9) continue;
    for (let gy = y0; gy <= y1; gy++) {
      const py = ((gy + 0.5) / rows) * cssH;
      for (let gx = x0; gx <= x1; gx++) {
        const px = ((gx + 0.5) / cols) * cssW;
        const u = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den;
        const v = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den;
        const w = 1 - u - v;
        if (u < -1e-4 || v < -1e-4 || w < -1e-4) continue;
        const z = u * az + v * bz + w * cz;
        const ci = gy * cols + gx;
        if (z < depth[ci]) {
          depth[ci] = z;
          grid[ci] = ch;
        }
      }
    }
  }
}

function computeSeatMetrics(parts, bones) {
  const saddle = parts.find((p) => /saddle/i.test(`${p.materialId} ${p.meshPartId}`));
  if (!saddle) return null;
  const byId = new Map(bones.map((b) => [b.id, b]));
  let riderRoot = byId.get('root') || null;
  if (!riderRoot || !riderRoot.parent) {
    riderRoot = bones.find((b) => /^root$/i.test(b.id) && b.parent && /Spine/i.test(b.parent)) || null;
  }
  const parent = riderRoot && riderRoot.parent ? byId.get(riderRoot.parent) || null : null;
  const hips = byId.get('Unit_Base_Rig_Hips') || bones.find((b) => /Hips$/i.test(b.id)) || null;
  const saddleTop = [saddle.aabb.center[0], saddle.aabb.max[1], saddle.aabb.center[2]];
  const horizontal = hips
    ? Math.hypot(hips.pos[0] - saddle.aabb.center[0], hips.pos[2] - saddle.aabb.center[2])
    : null;
  const offset = riderRoot && parent
    ? [r3(riderRoot.pos[0] - parent.pos[0]), r3(riderRoot.pos[1] - parent.pos[1]), r3(riderRoot.pos[2] - parent.pos[2])]
    : null;
  return {
    saddlePart: saddle.key,
    saddleAABB: saddle.aabb,
    saddleTopCenter: r3v(saddleTop),
    riderRoot: riderRoot ? {
      id: riderRoot.id,
      parent: riderRoot.parent,
      pos: r3v(riderRoot.pos),
      local: r3v(riderRoot.local),
      offsetFromParent: offset,
    } : null,
    parent: parent ? { id: parent.id, pos: r3v(parent.pos) } : null,
    hips: hips ? {
      id: hips.id,
      pos: r3v(hips.pos),
      deltaFromRiderRoot: riderRoot ? r3v([hips.pos[0] - riderRoot.pos[0], hips.pos[1] - riderRoot.pos[1], hips.pos[2] - riderRoot.pos[2]]) : null,
      hipsAboveSaddleTop: r3(hips.pos[1] - saddle.aabb.max[1]),
      hipsHorizontalFromSaddleCenter: r3(horizontal),
    } : null,
  };
}

function aabbOverlapVector(a, b) {
  return [
    Math.min(a.max[0], b.max[0]) - Math.max(a.min[0], b.min[0]),
    Math.min(a.max[1], b.max[1]) - Math.max(a.min[1], b.min[1]),
    Math.min(a.max[2], b.max[2]) - Math.max(a.min[2], b.min[2]),
  ];
}

function aabbGapVector(a, b) {
  return [
    Math.max(0, a.min[0] - b.max[0], b.min[0] - a.max[0]),
    Math.max(0, a.min[1] - b.max[1], b.min[1] - a.max[1]),
    Math.max(0, a.min[2] - b.max[2], b.min[2] - a.max[2]),
  ];
}

function boneGroup(id) {
  const s = String(id || '');
  const i = s.indexOf('.');
  return i > 0 ? s.slice(0, i) : s;
}

/**
 * 两个部件的相对位置与 AABB 近似穿模关系。
 * AABB 相交不等于精确三角形碰撞；expected=true 表示挂点/同骨导致的重叠（例如手持武器）。
 */
function partRelation(a, b) {
  const overlap = aabbOverlapVector(a.aabb, b.aabb);
  const gap = aabbGapVector(a.aabb, b.aabb);
  const intersects = overlap.every((v) => v > 0);
  const centerDelta = [
    b.aabb.center[0] - a.aabb.center[0],
    b.aabb.center[1] - a.aabb.center[1],
    b.aabb.center[2] - a.aabb.center[2],
  ];
  const centerDistance = Math.hypot(...centerDelta);
  const gapDistance = Math.hypot(...gap);
  const minSize = Math.max(1e-9, Math.min(...a.aabb.size, ...b.aabb.size));
  const penetration = intersects ? Math.min(...overlap) : 0;
  const overlapRatio = intersects ? penetration / minSize : 0;
  const volA = Math.max(1e-9, a.aabb.size[0] * a.aabb.size[1] * a.aabb.size[2]);
  const volB = Math.max(1e-9, b.aabb.size[0] * b.aabb.size[1] * b.aabb.size[2]);
  const overlapVolume = intersects ? overlap[0] * overlap[1] * overlap[2] : 0;
  const volumeRatio = intersects ? overlapVolume / Math.min(volA, volB) : 0;
  const sharedSocket = !!(a.socket && b.socket && a.socket === b.socket);
  const bodyBones = new Set([...(a.boneIds || []), ...(a.usedBones || [])]);
  const otherBones = new Set([...(b.boneIds || []), ...(b.usedBones || [])]);
  const socketOnBody = !!(
    (a.socket && otherBones.has(a.socket))
    || (b.socket && bodyBones.has(b.socket))
  );
  // 同一骨架族（如 polySurface1Shape.*）通常属于骑手/同一单位；
  // 仅凭骨骼集合判断会把“武器挂到 Weapon_Aim_Forward”误判成穿模。
  const bodyGroups = new Set([...bodyBones].map(boneGroup));
  const otherGroups = new Set([...otherBones].map(boneGroup));
  const socketGroup = a.socket ? boneGroup(a.socket) : (b.socket ? boneGroup(b.socket) : null);
  const sameSkeletonGroup = !!(
    socketGroup
    && (bodyGroups.has(socketGroup) || otherGroups.has(socketGroup))
  );
  const expected = sharedSocket || socketOnBody || sameSkeletonGroup;
  const pairKind = !a.accessory && !b.accessory
    ? 'body-body'
    : (a.accessory && b.accessory ? 'accessory-accessory' : 'accessory-body');
  const sa = a.screenBBox;
  const sb = b.screenBBox;
  let screenOverlap = null;
  if (sa && sb) {
    const ix = Math.max(0, Math.min(sa[2], sb[2]) - Math.max(sa[0], sb[0]));
    const iy = Math.max(0, Math.min(sa[3], sb[3]) - Math.max(sa[1], sb[1]));
    const areaA = Math.max(1e-9, (sa[2] - sa[0]) * (sa[3] - sa[1]));
    const areaB = Math.max(1e-9, (sb[2] - sb[0]) * (sb[3] - sb[1]));
    screenOverlap = {
      overlapArea: r3(ix * iy),
      ratio: r3((ix * iy) / Math.max(1e-9, Math.min(areaA, areaB))),
    };
  }
  // 屏幕上也看不到重叠时，AABB 重叠很可能只是“骑手在马体上方”这类空间包围盒相交。
  const visibleScreenOverlap = !screenOverlap || screenOverlap.ratio >= 0.08;
  const suspectedClip = intersects
    && !expected
    && pairKind !== 'body-body'
    && overlapRatio >= 0.2
    && visibleScreenOverlap;
  return {
    a: { char: a.char, label: a.label, type: a.type, isBody: !!a.isBody, accessory: !!a.accessory, socket: a.socket || null },
    b: { char: b.char, label: b.label, type: b.type, isBody: !!b.isBody, accessory: !!b.accessory, socket: b.socket || null },
    pairKind,
    method: 'aabb',
    centerDelta: r3v(centerDelta),
    centerDistance: r3(centerDistance),
    gap: r3v(gap),
    gapDistance: r3(gapDistance),
    aabbOverlap: intersects,
    overlap: r3v(overlap),
    penetration: r3(penetration),
    overlapRatio: r3(overlapRatio),
    overlapVolume: r3(overlapVolume),
    volumeRatio: r3(volumeRatio),
    screenOverlap,
    expected,
    expectedReason: sharedSocket
      ? 'same-socket'
      : (socketOnBody ? 'socket-on-other-part' : (sameSkeletonGroup ? 'same-skeleton-group' : null)),
    suspectedClip,
    relation: intersects
      ? (suspectedClip ? 'possible-clip' : (expected ? 'expected-overlap' : 'aabb-overlap'))
      : (gapDistance <= 0.02 ? 'touching' : 'separate'),
  };
}


function analyzePose(asset, options = {}) {
  const cols = Math.max(16, Math.min(96, options.grid && options.grid.cols || 56));
  const rows = Math.max(12, Math.min(64, options.grid && options.grid.rows || 30));
  const grid = new Array(cols * rows).fill(' ');
  const depth = new Float32Array(cols * rows).fill(Infinity);
  const proj = makeProjector();
  const cssW = renderer ? Math.max(1, renderer.lastCanvas.cssW) : 1;
  const cssH = renderer ? Math.max(1, renderer.lastCanvas.cssH) : 1;
  const legend = {};
  const parts = [];
  const warnings = [];
  const boneToParts = new Map();
  let nan = false;
  let poseMin = [Infinity, Infinity, Infinity];
  let poseMax = [-Infinity, -Infinity, -Infinity];
  let screenMin = [Infinity, Infinity];
  let screenMax = [-Infinity, -Infinity];
  let badTotal = 0, sampledTotal = 0, collapsedTotal = 0;
  let maxDeform = 1, p99Max = 1, maxStretch = 1, minSquash = 1;
  let worstPart = null;
  let nonFinite = false;

  for (let pi = 0; pi < asset.parts.length; pi++) {
    const part = asset.parts[pi];
    const ch = GRID_CHARS[pi] || '?';
    const cur = computePartPositions(part);
    const bind = computePartBindPositions(part);
    const count = part.mesh.vertexCount;
    const aabb = aabbFromPositions(cur);
    const bindAabb = aabbFromPositions(bind);
    if (aabb.nan) { nan = true; nonFinite = true; }
    for (let i = 0; i < 3; i++) {
      if (aabb.min[i] < poseMin[i]) poseMin[i] = aabb.min[i];
      if (aabb.max[i] > poseMax[i]) poseMax[i] = aabb.max[i];
    }

    const screen = new Float32Array(count * 3);
    let sMinX = Infinity, sMinY = Infinity, sMaxX = -Infinity, sMaxY = -Infinity;
    for (let vi = 0; vi < count; vi++) {
      const p = proj ? proj(cur[vi * 3], cur[vi * 3 + 1], cur[vi * 3 + 2]) : null;
      if (!p) {
        screen[vi * 3] = NaN;
        screen[vi * 3 + 1] = NaN;
        screen[vi * 3 + 2] = NaN;
        continue;
      }
      screen[vi * 3] = p.x;
      screen[vi * 3 + 1] = p.y;
      screen[vi * 3 + 2] = p.z;
      if (p.x < sMinX) sMinX = p.x;
      if (p.x > sMaxX) sMaxX = p.x;
      if (p.y < sMinY) sMinY = p.y;
      if (p.y > sMaxY) sMaxY = p.y;
    }
    if (sMinX < screenMin[0]) screenMin[0] = sMinX;
    if (sMinY < screenMin[1]) screenMin[1] = sMinY;
    if (sMaxX > screenMax[0]) screenMax[0] = sMaxX;
    if (sMaxY > screenMax[1]) screenMax[1] = sMaxY;

    const dist = computeEdgeDistortion(part, cur, bind);
    if (dist.nan) { nan = true; nonFinite = true; }
    badTotal += dist.bad;
    sampledTotal += dist.sampled;
    collapsedTotal += dist.collapsed;
    if (dist.maxDeform > maxDeform) maxDeform = dist.maxDeform;
    if (dist.p99Deform > p99Max) p99Max = dist.p99Deform;
    if (dist.maxStretch > maxStretch) maxStretch = dist.maxStretch;
    if (dist.minSquash < minSquash) minSquash = dist.minSquash;
    const partBadPct = dist.badPct;
    const partP99 = dist.p99Deform;
    let partLevel = 'ok';
    if (dist.nonFinite || partBadPct >= 5 || (partBadPct >= 1 && partP99 >= 10)) partLevel = 'error';
    else if (partBadPct >= 1 || partP99 >= 5 || dist.maxDeform >= 8) partLevel = 'warn';
    if (!worstPart || partBadPct > worstPart.badPct || (partBadPct === worstPart.badPct && dist.maxDeform > worstPart.maxDeform)) {
      worstPart = {
        char: ch, materialId: part.material.id, maxDeform: dist.maxDeform, badPct: partBadPct,
        level: partLevel, badBones: dist.badBones, maxDispBone: dist.maxDispBone,
      };
    }

    rasterizePart(part, screen, cssW, cssH, cols, rows, grid, depth, ch);
    const label = part.material.id || part.prim.id || part.node.id || `part${pi}`;
    if (!legend[ch] || legend[ch].startsWith('?')) legend[ch] = label;
    const firstBone = part.bones.length ? part.bones[0] : null;
    const partType = part.bones.length === 0 ? 'static' : (part.bones.length === 1 ? 'rigid' : 'skinned');
    const socket = partType === 'rigid' && firstBone ? firstBone.id : null;
    let skinScale = null;
    let scaleDev = 0;
    if (firstBone) {
      const skinMat = mat4Multiply(
        mat4Identity(),
        firstBone.node ? firstBone.node.bindGlobal : mat4Identity(),
        firstBone.invBind,
      );
      skinScale = [
        Math.hypot(skinMat[0], skinMat[1], skinMat[2]),
        Math.hypot(skinMat[4], skinMat[5], skinMat[6]),
        Math.hypot(skinMat[8], skinMat[9], skinMat[10]),
      ];
      scaleDev = Math.max(...skinScale.map((v) => Math.abs(v - 1)));
    }
    let deformMechanism = partType === 'skinned' ? 'skinning' : (partType === 'static' ? 'node' : 'rigid');
    if (partType === 'rigid' && scaleDev > 0.01) deformMechanism = 'boneScale';
    if (partType === 'rigid' && scaleDev <= 0.01 && partLevel !== 'ok') deformMechanism = 'rigidAnomaly';
    const socketBindPos = firstBone
      ? [r3(firstBone.bind[12]), r3(firstBone.bind[13]), r3(firstBone.bind[14])]
      : null;
    const socketCurrentPos = firstBone && firstBone.node
      ? [r3(firstBone.node.bindGlobal[12]), r3(firstBone.node.bindGlobal[13]), r3(firstBone.node.bindGlobal[14])]
      : null;
    const bindCenter = bindAabb.center;
    const bindOffsetWorld = socketBindPos ? r3v([
      bindCenter[0] - socketBindPos[0],
      bindCenter[1] - socketBindPos[1],
      bindCenter[2] - socketBindPos[2],
    ]) : null;
    const bindOffsetLocal = firstBone ? r3v(mat4Point(firstBone.invBind, bindCenter)) : null;
    const currentOffsetWorld = socketCurrentPos ? r3v([
      aabb.center[0] - socketCurrentPos[0],
      aabb.center[1] - socketCurrentPos[1],
      aabb.center[2] - socketCurrentPos[2],
    ]) : null;
    const centerDelta = r3v([
      aabb.center[0] - bindCenter[0],
      aabb.center[1] - bindCenter[1],
      aabb.center[2] - bindCenter[2],
    ]);
    const boneIds = part.bones.map((b) => b.id).filter(Boolean);
    for (const id of dist.usedBones || []) {
      const list = boneToParts.get(id) || [];
      if (!list.includes(ch)) list.push(ch);
      boneToParts.set(id, list);
    }
    parts.push({
      char: ch,
      key: `${part.node.id}|${part.material.id}|${part.prim.id}`,
      label,
      materialId: part.material.id,
      meshPartId: part.prim.id,
      nodeId: part.node.id,
      nodeParent: part.node.parent ? part.node.parent.id : null,
      vertices: count,
      triangles: Math.floor(part.prim.indexCount / 3),
      bones: part.bones.length,
      type: partType,
      deformMechanism,
      accessory: !part.isBody || partType !== 'skinned',
      skinningScale: skinScale ? r3v(skinScale) : null,
      scaleDeviation: r3(scaleDev),
      isBody: part.isBody,
      boneIds,
      usedBones: dist.usedBones,
      firstBone: firstBone ? firstBone.id : null,
      socket,
      socketBindPos,
      socketCurrentPos,
      bindAABB: { min: bindAabb.min, max: bindAabb.max, size: bindAabb.size, center: bindAabb.center },
      bindCenter,
      bindOffsetWorld,
      bindOffsetLocal,
      currentOffsetWorld,
      centerDelta,
      aabb: { min: aabb.min, max: aabb.max, size: aabb.size, center: aabb.center },
      screenBBox: Number.isFinite(sMinX) ? [r3(sMinX), r3(sMinY), r3(sMaxX), r3(sMaxY)] : null,
      cells: 0,
      distortion: {
        level: partLevel,
        mechanism: deformMechanism,
        nan: dist.nan,
        nonFinite: dist.nonFinite,
        sampled: dist.sampled,
        bad: dist.bad,
        collapsed: dist.collapsed,
        badPct: r3(dist.badPct),
        maxDeform: r3(dist.maxDeform),
        p99Deform: r3(dist.p99Deform),
        maxStretch: r3(dist.maxStretch),
        minSquash: r3(dist.minSquash),
        maxVertexDisp: r3(dist.maxVertexDisp),
        badBones: dist.badBones,
        boneUsage: dist.boneUsage,
        usedBones: dist.usedBones,
        maxDispBone: dist.maxDispBone,
      },
    });
  }

  // 配件相对位置 / AABB 近似穿模关系（位置几何，不是蒙皮边长变形）
  const bodyParts = parts.filter((p) => !p.accessory);
  const hasAccessory = parts.some((p) => p.accessory);
  for (const p of parts) p.relativeToBody = null;
  if (bodyParts.length) {
    for (const p of parts.filter((x) => x.accessory)) {
      let best = null;
      for (const body of bodyParts) {
        const r = partRelation(p, body);
        if (!best
          || r.gapDistance < best.gapDistance
          || (r.gapDistance === best.gapDistance && r.centerDistance < best.centerDistance)) {
          best = r;
        }
      }
      if (best) {
        p.relativeToBody = {
          part: best.b.char,
          label: best.b.label,
          centerDelta: best.centerDelta,
          centerDistance: best.centerDistance,
          gap: best.gap,
          gapDistance: best.gapDistance,
          aabbOverlap: best.aabbOverlap,
          penetration: best.penetration,
          overlapRatio: best.overlapRatio,
          expected: best.expected,
          relation: best.relation,
          method: 'aabb',
        };
      }
    }
  }

  const relations = [];
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i];
      const b = parts[j];
      // 有配件时只输出配件相关对；纯 body-body 的相互重叠通常是躯干/衣服分件，噪声较大。
      if (hasAccessory && !a.accessory && !b.accessory) continue;
      relations.push(partRelation(a, b));
    }
  }
  relations.sort((a, b) => (
    (Number(b.suspectedClip) - Number(a.suspectedClip))
    || (b.overlapRatio - a.overlapRatio)
    || (a.gapDistance - b.gapDistance)
    || a.a.char.localeCompare(b.a.char)
  ));
  const relationsTotal = relations.length;
  const suspectedRelations = relations.filter((r) => r.suspectedClip);
  const relationsShown = relations.slice(0, 60);
  const clip = {
    method: 'aabb',
    scope: 'geometry',
    level: suspectedRelations.length ? 'warn' : 'ok',
    suspectedCount: suspectedRelations.length,
    relationsTotal,
    suspected: suspectedRelations.slice(0, 12),
    note: 'AABB intersection is an approximation, not exact triangle collision; expected-overlap means same socket/held attachment. Use relations[].centerDelta/gap for relative position.',
  };

  if (!Number.isFinite(poseMin[0])) poseMin = [0, 0, 0];
  if (!Number.isFinite(poseMax[0])) poseMax = [0, 0, 0];
  if (!Number.isFinite(screenMin[0])) screenMin = [0, 0];
  if (!Number.isFinite(screenMax[0])) screenMax = [0, 0];

  // ASCII part map counts
  const counts = new Map();
  for (const ch of grid) if (ch !== ' ') counts.set(ch, (counts.get(ch) || 0) + 1);
  for (const p of parts) p.cells = counts.get(p.char) || 0;
  const gridRows = [];
  for (let y = 0; y < rows; y++) gridRows.push(grid.slice(y * cols, (y + 1) * cols).join(''));
  const gridCells = counts.size ? [...counts.values()].reduce((s, v) => s + v, 0) : 0;

  // bones (pose vs bind) + 绑定/挂点关系
  const depthOf = (node) => {
    let d = 0;
    let p = node.parent;
    while (p) { d++; p = p.parent; }
    return d;
  };
  const bones = asset.nodes.map((node) => {
    const p = node.bindGlobal;
    const rest = node.bindGlobalRest || node.bindGlobal;
    const pos = [p[12], p[13], p[14]];
    const rp = [rest[12], rest[13], rest[14]];
    const sp = proj ? proj(pos[0], pos[1], pos[2]) : null;
    const usedBy = boneToParts.get(node.id) || [];
    return {
      id: node.id,
      parent: node.parent ? node.parent.id : null,
      pos: r3v(pos),
      rest: r3v(rp),
      bindWorldPos: r3v(rp),
      delta: r3v([pos[0] - rp[0], pos[1] - rp[1], pos[2] - rp[2]]),
      local: r3v([node.bindLocal[12], node.bindLocal[13], node.bindLocal[14]]),
      bindLocal: {
        t: r3v(node.t),
        q: [r3(node.q[0]), r3(node.q[1]), r3(node.q[2]), r3(node.q[3])],
        s: r3v(node.s),
      },
      children: node.children.map((c) => c.id),
      depth: depthOf(node),
      usedBy,
      screen: sp ? [r3(sp.x), r3(sp.y)] : null,
      animated: renderer ? renderer.poseAnimated.has(node) : false,
    };
  });

  // 只保留骨骼节点（排除纯网格挂载节点），再保留“被部件使用”的骨骼及其祖先
  const isMeshOnly = (n) => !!(n.nodeParts && n.nodeParts.length && !boneToParts.has(n.id));
  const boneNodes = asset.nodes.filter((n) => !isMeshOnly(n));
  const treeSet = new Set();
  const addAncestors = (n) => {
    let cur = n;
    while (cur) { treeSet.add(cur.id); cur = cur.parent; }
  };
  for (const n of boneNodes) if (boneToParts.has(n.id)) addAncestors(n);
  for (const r of asset.roots) if (!isMeshOnly(r)) treeSet.add(r.id);
  const tree = boneNodes.filter((n) => treeSet.has(n.id)).map((n) => {
    const rest = n.bindGlobalRest || n.bindGlobal;
    const used = boneToParts.get(n.id) || [];
    const pos = [r3(rest[12]), r3(rest[13]), r3(rest[14])];
    return `${'  '.repeat(depthOf(n))}${n.id} ${JSON.stringify(pos)}${used.length ? ` [${used.join(',')}]` : ''}`;
  });
  const rig = {
    roots: asset.roots.filter((r) => !isMeshOnly(r)).map((r) => r.id),
    boneCount: boneNodes.length,
    jointCount: asset.stats.joints,
    boneParts: [...boneToParts.entries()]
      .map(([bone, chars]) => ({ bone, parts: chars }))
      .sort((a, b) => a.bone.localeCompare(b.bone)),
    tree,
  };
  const seat = computeSeatMetrics(parts, bones);
  if (seat) {
    seat.kind = 'position';
    seat.note = 'seat offset is position only; not edge-length deformation';
  }

  const overallBadPct = sampledTotal ? (badTotal / sampledTotal) * 100 : 0;
  const bindSize = asset.bounds ? asset.bounds.size : null;
  const poseSize = [r3(poseMax[0] - poseMin[0]), r3(poseMax[1] - poseMin[1]), r3(poseMax[2] - poseMin[2])];
  const heightRatio = bindSize && bindSize[1] > 1e-3 ? poseSize[1] / bindSize[1] : null;
  const clipped = proj
    ? (screenMin[0] < -0.5 || screenMin[1] < -0.5 || screenMax[0] > cssW + 0.5 || screenMax[1] > cssH + 0.5)
    : null;

  let shortTailTracks = 0;
  const anim = animationOf(app.state);
  if (anim && !app.clampTrackEnd) {
    const time = app.times[app.state] || 0;
    for (const track of anim.tracks) {
      for (const comp of [track.translation, track.rotation, track.scaling]) {
        if (comp && comp.times.length && comp.times[comp.times.length - 1] < time - 1e-3) shortTailTracks++;
      }
    }
  }

  let level = 'ok';
  const reasons = [];
  if (nonFinite) {
    level = 'error';
    reasons.push('存在非有限顶点或边长（NaN/Inf）');
  }
  const severeDistortion = overallBadPct >= 2 || (overallBadPct >= 0.5 && p99Max >= 15);
  if (severeDistortion) {
    level = 'error';
    const bone = worstPart && worstPart.badBones && worstPart.badBones[0];
    reasons.push(`严重边长扭曲: badTriangles=${badTotal}/${sampledTotal} (${r3(overallBadPct)}%), maxDeform=${r3(maxDeform)}, p99=${r3(p99Max)}${bone ? `，主要骨骼 ${bone.id}×${bone.count}` : ''}`);
  } else if (overallBadPct >= 0.2 || p99Max >= 5 || (maxDeform >= 8 && badTotal >= 2)) {
    if (level !== 'error') level = 'warn';
    reasons.push(`疑似边长扭曲: badTriangles=${badTotal}/${sampledTotal} (${r3(overallBadPct)}%), maxDeform=${r3(maxDeform)}, p99=${r3(p99Max)}`);
  }
  if (minSquash <= 1e-6) {
    if (level === 'ok') level = 'warn';
    reasons.push(`存在完全压扁的边 ×${collapsedTotal}（minSquash≈0；收帆/缩放动画可能是设计行为）`);
  }
  if (clipped) {
    if (level === 'ok') level = 'warn';
    reasons.push('模型超出视口（screenBBox 越界）');
  }
  if (heightRatio != null && (heightRatio > 2.5 || heightRatio < 0.25)) {
    if (level === 'ok') level = 'warn';
    reasons.push(`pose 高度相对绑定 ${r3(heightRatio)}×`);
  }
  if (gridCells === 0) {
    level = 'error';
    reasons.push('ASCII 轮廓为空（模型完全在视口外或投影失败）');
  }
  if (shortTailTracks > 0) {
    if (level === 'ok') level = 'warn';
    reasons.push(`当前帧处于 ${shortTailTracks} 条短轨道的外插尾段（libGDX 严格模式）`);
  }
  if (worstPart && (overallBadPct >= 0.2 || maxDeform >= 6)) {
    const bone = worstPart.badBones && worstPart.badBones[0];
    warnings.push(`最差部件 ${worstPart.char}=${worstPart.materialId} badPct=${r3(worstPart.badPct)}% maxDeform=${r3(worstPart.maxDeform)}${bone ? ` topBone=${bone.id}×${bone.count}` : ''}`);
  }

  // 位置关系（挂点/坐点）与边长变形（蒙皮/缩放）分开输出，避免把 offset 当拉伸
  const binding = {
    kind: 'position',
    note: 'socket / bindOffsetLocal / bindOffsetWorld / currentOffsetWorld / centerDelta are attachment position or motion, NOT edge-length deformation',
    rigidParts: parts.filter((p) => p.type === 'rigid').map((p) => ({
      part: p.char,
      label: p.label,
      socket: p.socket,
      bindCenter: p.bindCenter,
      bindOffsetLocal: p.bindOffsetLocal,
      bindOffsetWorld: p.bindOffsetWorld,
      currentOffsetWorld: p.currentOffsetWorld,
      centerDelta: p.centerDelta,
      deformMechanism: p.deformMechanism,
    })),
  };
  const deformParts = parts.filter((p) => p.distortion.level !== 'ok');
  const hasDeformation = deformParts.length > 0 || overallBadPct >= 0.2 || p99Max >= 5 || minSquash <= 1e-6;
  const issues = [];
  if (nonFinite) {
    issues.push({ kind: 'data', severity: 'error', scope: 'non-finite', message: '存在非有限顶点/边长（NaN/Inf）' });
  }
  if (hasDeformation) {
    issues.push({
      kind: 'deformation',
      severity: level === 'error' ? 'error' : 'warn',
      scope: 'edge-length',
      badPct: r3(overallBadPct),
      p99: r3(p99Max),
      maxDeform: r3(maxDeform),
      worstPart: worstPart ? worstPart.char : null,
      message: '边长相对绑定姿态发生变化（拉伸/压缩），不是挂点/坐点偏移',
    });
  }
  for (const p of deformParts) {
    const kind = p.deformMechanism === 'boneScale'
      ? 'boneScale'
      : (p.deformMechanism === 'rigidAnomaly' ? 'rigidAnomaly' : 'deformation');
    issues.push({
      kind,
      severity: p.distortion.level,
      scope: 'edge-length',
      part: p.char,
      label: p.label,
      mechanism: p.deformMechanism,
      badPct: p.distortion.badPct,
      p99: p.distortion.p99Deform,
      maxDeform: p.distortion.maxDeform,
      badBones: (p.distortion.badBones || []).slice(0, 3),
      message: kind === 'boneScale'
        ? '挂点骨缩放导致刚性件边长变化'
        : (kind === 'rigidAnomaly' ? '刚性件出现边长变化（矩阵/权重异常）' : '蒙皮边长扭曲'),
    });
  }
  for (const r of suspectedRelations.slice(0, 8)) {
    issues.push({
      kind: 'clip',
      severity: 'warn',
      scope: 'geometry',
      method: 'aabb',
      parts: [r.a.char, r.b.char],
      labels: [r.a.label, r.b.label],
      centerDelta: r.centerDelta,
      centerDistance: r.centerDistance,
      gapDistance: r.gapDistance,
      penetration: r.penetration,
      overlapRatio: r.overlapRatio,
      expected: r.expected,
      message: 'AABB 重叠，疑似穿模（近似检测；expected-overlap=同挂点/手持件，需结合 mesh 判断）',
    });
  }
  if (seat) {
    issues.push({
      kind: 'seat',
      severity: 'info',
      scope: 'position',
      hipsAboveSaddleTop: seat.hips ? seat.hips.hipsAboveSaddleTop : null,
      hipsHorizontalFromSaddleCenter: seat.hips ? seat.hips.hipsHorizontalFromSaddleCenter : null,
      message: '坐点偏移是位置关系，不是边长变形',
    });
  }

  return {
    nan,
    css: [r3(cssW), r3(cssH)],
    bbox: {
      min: r3v(poseMin),
      max: r3v(poseMax),
      size: poseSize,
      center: r3v([(poseMin[0] + poseMax[0]) * 0.5, (poseMin[1] + poseMax[1]) * 0.5, (poseMin[2] + poseMax[2]) * 0.5]),
    },
    screenBBox: [r3(screenMin[0]), r3(screenMin[1]), r3(screenMax[0]), r3(screenMax[1])],
    clipped,
    gridCells,
    gridColumns: cols,
    gridRows: rows,
    grid: gridRows,
    legend,
    parts,
    bones,
    rig,
    binding,
    relations: relationsShown,
    relationsTotal,
    clip,
    issues,
    seat,
    distortion: {
      level,
      reasons,
      nonFinite,
      badTriangles: badTotal,
      sampledTriangles: sampledTotal,
      collapsedEdges: collapsedTotal,
      badPct: r3(overallBadPct),
      maxDeform: r3(maxDeform),
      p99Deform: r3(p99Max),
      maxStretch: r3(maxStretch),
      minSquash: r3(minSquash),
      worstPart: worstPart ? {
        char: worstPart.char,
        materialId: worstPart.materialId,
        maxDeform: r3(worstPart.maxDeform),
        badPct: r3(worstPart.badPct),
        level: worstPart.level,
        badBones: worstPart.badBones,
        maxDispBone: worstPart.maxDispBone,
      } : null,
      shortTailTracks,
    },
    warnings,
  };
}

/** 静态绑定摘要：不随动画帧变化，AI 只需计算/读取一次。 */
function staticBindingSummary(asset, threshold = 0.01) {
  const missing = [];
  const bad = [];
  for (let i = 0; i < asset.parts.length; i++) {
    const part = asset.parts[i];
    const char = String.fromCharCode(49 + i);
    for (const b of part.bones) {
      if (!b.id || !b.node) missing.push(`${char}:${b.id || '?'}`);
    }
    if ((part.bindError || 0) > threshold) {
      bad.push({ part: char, node: part.node.id, mesh: part.prim?.id || null, bindError: r3(part.bindError) });
    }
  }
  return {
    bindMaxError: r3(asset.checks?.bindMaxError || 0),
    bindWorst: asset.checks?.bindWorst || null,
    bindBadParts: bad,
    missingBones: [...new Set(missing)],
  };
}

function quickPoseDistortion(asset, options = {}) {
  let maxDeform = 1, p99 = 1, bad = 0, sampled = 0, collapsed = 0, nan = false;
  let worst = null;
  const includeParts = !!options.includeParts;
  const maxTriangles = Math.max(80, Math.min(4000, Number(options.maxTriangles) || 600));
  const partRows = includeParts ? [] : null;
  for (let pi = 0; pi < asset.parts.length; pi++) {
    const part = asset.parts[pi];
    const cur = computePartPositions(part);
    const bind = computePartBindPositions(part);
    const d = computeEdgeDistortion(part, cur, bind, maxTriangles);
    if (d.nan) nan = true;
    bad += d.bad;
    sampled += d.sampled;
    collapsed += d.collapsed;
    if (d.maxDeform > maxDeform) maxDeform = d.maxDeform;
    if (d.p99Deform > p99) p99 = d.p99Deform;
    if (!worst || d.badPct > worst.badPct || (d.badPct === worst.badPct && d.maxDeform > worst.maxDeform)) {
      worst = { part: part.material.id, maxDeform: d.maxDeform, badPct: d.badPct };
    }
    if (includeParts) {
      partRows.push({
        part: String.fromCharCode(49 + pi),
        material: part.material.id,
        node: part.node.id,
        type: part.bones.length === 0 ? 'static' : (part.bones.length === 1 ? 'rigid' : 'skinned'),
        bones: part.bones.length,
        badPct: r3(d.badPct),
        p99: r3(d.p99Deform),
        maxDeform: r3(d.maxDeform),
        collapsed: d.collapsed,
        nonFinite: d.nonFinite,
        badBones: (d.badBones || []).slice(0, 4),
      });
    }
  }
  return {
    nan,
    nonFinite: nan,
    maxDeform,
    p99,
    bad,
    sampled,
    collapsed,
    badPct: sampled ? (bad / sampled) * 100 : 0,
    worstPart: worst ? worst.part : null,
    worstBadPct: worst ? worst.badPct : 0,
    ...(includeParts ? { parts: partRows } : {}),
  };
}

function fitInfo() {
  const a = app.asset;
  if (!a || !a.bounds) return null;
  const b = a.bounds;
  const hgt = b.size[1];
  const wid = Math.max(b.size[0], b.size[2]);
  const ref = app.fitByMax ? Math.max(hgt, wid) : hgt;
  const scale = ref > 1e-3 ? app.worldH * Math.max(0.1, Math.min(1.2, app.fitPct)) / ref : 1;
  return {
    worldH: app.worldH,
    fitPct: app.fitPct,
    fitByMax: app.fitByMax,
    ref: r3(ref),
    scale: r3(scale),
    dx: r3(-(b.min[0] + b.max[0]) * 0.5 * scale),
    dy: r3(-b.min[1] * scale),
    dz: r3(-(b.min[2] + b.max[2]) * 0.5 * scale),
    facingDeg: app.facing,
  };
}

function buildDiagnoseSummary(report) {
  const a = report.model;
  const p = report.pose;
  const f = report.frame;
  const lines = [];
  const level = p.distortion.level;
  const deformParts = p.parts.filter((x) => x.distortion.level !== 'ok');
  lines.push(`G3D-WEB DIAGNOSE ${level === 'error' ? 'FAIL' : level === 'warn' ? 'WARN' : 'OK'} · ${a.path}`);
  lines.push(`state=${report.view.stateId} anim=${f.animId || 'procedural'} frame=${f.frame}/${f.frames ? f.frames - 1 : '?'} t=${f.time}s mode=${f.mode} fps=${r3(f.fps)} gridFrames=${f.frames}`);
  lines.push(`stats: vertices=${a.stats.vertices} triangles=${a.stats.triangles} parts=${a.stats.parts} bones=${a.stats.joints}/${a.stats.nodes} maxPartBones=${a.stats.maxPartBones}`);
  lines.push(`bindMaxError=${a.checks.bindMaxError}${a.checks.bindWorst ? ` (${a.checks.bindWorst.node}/${a.checks.bindWorst.meshPartId})` : ''}`);
  lines.push(`VERDICT ${level.toUpperCase()} (deformation only; binding/seat are position): ${p.distortion.reasons.length ? p.distortion.reasons.join(' | ') : '未发现边长变形（binding/seat 偏移不是变形）'}`);
  lines.push(`DEFORMATION(global): nonFinite=${!!p.distortion.nonFinite} badTriangles=${p.distortion.badTriangles}/${p.distortion.sampledTriangles} (${p.distortion.badPct}%) maxDeform=${p.distortion.maxDeform} p99=${p.distortion.p99Deform} maxStretch=${p.distortion.maxStretch} minSquash=${p.distortion.minSquash} collapsedEdges=${p.distortion.collapsedEdges || 0}`);
  if (deformParts.length) {
    lines.push(`DEFORMATION(parts): ${deformParts.map((x) => `${x.char}=${x.label} mech=${x.deformMechanism} bad=${x.distortion.badPct}% p99=${x.distortion.p99Deform} max=${x.distortion.maxDeform} badBones=${(x.distortion.badBones || []).slice(0, 3).map((b) => b.id).join(',')}`).join(' ; ')}`);
  } else {
    lines.push(`DEFORMATION(parts): none above per-part threshold (global badPct=${p.distortion.badPct}%) — binding/seat offsets are POSITION, not deformation`);
  }
  lines.push(`pose: bboxMin=${JSON.stringify(p.bbox.min)} bboxMax=${JSON.stringify(p.bbox.max)} size=${JSON.stringify(p.bbox.size)} screenBBox=${JSON.stringify(p.screenBBox)} clipped=${p.clipped} gridCells=${p.gridCells}`);
  if (p.clip) {
    lines.push(`CLIP(aabb approx; geometry; not deformation): suspected=${p.clip.suspectedCount}/${p.clip.relationsTotal} overlapPairs · ${p.clip.suspectedCount ? p.clip.suspected.map((r) => `${r.a.char}=${r.a.label}↔${r.b.char}=${r.b.label} pen=${r.penetration} ratio=${r.overlapRatio} expected=${r.expected}`).join(' ; ') : 'none'}`);
    if (p.clip.note) lines.push(`CLIP note: ${p.clip.note}`);
  }
  const accessories = p.parts.filter((x) => x.accessory);
  if (accessories.length) {
    lines.push(`ACCESSORY(position; not deformation): ${accessories.map((x) => {
      const r = x.relativeToBody;
      return `${x.char}=${x.label} type=${x.type} socket=${x.socket || '-'} center=${JSON.stringify(x.aabb.center)} relBody=${r ? `${r.part}=${r.label} delta=${JSON.stringify(r.centerDelta)} dist=${r.centerDistance} gap=${r.gapDistance} overlap=${r.aabbOverlap} expected=${r.expected}` : 'n/a'}`;
    }).join(' ; ')}`);
  }
  if (p.relations && p.relations.length) {
    lines.push(`RELATIONS(nearest/top; aabb; position): ${p.relations.slice(0, 8).map((r) => `${r.a.char}↔${r.b.char} kind=${r.pairKind} centerΔ=${JSON.stringify(r.centerDelta)} dist=${r.centerDistance} gap=${r.gapDistance} overlap=${r.aabbOverlap} pen=${r.penetration} ratio=${r.overlapRatio} expected=${r.expected} relation=${r.relation}`).join(' ; ')}`);
  }
  if (p.seat) {
    const s = p.seat;
    lines.push(`SEAT(position; not deformation): riderRoot=${s.riderRoot ? `${s.riderRoot.id} pos=${JSON.stringify(s.riderRoot.pos)} local=${JSON.stringify(s.riderRoot.local)} offsetFromParent=${JSON.stringify(s.riderRoot.offsetFromParent)}` : 'n/a'}`);
    lines.push(`SEAT(position; not deformation): parent=${s.parent ? `${s.parent.id} pos=${JSON.stringify(s.parent.pos)}` : 'n/a'} hips=${s.hips ? `pos=${JSON.stringify(s.hips.pos)} aboveSaddleTop=${s.hips.hipsAboveSaddleTop} horizontal=${s.hips.hipsHorizontalFromSaddleCenter}` : 'n/a'}`);
    lines.push(`SEAT(position; not deformation): saddleTop=${JSON.stringify(s.saddleTopCenter)} saddlePart=${s.saddlePart}`);
  }
  if (p.rig) {
    lines.push(`rig: roots=${JSON.stringify(p.rig.roots)} boneNodes=${p.rig.boneCount} joints=${p.rig.jointCount}`);
    const rigid = p.parts.filter((x) => x.type === 'rigid');
    if (rigid.length) {
      lines.push(`BINDING(rigid; position; not deformation): ${rigid.map((x) => `${x.char}=${x.label}@${x.socket} bindCenter=${JSON.stringify(x.bindCenter)} local=${JSON.stringify(x.bindOffsetLocal)} world=${JSON.stringify(x.bindOffsetWorld)}${x.scaleDeviation > 0.01 ? ` scale=${JSON.stringify(x.skinningScale)}` : ''}`).join(' ; ')}`);
    }
    const skinned = p.parts.filter((x) => x.type === 'skinned');
    if (skinned.length) {
      lines.push(`RIG(skinning bones): ${skinned.map((x) => `${x.char}=${x.label} bones=${JSON.stringify(x.boneIds.slice(0, 12))}${x.boneIds.length > 12 ? '…' : ''} usage=${(x.distortion.boneUsage || []).slice(0, 6).map((u) => `${u.id}:${u.pct}%`).join(',')}`).join(' ; ')}`);
    }
    if (p.rig.boneParts.length) {
      const socketBones = new Set(p.parts.filter((x) => x.type === 'rigid' && x.socket).map((x) => x.socket));
      const bp = [...p.rig.boneParts].sort((a, b) => {
        const sa = socketBones.has(a.bone) ? 0 : 1;
        const sb = socketBones.has(b.bone) ? 0 : 1;
        if (sa !== sb) return sa - sb;
        if (b.parts.length !== a.parts.length) return b.parts.length - a.parts.length;
        return a.bone.localeCompare(b.bone);
      });
      const shown = bp.slice(0, 10);
      lines.push(`boneParts: ${shown.map((x) => `${x.bone}=${x.parts.join(',')}`).join(' ; ')}${bp.length > shown.length ? ` ; …(+${bp.length - shown.length})` : ''}`);
    }
  }
  if (p.issues && p.issues.length) {
    lines.push(`issues: ${p.issues.map((i) => `${i.kind}/${i.severity}${i.part ? `[${i.part}]` : ''}${i.message ? `:${i.message}` : ''}`).join(' ; ')}`);
  }
  if (p.warnings.length) lines.push(`poseWarnings: ${p.warnings.join(' | ')}`);
  lines.push(`parts: ${p.parts.map((x) => `${x.char}=${x.label}(type=${x.type},mech=${x.deformMechanism},cells=${x.cells},level=${x.distortion.level},bad=${x.distortion.badPct}%,max=${x.distortion.maxDeform},aabb=${JSON.stringify(x.aabb.size)},center=${JSON.stringify(x.aabb.center)}${x.relativeToBody ? `,relBody=${x.relativeToBody.part}/${x.relativeToBody.relation}` : ''})`).join(' ; ')}`);
  const wp = p.distortion.worstPart;
  if (wp && wp.badBones && wp.badBones.length) {
    lines.push(`DEFORMATION badBones(${wp.char}=${wp.materialId}): ${wp.badBones.map((b) => `${b.id || b.index}×${b.count}`).join(' ')}`);
  }
  if (wp && wp.maxDispBone) {
    const b = wp.maxDispBone;
    lines.push(`DEFORMATION maxDispBone: ${b.id || b.index} node=${b.node || '?'} weight=${b.weight} disp=${b.disp}`);
  }
  lines.push(`legend: ${Object.entries(p.legend).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  if (p.rig && p.rig.tree && p.rig.tree.length) {
    lines.push('bone tree (bind world; [parts]):');
    for (const row of p.rig.tree) lines.push(row);
  }
  lines.push('part map (top→bottom, chars = legend):');
  for (const row of p.grid) lines.push(row);
  return lines.join('\n');
}

/** 结构化诊断报告（JSON 可序列化；包含 ASCII 部件图与边长扭曲指标）。 */
function diagnose(options = {}) {
  const a = app.asset;
  if (!a) {
    return { schema: DIAG_SCHEMA, ok: false, summary: '没有加载模型', generatedAt: new Date().toISOString() };
  }
  if (renderer && options.render !== false) {
    try {
      renderer.render(a, buildView());
    } catch (e) {
      // 保留已有 last* 矩阵
    }
  }
  const info = frameInfo(app.state);
  // 轻量模式：只做 CPU 绑定/边长采样，跳过 ASCII、关系、骨架树等重数据。
  // AI 逐帧循环请优先用 probeFrames()；单帧快速检查可用 diagnose({light:true})。
  if (options.light) {
    const m = quickPoseDistortion(a, {
      includeParts: !!options.includeParts,
      maxTriangles: options.maxTriangles || 600,
    });
    const anim = animationOf(app.state);
    const light = {
      schema: DIAG_SCHEMA,
      light: true,
      generatedAt: new Date().toISOString(),
      ok: !a.errors.length && !m.nan,
      model: { path: a.path, id: a.id, stats: a.stats, bounds: a.bounds, checks: a.checks },
      frame: {
        state: app.state,
        animId: anim ? anim.id : null,
        frame: info.frame,
        frames: info.frames,
        time: r3(info.t),
        fps: r3(info.fps),
      },
      pose: {
        distortion: {
          level: m.nan || m.badPct >= 2 || (m.badPct >= 0.5 && m.p99 >= 15) ? 'error'
            : (m.badPct >= 0.2 || m.p99 >= 5 || m.maxDeform >= 8 ? 'warn' : 'ok'),
          nonFinite: m.nan,
          badPct: r3(m.badPct),
          p99Deform: r3(m.p99),
          maxDeform: r3(m.maxDeform),
          collapsedEdges: m.collapsed,
          worstPart: m.worstPart,
        },
        ...(m.parts ? { parts: m.parts } : {}),
      },
      binding: staticBindingSummary(a),
      verdict: {
        scope: 'deformation',
        level: m.nan || m.badPct >= 2 || (m.badPct >= 0.5 && m.p99 >= 15) ? 'error'
          : (m.badPct >= 0.2 || m.p99 >= 5 || m.maxDeform >= 8 ? 'warn' : 'ok'),
      },
    };
    light.summary = [
      `G3D-WEB LIGHT ${light.verdict.level.toUpperCase()} · ${a.path}`,
      `state=${app.state} anim=${light.frame.animId || 'procedural'} frame=${info.frame}/${info.frames}`,
      `badPct=${light.pose.distortion.badPct}% p99=${light.pose.distortion.p99Deform} maxDeform=${light.pose.distortion.maxDeform} worstPart=${m.worstPart || '—'}`,
      'light=true：未生成 ASCII/relations/bones；需要完整判断请调用 diagnose()',
    ].join('\n');
    return light;
  }
  const pose = analyzePose(a, options);
  // 高亮模式 problems 使用：把扭曲部件里出现次数最多的骨骼节点收集起来。
  try {
    const bad = new Set();
    for (const p of pose.parts || []) {
      for (const b of p.distortion?.badBones || []) {
        const id = typeof b === 'string' ? b : (b.id || b.node);
        if (id) bad.add(String(id));
      }
    }
    app.skeletonBadBones = [...bad];
  } catch (e) { /* optional */ }
  const anim = animationOf(app.state);
  const entry = app.models.find((m) => m.path === app.path);
  const frame = {
    state: app.state,
    animId: anim ? anim.id : null,
    mode: info.mode,
    frame: info.frame,
    frames: info.frames,
    time: r3(info.t),
    duration: r3(info.duration),
    fps: r3(info.fps),
    frameTime: r3(info.frameTime || 0),
    clampTrackEnd: !!app.clampTrackEnd,
    playing: !!app.playing,
  };
  const ok = !a.errors.length && !pose.nan && pose.distortion.level !== 'error';
  const report = {
    schema: DIAG_SCHEMA,
    generatedAt: new Date().toISOString(),
    ok,
    model: {
      path: a.path,
      id: a.id,
      group: entry ? entry.group : null,
      size: entry ? entry.size : null,
      mtimeMs: entry ? entry.mtimeMs || null : null,
      stats: a.stats,
      bounds: a.bounds,
      anchor: a.bounds ? a.bounds.anchor : null,
      checks: a.checks,
      runtime: a.runtime || null,
      errors: a.errors,
      warnings: a.warnings,
      states: a.states,
      animations: a.animations.map((x) => ({
        id: x.id,
        duration: r3(x.duration),
        tracks: x.tracks.length,
        frameCount: x.frameTimes ? x.frameTimes.length : 0,
        sourceFps: r3(x.sourceFps),
        shortTracks: x.shortTracks,
        shortRange: x.shortRange ? [r3(x.shortRange[0]), r3(x.shortRange[1])] : null,
      })),
      textures: [...a.materials.values()].map((m) => ({
        materialId: m.id,
        file: m.texture,
        loaded: !!m.textureObj,
        size: m.textureSize || null,
      })),
    },
    view: { ...buildView(), animId: anim ? anim.id : null },
    frame,
    fit: fitInfo(),
    // 模型中心（场景绝对坐标）/ 最终缩放：与属性页「摆放 / 缩放」同口径
    modelMetrics: getModelMetrics(),
    camera: renderer ? renderer.lastCamera : null,
    renderer: renderer ? {
      webgl: renderer.isWebGL2 ? 'webgl2' : 'webgl',
      maxBonesByLimit: renderer.maxBonesByLimit,
      draw: { calls: renderer.drawStats.calls, triangles: Math.round(renderer.drawStats.triangles) },
    } : null,
    pose,
    verdict: {
      scope: 'deformation',
      level: pose.distortion.level,
      reasons: pose.distortion.reasons,
    },
  };
  report.summary = buildDiagnoseSummary(report);
  return report;
}

/** 逐帧扫描当前状态的扭曲指标，找出哪一帧开始炸。 */
function scanAnimation(options = {}) {
  const a = app.asset;
  if (!a) return { schema: DIAG_SCHEMA, ok: false, summary: '没有加载模型' };
  const state = options.state || app.state;
  const anim = animationOf(state);
  if (!anim) return { schema: DIAG_SCHEMA, ok: false, summary: `状态 ${state} 没有动画` };
  const info = frameInfo(state);
  let times;
  if (info.mode === 'auto' && anim.frameTimes && anim.frameTimes.length) {
    times = anim.frameTimes;
  } else {
    const fps = info.fps || 30;
    const n = Math.max(1, Math.ceil(anim.duration * fps - 1e-6));
    times = Array.from({ length: n }, (_, i) => i / fps);
  }
  const maxFrames = Math.max(1, Math.min(2000, options.maxFrames || 240));
  const step = Math.max(1, Math.ceil(times.length / maxFrames));
  const originalTime = app.times[state] || 0;
  const frames = [];
  let worst = null;
  let level = 'ok';
  const reasons = [];
  for (let i = 0; i < times.length; i += step) {
    samplePose(a, anim, times[i], { clampEnd: options.clampTrackEnd !== undefined ? !!options.clampTrackEnd : !!app.clampTrackEnd });
    const m = quickPoseDistortion(a);
    const score = m.badPct * 4 + m.p99;
    const rec = {
      frame: i,
      time: r3(times[i]),
      maxDeform: r3(m.maxDeform),
      p99Deform: r3(m.p99),
      badPct: r3(m.badPct),
      nan: m.nonFinite,
      collapsed: m.collapsed,
      worstPart: m.worstPart,
      score: r3(score),
    };
    frames.push(rec);
    if (!worst || score > worst.score) worst = rec;
    if (m.nonFinite || m.badPct >= 2 || (m.badPct >= 0.5 && m.p99 >= 15)) level = 'error';
    else if (level === 'ok' && (m.badPct >= 0.2 || m.p99 >= 5 || m.maxDeform >= 8)) level = 'warn';
  }
  if (level !== 'ok') {
    reasons.push(`扫描 ${frames.length} 帧，最差帧 ${worst.frame} (t=${worst.time}s) maxDeform=${worst.maxDeform} badPct=${worst.badPct}%`);
  }
  // 恢复当前状态/帧
  const curAnim = animationOf(app.state);
  samplePose(a, curAnim, app.times[app.state] || 0, { clampEnd: !!app.clampTrackEnd });
  if (renderer) {
    try { renderer.render(a, buildView()); } catch (e) { /* ignore */ }
  }
  const sorted = frames.slice().sort((x, y) => y.score - x.score).slice(0, 5);
  const result = {
    schema: DIAG_SCHEMA,
    state,
    animId: anim.id,
    mode: info.mode,
    fps: r3(info.fps),
    frameCount: times.length,
    sampled: frames.length,
    level,
    reasons,
    worst,
    topFrames: sorted,
    frames,
  };
  result.summary = [
    `G3D-WEB SCAN ${level.toUpperCase()} · ${a.path} state=${state} anim=${anim.id}`,
    `frames=${times.length} sampled=${frames.length} mode=${info.mode} fps=${r3(info.fps)}`,
    `worstFrame=${worst.frame} t=${worst.time}s maxDeform=${worst.maxDeform} p99=${worst.p99Deform} badPct=${worst.badPct}% part=${worst.worstPart}`,
    ...(reasons.length ? reasons : ['未发现明显扭曲']),
    `topFrames=${JSON.stringify(sorted)}`,
  ].join('\n');
  return result;
}

/** 逐帧快速探测：只算绑定/边长变形，不生成 ASCII、不做关系/穿模全量分析。
 * 适合 AI 每个动画帧循环；绑定姿态与调色板缓冲会复用缓存。
 * options: { state, times:[秒], frames:[帧号], maxFrames=240, maxTriangles=600,
 *            includeParts=false, includeBones=false, clampTrackEnd }
 */
function probeFrames(options = {}) {
  const a = app.asset;
  if (!a) return { schema: 'g3d-web-probe/1', ok: false, summary: '没有加载模型' };
  const state = options.state || app.state;
  if (!STATE_KEYS.includes(state)) {
    return { schema: 'g3d-web-probe/1', ok: false, summary: `未知状态 ${state}` };
  }
  const anim = animationOf(state);
  if (!anim) return { schema: 'g3d-web-probe/1', ok: false, summary: `状态 ${state} 没有动画` };
  const info = frameInfo(state);
  let baseTimes;
  if (anim.frameTimes && anim.frameTimes.length) baseTimes = anim.frameTimes;
  else {
    const fps = info.fps || 30;
    const n = Math.max(1, Math.ceil(anim.duration * fps - 1e-6));
    baseTimes = Array.from({ length: n }, (_, i) => i / fps);
  }
  let times;
  if (Array.isArray(options.times) && options.times.length) {
    times = options.times.map(Number).filter(Number.isFinite);
  } else if (Array.isArray(options.frames) && options.frames.length) {
    times = options.frames.map((f) => baseTimes[Math.max(0, Math.min(baseTimes.length - 1, Math.round(Number(f))))]).filter(Number.isFinite);
  } else {
    times = baseTimes.slice();
  }
  const maxFrames = Math.max(1, Math.min(5000, Number(options.maxFrames) || 240));
  const step = Math.max(1, Math.ceil(times.length / maxFrames));
  const sampledTimes = [];
  for (let i = 0; i < times.length; i += step) sampledTimes.push(times[i]);
  const includeParts = !!options.includeParts;
  const includeBones = !!options.includeBones;
  const binding = staticBindingSummary(a);
  const clampEnd = options.clampTrackEnd !== undefined ? !!options.clampTrackEnd : !!app.clampTrackEnd;
  const originalState = app.state;
  const originalTime = app.times[originalState] || 0;
  const rows = [];
  let worst = null;
  let level = 'ok';
  const reasons = [];
  for (let i = 0; i < sampledTimes.length; i++) {
    const t = sampledTimes[i];
    const animated = samplePose(a, anim, t, { clampEnd });
    const m = quickPoseDistortion(a, {
      includeParts,
      maxTriangles: options.maxTriangles || 600,
    });
    const rec = {
      frame: Math.round(t * (info.fps || 30)),
      time: r3(t),
      badPct: r3(m.badPct),
      p99: r3(m.p99),
      maxDeform: r3(m.maxDeform),
      collapsed: m.collapsed,
      nan: m.nan,
      worstPart: m.worstPart,
      score: r3(m.badPct * 4 + m.p99),
      ...(includeParts ? { parts: m.parts } : {}),
      ...(includeBones ? { animatedBones: [...animated].map((n) => n.id) } : {}),
    };
    rows.push(rec);
    if (!worst || rec.score > worst.score) worst = rec;
    if (m.nan || m.badPct >= 2 || (m.badPct >= 0.5 && m.p99 >= 15)) level = 'error';
    else if (level === 'ok' && (m.badPct >= 0.2 || m.p99 >= 5 || m.maxDeform >= 8)) level = 'warn';
  }
  if (level !== 'ok' && worst) {
    reasons.push(`快速扫描 ${rows.length} 帧，最差帧 ${worst.frame} (t=${worst.time}s) badPct=${worst.badPct}% p99=${worst.p99} maxDeform=${worst.maxDeform}`);
  }
  // 恢复调用前的姿势，避免 AI 扫描后画面停在最后一帧
  samplePose(a, animationOf(originalState), originalTime, { clampEnd: !!app.clampTrackEnd });
  if (renderer) {
    try { renderer.render(a, buildView()); } catch (e) { /* ignore */ }
  }
  const result = {
    schema: 'g3d-web-probe/1',
    ok: true,
    state,
    animId: anim.id,
    frameCount: times.length,
    sampled: rows.length,
    level,
    reasons,
    binding,
    worst,
    frames: rows,
  };
  result.summary = [
    `G3D-WEB PROBE ${level.toUpperCase()} · ${a.path} state=${state} anim=${anim.id}`,
    `frames=${times.length} sampled=${rows.length} step=${step}`,
    `worstFrame=${worst ? worst.frame : '—'} t=${worst ? worst.time : '—'}s badPct=${worst ? worst.badPct : '—'}% p99=${worst ? worst.p99 : '—'} maxDeform=${worst ? worst.maxDeform : '—'}`,
    ...(reasons.length ? reasons : ['未发现明显扭曲']),
  ].join('\n');
  return result;
}


// 坐标约定：模型自动适配后，脚底中心在场景原点；position/pivot 用场景单位，
// rotation 用 XYZ 欧拉角度；scale 可用数字或 [sx,sy,sz]。

function cloneVec3(v, fallback = [0, 0, 0]) {
  if (Array.isArray(v) && v.length >= 3) {
    return [Number(v[0]) || 0, Number(v[1]) || 0, Number(v[2]) || 0];
  }
  if (v && typeof v === 'object') {
    return [Number(v.x) || 0, Number(v.y) || 0, Number(v.z) || 0];
  }
  return fallback.slice();
}

function cloneScale(v, fallback = [1, 1, 1]) {
  if (typeof v === 'number' && Number.isFinite(v)) return [v, v, v];
  if (Array.isArray(v) && v.length >= 3) {
    return [Number(v[0]) || 1, Number(v[1]) || 1, Number(v[2]) || 1];
  }
  if (v && typeof v === 'object') {
    return [Number(v.x) || 1, Number(v.y) || 1, Number(v.z) || 1];
  }
  return fallback.slice();
}

function clonePlacement(p = {}) {
  return {
    position: cloneVec3(p.position ?? p.offset ?? p.translation, [0, 0, 0]),
    rotation: cloneVec3(p.rotation ?? p.rotate, [0, 0, 0]),
    scale: cloneScale(p.scale ?? p.scaling, [1, 1, 1]),
    pivot: cloneVec3(p.pivot, [0, 0, 0]),
    ...(Array.isArray(p.matrix) && p.matrix.length === 16 ? { matrix: p.matrix.slice(0, 16) } : {}),
  };
}

function automaticPivot(kind) {
  if (kind === 'feet' || kind === 'origin' || !kind) return [0, 0, 0];
  const bounds = app.asset?.bounds;
  if (!bounds) return [0, 0, 0];
  const size = bounds.size || [0, 0, 0];
  const ref = app.fitByMax ? Math.max(size[0], size[2], size[1]) : size[1];
  const fitScale = ref > 1e-3 ? app.worldH * app.fitPct / ref : 1;
  if (kind === 'center' || kind === 'bboxCenter') {
    return [0, size[1] * fitScale * 0.5, 0];
  }
  return [0, 0, 0];
}

function renderPlacedModel() {
  if (renderer && app.asset) {
    try { renderer.render(app.asset, buildView()); } catch (e) { /* frame loop will retry */ }
  }
  updateHud(true);
}

function getPlacement() {
  const p = clonePlacement(app.placement);
  return {
    schema: 'g3d-web-placement/1',
    ...p,
    matrix: renderer?.lastWorld ? Array.from(renderer.lastWorld) : null,
    units: 'scene (auto-fit; feet center at origin)',
    rotationOrder: 'XYZ (degrees)',
    // 当前姿势下的模型中心 / 缩放（与属性面板同口径）：中心是场景绝对坐标
    metrics: getModelMetrics(),
  };
}

function setModelPlacement(opts = {}) {
  const reset = !!opts.reset;
  const src = isObject(opts.placement) ? opts.placement : opts;
  beginEdit('摆放 / 缩放');
  const base = reset ? PLACEMENT_DEFAULTS : app.placement;
  const next = {
    ...base,
    ...(src.position !== undefined || src.offset !== undefined || src.translation !== undefined
      ? { position: cloneVec3(src.position ?? src.offset ?? src.translation, [0, 0, 0]) } : {}),
    ...(src.rotation !== undefined || src.rotate !== undefined
      ? { rotation: cloneVec3(src.rotation ?? src.rotate, [0, 0, 0]) } : {}),
    ...(src.scale !== undefined || src.scaling !== undefined
      ? { scale: cloneScale(src.scale ?? src.scaling, [1, 1, 1]) } : {}),
    ...(src.pivot !== undefined
      ? { pivot: typeof src.pivot === 'string' ? automaticPivot(src.pivot) : cloneVec3(src.pivot, [0, 0, 0]) } : {}),
    ...(Array.isArray(src.matrix) && src.matrix.length === 16 ? { matrix: src.matrix.slice(0, 16) } : {}),
  };
  if (src.matrix === null) delete next.matrix;
  // 写入 position/rotation/scale/pivot 时退出矩阵覆盖模式，否则矩阵会继续压住这些字段。
  if (!Array.isArray(src.matrix)
      && (src.position !== undefined || src.offset !== undefined || src.translation !== undefined
        || src.rotation !== undefined || src.rotate !== undefined
        || src.scale !== undefined || src.scaling !== undefined || src.pivot !== undefined)) {
    delete next.matrix;
  }
  app.placement = clonePlacement(next);
  renderPlacedModel();
  return getPlacement();
}

function moveModel(delta = {}, opts = {}) {
  const d = cloneVec3(delta, [0, 0, 0]);
  const cur = app.placement;
  const pos = cur.position.slice();
  if (opts.space === 'local') {
    // 绕当前 Y 旋转后的局部 x/z；保持简单可预测，不引入相机依赖。
    const r = (cur.rotation[1] || 0) * Math.PI / 180;
    const c = Math.cos(r), s = Math.sin(r);
    pos[0] += d[0] * c + d[2] * s;
    pos[2] += -d[0] * s + d[2] * c;
    pos[1] += d[1];
  } else {
    pos[0] += d[0]; pos[1] += d[1]; pos[2] += d[2];
  }
  return setModelPlacement({ ...cur, position: pos, matrix: null });
}

function rotateModel(delta = {}, opts = {}) {
  const d = cloneVec3(delta, [0, 0, 0]);
  const cur = app.placement;
  const rot = cur.rotation.slice();
  rot[0] += d[0]; rot[1] += d[1]; rot[2] += d[2];
  return setModelPlacement({ ...cur, rotation: rot, pivot: opts.pivot ?? cur.pivot, matrix: null });
}

function scaleModel(value = 1) {
  const cur = app.placement;
  const delta = cloneScale(value, [1, 1, 1]);
  const next = cur.scale.map((v, i) => v * delta[i]);
  return setModelPlacement({ ...cur, scale: next, matrix: null });
}

function resetModelPlacement() {
  beginEdit('复位摆放 / 缩放');
  app.placement = clonePlacement(PLACEMENT_DEFAULTS);
  // 复位同时清掉自定义参考点，回到「包围盒中心」基准
  app.transformCustomLocal = null;
  app.transformRef = 'center';
  if (el.transformRef) el.transformRef.value = 'center';
  renderPlacedModel();
  updateTransformPanel({ blur: true });
  return getPlacement();
}

function setModelMatrix(matrix) {
  if (!Array.isArray(matrix) || matrix.length !== 16) {
    throw new Error('setModelMatrix 需要 16 个数的列主序矩阵');
  }
  beginEdit('设置模型矩阵');
  const cur = clonePlacement(app.placement);
  cur.matrix = matrix.slice(0, 16);
  app.placement = cur;
  renderPlacedModel();
  return getPlacement();
}

function screenOfWorldPoint(point) {
  const proj = makeProjector();
  if (!proj) return null;
  const p = cloneVec3(point, [0, 0, 0]);
  return proj(p[0], p[1], p[2]);
}

/** 骨架/绑定报告：骨骼姿势、绑定误差、每个部件的骨列表与挂点。 */
function buildSkeletonReport(opts = {}) {
  const a = app.asset;
  if (!a) return { schema: 'g3d-web-skeleton/1', ok: false, summary: '没有加载模型' };
  const animated = renderer?.poseAnimated || new Set();
  const boneToParts = new Map();
  const parts = a.parts.map((p, i) => {
    const char = String.fromCharCode(49 + i);
    for (const b of p.bones) {
      if (!b.node) continue;
      if (!boneToParts.has(b.node.id)) boneToParts.set(b.node.id, []);
      boneToParts.get(b.node.id).push(char);
    }
    return {
      part: char,
      node: p.node.id,
      mesh: p.prim?.id || null,
      material: p.material?.id || null,
      bones: p.bones.map((b) => b.id),
      boneCount: p.boneCount,
      runtimeAttachment: !p.isBody,
      bindError: r3(p.bindError || 0),
      bindTransform: Array.from(p.bindTransform || []).map((v) => r3(v)),
    };
  });
  const bones = a.nodes.map((node) => {
    const pose = node.bindGlobal;
    const rest = node.bindGlobalRest || node.bindGlobal;
    return {
      id: node.id,
      parent: node.parent ? node.parent.id : null,
      children: node.children.map((c) => c.id),
      usedBy: boneToParts.get(node.id) || [],
      animated: animated.has(node),
      poseLocal: [r3(pose[12]), r3(pose[13]), r3(pose[14])],
      restWorld: [r3(rest[12]), r3(rest[13]), r3(rest[14])],
      poseWorld: [r3(pose[12]), r3(pose[13]), r3(pose[14])],
      delta: [r3(pose[12] - rest[12]), r3(pose[13] - rest[13]), r3(pose[14] - rest[14])],
      bindLocal: {
        t: [r3(node.t[0]), r3(node.t[1]), r3(node.t[2])],
        q: [r3(node.q[0]), r3(node.q[1]), r3(node.q[2]), r3(node.q[3])],
        s: [r3(node.s[0]), r3(node.s[1]), r3(node.s[2])],
      },
    };
  });
  const missing = parts.flatMap((p) => p.bones.filter((b) => b && !a.nodeById.has(b)).map((b) => `${p.part}:${b}`));
  const threshold = Number(opts.threshold ?? 1e-2);
  const badParts = parts.filter((p) => p.bindError > threshold);
  const bindMaxError = a.checks?.bindMaxError || 0;
  const report = {
    schema: 'g3d-web-skeleton/1',
    ok: !a.errors?.length && !missing.length,
    path: a.path,
    state: app.state,
    animId: mappedAnimId(app.state),
    time: r3(app.times[app.state] || 0),
    boneCount: bones.length,
    jointCount: a.stats.joints,
    animatedCount: bones.filter((b) => b.animated).length,
    bindMaxError: r3(bindMaxError),
    bindWorst: a.checks?.bindWorst || null,
    bindBadParts: badParts.map((p) => ({ part: p.part, node: p.node, bindError: p.bindError })),
    missingBones: [...new Set(missing)],
    errors: a.errors || [],
    warnings: a.warnings || [],
    parts,
    bones,
    placement: getPlacement(),
  };
  report.summary = [
    `G3D-WEB SKELETON ${report.ok ? 'OK' : 'FAIL'} · ${a.path}`,
    `bones=${report.boneCount} joints=${report.jointCount} animated=${report.animatedCount} bindMaxError=${report.bindMaxError}`,
    `bindBadParts=${badParts.length} missingBones=${report.missingBones.length} errors=${report.errors.length}`,
    `parts=${parts.map((p) => `${p.part}:${p.bones.length}骨`).join(' ')}`,
    `placement=${JSON.stringify(report.placement.position)} rot=${JSON.stringify(report.placement.rotation)} scale=${JSON.stringify(report.placement.scale)}`,
  ].join('\n');
  return report;
}

function setSkeletonHighlight(opts = {}) {
  if (opts.enabled !== undefined) app.skeleton = !!opts.enabled;
  if (opts.mode) app.skeletonMode = opts.mode;
  if (opts.bones !== undefined) app.skeletonBones = (opts.bones || []).map(String);
  if (opts.badBones !== undefined) app.skeletonBadBones = (opts.badBones || []).map(String);
  if (app.skeleton) app.skeletonMode = opts.mode || (app.skeletonBones.length ? 'selected' : app.skeletonMode);
  if (el.skeleton) el.skeleton.checked = app.skeleton;
  if (el.skeletonMode) el.skeletonMode.value = app.skeletonMode;
  renderPlacedModel();
  return buildSkeletonReport();
}

function highlightBones(bones, opts = {}) {
  return setSkeletonHighlight({
    ...opts,
    enabled: opts.enabled !== undefined ? opts.enabled : true,
    mode: opts.mode || 'selected',
    bones: Array.isArray(bones) ? bones : (bones ? [bones] : []),
  });
}

/** 给 AI/脚本用的控制入口：设置状态/帧/帧率后立即返回诊断。 */
function applyAiControls(opts = {}) {
  if (!app.asset) return diagnose();
  if (opts.placement !== undefined || opts.position !== undefined || opts.rotation !== undefined
      || opts.scale !== undefined || opts.pivot !== undefined || opts.matrix !== undefined) {
    setModelPlacement(opts.placement !== undefined ? opts.placement : opts);
  }
  if (opts.skeleton !== undefined || opts.skeletonMode !== undefined || opts.bones !== undefined) {
    setSkeletonHighlight({
      enabled: opts.skeleton !== undefined ? opts.skeleton : true,
      mode: opts.skeletonMode,
      bones: opts.bones,
    });
  }
  if (opts.state && STATE_KEYS.includes(opts.state)) app.state = opts.state;
  if (opts.override !== undefined) {
    app.overrides[app.state] = opts.override || '';
    app.times[app.state] = 0;
  }
  if (opts.fps !== undefined) {
    app.frameRate = opts.fps === 'auto' ? 'auto' : (Number(opts.fps) || 30);
    syncFrameRateUI();
  }
  if (opts.clampTrackEnd !== undefined) {
    app.clampTrackEnd = !!opts.clampTrackEnd;
    el.clamp.checked = app.clampTrackEnd;
  }
  if (opts.facing !== undefined) {
    app.facing = Number(opts.facing) || 0;
    el.facing.value = String(app.facing);
    el.facingVal.textContent = `${app.facing}°`;
  }
  if (opts.playing !== undefined) app.playing = !!opts.playing;
  if (opts.time !== undefined) {
    app.times[app.state] = Math.max(0, Number(opts.time) || 0);
    app.playing = false;
  }
  if (opts.frame !== undefined) {
    setFrame(opts.frame);
    app.playing = false;
  }
  updateStateUI();
  updateScrub();
  updatePlayButton();
  updateHud(true);
  if (renderer && app.asset) {
    try { renderer.render(app.asset, buildView()); } catch (e) { /* ignore */ }
  }
  return diagnose(opts);
}

// ---------------------------------------------------------------- AI 报告面板

function showAiReport(obj) {
  const text = obj && typeof obj.summary === 'string'
    ? obj.summary
    : JSON.stringify(obj, null, 2);
  const json = JSON.stringify(obj, null, 2);
  if (el.aiReport) el.aiReport.textContent = json;
  if (el.aiSummary) el.aiSummary.textContent = text;
  if (el.aiPanel) el.aiPanel.classList.remove('hidden');
  console.log('G3D_DIAG ' + json);
  log('ok', `AI 诊断：verdict=${obj.verdict ? obj.verdict.level : (obj.level || '?')} · ${(obj.summary || '').split('\n')[0]}`);
  return text;
}



function updateHud(force = false) {
  const now = performance.now();
  if (!force && now - lastHud < 100) return;
  lastHud = now;
  updateTransformPanel();
  if (!app.asset) {
    el.hudAnim.textContent = '—';
    el.hudTime.textContent = '—';
    el.hudFps.textContent = '—';
    el.hudDraw.textContent = '—';
    el.scrub.disabled = true;
    el.scrub.max = '0';
    el.scrub.value = '0';
    el.frameLabel.textContent = '帧 — / —';
    el.timeLabel.textContent = '0.000 / 0.000s';
    return;
  }
  const id = mappedAnimId(app.state);
  const info = frameInfo(app.state);
  el.hudAnim.textContent = id ? `${STATE_LABELS[app.state]} · ${id}` : `${STATE_LABELS[app.state]} · 程序化`;
  el.hudTime.textContent = info.valid
    ? `${info.frame}/${info.frames - 1} · ${info.t.toFixed(2)}s`
    : '—';
  el.hudFps.textContent = app.fps.toFixed(0);
  const particleCount = renderer && renderer.drawStats ? (renderer.drawStats.particles || 0) : 0;
  el.hudDraw.textContent = `${renderer ? renderer.drawStats.calls : 0} / ${fmt(renderer ? renderer.drawStats.triangles : 0)} · 粒子 ${particleCount}`;

  if (el.particleNote) {
    const weapon = app.particleWeapon === 'auto'
      ? (renderer ? renderer.weapon : '—')
      : app.particleWeapon;
    const last = renderer && renderer.lastParticleEvent;
    el.particleNote.textContent = `事件表: ${weapon} · 粒子: ${particleCount}`
      + (last ? ` · 最近: ${last.preset} @ ${last.atTime.toFixed(2)}s` : '');
  }
  if (el.vfxBadge) el.vfxBadge.textContent = app.particles ? '开' : '关';
  if (el.smNote) {
    if (app.eu5sm && app.sm) {
      const s = app.sm.snapshot();
      el.smNote.textContent = `SM: ${s.state} (UnitState=${s.unitStateName}) · ${s.time.toFixed(2)}/${s.duration.toFixed(2)}s`;
    } else {
      el.smNote.textContent = 'Idle→Attack 等当前时间线结束；Attack→Move/Idle 立即。';
    }
  }
  updateScrub();
}

// ---------------------------------------------------------------- 撤销 / 重做（上一步 / 下一步）

const HISTORY_LIMIT = 100;
const HISTORY_COALESCE_MS = 900;
// undo/redo 里存的是「改动前」的界面状态；同一次连续操作（拖滑块 / 拖模型 / 滚轮）只压一条。
const history = { undo: [], redo: [], key: null, time: 0, suspended: 0 };

/** 可回退的界面状态：摆放 / 缩放、参考点、视角（缩放 / 方位 / 俯仰 / 朝向）。 */
function editSnapshot() {
  return {
    placement: clonePlacement(app.placement),
    transformRef: app.transformRef,
    transformCustomLocal: app.transformCustomLocal ? [...app.transformCustomLocal] : null,
    zoom: app.zoom,
    azimuth: app.azimuth,
    elevation: app.elevation,
    facing: app.facing,
  };
}

function snapshotSig(s) {
  return JSON.stringify(s);
}

function updateHistoryUI() {
  const last = history.undo[history.undo.length - 1];
  const next = history.redo[history.redo.length - 1];
  if (el.undoBtn) {
    el.undoBtn.disabled = !last;
    el.undoBtn.title = last ? `撤销「${last.label}」（Ctrl+Z）` : '没有可撤销的操作（Ctrl+Z）';
  }
  if (el.redoBtn) {
    el.redoBtn.disabled = !next;
    el.redoBtn.title = next ? `重做「${next.label}」（Ctrl+Shift+Z / Ctrl+Y）` : '没有可重做的操作';
  }
}

/**
 * 记录一次改动的**前**状态。key 相同且在 HISTORY_COALESCE_MS 内视为同一次连续操作，不再重复记录。
 */
function beginEdit(label, key = null) {
  if (history.suspended) return;
  const now = performance.now();
  if (key && key === history.key && now - history.time < HISTORY_COALESCE_MS) {
    history.time = now;
    return;
  }
  history.key = key;
  history.time = now;
  const snap = editSnapshot();
  const top = history.undo[history.undo.length - 1];
  if (top && snapshotSig(top.state) === snapshotSig(snap)) return;
  history.undo.push({ label, state: snap });
  if (history.undo.length > HISTORY_LIMIT) history.undo.shift();
  history.redo.length = 0;
  updateHistoryUI();
}

/** 连续交互（拖动模型 / 中键环绕）：整段只产生一条记录。 */
function beginGroupEdit(label) {
  beginEdit(label);
  history.suspended++;
}

function endGroupEdit() {
  if (history.suspended > 0) history.suspended--;
  history.key = null;
}

function applyHistory(state) {
  history.suspended++;
  try {
    app.placement = clonePlacement(state.placement);
    app.transformRef = TRANSFORM_REFS[state.transformRef] ? state.transformRef : 'center';
    app.transformCustomLocal = state.transformCustomLocal ? [...state.transformCustomLocal] : null;
    app.facing = state.facing;
    if (el.facing) el.facing.value = String(app.facing);
    if (el.facingVal) el.facingVal.textContent = `${app.facing}°`;
    if (el.transformRef) el.transformRef.value = app.transformRef;
    setZoom(state.zoom);
    setAzimuth(state.azimuth);
    setElevation(state.elevation);
    renderPlacedModel();
    updateTransformPanel({ blur: true });
  } finally {
    history.suspended--;
  }
  updateHistoryUI();
}

function undoEdit() {
  const entry = history.undo.pop();
  if (!entry) {
    log('info', '没有可撤销的操作');
    updateHistoryUI();
    return false;
  }
  history.redo.push({ label: entry.label, state: editSnapshot() });
  applyHistory(entry.state);
  history.key = null;
  log('info', `↶ 撤销「${entry.label}」（可撤销 ${history.undo.length} 步 / 可重做 ${history.redo.length} 步）`);
  return true;
}

function redoEdit() {
  const entry = history.redo.pop();
  if (!entry) {
    log('info', '没有可重做的操作');
    updateHistoryUI();
    return false;
  }
  history.undo.push({ label: entry.label, state: editSnapshot() });
  applyHistory(entry.state);
  history.key = null;
  log('info', `↷ 重做「${entry.label}」（可撤销 ${history.undo.length} 步 / 可重做 ${history.redo.length} 步）`);
  return true;
}

function clearHistory() {
  history.undo.length = 0;
  history.redo.length = 0;
  history.key = null;
  history.suspended = 0;
  updateHistoryUI();
}

// ---------------------------------------------------------------- 3D 视图交互（鼠标捕获）

// 相机参数（环绕方位 / 俯角 / 缩放）统一走 setter，保证滑块与标签同步。
const ZOOM_RANGE = [0.4, 2.5];
const AZIMUTH_RANGE = [-180, 180];
const ELEVATION_RANGE = [-85, 85];
// 中键拖动灵敏度（度 / 像素）
const ORBIT_DEG_PER_PX = 0.6;

function setZoom(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return app.zoom;
  // 与滑块 step=0.01 对齐，避免滚轮缩放后滑块与实际值差一点点
  const next = Math.round(Math.min(ZOOM_RANGE[1], Math.max(ZOOM_RANGE[0], n)) * 100) / 100;
  if (next !== app.zoom) beginEdit('相机缩放', 'camera');
  app.zoom = next;
  if (el.zoom) el.zoom.value = app.zoom.toFixed(2);
  if (el.zoomVal) el.zoomVal.textContent = app.zoom.toFixed(2) + '×';
  return app.zoom;
}

function setAzimuth(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return app.azimuth;
  let a = ((n + 180) % 360 + 360) % 360 - 180;
  const next = Math.round(Math.min(AZIMUTH_RANGE[1], Math.max(AZIMUTH_RANGE[0], a)));
  if (next !== app.azimuth) beginEdit('环绕方位', 'camera');
  app.azimuth = next;
  if (el.azimuth) el.azimuth.value = String(app.azimuth);
  if (el.azimuthVal) el.azimuthVal.textContent = `${app.azimuth}°`;
  return app.azimuth;
}

function setElevation(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return app.elevation;
  const next = Math.round(Math.min(ELEVATION_RANGE[1], Math.max(ELEVATION_RANGE[0], n)));
  if (next !== app.elevation) beginEdit('俯仰偏移', 'camera');
  app.elevation = next;
  if (el.elevation) el.elevation.value = String(app.elevation);
  if (el.elevationVal) el.elevationVal.textContent = `${app.elevation}°`;
  return app.elevation;
}

/** 画布坐标 → NDC。 */
function canvasNdc(canvas, clientX, clientY) {
  const r = canvas.getBoundingClientRect();
  return {
    x: ((clientX - r.left) / Math.max(1, r.width)) * 2 - 1,
    y: 1 - ((clientY - r.top) / Math.max(1, r.height)) * 2,
    inside: clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom,
  };
}

function ndcHitTri(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
  const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
  const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos);
}

/**
 * 屏幕点是否落在模型上（CPU 蒙皮 + 逐三角形 NDC 命中测试）。
 * 用当前姿势的顶点位置，与渲染完全同源；返回 { hit, part, triangle } 供日志/API 用。
 */
function pickModelAt(clientX, clientY, opts = {}) {
  if (!app.asset || !renderer || !renderer.lastProjView) return { hit: false, reason: 'no-model' };
  const canvas = el.canvas;
  const ndc = canvasNdc(canvas, clientX, clientY);
  if (!ndc.inside && !opts.allowOutside) return { hit: false, reason: 'outside' };
  const mvp = mat4Multiply(mat4Identity(), renderer.lastProjView, renderer.lastWorld);
  const asset = app.asset;
  const anim = animationOf(app.state);
  if (anim) samplePose(asset, anim, app.times[app.state] || 0, { clampEnd: app.clampTrackEnd });
  let best = null;
  for (let pi = 0; pi < asset.parts.length; pi++) {
    const part = asset.parts[pi];
    const pos = computePartPositions(part);
    if (!pos || !pos.length) continue;
    // 先算 NDC 包围盒，点在盒外直接跳过（避免全量三角形测试）。
    const n = pos.length / 3;
    const scr = new Float32Array(n * 2);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const ox = pos[i * 3], oy = pos[i * 3 + 1], oz = pos[i * 3 + 2];
      const cx = mvp[0] * ox + mvp[4] * oy + mvp[8] * oz + mvp[12];
      const cy = mvp[1] * ox + mvp[5] * oy + mvp[9] * oz + mvp[13];
      const cw = mvp[3] * ox + mvp[7] * oy + mvp[11] * oz + mvp[15];
      const w = Math.abs(cw) > 1e-9 ? cw : 1e-9;
      const nx = cx / w, ny = cy / w;
      scr[i * 2] = nx; scr[i * 2 + 1] = ny;
      if (nx < x0) x0 = nx;
      if (nx > x1) x1 = nx;
      if (ny < y0) y0 = ny;
      if (ny > y1) y1 = ny;
    }
    if (ndc.x < x0 || ndc.x > x1 || ndc.y < y0 || ndc.y > y1) continue;
    if (part.prim.type !== 'TRIANGLES') continue;
    const idx = part.prim.indices;
    for (let t = 0; t + 2 < idx.length; t += 3) {
      const a = idx[t], b = idx[t + 1], c = idx[t + 2];
      if (ndcHitTri(ndc.x, ndc.y, scr[a * 2], scr[a * 2 + 1], scr[b * 2], scr[b * 2 + 1], scr[c * 2], scr[c * 2 + 1])) {
        best = { hit: true, part, partIndex: pi, triangle: t / 3, screen: ndc };
        break;
      }
    }
    if (best) break;
  }
  return best || { hit: false, reason: 'empty', screen: ndc };
}

/** 选中态：画布轮廓高亮 + 光标提示（拖动可移动模型）。 */
function setSelected(on, opts = {}) {
  const next = !!on && !!app.asset;
  if (app.selected === next) {
    if (el.canvas) el.canvas.classList.toggle('is-selected', next);
    return app.selected;
  }
  app.selected = next;
  if (el.canvas) el.canvas.classList.toggle('is-selected', next);
  if (opts.silent !== true) {
    log(next ? 'ok' : 'info', next
      ? '选中模型（轮廓高亮；按住左键拖动 = 移动模型摆放）'
      : '取消选中');
  }
  return app.selected;
}

/** 屏幕像素位移 → 世界位移（相机平面内，1:1 跟手）。 */
function screenDeltaToWorld(dx, dy) {
  const cam = renderer && renderer.lastCamera;
  const canvas = el.canvas;
  if (!cam || !canvas) return null;
  const h = Math.max(1, canvas.clientHeight || canvas.height);
  const wpp = (app.worldH * app.zoom) / h; // 世界单位 / CSS 像素
  const fx = cam.target[0] - cam.eye[0];
  const fy = cam.target[1] - cam.eye[1];
  const fz = cam.target[2] - cam.eye[2];
  const fl = Math.hypot(fx, fy, fz) || 1;
  const f = [fx / fl, fy / fl, fz / fl];
  // right = normalize(cross(+Y, f))，up = cross(right, f)
  let rx = -f[2], rz = f[0];
  const rl = Math.hypot(rx, rz) || 1;
  rx /= rl; rz /= rl;
  const ux = -rz * f[1];
  const uy = rz * f[0] - rx * f[2];
  const uz = rx * f[1];
  // 屏幕 +x 向右 / +y 向下：world = right*dx - up*dy
  return [
    (rx * dx - ux * dy) * wpp,
    (-uy * dy) * wpp,
    (rz * dx - uz * dy) * wpp,
  ];
}

/** 拖动模型：把世界位移加到 placement.position（模型跟随光标，相机不动）。 */
function nudgeModelByWorld(delta) {
  if (!app.asset || !delta) return false;
  const cur = clonePlacement(app.placement);
  setModelPlacement({
    ...cur,
    position: cur.position.map((v, i) => v + delta[i]),
    matrix: null,
  });
  return true;
}

function bindViewInteraction() {
  const canvas = el.canvas;
  if (!canvas) return;
  // moved：拖动死区，避免「点一下选中」时抖出 1~2px 的位移。
  const state = { mode: null, id: null, lastX: 0, lastY: 0, x0: 0, y0: 0, moved: false, grouped: false };

  const begin = (mode, ev) => {
    state.mode = mode;
    state.moved = false;
    state.grouped = false;
    state.x0 = ev.clientX;
    state.y0 = ev.clientY;
    canvas.classList.add('is-dragging');
    try { canvas.setPointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
  };

  const onDown = (ev) => {
    if (!app.asset) return;
    state.id = ev.pointerId;
    state.lastX = ev.clientX;
    state.lastY = ev.clientY;
    if (ev.button === 1) {
      // 中键：环绕方位 + 俯角
      ev.preventDefault();
      begin('orbit', ev);
      return;
    }
    if (ev.button !== 0) return;
    const pick = pickModelAt(ev.clientX, ev.clientY);
    if (!pick.hit) {
      if (app.selected) setSelected(false);
      return;
    }
    // 命中模型：点击 = 选中（轮廓高亮）；按住拖动 = 移动模型摆放。
    if (!app.selected) setSelected(true);
    ev.preventDefault();
    begin('move', ev);
  };

  const onMove = (ev) => {
    if (!state.mode) return;
    const dx = ev.clientX - state.lastX;
    const dy = ev.clientY - state.lastY;
    state.lastX = ev.clientX;
    state.lastY = ev.clientY;
    if (!state.moved) {
      if (Math.abs(ev.clientX - state.x0) < 3 && Math.abs(ev.clientY - state.y0) < 3) return;
      state.moved = true;
      // 整段拖动只记一条撤销（点一下不记）。
      beginGroupEdit(state.mode === 'orbit' ? '环绕 / 俯角' : '拖动摆放');
      state.grouped = true;
    }
    if (!dx && !dy) return;
    ev.preventDefault();
    if (state.mode === 'orbit') {
      setAzimuth(app.azimuth - dx * ORBIT_DEG_PER_PX);
      setElevation(app.elevation - dy * ORBIT_DEG_PER_PX);
    } else {
      nudgeModelByWorld(screenDeltaToWorld(dx, dy));
      updateTransformPanel();
    }
  };

  const endDrag = (ev) => {
    if (!state.mode) return;
    const mode = state.mode;
    const moved = state.moved;
    const grouped = state.grouped;
    state.mode = null;
    state.moved = false;
    state.grouped = false;
    canvas.classList.remove('is-dragging');
    try { canvas.releasePointerCapture(ev.pointerId); } catch (_) { /* 忽略 */ }
    if (grouped) endGroupEdit();
    if (mode === 'orbit' && moved) {
      log('info', `视角：方位 ${app.azimuth}° · 俯角 ${app.elevation}°`);
    }
    if (mode === 'move' && moved) {
      const p = app.placement.position;
      log('info', `拖动摆放 → position [${p.map((v) => v.toFixed(3)).join(', ')}]（改的是模型本身）`);
      updateTransformPanel({ blur: true });
    }
  };

  const onWheel = (ev) => {
    if (!app.asset) return;
    ev.preventDefault();
    const step = ev.deltaY > 0 ? -0.08 : 0.08;
    setZoom(app.zoom + step * Math.max(0.5, app.zoom));
  };

  canvas.addEventListener('pointerdown', onDown);
  canvas.addEventListener('pointermove', onMove);
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('wheel', onWheel, { passive: false });
  // 中键在部分浏览器会触发自动滚动/粘贴，直接挡掉。
  canvas.addEventListener('auxclick', (ev) => { if (ev.button === 1) ev.preventDefault(); });
  canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
}

// ---------------------------------------------------------------- controls

function syncFrameRateUI() {
  const v = app.frameRate === 'auto' ? 'auto' : String(app.frameRate);
  if (![...el.frameRate.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = `${v}fps`;
    el.frameRate.appendChild(opt);
  }
  el.frameRate.value = v;
}

function bindControls() {
  el.search.addEventListener('input', () => {
    app.search = el.search.value;
    if (app.search.trim()) window.__g3dwebLayout?.expand('list');
    refreshList();
  });
  el.tabs.addEventListener('click', (e) => {
    const btn = e.target.closest('.tab');
    if (!btn) return;
    app.group = btn.dataset.group;
    for (const t of el.tabs.querySelectorAll('.tab')) t.classList.toggle('active', t === btn);
    window.__g3dwebLayout?.expand('list');
    refreshList();
  });
  el.prev.addEventListener('click', () => stepModel(-1));
  el.next.addEventListener('click', () => stepModel(1));
  el.reload.addEventListener('click', () => {
    if (!app.path) return;
    log('info', `重新加载 ${app.path}`);
    selectModel(app.path, true);
  });

  el.stateButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('.state-btn');
    if (!btn) return;
    if (app.eu5sm) {
      log('info', 'EU5 状态机开启中：请用右侧 UnitState 选择 0~4');
      return;
    }
    app.state = btn.dataset.state;
    updateStateUI();
    updateHud(true);
  });
  el.override.addEventListener('change', () => {
    app.overrides[app.state] = el.override.value;
    app.times[app.state] = 0;
    updateStateUI();
    updateScrub();
  });
  el.play.addEventListener('click', () => {
    app.playing = !app.playing;
    updatePlayButton();
  });
  el.restart.addEventListener('click', resetPlayback);
  el.stepBack.addEventListener('click', () => stepFrame(-1));
  el.step.addEventListener('click', () => stepFrame(1));
  el.scrub.addEventListener('input', () => {
    app.playing = false;
    updatePlayButton();
    setFrame(Number(el.scrub.value));
  });
  el.frameRate.addEventListener('change', () => {
    const v = el.frameRate.value;
    app.frameRate = v === 'auto' ? 'auto' : (Number(v) || 30);
    updateScrub();
    updateHud(true);
  });
  el.speed.addEventListener('input', () => {
    app.speed = Number(el.speed.value);
    el.speedVal.textContent = app.speed.toFixed(2) + '×';
  });
  el.clamp.addEventListener('change', () => { app.clampTrackEnd = el.clamp.checked; });

  el.facing.addEventListener('input', () => {
    const v = Number(el.facing.value);
    if (v !== app.facing) beginEdit('模型朝向', 'facing');
    app.facing = v;
    el.facingVal.textContent = `${app.facing}°`;
  });
  el.facingReset.addEventListener('click', () => {
    if (app.facing !== 0) beginEdit('模型朝向');
    app.facing = 0;
    el.facing.value = '0';
    el.facingVal.textContent = '0°';
  });
  el.zoom.addEventListener('input', () => setZoom(Number(el.zoom.value)));
  el.azimuth.addEventListener('input', () => setAzimuth(Number(el.azimuth.value)));
  el.elevation.addEventListener('input', () => setElevation(Number(el.elevation.value)));
  el.cameraReset.addEventListener('click', () => {
    setZoom(1);
    setAzimuth(0);
    setElevation(0);
  });
  el.fitpct.addEventListener('input', () => {
    app.fitPct = Number(el.fitpct.value);
    el.fitpctVal.textContent = app.fitPct.toFixed(2);
  });
  el.fitmax.addEventListener('change', () => { app.fitByMax = el.fitmax.checked; });
  el.worldh.addEventListener('change', () => {
    const v = Number(el.worldh.value);
    app.worldH = Number.isFinite(v) ? Math.max(0.5, Math.min(50, v)) : G3D_DEFAULTS.worldH;
    el.worldh.value = String(app.worldH);
  });

  // 摆放 / 缩放（改模型本身，不是镜头）
  el.transformRef.addEventListener('change', () => setTransformRef(el.transformRef.value));
  for (const node of [el.transformCx, el.transformCy, el.transformCz]) {
    node.addEventListener('change', applyTransformRef);
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); node.blur(); applyTransformRef(); }
    });
  }
  for (const node of [el.transformRefX, el.transformRefY, el.transformRefZ]) {
    node.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); node.blur(); applyCustomRefPoint(); }
    });
  }
  el.transformRefApply.addEventListener('click', applyCustomRefPoint);
  if (el.refMarker) {
    el.refMarker.checked = !!app.refMarker;
    el.refMarker.addEventListener('change', () => {
      app.refMarker = el.refMarker.checked;
      log('info', `参考点高亮${app.refMarker ? '开' : '关'}`);
    });
  }
  el.transformScale.addEventListener('change', applyTransformScale);
  el.transformScale.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); el.transformScale.blur(); applyTransformScale(); }
  });
  el.transformReset.addEventListener('click', () => {
    resetModelPlacement();
    log('info', '摆放 / 缩放已复位（模型回到 G3DArmy 默认：脚底在原点、等比适配；参考点 = 包围盒中心）');
  });
  if (el.undoBtn) el.undoBtn.addEventListener('click', () => undoEdit());
  if (el.redoBtn) el.redoBtn.addEventListener('click', () => redoEdit());

  el.tintMode.addEventListener('change', () => {
    app.tintMode = el.tintMode.value;
    el.tintColor.disabled = app.tintMode !== 'custom';
  });
  el.tintColor.addEventListener('input', () => {
    if (app.tintMode !== 'custom') {
      app.tintMode = 'custom';
      el.tintMode.value = 'custom';
    }
  });
  el.tintStrength.addEventListener('input', () => {
    app.tintStrength = Number(el.tintStrength.value);
    el.tintStrengthVal.textContent = app.tintStrength.toFixed(2);
  });
  el.footdark.addEventListener('input', () => {
    app.feetDark = Number(el.footdark.value);
    el.footdarkVal.textContent = app.feetDark.toFixed(2);
  });
  el.footdark.addEventListener('change', () => {
    if (app.asset && renderer) {
      renderer.feetDark = app.feetDark;
      try {
        renderer.setModel(app.asset);
        log('info', `脚底 AO 重建顶点色：bottom=${app.feetDark.toFixed(2)}`);
      } catch (e) {
        log('error', `重建失败: ${e.message || e}`);
      }
    }
  });
  el.shadow.addEventListener('change', () => { app.shadow = el.shadow.checked; });
  el.skeleton.addEventListener('change', () => {
    app.skeleton = el.skeleton.checked;
    if (app.skeleton && el.skeletonMode) app.skeletonMode = el.skeletonMode.value || 'all';
  });
  el.skeletonMode?.addEventListener('change', () => {
    app.skeletonMode = el.skeletonMode.value || 'all';
    app.skeleton = true;
    if (el.skeleton) el.skeleton.checked = true;
  });
  el.grid.addEventListener('change', () => { app.grid = el.grid.checked; });
  el.white.addEventListener('change', () => { app.white = el.white.checked; });

  el.particles.addEventListener('change', () => {
    app.particles = el.particles.checked;
    if (el.vfxBadge) el.vfxBadge.textContent = app.particles ? '开' : '关';
  });
  el.particleWeapon.addEventListener('change', () => {
    app.particleWeapon = el.particleWeapon.value;
    log('info', `粒子武器覆盖=${app.particleWeapon}`);
  });
  el.eu5sm.addEventListener('change', () => {
    app.eu5sm = el.eu5sm.checked;
    if (app.eu5sm) {
      app.sm = createUnitStateMachine('Idle');
      if (app.smRandom) app.sm.randomPhase = true;
      const snap = app.sm.snapshot();
      app.state = snap.displayState;
      app.times[app.state] = snap.time;
      app.prevTimes[app.state] = snap.time;
      app.playing = true;
      updatePlayButton();
      log('info', `EU5 状态机开启：UnitState=${UNIT_STATE_NAMES[app.unitState]}`);
    } else {
      log('info', 'EU5 状态机关闭（恢复手动四态）');
    }
    updateStateUI();
    updateHud(true);
  });
  el.eu5State.addEventListener('change', () => {
    app.unitState = Number(el.eu5State.value) || 0;
    if (app.sm) app.sm.unitState = app.unitState;
    log('info', `UnitState=${app.unitState} (${UNIT_STATE_NAMES[app.unitState]})`);
  });
  el.smRandom.addEventListener('change', () => {
    app.smRandom = el.smRandom.checked;
    if (app.sm) app.sm.randomPhase = app.smRandom;
  });
  el.smAuto.addEventListener('change', () => {
    app.smAuto = el.smAuto.checked;
    app.smAutoT = 0;
  });

  const applyRuntimeSelection = (patch = {}) => {
    const current = app.runtimeSelection || {};
    app.runtimeSelection = {
      ...current,
      ...patch,
      civ: el.runtimeCiv?.value || null,
      // 只有手动改「兵种规则」时才锁定 ruleKey；切 civ/group/level 仍走自动选型（与游戏一致）
      ruleKey: patch.ruleKey !== undefined ? patch.ruleKey : (current.ruleKey || null),
      group: el.runtimeGroup?.value || null,
      level: el.runtimeLevel?.value === '' ? null : Number(el.runtimeLevel?.value),
      aId: el.runtimeAid?.value === '' ? null : Number(el.runtimeAid?.value),
      religion: el.runtimeReligion?.value?.trim() || null,
      religionGroup: el.runtimeReligionGroup?.value === '' ? null : Number(el.runtimeReligionGroup?.value),
    };
    if (!Number.isFinite(app.runtimeSelection.level)) app.runtimeSelection.level = null;
    if (!Number.isFinite(app.runtimeSelection.aId)) app.runtimeSelection.aId = null;
    if (!Number.isFinite(app.runtimeSelection.religionGroup)) app.runtimeSelection.religionGroup = null;
    if (app.path) selectModel(app.path, true);
  };
  el.runtimeRule.addEventListener('change', () => applyRuntimeSelection({ ruleKey: el.runtimeRule.value || null }));
  el.runtimeGroup.addEventListener('change', () => applyRuntimeSelection({ group: el.runtimeGroup.value || null }));
  el.runtimeCiv?.addEventListener('change', () => applyRuntimeSelection({ civ: el.runtimeCiv.value || null }));
  el.runtimeLevel?.addEventListener('change', () => applyRuntimeSelection());
  el.runtimeAid?.addEventListener('change', () => applyRuntimeSelection());
  el.runtimeReligion?.addEventListener('change', () => applyRuntimeSelection());
  el.runtimeReligionGroup?.addEventListener('change', () => applyRuntimeSelection());

  el.logClear.addEventListener('click', () => { el.log.innerHTML = ''; });
  el.logCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.log.innerText);
      log('ok', '日志已复制到剪贴板');
    } catch (e) {
      log('warn', '复制失败：' + (e.message || e));
    }
  });
  el.report.addEventListener('click', report);
  el.aiRun.addEventListener('click', () => showAiReport(diagnose()));
  el.aiScan.addEventListener('click', () => {
    log('info', 'AI 扫描当前状态的所有帧…');
    const res = scanAnimation({ state: app.state });
    showAiReport(res);
  });
  el.aiClose.addEventListener('click', () => el.aiPanel.classList.add('hidden'));
  el.aiCopy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(el.aiReport.textContent || '');
      log('ok', 'AI 诊断 JSON 已复制');
    } catch (e) {
      log('warn', '复制失败：' + (e.message || e));
    }
  });

  window.addEventListener('keydown', (e) => {
    const tag = (e.target && e.target.tagName) || '';
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      if (e.shiftKey) redoEdit();
      else undoEdit();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redoEdit(); return; }
    if (e.code === 'Space') { e.preventDefault(); app.playing = !app.playing; updatePlayButton(); }
    else if (e.key === 'ArrowLeft' || e.key === ',') { e.preventDefault(); stepFrame(-1); }
    else if (e.key === 'ArrowRight' || e.key === '.') { e.preventDefault(); stepFrame(1); }
    else if (e.key === '1') { app.state = 'idle'; updateStateUI(); updateHud(true); }
    else if (e.key === '2') { app.state = 'move'; updateStateUI(); updateHud(true); }
    else if (e.key === '3') { app.state = 'battle'; updateStateUI(); updateHud(true); }
    else if (e.key === '4') { app.state = 'retreat'; updateStateUI(); updateHud(true); }
    else if (e.key === 'r' || e.key === 'R') resetPlayback();
    else if (e.key === '[') stepModel(-1);
    else if (e.key === ']') stepModel(1);
    else if (e.key === 'g' || e.key === 'G') { app.grid = !app.grid; el.grid.checked = app.grid; }
    else if (e.key === 's' || e.key === 'S') { app.skeleton = !app.skeleton; el.skeleton.checked = app.skeleton; }
    else if (e.key === 'w' || e.key === 'W') { app.white = !app.white; el.white.checked = app.white; }
  });

  window.addEventListener('hashchange', () => {
    let p = '';
    try { p = decodeURIComponent(location.hash.slice(1)); } catch { p = ''; }
    if (p && p !== app.path) selectModel(p);
  });
}

function stepModel(dir) {
  if (!app.filtered.length) return;
  const idx = app.filtered.findIndex((m) => m.path === app.path);
  const next = idx < 0 ? 0 : (idx + dir + app.filtered.length) % app.filtered.length;
  selectModel(app.filtered[next].path);
}

// ---------------------------------------------------------------- main loop

function frame(now) {
  requestAnimationFrame(frame);
  const rawDt = Math.max(0, (now - (frame.last || now)) / 1000);
  frame.last = now;
  const dt = Math.min(0.1, rawDt);
  frameCount++;
  if (now - fpsTime >= 500) {
    app.fps = frameCount * 1000 / (now - fpsTime);
    frameCount = 0;
    fpsTime = now;
  }
  // 暂停/截图时冻结粒子，避免看截图时粒子已经过期
  app.dt = app.playing ? dt : 0;
  if (app.eu5sm && app.smAuto && app.playing) {
    app.smAutoT += dt;
    if (app.smAutoT >= 3.0) {
      app.smAutoT = 0;
      const seq = [0, 1, 2, 0, 3, 0];
      const idx = seq.indexOf(app.unitState);
      app.unitState = seq[(idx + 1) % seq.length];
      el.eu5State.value = String(app.unitState);
      if (app.sm) app.sm.unitState = app.unitState;
    }
  }
  if (app.playing) advance(dt);
  if (!renderer) return;
  try {
    renderer.render(app.asset, buildView());
  } catch (e) {
    showError(e);
    renderer = null;
    log('error', `渲染失败: ${e.message || e}`);
  }
  updateHud();
}

// ---------------------------------------------------------------- boot

async function boot() {
  const params = new URLSearchParams(location.search);
  app.shot = params.get('shot') === '1';
  app.autoDiag = params.get('diag') === '1';
  app.deepState = params.get('state');
  if (params.has('t')) {
    const t = Number(params.get('t'));
    app.deepTime = Number.isFinite(t) ? t : null;
  }
  if (params.has('frame')) {
    const f = Number(params.get('frame'));
    app.deepFrame = Number.isFinite(f) ? Math.round(f) : null;
  }
  const fpsParam = params.get('fps');
  if (fpsParam) {
    if (fpsParam === 'auto') app.frameRate = 'auto';
    else {
      const v = Number(fpsParam);
      if (Number.isFinite(v) && v > 0 && v <= 240) app.frameRate = v;
    }
  }
  if (app.shot) {
    document.body.classList.add('shot');
    app.playing = false;
  }

  initLayoutDrawers();
  bindControls();
  bindViewInteraction();
  updateHistoryUI();
  syncFrameRateUI();
  el.tintColor.disabled = true;
  try {
    renderer = new Renderer(el.canvas, log);
  } catch (e) {
    showError(e);
    log('error', `WebGL 初始化失败: ${e.message || e}`);
  }
  updatePlayButton();
  updateStateUI();
  updateHud(true);
  await loadModelIndex();
  // 页面打开时定期发心跳：服务端 idle-timeout 只回收无人使用的端口。
  const heartbeat = () => fetch('/api/ping', { cache: 'no-store' }).catch(() => {});
  heartbeat();
  setInterval(heartbeat, 20000);
  requestAnimationFrame(frame);
}

// 调试钩子（浏览器控制台 / 自动化测试用）
window.__g3dweb = {
  app,
  get renderer() { return renderer; },
  get layout() { return window.__g3dwebLayout; },
  buildView,
  report,
  frameInfo,
  setFrame,
  diagnose,
  scanAnimation,
  probeFrames,
  probe: probeFrames,
  scanFrames: probeFrames,
  set: applyAiControls,
  showAiReport,

  // AI 放置 / 三维变换
  placeModel: setModelPlacement,
  setPlacement: setModelPlacement,
  placeObject: setModelPlacement,
  setObjectTransform: setModelPlacement,
  setPosition: (position) => setModelPlacement({ position }),
  setRotation: (rotation) => setModelPlacement({ rotation }),
  setScale: (scale) => setModelPlacement({ scale }),
  getPlacement,
  getModelMetrics,
  // 设置参考点（面板下拉的 API 版）：'center' | 'feetCenter' | 'custom'
  setModelReference: setTransformRef,
  // 自定义参考点：直接给场景全局坐标（= 下拉里「自定义」那一行）
  setCustomRefPoint: (point) => {
    if (!Array.isArray(point) && !(point && typeof point === 'object')) {
      throw new Error('setCustomRefPoint 需要 [x, y, z] 或 {x,y,z}');
    }
    if (transformRefKey() !== 'custom') setTransformRef('custom');
    translateRefTo(cloneVec3(point, [0, 0, 0]));
    updateTransformPanel({ blur: true });
    return getModelMetrics();
  },
  // 自定义参考点的局部（模型空间）坐标：脱绑 bbox 时用它固定一个直观位置
  setCustomRefLocal,
  setModelCenter: (point, ref = null) => {
    if (!renderer || !renderer.lastModel) return null;
    if (!Array.isArray(point) && !(point && typeof point === 'object')) {
      throw new Error('setModelCenter 需要 [x, y, z] 或 {x,y,z}');
    }
    const key = TRANSFORM_REFS[ref] ? ref : transformRefKey();
    if (key !== transformRefKey()) setTransformRef(key);
    translateRefTo(cloneVec3(point, [0, 0, 0]));
    updateTransformPanel({ blur: true });
    return getModelMetrics();
  },
  // 参考点的场景绝对坐标（同面板输入框）
  getModelReference: () => {
    const m = renderer && renderer.lastModel;
    const p = transformRefPoint(m);
    return p ? { ref: transformRefKey(), point: r3v(p) } : null;
  },
  // 参考点高亮小球开关（面板勾选框的 API 版）
  setRefMarker: (enabled) => {
    app.refMarker = enabled == null ? true : !!enabled;
    if (el.refMarker) el.refMarker.checked = app.refMarker;
    return app.refMarker;
  },
  getModelMatrix: () => (renderer?.lastWorld ? Array.from(renderer.lastWorld) : null),

  // 视图交互（画布鼠标捕获的 API 版）
  setZoom,
  setAzimuth,
  setElevation,
  // 撤销 / 重做（Ctrl+Z / Ctrl+Shift+Z），作用域 = 摆放/缩放 + 参考点 + 视角
  undo: undoEdit,
  redo: redoEdit,
  history: () => ({
    undo: history.undo.map((e) => e.label),
    redo: history.redo.map((e) => e.label),
    canUndo: history.undo.length > 0,
    canRedo: history.redo.length > 0,
  }),
  setCamera: (opts = {}) => {
    if (opts.zoom != null) setZoom(opts.zoom);
    if (opts.azimuth != null) setAzimuth(opts.azimuth);
    if (opts.elevation != null) setElevation(opts.elevation);
    return { zoom: app.zoom, azimuth: app.azimuth, elevation: app.elevation };
  },
  getCamera: () => ({ zoom: app.zoom, azimuth: app.azimuth, elevation: app.elevation, camera: renderer ? renderer.lastCamera : null }),
  // 屏幕坐标（CSS 像素，相对画布左上角）命中测试
  pickModel: (x, y) => {
    const r = el.canvas.getBoundingClientRect();
    const hit = pickModelAt(r.left + Number(x), r.top + Number(y));
    return { hit: !!hit.hit, reason: hit.reason || null, part: hit.part ? hit.part.name || hit.part.id || null : null, triangle: hit.triangle ?? null };
  },
  selectModel3D: (enabled) => setSelected(enabled == null ? true : !!enabled),
  isSelected: () => !!app.selected,
  moveModel,
  moveObject: moveModel,
  rotateModel,
  rotateObject: rotateModel,
  scaleModel,
  resetPlacement: resetModelPlacement,
  setModelMatrix,
  worldToScreen: screenOfWorldPoint,

  // 骨架 / 绑定
  skeleton: buildSkeletonReport,
  getSkeleton: buildSkeletonReport,
  bindings: buildSkeletonReport,
  setSkeletonHighlight,
  highlightBones,
  clearSkeletonHighlight: () => setSkeletonHighlight({ enabled: false, bones: [], mode: 'all' }),
};

boot();
