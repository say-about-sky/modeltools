//! g3d 模型结构与构建。
//!
//! - 顶点交错布局:`POSITION, NORMAL, [TANGENT], TEXCOORD0, BLENDWEIGHT0..n`
//!   (每个 BLENDWEIGHT = 2 个 float:骨骼索引 + 权重,影响数 1~4 → 1~4 个属性);
//! - 节点:每个 shape 一个网格节点(parts 引用 meshpart/材质/逆绑定骨骼表)+ 一个
//!   `*_skeleton` 骨骼节点树;骨骼节点局部 = `inv_bind(parent) · world(child)`,再 TRS 分解;
//! - 材质按 (shader,diff,n,spec) 去重;顶点数超限时按三角形拆分(保证 16 位索引可用)。

use std::collections::HashMap;

use super::matrix::{m4_mul, trs_decompose};
use super::mesh::{MaterialDef, MeshObj, Shape, Skeleton};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum Attr {
    Position,
    Normal,
    Tangent,
    TexCoord0,
    BlendWeight(u8),
}

impl Attr {
    pub fn name(&self) -> &'static str {
        match self {
            Attr::Position => "POSITION",
            Attr::Normal => "NORMAL",
            Attr::Tangent => "TANGENT",
            Attr::TexCoord0 => "TEXCOORD0",
            Attr::BlendWeight(0) => "BLENDWEIGHT0",
            Attr::BlendWeight(1) => "BLENDWEIGHT1",
            Attr::BlendWeight(2) => "BLENDWEIGHT2",
            Attr::BlendWeight(_) => "BLENDWEIGHT3",
        }
    }
    pub fn comps(&self) -> usize {
        match self {
            Attr::Position | Attr::Normal | Attr::Tangent => 3,
            Attr::TexCoord0 => 2,
            Attr::BlendWeight(_) => 2, // 单个影响:(骨骼索引, 权重)
        }
    }
}

#[derive(Debug)]
pub struct GMeshPart {
    pub id: String,
    pub indices: Vec<i32>,
}

#[derive(Debug)]
pub struct GMesh {
    pub attributes: Vec<Attr>,
    pub vertex_size: usize,
    pub vertices: Vec<f32>,
    pub parts: Vec<GMeshPart>,
}

#[derive(Debug)]
pub struct GTexture {
    pub id: String,
    pub filename: String,
    pub usage: &'static str,
}

#[derive(Debug)]
pub struct GMaterial {
    pub id: String,
    pub diffuse: [f32; 3],
    pub textures: Vec<GTexture>,
}

#[derive(Debug, Clone)]
pub struct GBoneRef {
    pub node: String,
    pub translation: [f32; 4],
    pub rotation: [f32; 4],
    pub scale: [f32; 4],
}

#[derive(Debug)]
pub struct GNodePart {
    pub meshpartid: String,
    pub materialid: String,
    pub bones: Vec<GBoneRef>,
    pub uv_mapping: bool,
}

#[derive(Debug, Default)]
pub struct GNode {
    pub id: String,
    pub rotation: Option<[f32; 4]>,
    pub scale: Option<[f32; 3]>,
    pub translation: Option<[f32; 3]>,
    pub parts: Vec<GNodePart>,
    pub children: Vec<GNode>,
}

#[derive(Debug, Default)]
pub struct GNodeAnim {
    pub bone_id: String,
    pub translation: Vec<(f32, [f32; 3])>,
    pub rotation: Vec<(f32, [f32; 4])>,
    pub scale: Vec<(f32, [f32; 3])>,
}

#[derive(Debug, Default)]
pub struct GAnim {
    pub id: String,
    pub nodes: Vec<GNodeAnim>,
}

#[derive(Debug, Default)]
pub struct GModel {
    pub id: String,
    pub meshes: Vec<GMesh>,
    pub materials: Vec<GMaterial>,
    pub nodes: Vec<GNode>,
    pub animations: Vec<GAnim>,
}

/// 构建选项
pub struct BuildOpts {
    pub include_normals: bool,
    pub include_tangents: bool,
    pub flip_v: bool,
    pub max_verts: usize,
    pub tex_override: Option<String>,
    pub tex_ext: Option<String>,
    pub no_textures: bool,
    pub diffuse: [f32; 3],
}

/// 顶点源数据(供拆分时按源顶点重建)
struct VertexSource<'a> {
    mesh: &'a MeshObj,
    /// 每源顶点的骨骼数据:(本地骨骼序号, 权重);未蒙皮时为空
    bone_data: Vec<Vec<(u32, f32)>>,
    attrs: Vec<Attr>,
    bw_count: usize,
    /// 法线数据源(源文件法线或计算出的平滑法线)
    normals: Option<&'a [f32]>,
}

