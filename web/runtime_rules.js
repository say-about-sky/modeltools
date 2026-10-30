// G3DArmy v4.9.14 运行时装配规则（g3d-web 版）
//
// 与 A:\android\Age.of.History.3\G3DArmy\src\com\saysky\g3darmy\G3DArmyPlugin.java 保持同步
// （v4.7.0 起选择语义未变；v4.8/4.9 只动了渲染窗口/相机/缓存，本文件只负责选型与挂件）：
//   loadSelect.json:
//     unitSelect = 宗教块数组 [ { "religion": "Catholic", "0:Warior": { level: {...} } }, ... ]
//                  或旧格式对象 { "0:Warior": {...} }
//     unitgroup  = 文化组兜底（unitgroup.<文化组>.<兵种>.level，或直接在 unitgroup 下按兵种写）
//   attachments.json:
//     unitSelect / unitgroup 同上；shipSelect 可写单条规则或按兵种分组；旧字段 rules == unitSelect
//   civilization/<tag>.json:
//     顶层 unitSelect / shipSelect（数组或对象）；attachments.unitSelect / unitgroup / shipSelect
//
// 选择顺序（条目内）：byId > religion > religionGroup > group > level > default（depth <= 8）
// 模型优先级：civilization 文件 > 全局 unitSelect（宗教块）> unitgroup（文化组）

export function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function mergeJsonDeep(base, over) {
  if (!isObject(base) || !isObject(over)) return over === undefined ? base : over;
  const out = { ...base };
  for (const [key, value] of Object.entries(over)) {
    out[key] = isObject(out[key]) && isObject(value) ? mergeJsonDeep(out[key], value) : value;
  }
  return out;
}

/** unitSelect 覆盖合并：数组块覆盖方排在前面（与 G3DArmyPlugin.mergeUnitConfig 一致）。 */
export function mergeUnitConfig(base, over) {
  if (base == null) return over;
  if (over == null) return base;
  if (Array.isArray(base) && Array.isArray(over)) return [...over, ...base];
  if (Array.isArray(base) && isObject(over)) return [over, ...base];
  if (isObject(base) && Array.isArray(over)) return [...over, base];
  if (isObject(base) && isObject(over)) return mergeJsonDeep(base, over);
  return base;
}

export function unitNodeLabel(node) {
  if (node == null) return '无';
  if (Array.isArray(node)) return `数组(${node.length}块)`;
  if (isObject(node)) return `对象(${Object.keys(node).filter((k) => !k.startsWith('_')).length})`;
  return '标量';
}

export function typeNameOfKey(key) {
  const s = String(key ?? '');
  return s.includes(':') ? s.slice(s.indexOf(':') + 1) : s;
}

export function typeIdOfKey(key) {
  const s = String(key ?? '');
  const n = Number(s.includes(':') ? s.slice(0, s.indexOf(':')) : s);
  return Number.isFinite(n) ? n : null;
}

/** "0-3" 区间 / "7+" 及以上 / "3" 精确。 */
export function levelInRange(key, level) {
  const k = String(key ?? '').trim();
  if (!k) return false;
  if (k.endsWith('+')) {
    const n = Number(k.slice(0, -1).trim());
    return Number.isFinite(n) && level >= n;
  }
  const dash = k.indexOf('-');
  if (dash > 0) {
    const lo = Number(k.slice(0, dash).trim());
    const hi = Number(k.slice(dash + 1).trim());
    return Number.isFinite(lo) && Number.isFinite(hi) && level >= lo && level <= hi;
  }
  const n = Number(k);
  return Number.isFinite(n) && level === n;
}

/** 等级段的一个代表值（用于自动从模型反推规则）。 */
export function levelSample(key) {
  const k = String(key ?? '').trim();
  if (k.endsWith('+')) {
    const n = Number(k.slice(0, -1));
    return Number.isFinite(n) ? n : 0;
  }
  const dash = k.indexOf('-');
  if (dash > 0) {
    const n = Number(k.slice(0, dash));
    return Number.isFinite(n) ? n : 0;
  }
  const n = Number(k);
  return Number.isFinite(n) ? n : 0;
}

export function isShipModel(model) {
  const category = String(model?.category || '').toLowerCase();
  const name = String(model?.name || '').toLowerCase();
  return category === 'ship' || name.startsWith('ship_');
}

/**
 * G3DArmyMin.weaponFamilyFromSig 的 JS 版：挂件签名 → 武器族
 * （crossbow / musket / bow / spear / sword；null = 没挂件/认不出）。
 * 插件里有两处用它：① assembly.animDonors 借动画；② anim_events.json 的攻击事件表。
 */
