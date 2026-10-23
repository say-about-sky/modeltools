//! 命令行入口(参数定义 + 主流程)。

use clap::{ArgAction, Parser};
use std::collections::HashMap;
use std::path::PathBuf;

use super::anim::{anim_to_g3d, parse_anim};
use super::json::JsonW;
use super::mesh::{Shape, extract_shape, scan_shapes};
use super::model::{BuildOpts, build_model};
use super::pdx::pdx_parse;
use super::ubjson::UbjW;
use super::writer::serialize_model;

/// 命令行参数
#[derive(Parser, Debug)]
#[command(
    name = "g3d",
    version,
    about = "将 Paradox .mesh 模型转换为 libGDX g3dj/g3db(网格解析:JoroDox;输出格式:fbx-conv)",
    author
)]
struct Args {
    /// 输入 .mesh 文件
    input: PathBuf,

    /// 输出文件(默认与输入同目录同名,扩展名 .g3dj 或 .g3db)
    #[arg(short, long)]
    output: Option<PathBuf>,

    /// 输出为 g3dj(文本 JSON)
    #[arg(short = 'j', long, conflicts_with = "g3db")]
    g3dj: bool,

    /// 输出为 g3db(二进制 UBJSON,默认)
    #[arg(short = 'b', long)]
    g3db: bool,

    /// 强制覆盖已存在的输出文件
    #[arg(short, long)]
    force: bool,

    /// 详细日志(可叠加:-v 信息、-vv 调试)
    #[arg(short, long, action = ArgAction::Count)]
    verbose: u8,

    /// 要导出的 LOD 级别(默认 0;all = 导出全部 shape)
    #[arg(short = 'l', long, default_value = "0")]
    lod: String,

    /// 模型 id(默认取输入文件名)
    #[arg(long)]
    id: Option<String>,

    /// 翻转纹理 V 坐标(v -> 1-v)
    #[arg(long)]
    flip_v: bool,

    /// 包含 TANGENT 切线属性(丢弃原来的 w 分量)
    #[arg(long)]
    tangents: bool,

    /// 不输出 NORMAL 法线属性
    #[arg(long)]
    no_normals: bool,

    /// 强制指定漫反射贴图文件名(作用于所有材质)
    #[arg(long, value_name = "FILE")]
    tex: Option<String>,

    /// 替换贴图文件扩展名(例如 png)
    #[arg(long, value_name = "EXT")]
    tex_ext: Option<String>,

    /// 不输出贴图
    #[arg(long)]
    no_textures: bool,

    /// 材质漫反射颜色 r,g,b(默认 0.8,0.8,0.8)
    #[arg(long, value_name = "R,G,B")]
    diffuse: Option<String>,

    /// 附加 .anim 动画文件(可重复;动画 id 取文件名)
    #[arg(long, value_name = "FILE")]
    anim: Vec<PathBuf>,

    /// 网格顶点数超过 N 时拆分(默认 32767,0 = 不拆分)
    #[arg(long, default_value_t = 32767)]
    max_verts: u32,

    /// 只列出 mesh 文件内容,不转换
    #[arg(long)]
    list: bool,
}

/// 二进制入口(由 g3d.rs 调用)
pub fn cli_main() {
    let args = Args::parse();
    match run(&args) {
        Ok(()) => {}
        Err(e) => {
            eprintln!("错误: {}", e);
            std::process::exit(1);
        }
    }
}

