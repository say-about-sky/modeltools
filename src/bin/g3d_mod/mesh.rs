//! `.mesh` 数据提取(移植自 JoroDox `rendererService.js` 的 loadPdxMesh 数据通路)。
//!
//! 层次:`object` → shape(LOD 变体,含 `lod` 属性)→ `skeleton`(骨骼表)与 `mesh`(网格对象表)。
//! 骨骼矩阵 `tx`(12 个 float)= 骨骼**世界矩阵的逆**,
//! 布局 = `[3x3 行主序(每行 3 个 float 连续)] + [平移 3]`(共 4 组 × 3)。

use std::collections::HashMap;

use super::matrix::{M4, m4_identity, m4_inverse, m4_transpose};
use super::pdx::PdxObj;

#[derive(Debug, Clone)]
pub struct Bone {
    pub name: String,
    pub parent: Option<usize>,
    /// 逆绑定矩阵(列向量约定,即 g3d NodePart.bones 中的变换)= tx 矩阵转置
    pub inv_bind: M4,
    /// 世界矩阵(列向量约定)= inv_bind^-1
    pub world: M4,
}

#[derive(Debug, Clone, Default)]
pub struct Skeleton {
    pub bones: Vec<Bone>,
    pub children: Vec<Vec<usize>>,
    pub roots: Vec<usize>,
}

#[derive(Debug, Clone)]
pub struct Skin {
    /// 每顶点影响数(1..=4);文件中 ix/w 恒定按 4 个一组存储
    pub influences: usize,
    pub ix: Vec<i32>,
    pub w: Vec<f32>,
}

#[derive(Debug, Clone, Default)]
pub struct MaterialDef {
    pub shader: String,
    pub diff: Option<String>,
    pub normal: Option<String>,
    pub spec: Option<String>,
}

#[derive(Debug, Clone)]
pub struct MeshObj {
    pub name: String,
    pub positions: Vec<f32>,
    pub normals: Vec<f32>,
    pub has_normals: bool,
    pub tangents: Vec<f32>,
    pub uv0: Vec<f32>,
    pub has_uv0: bool,
    pub indices: Vec<i32>,
    pub skin: Option<Skin>,
    pub material: MaterialDef,
}

#[derive(Debug, Clone)]
pub struct Shape {
    pub name: String,
    pub skeleton: Option<Skeleton>,
    pub meshes: Vec<MeshObj>,
}

impl MeshObj {
    pub fn vertex_count(&self) -> usize {
        self.positions.len() / 3
    }
}

/// 轻量扫描:列出 object 下所有 shape 的 (名称, lod)
pub fn scan_shapes(root: &PdxObj) -> Result<Vec<(String, Option<i32>)>, String> {
    let object = root.child("object").ok_or("mesh 文件中缺少 object 节点")?;
    Ok(object
        .children
        .iter()
        .map(|sh| (sh.name.clone(), sh.prop_i32("lod")))
        .collect())
}

/// 完整提取一个 shape(quiet = true 时不输出警告)
pub fn extract_shape(sh: &PdxObj, quiet: bool) -> Result<Shape, String> {
    let mut shape = Shape {
        name: sh.name.clone(),
        skeleton: None,
        meshes: Vec::new(),
    };
    if let Some(skel) = sh.child("skeleton") {
        shape.skeleton = Some(extract_skeleton(skel, quiet)?);
    }
    for m in &sh.children {
        let has_p = m.prop("p").is_some();
        if !has_p && m.prop("tri").is_none() {
            continue; // 非网格子对象
        }
        match extract_mesh(m, quiet) {
            Ok(mesh) => shape.meshes.push(mesh),
            Err(e) => {
                if !quiet {
                    eprintln!("警告: shape '{}' 的网格 '{}' 提取失败: {}", shape.name, m.name, e);
                }
            }
        }
    }
    Ok(shape)
}