export function weaponFamilyFromSig(sig) {
  if (sig == null || sig === '') return null;
  const s = String(sig).toLowerCase();
  if (s.includes('crossbow')) return 'crossbow';
  if (['musket', 'flintlock', 'matchlock', 'arquebus', 'handgonne', 'handgonna', 'pistol']
    .some((x) => s.includes(x))) return 'musket';
  if (s.includes('bow')) return 'bow';
  if (['spear', 'pike', 'lance', 'halberd'].some((x) => s.includes(x))) return 'spear';
  if (['sword', 'blade', 'saber', 'rapier', 'axe', 'mace', 'knife', 'katar']
    .some((x) => s.includes(x))) return 'sword';
  return null;
}

/**
 * assembly.combos[*].animSet 允许字符串或数组（v4.4+，如 `["musket_r", "horse"]`），
 * 插件会拼成逗号串再按逗号拆；这里统一成去空列表（顺序不变）。
 */
export function animSetList(value) {
  if (value == null) return [];
  const out = [];
  for (const item of Array.isArray(value) ? value : [value]) {
    for (const part of String(item).split(',')) {
      const s = part.trim();
      if (s) out.push(s);
    }
  }
  return out;
}

export function runtimeCiv(runtime, civTag) {
  if (!civTag) return null;
  return runtime?.civs?.[civTag] || null;
}

/** 旧写法：没有 unitSelect 时整段就是兵种表（与 civSection(legacyFlatAsUnit=true) 一致）。 */
function baseUnitSelectOf(node) {
  if (!isObject(node)) return null;
  if (node.unitSelect !== undefined && node.unitSelect !== null) return node.unitSelect;
  if (node.shipSelect != null || node.unitgroup != null) return null;
  return node;
}

/** civilization/<tag>.json 顶层 unitSelect；旧写法 loadSelect.unitSelect / 扁平 loadSelect。 */
export function civUnitSelectOf(civ) {
  if (!isObject(civ)) return null;
  if (civ.unitSelect !== undefined && civ.unitSelect !== null) return civ.unitSelect;
  return baseUnitSelectOf(civ.loadSelect);
}

/** civilization/<tag>.json 顶层 shipSelect；旧写法 loadSelect.shipSelect。 */
export function civShipSelectOf(civ) {
  if (!isObject(civ)) return null;
  if (civ.shipSelect !== undefined && civ.shipSelect !== null) return civ.shipSelect;
  return isObject(civ.loadSelect) ? (civ.loadSelect.shipSelect ?? null) : null;
}

/**
 * 选择上下文。
 * religion 支持数字 ID、英文名、本地化名；religionGroup 是 ReligionGroupID（0~5）。
 * 未提供 = 未知（宗教条件块不会命中，等价于游戏里 religionID < 0）。
 */
export function makeContext(selection = {}, overrides = {}) {
  const rawReligion = selection?.religion == null ? '' : String(selection.religion).trim();
  const numeric = /^-?\d+$/.test(rawReligion);
  const rawGroup = selection?.religionGroup;
  const rg = rawGroup === '' || rawGroup == null ? null : Number(rawGroup);
  const rawLevel = selection?.level;
  const level = rawLevel == null || rawLevel === '' ? 0 : Number(rawLevel);
  const rawAid = selection?.aId;
  const aId = rawAid == null || rawAid === '' ? null : Number(rawAid);
  return {
    religionId: numeric ? Number(rawReligion) : null,
    religionName: rawReligion && !numeric ? rawReligion : '',
    religionGroup: Number.isFinite(rg) ? rg : null,
    level: Number.isFinite(level) ? level : 0,
    aId: Number.isFinite(aId) ? aId : null,
    unitName: selection?.unitName || null,
    group: selection?.group || null,
    ...overrides,
  };
}

/** 在 religion 表里按「数字 ID → 英文名（大小写不敏感）」查找。 */
export function religionValueOf(map, ctx) {
  if (!isObject(map)) return null;
  if (ctx.religionId != null) {
    const v = map[String(ctx.religionId)];
    if (v != null) return v;
  }
  if (ctx.religionName) {
    const name = String(ctx.religionName);
    const direct = map[name];
    if (direct != null) return direct;
    const key = Object.keys(map).find((k) => k.toLowerCase() === name.toLowerCase());
    if (key) return map[key];
  }
  return null;
}

