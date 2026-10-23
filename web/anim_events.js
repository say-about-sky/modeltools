// EU5 攻击事件表 + 武器/挂点解析（g3d-web 版）。
//
// 数据来源（离线解析）：
//   F:\EU5\game\main_menu\gfx\animation_state_machines\unit_skeleton_state_machine_*.animsm
//   particle_action { trigger_time_absolute = ... hierarchy_place = ... type = start|stop }
//
// 注意：这些时间是对应 EU5 源动画的绝对秒；我们的 combo 动画大多直接来自这些 .anim，
// 所以可以原样使用。若某条动画被重采样/裁剪，事件时间需要按实际 duration 过滤。

import { mat4TransformPoint, mat4Identity, mat4Multiply } from './math.js';

export const UNIT_STATE_LABELS = {
  0: 'Idle',
  1: 'Attack',
  2: 'Move',
  3: 'Retreat',
  4: 'Charge',
};

export const WEAPON_LABELS = {
  auto: '自动识别',
  musket: '火枪（musket）',
  arquebus: '火绳枪（arquebus）',
  handgonne: '手炮（handgonne）',
  pistol: '手枪（pistol）',
  bow: '弓（bow）',
  crossbow: '弩（crossbow）',
  sword: '剑/近战（sword）',
  spear: '矛/长柄（spear）',
  cannon: '火炮（cannon）',
  melee: '通用近战',
  ww1_rifle: '一战步枪（ww1_rifle）',
  ww1_mg: '一战机枪（ww1_mg）',
  none: '关闭',
};

/** EU5 攻击时间线上的粒子事件（绝对秒）。 */
export const ATTACK_EVENTS = {
  musket: {
    duration: 13.0,
    events: [
      { t: 1.661597, preset: 'musket_muzzle' },
      { t: 1.543444, preset: 'musket_ignite' },
    ],
  },
  // 骑兵火枪：unit_skeleton_state_machine_musket_cavalry.animsm
  // particle_action trigger_time_absolute=0.070947, stop=3.598692
  musket_cavalry: {
    duration: 10.5,
    events: [
      { t: 0.070947, preset: 'musket_muzzle' },
      { t: 3.598692, preset: 'stop' },
    ],
  },
  arquebus: {
    duration: 10.534,
    events: [{ t: 0.78, preset: 'musket_muzzle' }],
  },
  handgonne: {
    duration: 16.0,
    events: [{ t: 0.133, preset: 'musket_muzzle' }],
  },
  pistol: {
    duration: 7.633,
    events: [{ t: 1.53, preset: 'musket_muzzle' }],
  },
  bow: {
    duration: 4.467,
    events: [{ t: 1.24101, preset: 'bow_release' }],
  },
  crossbow: {
    duration: 10.333441,
    events: [{ t: 0.286264, preset: 'bow_release' }],
  },
  sword: {
    duration: 3.100351,
    events: [0.184781, 0.916, 1.509, 2.002709, 2.559].map((t) => ({ t, preset: 'melee_sparks' })),
  },
  spear: {
    duration: 3.434,
    events: [0.64, 1.8, 2.95].map((t) => ({ t, preset: 'melee_sparks' })),
  },
  pike: {
    duration: 2.133838,
    events: [0.184781, 0.916, 1.509, 2.002709, 2.559].map((t) => ({ t, preset: 'melee_sparks' })),
  },
  cannon: {
    duration: 10.0,
    events: [
      { t: 0.7, preset: 'cannon_muzzle' },
      { t: 0.135, preset: 'cannon_muzzle' },
    ],
  },
  melee: {
    duration: 3.1,
    events: [0.3, 1.2, 2.1].map((t) => ({ t, preset: 'melee_sparks' })),
  },
  none: { duration: 0, events: [] },
};

export function weaponLabel(weapon) {
  return WEAPON_LABELS[weapon] || weapon;
}

