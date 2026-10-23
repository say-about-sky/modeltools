//! `.anim` 动画解析与到 g3d 动画的转换。
//!
//! 通道语义:`info` 子对象各自的 `sa` 字符串即该骨骼的通道列表(如 `tq`、`s`、`tqs`);
//! 样本数据按**样本主序**排列:样本 0 的全部骨骼、样本 1 的全部骨骼……,
//! 每个骨骼内部按 `sa` 字符串中的字符顺序读取(`t`=3、`q`=4、`s`=1 或 3 个 float)。
//! 时间轴 = `k * 1000 / fps`(毫秒)。t/q 即局部 TRS,直接透传。

use std::collections::HashMap;

use super::model::{GAnim, GNodeAnim};
use super::pdx::PdxObj;

pub struct AnimFile {
    pub id: String,
    pub fps: f32,
    pub sa: usize,
    /// (骨骼名, 通道串)
    pub bones: Vec<(String, String)>,
    pub t: Vec<f32>,
    pub q: Vec<f32>,
    pub s: Vec<f32>,
}
pub fn parse_anim(id: &str, root: &PdxObj) -> Result<AnimFile, String> {
    let info = root.child("info").ok_or("anim 缺少 info")?;
    let fps = info.prop_f32("fps").unwrap_or(30.0);
    let sa = info.prop_i32("sa").unwrap_or(0).max(0) as usize;
    let bone_objs: Vec<&PdxObj> = info.children.iter().collect();
    let mut bones = Vec::new();
    for b in &bone_objs {
        let ch = b.prop_str("sa").unwrap_or("").to_string();
        bones.push((b.name.clone(), ch));
    }
    let samples = root.child("samples").ok_or("anim 缺少 samples")?;
    let t = samples.prop_f32s("t").map(|v| v.to_vec()).unwrap_or_default();
    let q = samples.prop_f32s("q").map(|v| v.to_vec()).unwrap_or_default();
    let s = samples.prop_f32s("s").map(|v| v.to_vec()).unwrap_or_default();
    Ok(AnimFile {
        id: id.to_string(),
        fps,
        sa,
        bones,
        t,
        q,
        s,
    })
}

/// 将 .anim 转换为 g3d 动画(按 骨骼名 -> 节点 id 映射)
pub fn anim_to_g3d(anim: &AnimFile, known_bones: &HashMap<String, String>) -> Result<GAnim, String> {
    let n_t = anim.bones.iter().filter(|(_, c)| c.contains('t')).count();
    let n_q = anim.bones.iter().filter(|(_, c)| c.contains('q')).count();
    let n_s = anim.bones.iter().filter(|(_, c)| c.contains('s')).count();
    let sa = anim.sa;
    if anim.fps <= 0.001 {
        return Err(format!("动画 '{}' fps 非法: {}", anim.id, anim.fps));
    }
    // 样本长度校验(t: ×3,q: ×4,s: ×1 或 ×3 变体)
    let s_wide = anim.s.len() == sa * n_s * 3 && anim.s.len() != sa * n_s;
    let t_ok = anim.t.len() == sa * n_t * 3;
    let q_ok = anim.q.len() == sa * n_q * 4;
    let s_ok = anim.s.len() == sa * n_s || s_wide;
    if !t_ok || !q_ok || !s_ok {
        return Err(format!(
            "动画 '{}' 样本长度异常: sa={} 骨骼={} t={}/{} q={}/{} s={}/{}(或 {})",
            anim.id,
            sa,
            anim.bones.len(),
            anim.t.len(),
            sa * n_t * 3,
            anim.q.len(),
            sa * n_q * 4,
            anim.s.len(),
            sa * n_s,
            sa * n_s * 3
        ));
    }
    // 每个骨骼一个通道集合
    #[derive(Default)]
    struct Chan {
        name: String,
        t: Vec<(f32, [f32; 3])>,
        q: Vec<(f32, [f32; 4])>,
        s: Vec<(f32, [f32; 3])>,
    }
    let mut chans: Vec<Chan> = anim
        .bones
        .iter()
        .map(|(n, c)| Chan {
            name: n.clone(),
            t: if c.contains('t') { Vec::with_capacity(sa) } else { vec![] },
            q: if c.contains('q') { Vec::with_capacity(sa) } else { vec![] },
            s: if c.contains('s') { Vec::with_capacity(sa) } else { vec![] },
        })
        .collect();
    // 解码:样本主序 -> 骨骼 -> 通道(按 sa 字符串顺序)
    let (mut it, mut iq, mut is) = (0usize, 0usize, 0usize);
    for k in 0..sa {
        let time = (k as f32) * 1000.0 / anim.fps;
        for (bi, (_, ch)) in anim.bones.iter().enumerate() {
            for c in ch.chars() {
                match c {
                    't' => {
                        let v = [anim.t[it], anim.t[it + 1], anim.t[it + 2]];
                        it += 3;
                        chans[bi].t.push((time, v));
                    }
                    'q' => {
                        let v = [anim.q[iq], anim.q[iq + 1], anim.q[iq + 2], anim.q[iq + 3]];
                        iq += 4;
                        chans[bi].q.push((time, v));
                    }
                    's' => {
                        if s_wide {
                            let v = [anim.s[is], anim.s[is + 1], anim.s[is + 2]];
                            is += 3;
                            chans[bi].s.push((time, v));
                        } else {
                            let v = anim.s[is];
                            is += 1;
                            chans[bi].s.push((time, [v, v, v]));
                        }
                    }
                    _ => {}
                }
            }
        }
    }
    // 组装
    let mut out = GAnim {
        id: anim.id.clone(),
        nodes: Vec::new(),
    };
    let mut missing = 0usize;
    for chan in chans {
        if chan.t.is_empty() && chan.q.is_empty() && chan.s.is_empty() {
            continue;
        }
        let node_id = match known_bones.get(&chan.name) {
            Some(id) => id.clone(),
            None => {
                missing += 1;
                continue;
            }
        };
        out.nodes.push(GNodeAnim {
            bone_id: node_id,
            translation: chan.t,
            rotation: chan.q,
            scale: chan.s,
        });
    }
    if missing > 0 {
        eprintln!(
            "警告: 动画 '{}' 有 {} 根骨骼在模型中不存在,已跳过",
            anim.id, missing
        );
    }
    Ok(out)
}