/** religion 条件：字符串（名称/ID）/ 数字 / 数组 / {键:值} 表。 */
export function religionMatches(v, ctx) {
  if (v == null) return true;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return false;
    if (/^-?\d+$/.test(s)) return ctx.religionId != null && Number(s) === ctx.religionId;
    return !!ctx.religionName && s.toLowerCase() === String(ctx.religionName).toLowerCase();
  }
  if (typeof v === 'number') return ctx.religionId != null && v === ctx.religionId;
  if (Array.isArray(v)) return v.some((c) => religionMatches(c, ctx));
  if (isObject(v)) return religionValueOf(v, ctx) != null;
  return false;
}

/** religionGroup 条件：数字 / 数字字符串 / 数组 / 表键。 */
export function religionGroupMatches(v, ctx) {
  if (v == null) return true;
  const rg = ctx.religionGroup;
  if (typeof v === 'number') return rg != null && v === rg;
  if (typeof v === 'string') {
    const n = Number(v.trim());
    return Number.isFinite(n) && rg != null && n === rg;
  }
  if (Array.isArray(v)) return v.some((c) => religionGroupMatches(c, ctx));
  if (isObject(v)) return rg != null && v[String(rg)] != null;
  return false;
}

/** group 条件：字符串 / 数组 / 表键（大小写不敏感）。 */
export function groupMatches(v, group) {
  if (v == null) return true;
  if (group == null || group === '') return false;
  const want = String(group).toLowerCase();
  if (typeof v === 'string') return v.toLowerCase() === want;
  if (Array.isArray(v)) return v.some((c) => groupMatches(c, group));
  if (isObject(v)) {
    if (v[group] != null) return true;
    return Object.keys(v).some((k) => k.toLowerCase() === want);
  }
  return false;
}

/** 数组宗教块的匹配条件（religion / religionGroup / group 未写 = 通配）。 */
export function blockMatches(block, ctx) {
  if (!isObject(block)) return false;
  if (block.religion != null && !religionMatches(block.religion, ctx)) return false;
  if (block.religionGroup != null && !religionGroupMatches(block.religionGroup, ctx)) return false;
  if (block.group != null && !groupMatches(block.group, ctx.group)) return false;
  return true;
}

/** 在 unitSelect 对象里取兵种条目：优先 "<uid>:<Type>"，其次 "<Type>"，最后 "<uid>"；未知类型按前缀找。 */
export function typeEntry(root, uid, typeName) {
  if (!isObject(root)) return null;
  const idKey = String(uid);
  const name = typeName == null ? '' : String(typeName);
  if (name) {
    const withId = root[`${idKey}:${name}`];
    if (withId != null) return withId;
    const byName = root[name];
    if (byName != null) return byName;
  } else {
    const prefix = `${idKey}:`;
    const key = Object.keys(root).find((k) => k.startsWith(prefix));
    if (key) return root[key];
  }
  const byId = root[idKey];
  return byId === undefined ? null : byId;
}

/** v4.6 统一选择器（模型/挂件通用）。终端值可以是字符串或挂件数组。 */
export function selectNode(entry, ctx, depth = 0) {
  if (entry == null || depth > 8) return null;
  if (typeof entry === 'string' || Array.isArray(entry)) return entry;
  if (!isObject(entry)) return null;
  // ① byId：具体兵团（aID 或兵团名）
  if (isObject(entry.byId)) {
    let v = ctx.aId != null ? entry.byId[String(ctx.aId)] : undefined;
    if (v === undefined && ctx.unitName) {
      v = entry.byId[ctx.unitName];
      if (v === undefined) {
        const key = Object.keys(entry.byId).find((k) => k.toLowerCase() === String(ctx.unitName).toLowerCase());
        if (key) v = entry.byId[key];
      }
    }
    if (v !== undefined && v !== null) {
      const r = selectNode(v, ctx, depth + 1);
      if (r != null) return r;
    }
  }
  // ② religion：具体宗教
  if (entry.religion != null) {
    const v = religionValueOf(entry.religion, ctx);
    if (v != null) {
      const r = selectNode(v, ctx, depth + 1);
      if (r != null) return r;
    }
  }
  // ③ religionGroup：宗教大组
  if (entry.religionGroup != null && ctx.religionGroup != null) {
    const v = entry.religionGroup[String(ctx.religionGroup)];
    if (v != null) {
      const r = selectNode(v, ctx, depth + 1);
      if (r != null) return r;
    }
  }
  // ④ group：文化簇
  if (isObject(entry.group) && ctx.group) {
    let v = entry.group[ctx.group];
    if (v == null) {
      const key = Object.keys(entry.group).find((k) => k.toLowerCase() === String(ctx.group).toLowerCase());
      if (key) v = entry.group[key];
    }
    if (v != null) {
      const r = selectNode(v, ctx, depth + 1);
      if (r != null) return r;
    }
  }
  // ⑤ level：等级段（可出现在任意层级）
  if (isObject(entry.level)) {
    for (const [key, value] of Object.entries(entry.level)) {
      if (!levelInRange(key, ctx.level ?? 0)) continue;
      const r = selectNode(value, ctx, depth + 1);
      if (r != null) return r;
    }
  }
  // ⑥ default
  if (entry.default != null) return selectNode(entry.default, ctx, depth + 1);
  return null;
}