pub fn build_model(shapes: &[Shape], opts: &BuildOpts, model_id: &str) -> Result<GModel, String> {
    let mut model = GModel {
        id: model_id.to_string(),
        ..Default::default()
    };
    let multi = shapes.len() > 1;
    // 去重用的材质表:(shader, diff, n, spec) -> 材质下标
    let mut material_map: HashMap<(String, String, String, String), usize> = HashMap::new();
    let mut warnings: Vec<String> = Vec::new();

    for (shape_idx, shape) in shapes.iter().enumerate() {
        let prefix = if multi && shape_idx > 0 {
            Some(shape.name.as_str())
        } else {
            None
        };
        let bone_node_id = |bone_name: &str| -> String {
            match prefix {
                Some(p) => format!("{}.{}", p, bone_name),
                None => bone_name.to_string(),
            }
        };

        // ------- 网格节点(含各 mesh 对象的 NodePart) -------
        let mut mesh_node = GNode {
            id: shape.name.clone(),
            ..Default::default()
        };
        let mut part_counter = 0usize;

        for mobj in &shape.meshes {
            let nv = mobj.vertex_count();
            if nv == 0 || mobj.indices.is_empty() {
                continue;
            }
            // 材质(全局去重)
            let mat_idx = get_material(&mut model, &mut material_map, &mobj.material, shape, opts);
            let mat = &model.materials[mat_idx];
            let has_tex = !mat.textures.is_empty();
            let material_id = mat.id.clone();

            // 骨骼重映射(该网格用到的骨骼,按骨架顺序)
            let mut bone_refs: Vec<GBoneRef> = Vec::new();
            let mut vertex_bones: Vec<Vec<(u32, f32)>> = Vec::new();
            let mut influences = 0usize;
            if let (Some(skin), Some(skel)) = (mobj.skin.as_ref(), shape.skeleton.as_ref()) {
                influences = skin.influences.clamp(1, 4);
                let mut used_bone: Vec<bool> = vec![false; skel.bones.len()];
                let mut dropped = 0usize;
                let mut bad = 0usize;
                let mut fallbacks = 0usize;
                let mut renorm = 0usize;
                // 第一遍:收集使用到的骨骼
                for k in 0..nv {
                    let mut any = false;
                    for j in 0..influences {
                        let ix = skin.ix[k * 4 + j];
                        let w = skin.w[k * 4 + j];
                        if w > 0.0 && ix >= 0 && (ix as usize) < skel.bones.len() {
                            used_bone[ix as usize] = true;
                            any = true;
                        }
                    }
                    if !any {
                        dropped += 1;
                    }
                }
                if used_bone.iter().any(|b| *b) {
                    // 建立 骨架序号 -> 局部序号(按骨架顺序)
                    let mut remap: Vec<i32> = vec![-1; skel.bones.len()];
                    let mut local_names: Vec<usize> = Vec::new();
                    for (i, used) in used_bone.iter().enumerate() {
                        if *used {
                            remap[i] = local_names.len() as i32;
                            local_names.push(i);
                        }
                    }
                    for &bi in &local_names {
                        let b = &skel.bones[bi];
                        let (t, q, s) = trs_decompose(&b.inv_bind);
                        bone_refs.push(GBoneRef {
                            node: bone_node_id(&b.name),
                            translation: [t[0] as f32, t[1] as f32, t[2] as f32, 0.0],
                            rotation: [q[0] as f32, q[1] as f32, q[2] as f32, q[3] as f32],
                            scale: [s[0] as f32, s[1] as f32, s[2] as f32, 0.0],
                        });
                    }
                    // 第二遍:每顶点权重(重映射 + 归一化 + 兜底)
                    vertex_bones.reserve(nv);
                    for k in 0..nv {
                        let mut list: Vec<(u32, f32)> = Vec::with_capacity(4);
                        let mut sum = 0.0f32;
                        for j in 0..influences {
                            let ix = skin.ix[k * 4 + j];
                            let w = skin.w[k * 4 + j];
                            if w <= 0.0 {
                                continue;
                            }
                            if ix >= 0 && (ix as usize) < skel.bones.len() {
                                let local = remap[ix as usize];
                                if local >= 0 {
                                    list.push((local as u32, w));
                                    sum += w;
                                }
                            } else {
                                bad += 1;
                            }
                        }
                        if list.is_empty() {
                            // 全部无效:兜底绑定到第 0 个骨骼
                            list.push((0, 1.0));
                            fallbacks += 1;
                        } else if (sum - 1.0).abs() > 1e-3 {
                            if sum > 1e-6 {
                                for e in list.iter_mut() {
                                    e.1 /= sum;
                                }
                                renorm += 1;
                            } else {
                                list.clear();
                                list.push((0, 1.0));
                                fallbacks += 1;
                            }
                        }
                        vertex_bones.push(list);
                    }
                    if dropped > 0 {
                        warnings.push(format!(
                            "shape '{}' 网格 '{}': {} 个顶点无有效权重,已兜底绑定骨骼 0",
                            shape.name, mobj.name, dropped
                        ));
                    }
                    if bad > 0 {
                        warnings.push(format!(
                            "shape '{}' 网格 '{}': {} 个权重索引越界已丢弃",
                            shape.name, mobj.name, bad
                        ));
                    }
                    if renorm > 0 {
                        warnings.push(format!(
                            "shape '{}' 网格 '{}': {} 个顶点权重和≠1 已归一化",
                            shape.name, mobj.name, renorm
                        ));
                    }
                    if fallbacks > 0 {
                        warnings.push(format!(
                            "shape '{}' 网格 '{}': {} 个顶点权重全零已兜底",
                            shape.name, mobj.name, fallbacks
                        ));
                    }
                } else {
                    warnings.push(format!(
                        "shape '{}' 网格 '{}': 蒙皮数据无有效权重,按静态网格导出",
                        shape.name, mobj.name
                    ));
                }
            } else if mobj.skin.is_some() && shape.skeleton.is_none() {
                warnings.push(format!(
                    "shape '{}' 网格 '{}': 有蒙皮但 shape 无骨架,按静态网格导出",
                    shape.name, mobj.name
                ));
            }

            let has_bones = !bone_refs.is_empty();
            // 每个影响 1 个 BLENDWEIGHT 属性 = 2 个 float(索引, 权重)
            let bw_count = if has_bones { influences.clamp(1, 4) } else { 0 };

            // 属性表
            let mut attrs = vec![Attr::Position];
            if opts.include_normals {
                attrs.push(Attr::Normal);
            }
            if opts.include_tangents && !mobj.tangents.is_empty() {
                attrs.push(Attr::Tangent);
            }
            if mobj.has_uv0 {
                attrs.push(Attr::TexCoord0);
            }
            for bi in 0..bw_count {
                attrs.push(Attr::BlendWeight(bi as u8));
            }
            let stride: usize = attrs.iter().map(|a| a.comps()).sum();

            // 缺少法线时预计算一次平滑法线
            let computed_normals: Vec<f32>;
            let normals_ref: Option<&[f32]> = if !opts.include_normals {
                None
            } else if mobj.has_normals {
                Some(&mobj.normals)
            } else {
                computed_normals = compute_smooth_normals(mobj);
                Some(&computed_normals)
            };

            let src = VertexSource {
                mesh: mobj,
                bone_data: vertex_bones,
                attrs: attrs.clone(),
                bw_count,
                normals: normals_ref,
            };

            // 顶点数超限时按三角形分组拆分
            let groups = partition_indices(&mobj.indices, nv, opts.max_verts);
            if groups.len() > 1 {
                warnings.push(format!(
                    "shape '{}' 网格 '{}': {} 个顶点超过 --max-verts,拆分为 {} 块",
                    shape.name,
                    mobj.name,
                    nv,
                    groups.len()
                ));
            }
            for group in &groups {
                part_counter += 1;
                let part_id = format!("{}_part{}", shape.name, part_counter);
                let mut vertices = Vec::with_capacity(group.src.len() * stride);
                for &sv in &group.src {
                    write_vertex(&mut vertices, &src, sv as usize, opts);
                }
                let mesh = GMesh {
                    attributes: attrs.clone(),
                    vertex_size: stride,
                    vertices,
                    parts: vec![GMeshPart {
                        id: part_id.clone(),
                        indices: group.indices.clone(),
                    }],
                };
                model.meshes.push(mesh);
                mesh_node.parts.push(GNodePart {
                    meshpartid: part_id,
                    materialid: material_id.clone(),
                    bones: bone_refs.clone(),
                    uv_mapping: has_tex,
                });
            }
        }
        if !mesh_node.parts.is_empty() {
            model.nodes.push(mesh_node);
        }

        // ------- 骨架节点树 -------
        if let Some(skel) = &shape.skeleton {
            let mut skel_node = GNode {
                id: format!("{}_skeleton", shape.name),
                ..Default::default()
            };
            let mut guard = 0usize;
            for &r in &skel.roots {
                skel_node
                    .children
                    .push(build_bone_node(skel, r, &bone_node_id, &mut guard));
            }
            model.nodes.push(skel_node);
        }
    }

    for w in warnings {
        eprintln!("警告: {}", w);
    }
    Ok(model)
}

