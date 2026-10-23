//! g3d —— 将 Paradox (.mesh) 模型文件转换为 libGDX g3dj / g3db 格式。
//!
//! 网格解析逻辑移植自 JoroDox(js/pdxDataService.js、js/rendererService.js 的 mesh→dae 通路):
//! pdx 二进制容器解析(@@b@ 头、'[' 深度对象、'!' 属性)、顶点/法线/切线/UV/三角形/蒙皮/骨骼/材质的提取。
//! 输出格式移植自 fbx-conv-master(src/modeldata/Serialization.cpp、json/JSONWriter.h、json/UBJSONWriter.h):
//! g3dj 为 JSONWriter 风格(制表符缩进、CRLF、"% 8f" 浮点、" %3i" 整数等);
//! g3db 为 UBJSON 二进制(大端;'i'=int16、'I'=int32、'd'=float32、'a/A' 强类型数组,
//! 兼容 libgdx UBJsonReader(oldFormat=true))。
//!
//! 骨骼矩阵要点(.mesh 实测验证):
//!   - 存储的 tx(12 个 float)= 骨骼世界矩阵的逆,行主序,最后一行是平移;
//!   - g3d 逆绑定矩阵 invBind = tx 矩阵转置(3x3 转置 + 平移落到第 4 列);
//!   - 世界矩阵 C = invBind^-1;节点局部 = C_parent^-1 * C_child;
//!   - .anim 动画中的 t/q 为局部变换,可直接透传。
//!
//! 本文件同时是二进制 `g3d`(入口 `src/bin/g3d.rs`,经 `#[path]` 加载)的模块根,
//! 各模块如下:
//! - [`matrix`] 4x4 矩阵 / 四元数 / TRS 分解工具;
//! - [`pdx`]    PDX 二进制容器解析(.mesh / .anim 共用);
//! - [`mesh`]   .mesh 数据提取(骨架 / 蒙皮 / 网格 / 材质 / shape);
//! - [`model`]  g3d 模型结构定义与构建(顶点交错、骨骼节点树、材质去重、拆分);
//! - [`writer`] 序列化入口(G3dW trait + serialize_* 系列,移植自 fbx-conv);
//! - [`json`]   g3dj(JSON)写入器;
//! - [`ubjson`] g3db(UBJSON)写入器;
//! - [`anim`]   .anim 动画解析与 g3d 转换;
//! - [`app`]    命令行参数与主流程(二进制入口 [`cli_main`])。
//!
//! 用法示例:
//!   g3d unit_weapon_zweihander.mesh
//!   g3d unit_skeleton.mesh -j -o out.g3dj -v
//!   g3d unit_torso.mesh --lod all --anim x_idle.anim --anim x_walk.anim

pub mod anim;
pub mod app;
pub mod json;
pub mod matrix;
pub mod mesh;
pub mod model;
pub mod pdx;
pub mod ubjson;
pub mod writer;

pub use app::cli_main;

#[cfg(test)]
mod tests {
    use super::matrix::{M4, m4_identity, m4_mul};
    use super::mesh::extract_shape;
    use super::model::{Attr, BuildOpts, GBoneRef, GModel, GNode, build_model};
    use super::pdx::pdx_parse;
    use std::collections::HashMap;

    // ---------------------------------------------------------------- PDX 测试字节合成