/**
 * v4.7：在 unitSelect 节点（数组=宗教块 / 对象=旧格式）里找兵种条目并解析。
 * 数组块可用 religion / religionGroup / group 作为块条件；无条件块（文明文件）直接匹配。
 */
export function resolveUnitNode(node, ctx, uid, typeName, depth = 0) {
  if (node == null || depth > 8) return null;
  if (Array.isArray(node)) {
    for (const block of node) {
      if (!isObject(block) || !blockMatches(block, ctx)) continue;
      const entry = typeEntry(block, uid, typeName);
      if (entry == null) continue;
      const r = selectNode(entry, ctx, depth + 1);
      if (r != null) return r;
    }
    return null;
  }
  if (!isObject(node)) return null;
  const entry = typeEntry(node, uid, typeName);
  if (entry == null) return null;
  return selectNode(entry, ctx, depth + 1);
}

/** 模型解析入口（处理 @fallback_foot / @fallback_none）。 */
export function resolveComboFromRoot(root, ctx, uid, typeName, depth = 0) {
  const v = resolveUnitNode(root, ctx, uid, typeName, depth);
  if (v == null || typeof v !== 'string') return null;
  if (v.startsWith('@fallback_foot')) {
    // 用同一根节点解析步兵（0:Warior），保持宗教/文化上下文
    return resolveComboFromRoot(root, ctx, 0, 'Warior', depth + 1);
  }
  if (v.startsWith('@')) return null; // @fallback_none 等 = 没有对应模型
  return v;
}

function unitGroupTable(ug, group) {
  if (!isObject(ug) || !group) return null;
  let g = ug[group];
  if (g == null) {
    const key = Object.keys(ug).find((k) => k.toLowerCase() === String(group).toLowerCase());
    if (key) g = ug[key];
  }
  return isObject(g) ? g : null;
}

/** unitgroup 兜底：先查文化组专属表，再查旧式“单位类型直写”表。 */
export function resolveUnitGroupValue(ug, ctx, uid, typeName, depth = 0) {
  if (!isObject(ug) || depth > 8) return null;
  const table = unitGroupTable(ug, ctx.group);
  if (table) {
    const v = resolveUnitNode(table, ctx, uid, typeName, depth + 1);
    if (v != null) return v;
  }
  return resolveUnitNode(ug, ctx, uid, typeName, depth + 1);
}

export function resolveUnitGroupCombo(ug, ctx, uid, typeName, depth = 0) {
  const v = resolveUnitGroupValue(ug, ctx, uid, typeName, depth);
  return typeof v === 'string' ? v : null;
}

/** 是否是一条规则条目（byId/religion/religionGroup/group/level/default 任一存在）。 */
export function isRuleEntry(v) {
  return isObject(v)
    && (v.byId != null || v.religion != null || v.religionGroup != null
      || v.group != null || v.level != null || v.default != null);
}

/** 挂件节点解析：船规则条目用 selectNode；数组/兵种表用 resolveUnitNode。 */
export function resolveAttachValue(rules, ship, ctx, uid, typeName, depth = 0) {
  if (rules == null || depth > 8) return null;
  if (ship && isRuleEntry(rules)) return selectNode(rules, ctx, depth + 1);
  return resolveUnitNode(rules, ctx, uid, typeName, depth + 1);
}

/**
 * 全局 loadSelect（含 loadSelect.override.json）。
 * global = unitSelect 节点（数组/对象），globalGroup = unitgroup，globalShip = shipSelect。
 */
export function runtimeSelectRoots(runtime, civTag) {
  const base = runtime?.unitSelect || {};
  const override = runtime?.override || null;
  let global = baseUnitSelectOf(base);
  if (override && override.unitSelect !== undefined && override.unitSelect !== null) {
    global = mergeUnitConfig(global, override.unitSelect);
  }
  let globalGroup = isObject(base.unitgroup) ? base.unitgroup : null;
  if (isObject(override?.unitgroup)) {
    globalGroup = globalGroup ? mergeJsonDeep(globalGroup, override.unitgroup) : override.unitgroup;
  }
  const baseShip = base.shipSelect || null;
  const overrideShip = override?.shipSelect || null;
  const globalShip = overrideShip ? mergeJsonDeep(baseShip || {}, overrideShip) : baseShip;
  const civ = runtimeCiv(runtime, civTag);
  return {
    global,
    local: civUnitSelectOf(civ),
    globalGroup,
    globalShip,
    localShip: civShipSelectOf(civ),
    civ,
  };
}