fn build_bone_node(
    skel: &Skeleton,
    idx: usize,
    bone_node_id: &dyn Fn(&str) -> String,
    guard: &mut usize,
) -> GNode {
    let bone = &skel.bones[idx];
    // 局部矩阵 L = C_parent^-1 * C_child = inv_bind(parent) * world(child)
    let local = match bone.parent {
        Some(p) => m4_mul(&skel.bones[p].inv_bind, &bone.world),
        None => bone.world,
    };
    let (t, q, s) = trs_decompose(&local);
    let mut node = GNode {
        id: bone_node_id(&bone.name),
        ..Default::default()
    };
    // g3d 默认值检查:rotation != (0,0,0,1) / scale != (1,1,1) / translation != (0,0,0)
    let qf = [q[0] as f32, q[1] as f32, q[2] as f32, q[3] as f32];
    if qf != [0.0, 0.0, 0.0, 1.0] {
        node.rotation = Some(qf);
    }
    let sf = [
        if (s[0] - 1.0).abs() < 1e-6 { 1.0 } else { s[0] as f32 },
        if (s[1] - 1.0).abs() < 1e-6 { 1.0 } else { s[1] as f32 },
        if (s[2] - 1.0).abs() < 1e-6 { 1.0 } else { s[2] as f32 },
    ];
    if sf != [1.0, 1.0, 1.0] {
        node.scale = Some(sf);
    }
    let tf = [t[0] as f32, t[1] as f32, t[2] as f32];
    if tf != [0.0, 0.0, 0.0] {
        node.translation = Some(tf);
    }
    *guard += 1;
    if *guard < 10_000 {
        for &c in &skel.children[idx] {
            node.children
                .push(build_bone_node(skel, c, bone_node_id, guard));
        }
    }
    node
}

