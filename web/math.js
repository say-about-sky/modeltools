// 4x4 矩阵 / 四元数工具（列主序，与 WebGL / libGDX 的内存布局一致）。
//
// 约定（与 libGDX Matrix4 相同）：
//   - 数组下标 = 列 * 4 + 行（column-major）
//   - 变换顺序：M = T * R * S
//   - 绕 Y 轴 +deg 的旋转矩阵与 libGDX Matrix4.rotate(Vector3.Y, deg) 一致：
//       x' =  cos*x + sin*z
//       z' = -sin*x + cos*z

export function mat4Identity(out = new Float32Array(16)) {
  out.fill(0);
  out[0] = out[5] = out[10] = out[15] = 1;
  return out;
}

export function mat4Copy(out, a) {
  out.set(a);
  return out;
}

/** out = a * b（先应用 b，再应用 a）。 */
export function mat4Multiply(out, a, b) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  for (let i = 0; i < 4; i++) {
    const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3];
    out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30;
    out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31;
    out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32;
    out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33;
  }
  return out;
}

/**
 * 由 TRS 组装矩阵（等价 libGDX Matrix4.set(translation, rotation, scale)）。
 * q = [x, y, z, w]；s 可为标量或 [sx, sy, sz]。
 */
export function mat4Compose(out, t, q, s) {
  const sx = s.length === 3 ? s[0] : s;
  const sy = s.length === 3 ? s[1] : s;
  const sz = s.length === 3 ? s[2] : s;
  const qx = q[0], qy = q[1], qz = q[2], qw = q[3];

  const x2 = qx + qx, y2 = qy + qy, z2 = qz + qz;
  const xx = qx * x2, xy = qx * y2, xz = qx * z2;
  const yy = qy * y2, yz = qy * z2, zz = qz * z2;
  const wx = qw * x2, wy = qw * y2, wz = qw * z2;

  out[0] = (1 - (yy + zz)) * sx;
  out[1] = (xy + wz) * sx;
  out[2] = (xz - wy) * sx;
  out[3] = 0;

  out[4] = (xy - wz) * sy;
  out[5] = (1 - (xx + zz)) * sy;
  out[6] = (yz + wx) * sy;
  out[7] = 0;

  out[8] = (xz + wy) * sz;
  out[9] = (yz - wx) * sz;
  out[10] = (1 - (xx + yy)) * sz;
  out[11] = 0;

  out[12] = t[0];
  out[13] = t[1];
  out[14] = t[2];
  out[15] = 1;
  return out;
}

/** 绕 Y 轴旋转（角度制），与 libGDX Matrix4.rotate(Y, deg) 完全一致。 */
export function mat4RotationY(deg) {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const out = mat4Identity();
  out[0] = c;
  out[2] = -s;
  out[8] = s;
  out[10] = c;
  return out;
}

/** 绕 X 轴旋转（角度制），列主序，与 libGDX Matrix4.rotate(X, deg) 一致。 */
export function mat4RotationX(deg) {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const out = mat4Identity();
  out[5] = c;
  out[6] = s;
  out[9] = -s;
  out[10] = c;
  return out;
}

/** 绕 Z 轴旋转（角度制），列主序。 */
export function mat4RotationZ(deg) {
  const rad = deg * Math.PI / 180;
  const c = Math.cos(rad), s = Math.sin(rad);
  const out = mat4Identity();
  out[0] = c;
  out[1] = s;
  out[4] = -s;
  out[5] = c;
  return out;
}

/** 欧拉角 XYZ（角度制）：R = Rz * Ry * Rx，供 AI 放置 API 使用。 */
export function mat4RotationEuler(out, rx, ry, rz) {
  const z = mat4RotationZ(rz);
  const y = mat4RotationY(ry);
  const x = mat4RotationX(rx);
  mat4Multiply(out, z, y);
  mat4Multiply(out, out, x);
  return out;
}

export function mat4Translation(x, y, z) {
  const out = mat4Identity();
  out[12] = x;
  out[13] = y;
  out[14] = z;
  return out;
}

export function mat4Scaling(sx, sy, sz) {
  const out = mat4Identity();
  out[0] = sx;
  out[5] = sy;
  out[10] = sz;
  return out;
}