/** attachments 规则根：文明覆盖优先，未命中的兵种回落到全局。 */
export function runtimeAttachmentRoots(runtime, civTag) {
  const base = runtime?.attachments || {};
  const global = base.unitSelect != null ? base.unitSelect : (base.rules != null ? base.rules : null);
  const globalGroup = isObject(base.unitgroup) ? base.unitgroup : null;
  const globalShip = base.shipSelect || null;
  const civ = runtimeCiv(runtime, civTag);
  const at = civ?.attachments;
  let local = null;
  let localGroup = null;
  let localShip = null;
  if (at != null) {
    if (Array.isArray(at)) {
      local = at;
    } else if (isObject(at)) {
      if (at.unitSelect !== undefined && at.unitSelect !== null) local = at.unitSelect;
      else if (at.shipSelect == null) local = at; // 旧写法：attachments 整段就是 unitSelect
      localGroup = isObject(at.unitgroup) ? at.unitgroup : null;
      localShip = at.shipSelect != null ? at.shipSelect : null;
    }
  }
  return {
    global,
    globalGroup,
    local,
    localGroup,
    globalShip,
    localShip,
    strip: base.strip,
    civ,
  };
}

/**
 * 解析某兵种规则对应的挂件数组。
 * 顺序：civ unitSelect > civ unitgroup > 全局 unitSelect > 全局 unitgroup（船只看 shipSelect）。
 * 返回 { list, scope }；list 为 null 表示规则不存在/无挂件。
 */
export function resolveAttachmentList(runtime, civTag, ship, key, ctx) {
  if (key == null) return { list: null, scope: 'none' };
  const roots = runtimeAttachmentRoots(runtime, civTag);
  const uid = typeIdOfKey(key);
  const typeName = typeNameOfKey(key);
  const localRules = ship ? roots.localShip : roots.local;
  const globalRules = ship ? roots.globalShip : roots.global;
  let list = null;
  let scope = 'none';
  if (localRules != null) {
    list = resolveAttachValue(localRules, ship, ctx, uid, typeName);
    if (list == null && !ship && roots.localGroup) {
      list = resolveUnitGroupValue(roots.localGroup, ctx, uid, typeName);
    }
    if (list != null) scope = 'civ';
  }
  if (list == null) {
    list = resolveAttachValue(globalRules, ship, ctx, uid, typeName);
    if (list != null) scope = 'global';
  }
  if (list == null && !ship && roots.globalGroup) {
    list = resolveUnitGroupValue(roots.globalGroup, ctx, uid, typeName);
    if (list != null) scope = 'global-group';
  }
  return { list, scope, roots };
}

const BLOCK_COND_KEYS = new Set(['religion', 'religionGroup', 'group', '_comment']);

function addUnitKeys(node, out, depth = 0, isBlock = false) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const block of node) addUnitKeys(block, out, depth + 1, true);
    return;
  }
  if (!isObject(node)) return;
  if (!isBlock && isRuleEntry(node)) return; // 单条规则，没有兵种键
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('_') || (isBlock && BLOCK_COND_KEYS.has(key))) continue;
    if (typeof value === 'string' || Array.isArray(value)) {
      out.add(key);
      continue;
    }
    if (!isObject(value)) continue;
    if (isRuleEntry(value)) {
      out.add(key);
      continue;
    }
    // 单位类型直写但内容仅 { } 或其它：按 "<uid>:" 形态仍算兵种键，否则视为文化组表
    if (/^\d+($|:)/.test(key)) out.add(key);
    else addUnitKeys(value, out, depth + 1, false);
  }
}

/** 规则下拉可选项（attachments + loadSelect 的兵种键）。 */
export function runtimeRuleKeys(runtime, civTag = null, ship = false) {
  const out = new Set();
  const att = runtimeAttachmentRoots(runtime, civTag);
  const sel = runtimeSelectRoots(runtime, civTag);
  const localRules = ship ? att.localShip : att.local;
  const globalRules = ship ? att.globalShip : att.global;
  for (const rules of [localRules, globalRules]) {
    if (rules == null) continue;
    if (ship && isRuleEntry(rules)) {
      out.add('shipSelect');
      continue;
    }
    addUnitKeys(rules, out);
  }
  if (!ship) {
    for (const node of [att.localGroup, att.globalGroup, sel.local, sel.global, sel.globalGroup]) {
      if (node != null) addUnitKeys(node, out);
    }
  }
  if (ship && !out.size && (isRuleEntry(localRules) || isRuleEntry(globalRules))) out.add('shipSelect');
  return [...out];
}