    fn prop_i(name: &str, vals: &[i32]) -> Vec<u8> {
        let mut b = vec![b'!', name.len() as u8];
        b.extend_from_slice(name.as_bytes());
        b.push(b'i');
        b.extend_from_slice(&(vals.len() as u32).to_le_bytes());
        for &v in vals {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b
    }

    fn prop_f(name: &str, vals: &[f32]) -> Vec<u8> {
        let mut b = vec![b'!', name.len() as u8];
        b.extend_from_slice(name.as_bytes());
        b.push(b'f');
        b.extend_from_slice(&(vals.len() as u32).to_le_bytes());
        for &v in vals {
            b.extend_from_slice(&v.to_le_bytes());
        }
        b
    }

    fn prop_s(name: &str, s: &str) -> Vec<u8> {
        let mut b = vec![b'!', name.len() as u8];
        b.extend_from_slice(name.as_bytes());
        b.push(b's');
        b.extend_from_slice(&1u32.to_le_bytes());
        b.extend_from_slice(&((s.len() + 1) as u32).to_le_bytes());
        b.extend_from_slice(s.as_bytes());
        b.push(0);
        b
    }

    /// 合成 pdx 对象:depth 个 '[' + 名字 + NUL + 内容
    fn obj(depth: usize, name: &str, content: Vec<u8>) -> Vec<u8> {
        let mut b = vec![b'['; depth];
        b.extend_from_slice(name.as_bytes());
        b.push(0);
        b.extend(content);
        b
    }

    /// 单位 tx
    const IDENTITY_TX: [f32; 12] = [
        1.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, //
        0.0, 0.0, 1.0, //
        0.0, 0.0, 0.0,
    ];

    /// 平移 (0, 10, 0) 的 tx(invBind 平移 = (0,10,0))
    const BONE_TX: [f32; 12] = [
        1.0, 0.0, 0.0, //
        0.0, 1.0, 0.0, //
        0.0, 0.0, 1.0, //
        0.0, 10.0, 0.0,
    ];

    /// 合成 .mesh 文件:根(pdxasset 属性)→ object → testShape → skeleton / testMesh
    fn mesh_file() -> Vec<u8> {
        let mut b = b"@@b@".to_vec();
        b.extend(prop_i("pdxasset", &[1, 0])); // 根对象属性(与真实文件一致)
        let skeleton = obj(3, "skeleton", {
            let mut c = obj(4, "root", [prop_i("ix", &[0]), prop_f("tx", &IDENTITY_TX)].concat());
            c.extend(obj(
                4,
                "bone1",
                [
                    prop_i("ix", &[1]),
                    prop_i("pa", &[0]),
                    prop_f("tx", &BONE_TX),
                ]
                .concat(),
            ));
            c
        });
        let mesh = obj(3, "testMesh", {
            let mut c = [
                prop_f("p", &[0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0]),
                prop_f("n", &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
                prop_f("u0", &[0.0, 0.0, 1.0, 0.0, 0.0, 1.0]),
                prop_i("tri", &[0, 1, 2]),
            ]
            .concat();
            c.extend(obj(
                4,
                "skin",
                [
                    prop_i("bones", &[2]), // 每顶点 2 个影响
                    prop_i("ix", &[0, 1, -1, -1, 1, -1, -1, -1, 0, -1, -1, -1]),
                    prop_f("w", &[0.5, 0.5, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0]),
                ]
                .concat(),
            ));
            c.extend(obj(
                4,
                "material",
                [prop_s("shader", "standard"), prop_s("diff", "t_diffuse.dds")].concat(),
            ));
            c
        });
        let shape = obj(2, "testShape", [skeleton, mesh].concat());
        b.extend(obj(1, "object", shape));
        b
    }

    fn test_opts() -> BuildOpts {
        BuildOpts {
            include_normals: true,
            include_tangents: false,
            flip_v: false,
            max_verts: 32767,
            tex_override: None,
            tex_ext: None,
            no_textures: false,
            diffuse: [0.8, 0.8, 0.8],
        }
    }

    /// 由合成 .mesh 走完整管线生成模型
    fn sample_model(opts: &BuildOpts) -> GModel {
        let root = pdx_parse(&mesh_file()).expect("pdx 解析失败");
        let object = root.child("object").expect("缺少 object 节点");
        let shape = extract_shape(&object.children[0], true).expect("shape 提取失败");
        build_model(&[shape], opts, "test").expect("模型构建失败")
    }

    // ---------------------------------------------------------------- 矩阵测试工具

    fn quat_to_m4(q: &[f64; 4]) -> M4 {
        let (x, y, z, w) = (q[0], q[1], q[2], q[3]);
        let mut m = m4_identity();
        m[0][0] = 1.0 - 2.0 * (y * y + z * z);
        m[0][1] = 2.0 * (x * y - z * w);
        m[0][2] = 2.0 * (x * z + y * w);
        m[1][0] = 2.0 * (x * y + z * w);
        m[1][1] = 1.0 - 2.0 * (x * x + z * z);
        m[1][2] = 2.0 * (y * z - x * w);
        m[2][0] = 2.0 * (x * z - y * w);
        m[2][1] = 2.0 * (y * z + x * w);
        m[2][2] = 1.0 - 2.0 * (x * x + y * y);
        m
    }

    /// 节点局部矩阵 T * R * S
    fn node_trs(n: &GNode) -> M4 {
        let mut t = m4_identity();
        if let Some(v) = n.translation {
            t[0][3] = v[0] as f64;
            t[1][3] = v[1] as f64;
            t[2][3] = v[2] as f64;
        }
        let r = match n.rotation {
            Some(q) => quat_to_m4(&[q[0] as f64, q[1] as f64, q[2] as f64, q[3] as f64]),
            None => m4_identity(),
        };
        let mut s = m4_identity();
        if let Some(v) = n.scale {
            s[0][0] = v[0] as f64;
            s[1][1] = v[1] as f64;
            s[2][2] = v[2] as f64;
        }
        m4_mul(&m4_mul(&t, &r), &s)
    }

    fn collect_globals(n: &GNode, parent: &M4, out: &mut HashMap<String, M4>) {
        let g = m4_mul(parent, &node_trs(n));
        out.insert(n.id.clone(), g);
        for c in &n.children {
            collect_globals(c, &g, out);
        }
    }

    /// 逆绑定矩阵参考:由 NodePart.bones 的 TRS 重组 T * R * S
    fn bone_ref_matrix(b: &GBoneRef) -> M4 {
        let mut t = m4_identity();
        t[0][3] = b.translation[0] as f64;
        t[1][3] = b.translation[1] as f64;
        t[2][3] = b.translation[2] as f64;
        let r = quat_to_m4(&[
            b.rotation[0] as f64,
            b.rotation[1] as f64,
            b.rotation[2] as f64,
            b.rotation[3] as f64,
        ]);
        let mut s = m4_identity();
        s[0][0] = b.scale[0] as f64;
        s[1][1] = b.scale[1] as f64;
        s[2][2] = b.scale[2] as f64;
        m4_mul(&m4_mul(&t, &r), &s)
    }

    // ---------------------------------------------------------------- 测试:mesh 管线

    #[test]
    fn mesh_to_g3d() {
        let model = sample_model(&test_opts());
        assert_eq!(model.id, "test");
        // 网格与属性
        assert_eq!(model.meshes.len(), 1);
        let mesh = &model.meshes[0];
        assert_eq!(
            mesh.attributes,
            vec![
                Attr::Position,
                Attr::Normal,
                Attr::TexCoord0,
                Attr::BlendWeight(0),
                Attr::BlendWeight(1)
            ]
        );
        assert_eq!(mesh.vertex_size, 12); // 3 + 3 + 2 + 2 + 2
        assert_eq!(mesh.vertices.len(), 3 * 12);
        assert_eq!(mesh.parts[0].id, "testShape_part1");
        assert_eq!(mesh.parts[0].indices, vec![0, 1, 2]);
        // 位置 / 法线 / UV 原样透传
        assert_eq!(&mesh.vertices[0..3], &[0.0, 0.0, 0.0]);
        assert_eq!(&mesh.vertices[3..6], &[0.0, 0.0, 1.0]);
        assert_eq!(&mesh.vertices[6..8], &[0.0, 0.0]);
        assert_eq!(&mesh.vertices[12..15], &[1.0, 0.0, 0.0]);
        // 混合权重(每顶点 2 个影响 = 4 个 float)
        assert_eq!(&mesh.vertices[8..12], &[0.0, 0.5, 1.0, 0.5]); // v0: 骨骼 0/1 各半
        assert_eq!(&mesh.vertices[20..24], &[1.0, 1.0, 0.0, 0.0]); // v1: 骨骼 1 全权
        assert_eq!(&mesh.vertices[32..36], &[0.0, 1.0, 0.0, 0.0]); // v2: 骨骼 0 全权
        // 材质
        assert_eq!(model.materials.len(), 1);
        let mat = &model.materials[0];
        assert_eq!(mat.id, "testShape_mat1");
        assert_eq!(mat.textures.len(), 1);
        assert_eq!(mat.textures[0].filename, "t_diffuse.dds");
        // 节点:网格节点 + 骨架节点
        assert_eq!(model.nodes.len(), 2);
        let mesh_node = model.nodes.iter().find(|n| n.id == "testShape").unwrap();
        let skel_node = model.nodes.iter().find(|n| n.id == "testShape_skeleton").unwrap();
        assert_eq!(mesh_node.parts.len(), 1);
        assert!(mesh_node.parts[0].uv_mapping);
        // 骨骼引用:用了骨架里的 2 根骨骼(按骨架顺序)
        let part = &mesh_node.parts[0];
        assert_eq!(part.bones.len(), 2);
        assert_eq!(part.bones[0].node, "root");
        assert_eq!(part.bones[1].node, "bone1");
        assert!(part.bones[0].translation[..3].iter().all(|v| v.abs() < 1e-6));
        assert!((part.bones[1].translation[1] - 10.0).abs() < 1e-5);
        assert_eq!(part.bones[0].rotation, [0.0, 0.0, 0.0, 1.0]);
        // 骨架节点:root(单位局部)→ bone1(平移 -(0,10,0))
        assert_eq!(skel_node.children.len(), 1);
        let root_node = &skel_node.children[0];
        assert_eq!(root_node.id, "root");
        assert!(root_node.translation.is_none());
        assert_eq!(root_node.children.len(), 1);
        let bone1_node = &root_node.children[0];
        assert_eq!(bone1_node.id, "bone1");
        let t = bone1_node.translation.unwrap();
        assert!((t[1] + 10.0).abs() < 1e-5, "bone1 局部平移应为 (0,-10,0),实际 {t:?}");
        // 绑定姿态自检:global(骨骼节点) × invBind ≈ 单位阵
        let mut globals = HashMap::new();
        for c in &skel_node.children {
            collect_globals(c, &m4_identity(), &mut globals);
        }
        for b in &part.bones {
            let g = globals.get(&b.node).expect("缺少骨骼节点");
            let bind = m4_mul(g, &bone_ref_matrix(b));
            for i in 0..4 {
                for j in 0..4 {
                    let expect = if i == j { 1.0 } else { 0.0 };
                    assert!(
                        (bind[i][j] - expect).abs() < 1e-4,
                        "绑定姿态偏差 {}[{i}][{j}] = {}",
                        b.node,
                        bind[i][j]
                    );
                }
            }
        }
        // flip_v 选项
        let mut opts = test_opts();
        opts.flip_v = true;
        let flipped = sample_model(&opts);
        assert_eq!(&flipped.meshes[0].vertices[6..8], &[0.0, 1.0]); // (0,0) → (0,1)
    }

    // ---------------------------------------------------------------- 测试:动画管线

    fn anim_file() -> Vec<u8> {
        let mut b = b"@@b@".to_vec();
        b.extend(prop_i("pdxasset", &[1, 0])); // 根对象属性(与真实文件一致)
        let info = obj(1, "info", {
            let mut c = [prop_f("fps", &[10.0]), prop_i("sa", &[2])].concat();
            c.extend(obj(2, "root", prop_s("sa", "")));
            c.extend(obj(2, "bone1", prop_s("sa", "tq")));
            c.extend(obj(2, "bone2", prop_s("sa", "s")));
            c
        });
        let samples = obj(1, "samples", {
            [
                prop_f("t", &[0.0, 0.0, 0.0, 1.0, 2.0, 3.0]),
                prop_f(
                    "q",
                    &[
                        0.0,
                        0.0,
                        0.0,
                        1.0,
                        0.0,
                        0.0,
                        std::f32::consts::FRAC_1_SQRT_2,
                        std::f32::consts::FRAC_1_SQRT_2,
                    ],
                ),
                prop_f("s", &[2.0, 4.0]), // 标量变体:每样本 1 个 float
            ]
            .concat()
        });
        b.extend([info, samples].concat());
        b
    }

    #[test]
    fn anim_to_g3d() {
        use super::anim::{anim_to_g3d, parse_anim};
        let root = pdx_parse(&anim_file()).expect("anim 解析失败");
        let af = parse_anim("x_test", &root).expect("parse_anim 失败");
        assert_eq!(af.fps, 10.0);
        assert_eq!(af.sa, 2);
        assert_eq!(af.bones.len(), 3);
        let mut known = HashMap::new();
        for n in ["root", "bone1", "bone2"] {
            known.insert(n.to_string(), n.to_string());
        }
        let ganim = anim_to_g3d(&af, &known).expect("anim_to_g3d 失败");
        assert_eq!(ganim.id, "x_test");
        assert_eq!(ganim.nodes.len(), 2); // root 无通道,不产生节点
        let n0 = &ganim.nodes[0];
        assert_eq!(n0.bone_id, "bone1");
        assert_eq!(n0.translation.len(), 2);
        assert_eq!(n0.rotation.len(), 2);
        // 时间轴 = k * 1000 / fps
        assert_eq!(n0.translation[0].0, 0.0);
        assert_eq!(n0.translation[1].0, 100.0);
        assert_eq!(n0.translation[1].1, [1.0, 2.0, 3.0]);
        assert_eq!(n0.rotation[0].1, [0.0, 0.0, 0.0, 1.0]);
        let q1 = n0.rotation[1].1;
        assert!((q1[2] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        assert!((q1[3] - std::f32::consts::FRAC_1_SQRT_2).abs() < 1e-6);
        // 标量缩放变体展开为 (v, v, v)
        let n1 = &ganim.nodes[1];
        assert_eq!(n1.bone_id, "bone2");
        assert_eq!(n1.scale.len(), 2);
        assert_eq!(n1.scale[0].1, [2.0, 2.0, 2.0]);
        assert_eq!(n1.scale[1].1, [4.0, 4.0, 4.0]);
        assert!(n1.translation.is_empty() && n1.rotation.is_empty());
        // 未知骨骼被跳过并告警(不报错)
        let empty = HashMap::new();
        let g2 = anim_to_g3d(&af, &empty).expect("空映射不应报错");
        assert_eq!(g2.nodes.len(), 0);
    }

    // ---------------------------------------------------------------- 测试:g3d 序列化

    /// 极简 UBJSON 解码器(仅本测试用)
    #[derive(Debug, PartialEq)]
    enum J {
        Int(i64),
        Float(f64),
        Str(String),
        Arr(Vec<J>),
        Obj(Vec<(String, J)>),
    }

    impl J {
        fn get(&self, key: &str) -> &J {
            match self {
                J::Obj(kv) => kv.iter().find(|(k, _)| k == key).map(|(_, v)| v).expect("缺少键"),
                _ => panic!("不是对象"),
            }
        }
        fn arr(&self) -> &Vec<J> {
            match self {
                J::Arr(a) => a,
                _ => panic!("不是数组"),
            }
        }
        fn i(&self) -> i64 {
            match self {
                J::Int(v) => *v,
                _ => panic!("不是整数"),
            }
        }
        fn f(&self) -> f64 {
            match self {
                J::Float(v) => *v,
                _ => panic!("不是浮点"),
            }
        }
        fn s(&self) -> &str {
            match self {
                J::Str(s) => s,
                _ => panic!("不是字符串"),
            }
        }
    }

    fn ubj_val(b: &[u8], p: &mut usize, t: u8) -> J {
        match t {
            b'i' => {
                let v = i16::from_be_bytes([b[*p], b[*p + 1]]);
                *p += 2;
                J::Int(v as i64)
            }
            b'I' => {
                let v = i32::from_be_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]);
                *p += 4;
                J::Int(v as i64)
            }
            b'd' => {
                let v = f32::from_be_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]);
                *p += 4;
                J::Float(v as f64)
            }
            b's' => {
                let n = b[*p] as usize;
                *p += 1;
                let s = String::from_utf8(b[*p..*p + n].to_vec()).unwrap();
                *p += n;
                J::Str(s)
            }
            b'S' => {
                let n = u32::from_be_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]) as usize;
                *p += 4;
                let s = String::from_utf8(b[*p..*p + n].to_vec()).unwrap();
                *p += n;
                J::Str(s)
            }
            other => panic!("未知 UBJSON 类型 0x{other:02X}"),
        }
    }

    fn ubj_parse(b: &[u8], p: &mut usize) -> J {
        let t = b[*p];
        *p += 1;
        match t {
            b'[' => {
                let mut a = Vec::new();
                while b[*p] != b']' {
                    a.push(ubj_parse(b, p));
                }
                *p += 1;
                J::Arr(a)
            }
            b'{' => {
                let mut kv = Vec::new();
                while b[*p] != b'}' {
                    let k = match ubj_parse(b, p) {
                        J::Str(s) => s,
                        _ => panic!("键不是字符串"),
                    };
                    let v = ubj_parse(b, p);
                    kv.push((k, v));
                }
                *p += 1;
                J::Obj(kv)
            }
            b'a' | b'A' => {
                let ty = b[*p];
                *p += 1;
                let n = if t == b'a' {
                    let v = b[*p] as usize;
                    *p += 1;
                    v
                } else {
                    let v = u32::from_be_bytes([b[*p], b[*p + 1], b[*p + 2], b[*p + 3]]) as usize;
                    *p += 4;
                    v
                };
                let mut a = Vec::with_capacity(n);
                for _ in 0..n {
                    a.push(ubj_val(b, p, ty));
                }
                J::Arr(a)
            }
            other => ubj_val(b, p, other),
        }
    }

    #[test]
    fn g3d() {
        use super::json::JsonW;
        use super::ubjson::UbjW;
        use super::writer::serialize_model;

        let model = sample_model(&test_opts());

        // ---- g3dj(文本)----
        let mut w = JsonW::new();
        serialize_model(&mut w, &model);
        let s = w.finish();
        assert!(
            s.starts_with("{\r\n\t\"version\": [  0,   1], \r\n"),
            "g3dj 头部格式不符: {:?}",
            &s[..s.len().min(48)]
        );
        assert!(s.contains("\"id\": \"test\""));
        assert!(s.contains(
            "\"attributes\": [\"POSITION\", \"NORMAL\", \"TEXCOORD0\", \"BLENDWEIGHT0\", \"BLENDWEIGHT1\"]"
        ));
        assert!(s.contains("\"vertices\": ["));
        assert!(s.contains("\"type\": \"TRIANGLES\""));
        assert!(s.contains("\"indices\": ["));
        assert!(s.contains("\"filename\": \"t_diffuse.dds\""));
        assert!(s.contains("\"type\": \"DIFFUSE\""));
        assert!(s.contains("\"animations\": []"));
        assert!(s.ends_with("}"));
        // 浮点 = C 的 "% 8f"(正数带前导空格)
        assert!(s.contains(" 0.00000000,"));

        // ---- g3db(二进制)----
        let mut uw = UbjW::new();
        serialize_model(&mut uw, &model);
        let data = uw.finish();
        assert_eq!(data[0], b'{');
        // '{' + 's' 7 "version" + 'a' 'i' 2 + (00 00 | 00 01)
        assert!(
            data.starts_with(&[
                b'{', b's', 7, b'v', b'e', b'r', b's', b'i', b'o', b'n', b'a', b'i', 2, 0, 0, 0,
                1
            ]),
            "g3db 头部字节不符: {:02X?}",
            &data[..24.min(data.len())]
        );
        let mut pos = 0usize;
        let j = ubj_parse(&data, &mut pos);
        assert_eq!(pos, data.len(), "g3db 尾部有未消费字节");
        let ver = j.get("version").arr();
        assert_eq!((ver[0].i(), ver[1].i()), (0, 1));
        assert_eq!(j.get("id").s(), "test");
        let meshes = j.get("meshes").arr();
        assert_eq!(meshes.len(), 1);
        let m0 = &meshes[0];
        let attrs: Vec<&str> = m0.get("attributes").arr().iter().map(|a| a.s()).collect();
        assert_eq!(
            attrs,
            ["POSITION", "NORMAL", "TEXCOORD0", "BLENDWEIGHT0", "BLENDWEIGHT1"]
        );
        let verts = m0.get("vertices").arr();
        assert_eq!(verts.len(), 36);
        assert_eq!(verts[0].f(), 0.0);
        assert_eq!(verts[12].f(), 1.0); // v1.x
        assert_eq!(verts[8].f(), 0.0); // v0.bw0 索引
        assert_eq!(verts[9].f(), 0.5); // v0.bw0 权重
        let parts = m0.get("parts").arr();
        assert_eq!(parts[0].get("id").s(), "testShape_part1");
        assert_eq!(parts[0].get("type").s(), "TRIANGLES");
        let idx: Vec<i64> = parts[0].get("indices").arr().iter().map(|v| v.i()).collect();
        assert_eq!(idx, [0, 1, 2]);
        let mats = j.get("materials").arr();
        assert_eq!(mats.len(), 1);
        assert_eq!(mats[0].get("id").s(), "testShape_mat1");
        let dif = mats[0].get("diffuse").arr();
        assert_eq!(dif.len(), 3);
        assert!((dif[0].f() - 0.8).abs() < 1e-6);
        assert_eq!(
            mats[0].get("textures").arr()[0].get("filename").s(),
            "t_diffuse.dds"
        );
        let nodes = j.get("nodes").arr();
        assert_eq!(nodes.len(), 2);
        let mesh_node = nodes.iter().find(|n| n.get("id").s() == "testShape").unwrap();
        let bones = mesh_node.get("parts").arr()[0].get("bones").arr();
        assert_eq!(bones.len(), 2);
        assert_eq!(bones[0].get("node").s(), "root");
        assert_eq!(bones[1].get("node").s(), "bone1");
        // 骨骼逆绑定平移
        let bt = bones[1].get("translation").arr();
        assert!((bt[1].f() - 10.0).abs() < 1e-5);
        let skel_node = nodes
            .iter()
            .find(|n| n.get("id").s() == "testShape_skeleton")
            .unwrap();
        let root_node = &skel_node.get("children").arr()[0];
        assert_eq!(root_node.get("id").s(), "root");
        assert_eq!(root_node.get("children").arr()[0].get("id").s(), "bone1");
        // 空动画数组回退为普通 '[]'
        assert!(j.get("animations").arr().is_empty());
    }
}
