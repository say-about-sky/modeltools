//! 序列化入口(fbx-conv `src/modeldata/Serialization.cpp` 的移植)。
//!
//! `G3dW` trait 抽象 g3dj(json.rs)与 g3db(ubjson.rs)两种写入器,
//! `serialize_*` 系列按 fbx-conv 的字段顺序与容器规则输出模型。

use super::model::{GAnim, GMaterial, GMesh, GModel, GNode, GNodePart};

pub trait G3dW {
    fn obj(&mut self);
    fn obj_cap(&mut self, cap: i64);
    fn arr(&mut self);
    fn arr_cap(&mut self, cap: i64);
    fn arr_cap_line(&mut self, cap: i64, line: u64);
    fn end(&mut self);
    fn key(&mut self, s: &str);
    fn sval(&mut self, s: &str);
    fn fval(&mut self, v: f32);
    fn ival(&mut self, v: i32);
    fn fdata(&mut self, v: &[f32], line: u64);
    fn idata(&mut self, v: &[i32], line: u64);
    fn i16data(&mut self, v: &[i16]);
}

pub fn serialize_model<W: G3dW>(w: &mut W, m: &GModel) {
    w.obj_cap(6);
    w.key("version");
    w.i16data(&[0, 1]);
    w.key("id");
    w.sval(&m.id);
    w.key("meshes");
    w.arr_cap(m.meshes.len() as i64);
    for mesh in &m.meshes {
        serialize_mesh(w, mesh);
    }
    w.end();
    w.key("materials");
    w.arr_cap(m.materials.len() as i64);
    for mat in &m.materials {
        serialize_material(w, mat);
    }
    w.end();
    w.key("nodes");
    w.arr_cap(m.nodes.len() as i64);
    for node in &m.nodes {
        serialize_node(w, node);
    }
    w.end();
    w.key("animations");
    w.arr_cap(m.animations.len() as i64);
    for anim in &m.animations {
        serialize_anim(w, anim);
    }
    w.end();
    w.end();
}

fn serialize_mesh<W: G3dW>(w: &mut W, mesh: &GMesh) {
    w.obj_cap(3);
    w.key("attributes");
    w.arr_cap_line(mesh.attributes.len() as i64, 8);
    for a in &mesh.attributes {
        w.sval(a.name());
    }
    w.end();
    w.key("vertices");
    w.fdata(&mesh.vertices, mesh.vertex_size as u64);
    w.key("parts");
    w.arr_cap(mesh.parts.len() as i64);
    for p in &mesh.parts {
        w.obj_cap(3);
        w.key("id");
        w.sval(&p.id);
        w.key("type");
        w.sval("TRIANGLES");
        w.key("indices");
        w.idata(&p.indices, 12);
        w.end();
    }
    w.end();
    w.end();
}

fn serialize_material<W: G3dW>(w: &mut W, mat: &GMaterial) {
    w.obj();
    w.key("id");
    w.sval(&mat.id);
    w.key("diffuse");
    w.fdata(&mat.diffuse, 32);
    if !mat.textures.is_empty() {
        w.key("textures");
        w.arr_cap(mat.textures.len() as i64);
        for t in &mat.textures {
            w.obj();
            w.key("id");
            w.sval(&t.id);
            w.key("filename");
            w.sval(&t.filename);
            w.key("type");
            w.sval(t.usage);
            w.end();
        }
        w.end();
    }
    w.end();
}

fn serialize_node<W: G3dW>(w: &mut W, node: &GNode) {
    w.obj();
    w.key("id");
    w.sval(&node.id);
    if let Some(rot) = &node.rotation {
        w.key("rotation");
        w.fdata(rot, 32);
    }
    if let Some(scl) = &node.scale {
        w.key("scale");
        w.fdata(scl, 32);
    }
    if let Some(t) = &node.translation {
        w.key("translation");
        w.fdata(t, 32);
    }
    if !node.parts.is_empty() {
        w.key("parts");
        w.arr_cap(node.parts.len() as i64);
        for p in &node.parts {
            serialize_node_part(w, p);
        }
        w.end();
    }
    if !node.children.is_empty() {
        w.key("children");
        w.arr_cap(node.children.len() as i64);
        for c in &node.children {
            serialize_node(w, c);
        }
        w.end();
    }
    w.end();
}

fn serialize_node_part<W: G3dW>(w: &mut W, p: &GNodePart) {
    w.obj();
    w.key("meshpartid");
    w.sval(&p.meshpartid);
    w.key("materialid");
    w.sval(&p.materialid);
    if !p.bones.is_empty() {
        w.key("bones");
        w.arr();
        for b in &p.bones {
            w.obj();
            w.key("node");
            w.sval(&b.node);
            w.key("translation");
            w.fdata(&b.translation, 32);
            w.key("rotation");
            w.fdata(&b.rotation, 32);
            w.key("scale");
            w.fdata(&b.scale, 32);
            w.end();
        }
        w.end();
    }
    if p.uv_mapping {
        w.key("uvMapping");
        w.arr_cap_line(1, 16);
        w.arr_cap_line(1, 16);
        w.ival(0);
        w.end();
        w.end();
    }
    w.end();
}

fn serialize_anim<W: G3dW>(w: &mut W, anim: &GAnim) {
    w.obj_cap(2);
    w.key("id");
    w.sval(&anim.id);
    w.key("bones");
    w.arr_cap(anim.nodes.len() as i64);
    for na in &anim.nodes {
        w.obj_cap(2);
        w.key("boneId");
        w.sval(&na.bone_id);
        w.key("keyframes");
        let count = na.translation.len().max(na.rotation.len()).max(na.scale.len());
        w.arr_cap(count as i64);
        for ki in 0..count {
            w.obj();
            let time = na
                .translation
                .get(ki)
                .map(|k| k.0)
                .or_else(|| na.rotation.get(ki).map(|k| k.0))
                .or_else(|| na.scale.get(ki).map(|k| k.0))
                .unwrap_or(0.0);
            w.key("keytime");
            w.fval(time);
            if let Some((_, q)) = na.rotation.get(ki) {
                w.key("rotation");
                w.fdata(q, 32);
            }
            if let Some((_, s)) = na.scale.get(ki) {
                w.key("scale");
                w.fdata(s, 32);
            }
            if let Some((_, t)) = na.translation.get(ki) {
                w.key("translation");
                w.fdata(t, 32);
            }
            w.end();
        }
        w.end();
        w.end();
    }
    w.end();
    w.end();
}