function categoryForType(typeName) {
  const s = String(typeName || '').toLowerCase();
  if (/cavalry|mounted|horse/.test(s)) return 'mounted';
  if (/canon|artillery/.test(s)) return 'artillery';
  if (/warior|warrior|spear|archer|settler|fighter|infantry/.test(s)) return 'foot';
  return '';
}

const PRIORITY_RANK = { byId: 6, religion: 5, religionGroup: 4, group: 3, level: 2, default: 1 };
const PRIORITY_NAME = ['', 'default', 'level', 'group', 'religionGroup', 'religion', 'byId'];

function higherPriority(a, b) {
  return (PRIORITY_RANK[a] || 0) >= (PRIORITY_RANK[b] || 0) ? a : b;
}

/** 递归收集条目里所有可能的模型叶子（字符串），带上下文与原层级优先级。 */
function walkLeaves(entry, ctx, priority, out, depth = 0) {
  if (entry == null || depth > 8) return;
  if (typeof entry === 'string') {
    out.push({ model: entry, ctx: { ...ctx }, priority });
    return;
  }
  if (!isObject(entry)) return;
  if (isObject(entry.byId)) {
    for (const [key, value] of Object.entries(entry.byId)) {
      const aId = /^\d+$/.test(key) ? Number(key) : null;
      walkLeaves(value, { ...ctx, aId, unitName: key }, higherPriority(priority, 'byId'), out, depth + 1);
    }
  }
  if (isObject(entry.religion)) {
    for (const [key, value] of Object.entries(entry.religion)) {
      const numeric = /^-?\d+$/.test(key);
      walkLeaves(value, {
        ...ctx,
        religionId: numeric ? Number(key) : ctx.religionId,
        religionName: numeric ? ctx.religionName : key,
      }, higherPriority(priority, 'religion'), out, depth + 1);
    }
  }
  if (isObject(entry.religionGroup)) {
    for (const [key, value] of Object.entries(entry.religionGroup)) {
      const n = Number(key);
      walkLeaves(value, {
        ...ctx,
        religionGroup: Number.isFinite(n) ? n : ctx.religionGroup,
      }, higherPriority(priority, 'religionGroup'), out, depth + 1);
    }
  }
  if (isObject(entry.group)) {
    for (const [key, value] of Object.entries(entry.group)) {
      walkLeaves(value, { ...ctx, group: key }, higherPriority(priority, 'group'), out, depth + 1);
    }
  }
  if (isObject(entry.level)) {
    for (const [key, value] of Object.entries(entry.level)) {
      walkLeaves(value, { ...ctx, level: levelSample(key) }, higherPriority(priority, 'level'), out, depth + 1);
    }
  }
  if (entry.default != null) {
    walkLeaves(entry.default, ctx, higherPriority(priority, 'default'), out, depth + 1);
  }
}

function blockContext(block, baseCtx) {
  const ctx = { ...baseCtx };
  const rel = block.religion;
  if (typeof rel === 'number') ctx.religionId = rel;
  else if (typeof rel === 'string') {
    const t = rel.trim();
    if (/^-?\d+$/.test(t)) ctx.religionId = Number(t);
    else if (t) ctx.religionName = t;
  } else if (Array.isArray(rel) && rel.length) {
    ctx.religionId = typeof rel[0] === 'number'
      ? rel[0]
      : (/^-?\d+$/.test(String(rel[0]).trim()) ? Number(rel[0]) : ctx.religionId);
    if (ctx.religionId == null && typeof rel[0] === 'string') ctx.religionName = rel[0];
  }
  const rg = block.religionGroup;
  if (typeof rg === 'number') ctx.religionGroup = rg;
  else if (typeof rg === 'string' && Number.isFinite(Number(rg))) ctx.religionGroup = Number(rg);
  else if (Array.isArray(rg) && rg.length && Number.isFinite(Number(rg[0]))) ctx.religionGroup = Number(rg[0]);
  const gp = block.group;
  if (typeof gp === 'string') ctx.group = gp;
  else if (Array.isArray(gp) && gp.length && typeof gp[0] === 'string') ctx.group = gp[0];
  return ctx;
}