fn extract_skeleton(skel: &PdxObj, quiet: bool) -> Result<Skeleton, String> {
    macro_rules! warn {
        ($($arg:tt)*) => {
            if !quiet {
                eprintln!("警告: {}", format!($($arg)*));
            }
        };
    }
    let bone_objs: Vec<&PdxObj> = skel.children.iter().collect();
    let n = bone_objs.len();
    if n == 0 {
        return Err("skeleton 为空".into());
    }
    // ix 值 -> 骨骼序号(正常文件里两者相等;异常时以 ix 为准建立映射)
    let mut index_map: HashMap<i32, usize> = HashMap::new();
    for (i, b) in bone_objs.iter().enumerate() {
        let ix = b.prop_i32("ix").unwrap_or(i as i32);
        if ix != i as i32 {
            warn!("骨骼 '{}' 的 ix={} 与序号 {} 不一致,按 ix 建立映射", b.name, ix, i);
        }
        index_map.insert(ix, i);
    }
    let mut bones: Vec<Bone> = Vec::with_capacity(n);
    for b in bone_objs.iter() {
        // tx:12 个 float,行主序 3x4,最后一行为平移
        // 布局 = [r0.x r0.y r0.z | r1.x r1.y r1.z | r2.x r2.y r2.z | tx ty tz]
        let mut s_mat = m4_identity();
        if let Some(tx) = b.prop_f32s("tx") {
            if tx.len() == 12 {
                let all_zero = tx.iter().all(|v| *v == 0.0);
                if !all_zero {
                    for r in 0..3 {
                        for c in 0..3 {
                            s_mat[r][c] = tx[r * 3 + c] as f64;
                        }
                    }
                    s_mat[3][0] = tx[9] as f64;
                    s_mat[3][1] = tx[10] as f64;
                    s_mat[3][2] = tx[11] as f64;
                } else {
                    warn!("骨骼 '{}' 的 tx 全为 0,按单位阵处理", b.name);
                }
            } else {
                warn!("骨骼 '{}' 的 tx 长度={}(应为 12),按单位阵处理", b.name, tx.len());
            }
        } else {
            warn!("骨骼 '{}' 缺少 tx,按单位阵处理", b.name);
        }
        // invBind = S^T
        let inv_bind = m4_transpose(&s_mat);
        let world = m4_inverse(&inv_bind).unwrap_or_else(m4_identity);
        bones.push(Bone {
            name: b.name.clone(),
            parent: None,
            inv_bind,
            world,
        });
    }
    // 解析父级(pa),防止环路
    let mut children: Vec<Vec<usize>> = vec![Vec::new(); n];
    let mut roots: Vec<usize> = Vec::new();
    for i in 0..n {
        let mut parent = None;
        if let Some(pa) = bone_objs[i].prop_i32("pa") {
            if let Some(&pi) = index_map.get(&pa) {
                if pi != i {
                    // 沿父链上溯,检测环路
                    let mut cur = pi;
                    let mut steps = 0;
                    let mut cycle = false;
                    while steps <= n {
                        if cur == i {
                            cycle = true;
                            break;
                        }
                        match bones[cur].parent {
                            Some(p) => cur = p,
                            None => break,
                        }
                        steps += 1;
                    }
                    if !cycle {
                        parent = Some(pi);
                    } else {
                        warn!("骨骼 '{}' 的父级关系形成环路,按根骨骼处理", bones[i].name);
                    }
                }
            } else {
                warn!("骨骼 '{}' 的 pa={} 无效,按根骨骼处理", bones[i].name, pa);
            }
        }
        bones[i].parent = parent;
        match parent {
            Some(p) => children[p].push(i),
            None => roots.push(i),
        }
    }
    Ok(Skeleton {
        bones,
        children,
        roots,
    })
}

fn extract_mesh(m: &PdxObj, quiet: bool) -> Result<MeshObj, String> {
    macro_rules! warn {
        ($($arg:tt)*) => {
            if !quiet {
                eprintln!("警告: {}", format!($($arg)*));
            }
        };
    }
    let p = m.prop_f32s("p").ok_or("缺少 p(顶点)")?;
    if p.len() % 3 != 0 {
        return Err(format!("p 长度 {} 不是 3 的倍数", p.len()));
    }
    let nv = p.len() / 3;
    let normals = m.prop_f32s("n").map(|v| v.to_vec()).unwrap_or_default();
    let has_normals = normals.len() == nv * 3;
    if !normals.is_empty() && !has_normals {
        warn!("网格 '{}' 法线数({}/{})与顶点数不符,将重新计算", m.name, normals.len() / 3, nv);
    }
    let tangents = m
        .prop_f32s("ta")
        .filter(|v| v.len() == nv * 4)
        .map(|v| v.to_vec())
        .unwrap_or_default();
    let uv0 = m
        .prop_f32s("u0")
        .filter(|v| v.len() == nv * 2)
        .map(|v| v.to_vec())
        .unwrap_or_default();
    let has_uv0 = uv0.len() == nv * 2 && nv > 0;
    let indices: Vec<i32> = m.prop_i32s("tri").map(|v| v.to_vec()).unwrap_or_default();
    if !indices.len().is_multiple_of(3) {
        return Err(format!("tri 长度 {} 不是 3 的倍数", indices.len()));
    }
    for &i in &indices {
        if i < 0 || i as usize >= nv {
            return Err(format!("tri 含越界索引 {}", i));
        }
    }
    // 蒙皮
    let mut skin = None;
    if let Some(sk) = m.child("skin") {
        let influences = sk
            .prop_i32("bones")
            .map(|v| v.clamp(1, 4) as usize)
            .unwrap_or_else(|| {
                warn!("网格 '{}' 的 skin 缺少 bones(影响数),按 4 处理", m.name);
                4
            });
        let ix = sk.prop_i32s("ix").map(|v| v.to_vec()).unwrap_or_default();
        let w = sk.prop_f32s("w").map(|v| v.to_vec()).unwrap_or_default();
        if ix.len() != nv * 4 || w.len() != nv * 4 {
            warn!(
                "网格 '{}' 的 skin 数据长度异常(ix={} w={}, 期望 {})",
                m.name,
                ix.len(),
                w.len(),
                nv * 4
            );
        } else {
            skin = Some(Skin { influences, ix, w });
        }
    }
    // 材质
    let mut material = MaterialDef {
        shader: "standard".into(),
        ..Default::default()
    };
    if let Some(mat) = m.child("material") {
        if let Some(s) = mat.prop_str("shader") {
            material.shader = s.to_string();
        }
        material.diff = mat.prop_str("diff").map(|s| s.to_string());
        material.normal = mat.prop_str("n").map(|s| s.to_string());
        material.spec = mat.prop_str("spec").map(|s| s.to_string());
    }
    Ok(MeshObj {
        name: m.name.clone(),
        positions: p.to_vec(),
        normals,
        has_normals,
        tangents,
        uv0,
        has_uv0,
        indices,
        skin,
        material,
    })
}