/// 材质去重/创建
fn get_material(
    model: &mut GModel,
    map: &mut HashMap<(String, String, String, String), usize>,
    def: &MaterialDef,
    shape: &Shape,
    opts: &BuildOpts,
) -> usize {
    let mut diff = def.diff.clone();
    if let Some(t) = &opts.tex_override {
        diff = Some(t.clone());
    } else if let (Some(d), Some(ext)) = (&diff, &opts.tex_ext) {
        diff = Some(replace_ext(d, ext));
    }
    let normal = def.normal.clone();
    let spec = def.spec.clone();
    let key = (
        def.shader.clone(),
        diff.clone().unwrap_or_default(),
        normal.clone().unwrap_or_default(),
        spec.clone().unwrap_or_default(),
    );
    if let Some(&idx) = map.get(&key) {
        return idx;
    }
    let id = format!("{}_mat{}", shape.name, model.materials.len() + 1);
    let mut textures = Vec::new();
    if !opts.no_textures {
        let mut push_tex = |file: &Option<String>, usage: &'static str, n: &mut usize| {
            if let Some(f) = file {
                *n += 1;
                textures.push(GTexture {
                    id: format!("{}_tex{}", id, *n),
                    filename: basename(f),
                    usage,
                });
            }
        };
        let mut n = 0usize;
        push_tex(&diff, "DIFFUSE", &mut n);
        push_tex(&normal, "NORMAL", &mut n);
        push_tex(&spec, "SPECULAR", &mut n);
    }
    model.materials.push(GMaterial {
        id,
        diffuse: opts.diffuse,
        textures,
    });
    let idx = model.materials.len() - 1;
    map.insert(key, idx);
    idx
}

fn replace_ext(file: &str, ext: &str) -> String {
    match file.rfind('.') {
        Some(pos) => format!("{}.{}", &file[..pos], ext.trim_start_matches('.')),
        None => format!("{}.{}", file, ext.trim_start_matches('.')),
    }
}

fn basename(file: &str) -> String {
    let f = file.rsplit(['/', '\\']).next().unwrap_or(file);
    f.to_string()
}

/// 顶点分组:每组一个独立顶点缓冲(保证索引可用 16 位)
struct VGroup {
    /// 组内新顶点对应的源顶点序号(按出现顺序)
    src: Vec<i32>,
    /// 组内三角形索引(引用 src 的下标)
    indices: Vec<i32>,
}