function collectUnitEntriesFrom(obj, scope, ctx, out, depth = 0, filterCtx = null) {
  for (const [key, value] of Object.entries(obj)) {
    if (key.startsWith('_') || BLOCK_COND_KEYS.has(key)) continue;
    if (typeof value === 'string') {
      out.push({ ruleKey: key, entry: value, ctx: { ...ctx }, scope });
      continue;
    }
    if (!isObject(value)) continue;
    if (isRuleEntry(value)) {
      const leaves = [];
      walkLeaves(value, ctx, 'default', leaves);
      for (const leaf of leaves) {
        out.push({ ruleKey: key, entry: leaf.model, ctx: leaf.ctx, priority: leaf.priority, scope });
      }
      continue;
    }
    // unitgroup 文化组表：值是一组兵种条目
    if (/^\d+($|:)/.test(key)) {
      out.push({ ruleKey: key, entry: value, ctx: { ...ctx }, scope });
      continue;
    }
    collectFromNode(value, scope, { ...ctx, group: ctx.group || key }, out, depth + 1, filterCtx);
  }
}

function collectFromNode(node, scope, ctx, out, depth = 0, filterCtx = null) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const block of node) {
      if (!isObject(block)) continue;
      // 手动指定 religion/group 时，只收集命中的宗教块；不指定则保留所有块供自动推断。
      if (filterCtx && !blockMatches(block, filterCtx)) continue;
      collectUnitEntriesFrom(block, scope, blockContext(block, ctx), out, depth + 1, filterCtx);
    }
    return;
  }
  if (!isObject(node) || isRuleEntry(node)) return;
  collectUnitEntriesFrom(node, scope, ctx, out, depth, filterCtx);
}

/** 从 loadSelect 反推当前模型可能对应的兵种/等级/文化；用于自动选规则。 */
export function collectRuntimeCandidates(runtime, model, civTag, manual = null) {
  const name = model?.name || '';
  if (!name) return [];
  const roots = runtimeSelectRoots(runtime, civTag);
  const found = [];
  const baseCtx = makeContext({ religion: null, religionGroup: null, group: null });
  // 只把用户明确填写的条件用于筛块；空输入仍走全量自动推断。
  const hasFilter = !!manual && (
    (manual.religion != null && String(manual.religion).trim() !== '')
    || (manual.religionGroup != null && manual.religionGroup !== '')
    || (manual.group != null && manual.group !== '')
  );
  const filterCtx = hasFilter ? makeContext(manual) : null;
  if (roots.local != null) collectFromNode(roots.local, 'civ', baseCtx, found, 0, filterCtx);
  if (roots.global != null) collectFromNode(roots.global, 'global', baseCtx, found, 0, filterCtx);
  if (roots.globalGroup != null) collectFromNode(roots.globalGroup, 'unitgroup', baseCtx, found, 0, filterCtx);
  return found
    .filter((c) => c.entry === name)
    .filter((c) => {
      if (!filterCtx) return true;
      if (filterCtx.group && c.ctx.group
        && String(filterCtx.group).toLowerCase() !== String(c.ctx.group).toLowerCase()) return false;
      return true;
    })
    .map((c) => ({
      ruleKey: c.ruleKey,
      typeName: typeNameOfKey(c.ruleKey),
      scope: c.scope,
      model: c.entry,
      priority: PRIORITY_NAME[PRIORITY_RANK[c.priority || 'default']] || c.priority || 'default',
      level: c.ctx.level ?? 0,
      group: c.ctx.group ?? null,
      aId: c.ctx.aId ?? null,
      unitName: c.ctx.unitName ?? null,
      religion: c.ctx.religionName || (c.ctx.religionId != null ? String(c.ctx.religionId) : null),
      religionGroup: c.ctx.religionGroup ?? null,
    }));
}

function candidateScore(candidate, model, tokens) {
  let score = 0;
  const typeCategory = categoryForType(candidate.typeName);
  if (typeCategory && model?.category === typeCategory) score += 100;
  if (candidate.scope === 'civ') score += 20;
  score += { byId: 40, group: 30, level: 20, default: 10 }[candidate.priority] || 0;
  if (tokens?.length) score += 8;
  return score;
}

function pickedInfo(base, key, ctx, list, scope, extra = {}) {
  return {
    ruleKey: key,
    typeName: typeNameOfKey(key),
    scope,
    level: ctx.level ?? 0,
    group: ctx.group ?? null,
    aId: ctx.aId ?? null,
    unitName: ctx.unitName ?? null,
    religion: ctx.religionName || (ctx.religionId != null ? String(ctx.religionId) : null),
    religionGroup: ctx.religionGroup ?? null,
    tokens: Array.isArray(list) ? list : [],
    entry: Array.isArray(list),
    ...base,
    ...extra,
  };
}