/** 4x4 逆矩阵。 */
export function mat4Invert(out, a) {
  const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3];
  const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7];
  const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11];
  const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15];

  const b00 = a00 * a11 - a01 * a10;
  const b01 = a00 * a12 - a02 * a10;
  const b02 = a00 * a13 - a03 * a10;
  const b03 = a01 * a12 - a02 * a11;
  const b04 = a01 * a13 - a03 * a11;
  const b05 = a02 * a13 - a03 * a12;
  const b06 = a20 * a31 - a21 * a30;
  const b07 = a20 * a32 - a22 * a30;
  const b08 = a20 * a33 - a23 * a30;
  const b09 = a21 * a32 - a22 * a31;
  const b10 = a21 * a33 - a23 * a31;
  const b11 = a22 * a33 - a23 * a32;

  let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
  if (!det) {
    return null;
  }
  det = 1.0 / det;

  out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
  out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
  out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
  out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
  out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
  out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
  out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
  out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
  out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
  out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
  out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
  out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
  out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
  out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
  out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
  out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
  return out;
}

/** 点变换：p' = M * [x,y,z,1]。 */
export function mat4TransformPoint(out, m, x, y, z) {
  out[0] = m[0] * x + m[4] * y + m[8] * z + m[12];
  out[1] = m[1] * x + m[5] * y + m[9] * z + m[13];
  out[2] = m[2] * x + m[6] * y + m[10] * z + m[14];
  return out;
}

export function quatIdentity() {
  return [0, 0, 0, 1];
}

export function quatNormalize(q) {
  const len = Math.hypot(q[0], q[1], q[2], q[3]);
  if (len > 0) {
    q[0] /= len; q[1] /= len; q[2] /= len; q[3] /= len;
  }
  return q;
}

/**
 * 四元数球面插值 —— 逐行对照 libGDX Quaternion.slerp：
 * 当 1-|dot| <= 0.1 时退化为线性插值（nlerp），且不额外归一化。
 */
export function quatSlerp(out, a, b, alpha) {
  const d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const absDot = d < 0 ? -d : d;
  let scale0 = 1 - alpha;
  let scale1 = alpha;
  if (1 - absDot > 0.1) {
    const angle = Math.acos(Math.min(1, absDot));
    const invSin = 1 / Math.sin(angle);
    scale0 = Math.sin((1 - alpha) * angle) * invSin;
    scale1 = Math.sin(alpha * angle) * invSin;
  }
  if (d < 0) {
    scale1 = -scale1;
  }
  out[0] = scale0 * a[0] + scale1 * b[0];
  out[1] = scale0 * a[1] + scale1 * b[1];
  out[2] = scale0 * a[2] + scale1 * b[2];
  out[3] = scale0 * a[3] + scale1 * b[3];
  return out;
}

export function vec3Lerp(out, a, b, alpha) {
  const inv = 1 - alpha;
  out[0] = a[0] * inv + b[0] * alpha;
  out[1] = a[1] * inv + b[1] * alpha;
  out[2] = a[2] * inv + b[2] * alpha;
  return out;
}

/** 右-handed lookAt（与 libGDX Camera / OpenGL 相同）。 */
export function mat4LookAt(out, eye, center, up) {
  let zx = eye[0] - center[0], zy = eye[1] - center[1], zz = eye[2] - center[2];
  let len = Math.hypot(zx, zy, zz) || 1;
  zx /= len; zy /= len; zz /= len;

  let xx = up[1] * zz - up[2] * zy;
  let xy = up[2] * zx - up[0] * zz;
  let xz = up[0] * zy - up[1] * zx;
  len = Math.hypot(xx, xy, xz) || 1;
  xx /= len; xy /= len; xz /= len;

  const yx = zy * xz - zz * xy;
  const yy = zz * xx - zx * xz;
  const yz = zx * xy - zy * xx;

  out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
  out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
  out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
  out[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
  out[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
  out[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
  out[15] = 1;
  return out;
}

export function mat4Ortho(out, left, right, bottom, top, near, far) {
  const w = right - left, h = top - bottom, d = far - near;
  out.fill(0);
  out[0] = 2 / w;
  out[5] = 2 / h;
  out[10] = -2 / d;
  out[12] = -(right + left) / w;
  out[13] = -(top + bottom) / h;
  out[14] = -(far + near) / d;
  out[15] = 1;
  return out;
}

export function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}