fn partition_indices(indices: &[i32], nv: usize, max_verts: usize) -> Vec<VGroup> {
    if max_verts == 0 || nv <= max_verts {
        return vec![VGroup {
            src: (0..nv as i32).collect(),
            indices: indices.to_vec(),
        }];
    }
    let mut groups: Vec<VGroup> = Vec::new();
    let mut map: HashMap<i32, i32> = HashMap::new();
    let mut cur_src: Vec<i32> = Vec::new();
    let mut cur_idx: Vec<i32> = Vec::new();
    for tri in indices.chunks(3) {
        let mut newc = 0;
        for &v in tri {
            if !map.contains_key(&v) {
                newc += 1;
            }
        }
        if !cur_idx.is_empty() && map.len() + newc > max_verts {
            groups.push(VGroup {
                src: std::mem::take(&mut cur_src),
                indices: std::mem::take(&mut cur_idx),
            });
            map.clear();
        }
        for &v in tri {
            let id = match map.get(&v) {
                Some(&id) => id,
                None => {
                    let id = cur_src.len() as i32;
                    cur_src.push(v);
                    map.insert(v, id);
                    id
                }
            };
            cur_idx.push(id);
        }
    }
    if !cur_idx.is_empty() {
        groups.push(VGroup {
            src: cur_src,
            indices: cur_idx,
        });
    }
    groups
}

/// 将单个源顶点写入交错顶点缓冲
fn write_vertex(out: &mut Vec<f32>, src: &VertexSource, vi: usize, opts: &BuildOpts) {
    let m = src.mesh;
    // POSITION
    out.push(m.positions[vi * 3]);
    out.push(m.positions[vi * 3 + 1]);
    out.push(m.positions[vi * 3 + 2]);
    // NORMAL
    if src.attrs.contains(&Attr::Normal) {
        if let Some(norms) = src.normals {
            out.push(norms[vi * 3]);
            out.push(norms[vi * 3 + 1]);
            out.push(norms[vi * 3 + 2]);
        } else {
            out.push(0.0);
            out.push(0.0);
            out.push(0.0);
        }
    }
    // TANGENT(丢弃 w)
    if src.attrs.contains(&Attr::Tangent) {
        out.push(m.tangents[vi * 4]);
        out.push(m.tangents[vi * 4 + 1]);
        out.push(m.tangents[vi * 4 + 2]);
    }
    // TEXCOORD0
    if src.attrs.contains(&Attr::TexCoord0) {
        let u = m.uv0[vi * 2];
        let mut v = m.uv0[vi * 2 + 1];
        if opts.flip_v {
            v = 1.0 - v;
        }
        out.push(u);
        out.push(v);
    }
    // BLENDWEIGHT:每个影响 = 2 个 float(索引, 权重);不足补 (0, 0)
    if src.bw_count > 0 {
        let bones = &src.bone_data[vi];
        for j in 0..src.bw_count {
            match bones.get(j) {
                Some((idx, w)) => {
                    out.push(*idx as f32);
                    out.push(*w);
                }
                None => {
                    out.push(0.0);
                    out.push(0.0);
                }
            }
        }
    }
}

/// 平滑法线(仅当源文件缺 n 时使用):按面法线加权累加
fn compute_smooth_normals(m: &MeshObj) -> Vec<f32> {
    let nv = m.vertex_count();
    let mut acc = vec![[0.0f64; 3]; nv];
    for tri in m.indices.chunks(3) {
        let (ax, ay, az) = get_pos(m, tri[0] as usize);
        let (bx, by, bz) = get_pos(m, tri[1] as usize);
        let (cx, cy, cz) = get_pos(m, tri[2] as usize);
        let ux = bx - ax;
        let uy = by - ay;
        let uz = bz - az;
        let vx = cx - ax;
        let vy = cy - ay;
        let vz = cz - az;
        let nx = (uy * vz - uz * vy) as f64;
        let ny = (uz * vx - ux * vz) as f64;
        let nz = (ux * vy - uy * vx) as f64;
        for &vi in tri {
            let a = &mut acc[vi as usize];
            a[0] += nx;
            a[1] += ny;
            a[2] += nz;
        }
    }
    let mut out = vec![0.0f32; nv * 3];
    for (i, a) in acc.iter().enumerate() {
        let len = (a[0] * a[0] + a[1] * a[1] + a[2] * a[2]).sqrt();
        if len > 1e-12 {
            out[i * 3] = (a[0] / len) as f32;
            out[i * 3 + 1] = (a[1] / len) as f32;
            out[i * 3 + 2] = (a[2] / len) as f32;
        }
    }
    out
}

fn get_pos(m: &MeshObj, i: usize) -> (f32, f32, f32) {
    (m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2])
}
