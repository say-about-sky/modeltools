//! 矩阵 / 四元数 / TRS 分解工具(f64 计算,输出时转 f32)。
//!
//! 约定:全部按**列向量**语义处理(与 g3d/libgdx 一致):
//! - 平移在矩阵第 4 列;组合 `A·B` 表示"先 B 后 A";
//! - 骨骼世界矩阵 `C = (txᵀ)⁻¹`(tx 为 .mesh 中存储的"世界矩阵的逆");
//! - 节点局部 `L = C_parent⁻¹·C_child`。

/// 4x4 矩阵(行主序存储,列向量语义)
pub type M4 = [[f64; 4]; 4];

pub fn m4_identity() -> M4 {
    [
        [1.0, 0.0, 0.0, 0.0],
        [0.0, 1.0, 0.0, 0.0],
        [0.0, 0.0, 1.0, 0.0],
        [0.0, 0.0, 0.0, 1.0],
    ]
}

pub fn m4_mul(a: &M4, b: &M4) -> M4 {
    let mut r = [[0.0f64; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            let mut s = 0.0;
            for k in 0..4 {
                s += a[i][k] * b[k][j];
            }
            r[i][j] = s;
        }
    }
    r
}

pub fn m4_transpose(a: &M4) -> M4 {
    let mut r = [[0.0f64; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            r[i][j] = a[j][i];
        }
    }
    r
}

/// 高斯-约当消元求逆(带部分主元)
pub fn m4_inverse(a: &M4) -> Option<M4> {
    let mut m = [[0.0f64; 8]; 4];
    for i in 0..4 {
        for j in 0..4 {
            m[i][j] = a[i][j];
            m[i][4 + j] = if i == j { 1.0 } else { 0.0 };
        }
    }
    for col in 0..4 {
        // 选主元
        let mut piv = col;
        for r in col + 1..4 {
            if m[r][col].abs() > m[piv][col].abs() {
                piv = r;
            }
        }
        if m[piv][col].abs() < 1e-12 {
            return None;
        }
        m.swap(col, piv);
        let d = m[col][col];
        for x in m[col].iter_mut() {
            *x /= d;
        }
        for r in 0..4 {
            if r != col {
                let f = m[r][col];
                if f != 0.0 {
                    let row = m[col];
                    for (x, y) in m[r].iter_mut().zip(row.iter()) {
                        *x -= f * y;
                    }
                }
            }
        }
    }
    let mut inv = [[0.0f64; 4]; 4];
    for i in 0..4 {
        for j in 0..4 {
            inv[i][j] = m[i][4 + j];
        }
    }
    Some(inv)
}

/// 由 3x3 旋转矩阵求四元数 (x,y,z,w)
pub fn quat_from_mat3(m: &[[f64; 3]; 3]) -> [f64; 4] {
    let tr = m[0][0] + m[1][1] + m[2][2];
    let (mut x, mut y, mut z, mut w);
    if tr > 0.0 {
        let s = (tr + 1.0).sqrt() * 2.0;
        w = 0.25 * s;
        x = (m[2][1] - m[1][2]) / s;
        y = (m[0][2] - m[2][0]) / s;
        z = (m[1][0] - m[0][1]) / s;
    } else if m[0][0] > m[1][1] && m[0][0] > m[2][2] {
        let s = (1.0 + m[0][0] - m[1][1] - m[2][2]).sqrt() * 2.0;
        w = (m[2][1] - m[1][2]) / s;
        x = 0.25 * s;
        y = (m[0][1] + m[1][0]) / s;
        z = (m[0][2] + m[2][0]) / s;
    } else if m[1][1] > m[2][2] {
        let s = (1.0 + m[1][1] - m[0][0] - m[2][2]).sqrt() * 2.0;
        w = (m[0][2] - m[2][0]) / s;
        x = (m[0][1] + m[1][0]) / s;
        y = 0.25 * s;
        z = (m[1][2] + m[2][1]) / s;
    } else {
        let s = (1.0 + m[2][2] - m[0][0] - m[1][1]).sqrt() * 2.0;
        w = (m[1][0] - m[0][1]) / s;
        x = (m[0][2] + m[2][0]) / s;
        y = (m[1][2] + m[2][1]) / s;
        z = 0.25 * s;
    }
    // 归一化并规范符号(w >= 0 时更稳定)
    let len = (x * x + y * y + z * z + w * w).sqrt();
    if len > 1e-12 {
        x /= len;
        y /= len;
        z /= len;
        w /= len;
    }
    if w < 0.0 {
        x = -x;
        y = -y;
        z = -z;
        w = -w;
    }
    [x, y, z, w]
}

/// 将矩阵分解为平移(T)·旋转(R)·缩放(S)分量(列向量约定)
pub fn trs_decompose(m: &M4) -> ([f64; 3], [f64; 4], [f64; 3]) {
    let t = [m[0][3], m[1][3], m[2][3]];
    let mut c0 = [m[0][0], m[1][0], m[2][0]];
    let mut c1 = [m[0][1], m[1][1], m[2][1]];
    let mut c2 = [m[0][2], m[1][2], m[2][2]];
    let sx = (c0[0] * c0[0] + c0[1] * c0[1] + c0[2] * c0[2]).sqrt();
    let sy = (c1[0] * c1[0] + c1[1] * c1[1] + c1[2] * c1[2]).sqrt();
    let sz = (c2[0] * c2[0] + c2[1] * c2[1] + c2[2] * c2[2]).sqrt();
    if sx > 1e-12 {
        c0 = [c0[0] / sx, c0[1] / sx, c0[2] / sx];
    }
    if sy > 1e-12 {
        c1 = [c1[0] / sy, c1[1] / sy, c1[2] / sy];
    }
    if sz > 1e-12 {
        c2 = [c2[0] / sz, c2[1] / sz, c2[2] / sz];
    }
    // 若行列式为负(镜像),翻转一个缩放分量
    let det = c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) - c1[0] * (c0[1] * c2[2] - c0[2] * c2[1])
        + c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
    let mut sc = [sx.max(0.0), sy.max(0.0), sz.max(0.0)];
    if det < 0.0 {
        sc[0] = -sc[0];
        c0 = [-c0[0], -c0[1], -c0[2]];
    }
    // 旋转矩阵按行组装:rot[i][j] = m[i][j](即第 j 列的第 i 个分量)
    let rot = [
        [c0[0], c1[0], c2[0]],
        [c0[1], c1[1], c2[1]],
        [c0[2], c1[2], c2[2]],
    ];
    let q = quat_from_mat3(&rot);
    (t, q, sc)
}