fn run(args: &Args) -> Result<(), String> {
    let verbose = args.verbose;
    let t0 = std::time::Instant::now();
    // ---- 读取并解析 .mesh ----
    let bytes = std::fs::read(&args.input).map_err(|e| format!("读取 {} 失败: {}", args.input.display(), e))?;
    if verbose > 0 {
        println!("读取 {} ({} 字节)", args.input.display(), bytes.len());
    }
    let root = pdx_parse(&bytes)?;
    let object = root.child("object").ok_or("mesh 文件中缺少 object 节点")?;
    let metas = scan_shapes(&root)?;
    if metas.is_empty() {
        return Err("文件中没有可导出的 shape".into());
    }

    // ---- 列出模式 ----
    if args.list {
        println!("文件: {} ({} 字节)", args.input.display(), bytes.len());
        for (si, (name, lod)) in metas.iter().enumerate() {
            let sh = extract_shape(&object.children[si], true)?;
            println!(
                "Shape[{}]: {}  lod={}",
                si,
                name,
                lod.map(|l| l.to_string()).unwrap_or_else(|| "-".into())
            );
            if let Some(sk) = &sh.skeleton {
                println!("  骨骼: {} 根", sk.bones.len());
            }
            for m in &sh.meshes {
                let nv = m.vertex_count();
                let mut extra = String::new();
                if let Some(sk) = &m.skin {
                    extra.push_str(&format!(" skin({}影响)", sk.influences));
                }
                if m.has_uv0 {
                    extra.push_str(" u0");
                }
                if !m.tangents.is_empty() {
                    extra.push_str(" ta");
                }
                println!(
                    "  网格 '{}': 顶点={} 三角形={} 材质={}(diff={}){}",
                    m.name,
                    nv,
                    m.indices.len() / 3,
                    m.material.shader,
                    m.material.diff.as_deref().unwrap_or("-"),
                    extra
                );
            }
        }
        let lods: Vec<String> = metas
            .iter()
            .map(|(_, l)| l.map(|x| x.to_string()).unwrap_or_else(|| "-".into()))
            .collect();
        println!("LOD: {}", lods.join(", "));
        return Ok(());
    }

    // ---- 选择 shape ----
    let want_all = args.lod.eq_ignore_ascii_case("all");
    let target: Option<i32> = if want_all {
        None
    } else {
        Some(
            args.lod
                .parse::<i32>()
                .map_err(|_| format!("--lod 参数 '{}' 非法(应为整数或 all)", args.lod))?,
        )
    };
    let any_lod = metas.iter().any(|(_, l)| l.is_some());
    let idxs: Vec<usize> = if want_all || !any_lod {
        (0..metas.len()).collect()
    } else {
        let t = target.unwrap();
        let v: Vec<usize> = metas
            .iter()
            .enumerate()
            .filter(|(_, (_, l))| *l == Some(t))
            .map(|(i, _)| i)
            .collect();
        if v.is_empty() {
            let avail: Vec<String> = metas
                .iter()
                .map(|(_, l)| l.map(|x| x.to_string()).unwrap_or_else(|| "-".into()))
                .collect();
            return Err(format!("找不到 LOD={} 的 shape(可用: {})", t, avail.join(", ")));
        }
        v
    };
    if verbose > 0 {
        println!(
            "选中 {} 个 shape: {}",
            idxs.len(),
            idxs.iter().map(|&i| metas[i].0.as_str()).collect::<Vec<_>>().join(", ")
        );
    }
    // 只完整提取选中的 shape
    let sel: Vec<Shape> = idxs
        .iter()
        .map(|&i| extract_shape(&object.children[i], false))
        .collect::<Result<_, _>>()?;

    // ---- 构建 g3d 模型 ----
    let model_id = args
        .id
        .clone()
        .unwrap_or_else(|| {
            args.input
                .file_stem()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default()
        });
    let diffuse = match &args.diffuse {
        Some(s) => {
            let parts: Vec<f32> = s
                .split(',')
                .map(|p| p.trim().parse::<f32>().map_err(|_| format!("--diffuse 解析失败: {}", s)))
                .collect::<Result<_, _>>()?;
            if parts.len() != 3 {
                return Err("--diffuse 需要 3 个分量 r,g,b".into());
            }
            [parts[0], parts[1], parts[2]]
        }
        None => [0.8, 0.8, 0.8],
    };
    let opts = BuildOpts {
        include_normals: !args.no_normals,
        include_tangents: args.tangents,
        flip_v: args.flip_v,
        max_verts: args.max_verts as usize,
        tex_override: args.tex.clone(),
        tex_ext: args.tex_ext.clone(),
        no_textures: args.no_textures,
        diffuse,
    };
    let mut model = build_model(&sel, &opts, &model_id)?;

    // ---- 动画 ----
    if !args.anim.is_empty() {
        // 骨骼名 -> 节点 id 映射(取第一个 shape 的骨架;多 shape 时后续 shape 的骨骼带前缀)
        let mut known: HashMap<String, String> = HashMap::new();
        if let Some(sh) = sel.first()
            && let Some(sk) = &sh.skeleton
        {
            for b in &sk.bones {
                known.insert(b.name.clone(), b.name.clone());
            }
        }
        if known.is_empty() {
            eprintln!("警告: 模型没有骨架,忽略 --anim");
        } else {
            if sel.len() > 1 {
                eprintln!("警告: 导出多个 shape 时仅第一个 shape 的骨骼与动画骨骼名匹配");
            }
            let mut used_ids: Vec<String> = model.animations.iter().map(|a| a.id.clone()).collect();
            for path in &args.anim {
                let abytes = std::fs::read(path).map_err(|e| format!("读取动画 {} 失败: {}", path.display(), e))?;
                let aroot = pdx_parse(&abytes).map_err(|e| format!("解析动画 {} 失败: {}", path.display(), e))?;
                let id = path
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
                    .unwrap_or_else(|| "anim".into());
                if used_ids.contains(&id) {
                    eprintln!("警告: 动画 id '{}' 重复,跳过 {}", id, path.display());
                    continue;
                }
                let af = parse_anim(&id, &aroot)?;
                let ganim = anim_to_g3d(&af, &known)?;
                if verbose > 0 {
                    println!(
                        "动画 '{}': {} 键骨骼, {} 样本 @ {:.2} fps",
                        id,
                        ganim.nodes.len(),
                        af.sa,
                        af.fps
                    );
                }
                used_ids.push(id);
                model.animations.push(ganim);
            }
        }
    }

    // ---- 输出格式与路径 ----
    let explicit_g3dj = args.g3dj;
    let explicit_g3db = args.g3db;
    let mut out_path = args.output.clone().unwrap_or_else(|| {
        let ext = if explicit_g3dj { "g3dj" } else { "g3db" };
        args.input.with_extension(ext)
    });
    let is_g3dj = if explicit_g3dj {
        true
    } else if explicit_g3db {
        false
    } else {
        match out_path.extension().and_then(|e| e.to_str()) {
            Some("g3dj") => true,
            Some("g3db") => false,
            _ => {
                // 未指定格式且扩展名未知:补 .g3db
                if out_path.extension().is_none() {
                    out_path.set_extension("g3db");
                }
                false
            }
        }
    };
    if out_path.exists() && !args.force {
        return Err(format!(
            "输出文件已存在: {}(使用 -f/--force 覆盖)",
            out_path.display()
        ));
    }
    if let Some(parent) = out_path.parent()
        && !parent.as_os_str().is_empty()
        && !parent.exists()
    {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("创建输出目录 {} 失败: {}", parent.display(), e))?;
    }

    // ---- 序列化 ----
    let data: Vec<u8> = if is_g3dj {
        let mut w = JsonW::new();
        serialize_model(&mut w, &model);
        w.finish().into_bytes()
    } else {
        let mut w = UbjW::new();
        serialize_model(&mut w, &model);
        w.finish()
    };
    std::fs::write(&out_path, &data).map_err(|e| format!("写入 {} 失败: {}", out_path.display(), e))?;

    // ---- 汇总 ----
    let total_verts: usize = model.meshes.iter().map(|m| m.vertices.len() / m.vertex_size).sum();
    let total_tris: usize = model.meshes.iter().flat_map(|m| m.parts.iter()).map(|p| p.indices.len() / 3).sum();
    let bones = sel.first().and_then(|s| s.skeleton.as_ref()).map(|s| s.bones.len()).unwrap_or(0);
    println!(
        "已写出 {} ({} 字节,{} ms)",
        out_path.display(),
        data.len(),
        t0.elapsed().as_millis()
    );
    println!(
        "  shape={} 骨骼={} 网格={} 顶点={} 三角形={} 材质={} 动画={}",
        sel.len(),
        bones,
        model.meshes.len(),
        total_verts,
        total_tris,
        model.materials.len(),
        model.animations.len()
    );
    for m in &model.materials {
        let texs: Vec<&str> = m.textures.iter().map(|t| t.filename.as_str()).collect();
        if !texs.is_empty() {
            println!("  材质 {}: 贴图 [{}]", m.id, texs.join(", "));
        }
    }
    if verbose > 0 {
        println!("  格式: {}", if is_g3dj { "g3dj" } else { "g3db" });
    }
    Ok(())
}