export function pickRuntimeRule(runtime, model, manual = null) {
  const civTag = manual?.civ || null;
  const ship = isShipModel(model);
  const att = runtimeAttachmentRoots(runtime, civTag);
  const manualKey = manual?.ruleKey || null;

  if (manualKey) {
    const ctx = makeContext(manual);
    const { list, scope } = resolveAttachmentList(runtime, civTag, ship, manualKey, ctx);
    return pickedInfo({ reason: 'manual', civ: civTag, ship }, manualKey, ctx, list, scope);
  }

  if (ship) {
    const keys = runtimeRuleKeys(runtime, civTag, true);
    const key = keys[0] || null;
    if (key) {
      const ctx = makeContext({ ...manual, level: 0, group: null, aId: null });
      const { list, scope } = resolveAttachmentList(runtime, civTag, true, key, ctx);
      if (list != null) {
        return pickedInfo({ reason: 'shipSelect', civ: civTag, ship: true }, key, ctx, list, scope);
      }
    }
  }

  const candidates = ship ? [] : collectRuntimeCandidates(runtime, model, civTag, manual);
  let best = null;
  for (const cand of candidates) {
    const ctx = makeContext(cand);
    const { list, scope } = resolveAttachmentList(runtime, civTag, false, cand.ruleKey, ctx);
    const score = candidateScore(cand, model, Array.isArray(list) ? list : []);
    if (!best || score > best.score) {
      best = { ...cand, ...pickedInfo({ reason: 'candidate' }, cand.ruleKey, ctx, list, scope), score, civ: civTag, ship: false };
    }
  }
  if (best) return best;

  // 没有从 loadSelect 反推出来（例如直接打开一个 extra combo）时，按类别选一条规则。
  const keys = runtimeRuleKeys(runtime, civTag, ship);
  const categoryMap = {
    mounted: /Cavalry/i, artillery: /Canon/i, foot: /Archer/i,
    tank: /Warior/i, mg: /Spearmen/i, logistics: /后勤/, mech: /机械化/,
    ship: /ship/i,
  };
  const re = categoryMap[model?.category || ''];
  const key = (re && keys.find((k) => re.test(k))) || keys[0];
  if (!key) return null;
  const ctx = makeContext({ ...manual, level: 0, group: null, aId: null });
  const { list, scope } = resolveAttachmentList(runtime, civTag, ship, key, ctx);
  return pickedInfo({ reason: 'category', civ: civTag, ship }, key, ctx, list, scope);
}

function collectNestedGroupKeys(entry, out, depth = 0) {
  if (!isObject(entry) || depth > 8) return;
  if (isObject(entry.group)) {
    for (const key of Object.keys(entry.group)) out.add(key);
  }
  for (const key of ['byId', 'religion', 'religionGroup', 'level']) {
    if (!isObject(entry[key])) continue;
    for (const value of Object.values(entry[key])) collectNestedGroupKeys(value, out, depth + 1);
  }
  if (entry.default != null) collectNestedGroupKeys(entry.default, out, depth + 1);
}

function collectGroupKeys(node, out, depth = 0) {
  if (node == null || depth > 8) return;
  if (Array.isArray(node)) {
    for (const block of node) {
      if (!isObject(block)) continue;
      if (typeof block.group === 'string') out.add(block.group);
      else if (Array.isArray(block.group)) block.group.forEach((g) => typeof g === 'string' && out.add(g));
      for (const [key, value] of Object.entries(block)) {
        if (key.startsWith('_') || BLOCK_COND_KEYS.has(key)) continue;
        collectGroupKeys(value, out, depth + 1);
      }
    }
    return;
  }
  if (!isObject(node)) return;
  if (isRuleEntry(node)) {
    collectNestedGroupKeys(node, out);
    return;
  }
  for (const [key, value] of Object.entries(node)) {
    if (key.startsWith('_')) continue;
    if (!isObject(value)) continue;
    if (isRuleEntry(value)) {
      collectNestedGroupKeys(value, out);
    } else if (!/^\d+($|:)/.test(key)) {
      out.add(key); // unitgroup 文化组表名
      collectGroupKeys(value, out, depth + 1);
    } else {
      collectGroupKeys(value, out, depth + 1);
    }
  }
}

/** 文化组下拉可选项（unitgroup 表名 + 条目内的 group 键）。 */
export function runtimeGroupOptions(runtime, civTag = null, ship = false) {
  const out = new Set();
  const att = runtimeAttachmentRoots(runtime, civTag);
  const sel = runtimeSelectRoots(runtime, civTag);
  const nodes = ship
    ? [att.localShip, att.globalShip]
    : [att.local, att.global, att.localGroup, att.globalGroup, sel.local, sel.global, sel.globalGroup];
  for (const node of nodes) collectGroupKeys(node, out);
  return [...out].sort((a, b) => a.localeCompare(b));
}