function partText(part) {
  return [
    part.meshpartid,
    part.prim && part.prim.id,
    part.material && part.material.id,
    part.node && part.node.id,
    part.mesh && part.mesh.id,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

/** 从模型节点/部件/材质名推断武器类型。 */
export function detectWeapon(asset) {
  if (!asset || !asset.parts || !asset.parts.length) return 'none';
  const text = asset.parts.map(partText).join(' ');
  if (!text) return 'none';

  if (text.includes('crossbow')) return 'crossbow';
  if (text.includes('handgonne') || text.includes('handgonna')) return 'handgonne';
  if (text.includes('arquebus') || text.includes('arqebus')) return 'arquebus';
  // 先判 pistol：mounted_arab_musket 的 node id 里有 "musket"，但武器网格是
  // unit_weapon_pistol；若先判 musket 会误用步兵火枪的 1.66s 事件。
  if (text.includes('pistol')) return 'pistol';
  if (text.includes('musket') || text.includes('flintlock') || text.includes('matchlock')) return 'musket';
  if (text.includes('cannon') || text.includes('canon') || text.includes('mortar') || text.includes('artillery')) return 'cannon';
  if (text.includes('bow')) return 'bow';
  if (text.includes('sword') || text.includes('blade') || text.includes('saber') || text.includes('rapier') || text.includes('katar') || text.includes('knife') || text.includes('axe') || text.includes('mace')) return 'sword';
  if (text.includes('spear') || text.includes('pike') || text.includes('lance') || text.includes('halberd')) return 'spear';
  return 'melee';
}

/** 武器关键字 → 部件打分；分高者优先，避免把盾牌当武器。 */
function scorePart(part, weapon) {
  const t = partText(part);
  let score = 0;
  switch (weapon) {
    case 'musket':
      if (t.includes('musket') || t.includes('flintlock') || t.includes('matchlock')) score += 10;
      if (t.includes('weapon')) score += 2;
      break;
    case 'arquebus':
      if (t.includes('arquebus')) score += 10;
      if (t.includes('weapon')) score += 2;
      break;
    case 'handgonne':
      if (t.includes('handgonne') || t.includes('handgonna')) score += 10;
      break;
    case 'pistol':
      if (t.includes('pistol')) score += 10;
      break;
    case 'bow':
      if (t.includes('bow') && !t.includes('crossbow')) score += 10;
      break;
    case 'crossbow':
      if (t.includes('crossbow')) score += 10;
      break;
    case 'sword':
      if (t.includes('sword') || t.includes('blade') || t.includes('saber') || t.includes('rapier') || t.includes('katar')) score += 10;
      if (t.includes('knife') || t.includes('axe') || t.includes('mace')) score += 6;
      if (t.includes('weapon')) score += 2;
      if (t.includes('shield')) score -= 4;
      break;
    case 'spear':
      if (t.includes('spear') || t.includes('pike') || t.includes('lance') || t.includes('halberd')) score += 10;
      if (t.includes('weapon')) score += 2;
      break;
    case 'cannon':
      if (t.includes('cannon') || t.includes('canon') || t.includes('mortar') || t.includes('barrel')) score += 10;
      if (t.includes('artillery')) score += 4;
      break;
    default:
      if (t.includes('weapon')) score += 2;
      break;
  }
  return score;
}

/** 找到该武器的部件（用于枪口/刀尖锚点）。 */
export function findWeaponPart(asset, weapon) {
  if (!asset || !asset.parts) return null;
  let best = null;
  let bestScore = 0;
  let bestVerts = -1;
  for (const part of asset.parts) {
    const score = scorePart(part, weapon);
    if (score <= 0) continue;
    const verts = (part.mesh && part.mesh.vertexCount) || 0;
    if (score > bestScore || (score === bestScore && verts > bestVerts)) {
      best = part;
      bestScore = score;
      bestVerts = verts;
    }
  }
  return best;
}

/** 部件顶点在「第一根骨骼 local 空间」里最远的点 = 枪口/刀尖。 */
function partTipBoneLocal(part) {
  if (part._tipBoneLocal) return part._tipBoneLocal;
  if (!part || !part.bones || !part.bones.length) return null;
  const bone = part.bones[0];
  const mesh = part.mesh;
  if (!mesh || !mesh.vertices || mesh.vertexCount <= 0) return null;
  const posOff = mesh.offsets.position;
  if (posOff < 0) return null;
  const stride = mesh.stride;
  const src = mesh.vertices;
  const out = [0, 0, 0];
  let bestLen = -1;
  let best = null;
  for (let vi = 0; vi < mesh.vertexCount; vi++) {
    const s = vi * stride + posOff;
    mat4TransformPoint(out, bone.invBind, src[s], src[s + 1], src[s + 2]);
    const len = out[0] * out[0] + out[1] * out[1] + out[2] * out[2];
    if (len > bestLen) {
      bestLen = len;
      best = [out[0], out[1], out[2]];
    }
  }
  if (!best || bestLen < 1e-8) best = [0, 0, -0.3];
  part._tipBoneLocal = best;
  return best;
}

function transformDir(out, m, x, y, z) {
  out[0] = m[0] * x + m[4] * y + m[8] * z;
  out[1] = m[1] * x + m[5] * y + m[9] * z;
  out[2] = m[2] * x + m[6] * y + m[10] * z;
  const l = Math.hypot(out[0], out[1], out[2]) || 1;
  out[0] /= l;
  out[1] /= l;
  out[2] /= l;
  return out;
}

function nodeBindWorld(node) {
  // 有些 locator（如 artillery 的 cannon_front_j）不在渲染骨架里，
  // bindGlobal 保持全 0；沿 parent/bindLocal 现算一次。
  const chain = [];
  let n = node;
  while (n) {
    chain.push(n);
    n = n.parent;
  }
  let m = mat4Identity();
  for (let i = chain.length - 1; i >= 0; i--) {
    const local = chain[i].bindLocal;
    if (local) m = mat4Multiply(mat4Identity(), m, local);
  }
  return m;
}

function nodeWorldPos(node, world) {
  if (!node) return null;
  const bg = node.bindGlobal;
  const local = (bg && (bg[12] || bg[13] || bg[14])) ? bg : nodeBindWorld(node);
  const p = [0, 0, 0];
  mat4TransformPoint(p, local, 0, 0, 0);
  const w = [0, 0, 0];
  mat4TransformPoint(w, world, p[0], p[1], p[2]);
  return w;
}

/**
 * 计算攻击粒子锚点。
 * @returns {{pos:number[], dir:number[], grip:number[]}|null}
 */
export function computeAttackAnchor(asset, world, weapon) {
  if (!asset || !world) return null;

  // 火炮：优先用骨架里的炮口节点/炮尾节点，而不是模型包围盒。
  // artillery_discovery 有 cannon_front_j（炮口）和 cannon_back_j（炮尾）。
  if (weapon === 'cannon') {
    const front = asset.nodes.find((n) =>
      /cannon_front|barrel_end|muzzle|vfx_loc/i.test(n.id || ''));
    const back = asset.nodes.find((n) =>
      /cannon_back|barrel_base|cannon_?body/i.test(n.id || ''));
    if (front) {
      const pos = nodeWorldPos(front, world);
      let dir = transformDir([0, 0, 0], world, 0, 0, -1);
      if (back) {
        const bp = nodeWorldPos(back, world);
        const d = [pos[0] - bp[0], pos[1] - bp[1], pos[2] - bp[2]];
        const l = Math.hypot(d[0], d[1], d[2]) || 1;
        dir = [d[0] / l, d[1] / l, d[2] / l];
      }
      return { pos, dir, grip: pos.slice() };
    }
    // 没有炮口节点时才退回包围盒前缘
    if (asset.bounds) {
      const b = asset.bounds;
      const p = [
        (b.min[0] + b.max[0]) * 0.5,
        b.min[1] + (b.max[1] - b.min[1]) * 0.55,
        b.min[2] + (b.max[2] - b.min[2]) * 0.12,
      ];
      const pos = [0, 0, 0];
      mat4TransformPoint(pos, world, p[0], p[1], p[2]);
      const dir = transformDir([0, 0, 0], world, 0, 0, -1);
      return { pos, dir, grip: pos.slice() };
    }
  }

  // 武器部件：枪口/刀尖 = 骨骼 local 空间里离握把最远的顶点
  const part = findWeaponPart(asset, weapon);
  if (part && part.bones && part.bones.length) {
    const bone = part.bones[0];
    const node = bone.node;
    const tipLocal = partTipBoneLocal(part);
    if (node && tipLocal) {
      const tipModel = [0, 0, 0];
      mat4TransformPoint(tipModel, node.bindGlobal, tipLocal[0], tipLocal[1], tipLocal[2]);
      const gripModel = [0, 0, 0];
      mat4TransformPoint(gripModel, node.bindGlobal, 0, 0, 0);
      const dirModel = [tipModel[0] - gripModel[0], tipModel[1] - gripModel[1], tipModel[2] - gripModel[2]];
      const dl = Math.hypot(dirModel[0], dirModel[1], dirModel[2]) || 1;
      dirModel[0] /= dl; dirModel[1] /= dl; dirModel[2] /= dl;

      const pos = [0, 0, 0];
      mat4TransformPoint(pos, world, tipModel[0], tipModel[1], tipModel[2]);
      const grip = [0, 0, 0];
      mat4TransformPoint(grip, world, gripModel[0], gripModel[1], gripModel[2]);
      const dir = transformDir([0, 0, 0], world, dirModel[0], dirModel[1], dirModel[2]);
      // 弓：弓梢尖端不是箭的释放方向，用握把 + 模型前向
      if (weapon === 'bow') {
        return { pos: grip, dir: transformDir([0, 0, 0], world, 0, 0, -1), grip };
      }
      return { pos, dir, grip };
    }
  }

  // 兜底：右手骨
  const names = ['Unit_Wea_Right_Hand02', 'Unit_Wea_Right_Hand01', 'Unit_Base_Rig_RightHand', 'RightHand'];
  let node = null;
  for (const n of names) {
    node = asset.nodes.find((x) => x.id === n);
    if (node) break;
  }
  if (!node) node = asset.nodes.find((x) => /hand/i.test(x.id || ''));
  if (node) {
    const pos = nodeWorldPos(node, world);
    const dir = transformDir([0, 0, 0], world, 0, 0, -1);
    return { pos, dir, grip: pos.slice() };
  }

  return null;
}

/** 当前战斗状态的粒子事件列表；自动按实际动画 duration 过滤过期事件。 */
export function eventListFor(asset, stateId, weapon, actualDuration) {
  if (stateId !== 'battle') return [];
  // G3DArmy runtime: assembly.json 的 animSet 直接对应 anim_events.json 的 weapons 键。
  // WW1 步枪/机枪等自定义武器不走下面的 EU5 硬编码表，否则会被误判成 melee。
  const rt = asset && asset.runtime;
  const profile = rt && rt.animEvents && rt.animSet
    ? (rt.animEvents.weapons || {})[rt.animSet]
    : null;
  // 手动覆盖武器（UI 下拉）时仍走下面的 EU5 表；自动模式 weapon===animSet。
  if (profile && Array.isArray(profile.events) && weapon === rt.animSet) {
    const dur = actualDuration > 0
      ? actualDuration
      : (profile.animDuration || profile.stateMachineDuration || 0);
    const presets = rt.animEvents.presets || {};
    return profile.events
      .filter((e) => e.t >= 0 && (!(dur > 0) || e.t < dur - 1e-4))
      .map((e, i) => ({
        ...e,
        index: i,
        defs: (presets[e.preset] && presets[e.preset].burst) || [],
      }));
  }
  // mounted_arab_musket 的武器网格是 pistol，但战斗动画是 10.5s 的
  // unit_musket_cavalry_attack；步兵 musket/pistol 都约 13s/7.6s。
  // 用实际动画时长区分，避免用 1.66s 的步兵事件。
  let key = weapon;
  if (actualDuration > 9 && actualDuration < 12 && (weapon === 'pistol' || weapon === 'musket')) {
    key = 'musket_cavalry';
  }
  const info = ATTACK_EVENTS[key] || ATTACK_EVENTS.melee;
  const dur = actualDuration && actualDuration > 0 ? actualDuration : info.duration;
  return info.events
    .filter((e) => e.t >= 0 && e.t < dur - 1e-4)
    .map((e, i) => ({ ...e, index: i }));
}

/** 时间轴上是否跨过事件点（支持 loop 回绕）。 */
export function crossed(prev, now, t, duration) {
  if (!(duration > 0)) return false;
  if (now >= prev) return prev <= t && now > t;
  // 回绕：prev..duration + 0..now
  return (prev <= t && t <= duration) || (0 <= t && t < now);
}
