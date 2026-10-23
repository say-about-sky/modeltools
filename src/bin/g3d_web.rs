//! `g3d-web` —— age3mudels 轻量调试器的本地 HTTP 服务。
//!
//! 前端资源（web/）编译时内嵌进 exe；运行时只负责：
//!   * GET /                     → 调试页面
//!   * GET /api/models           → 扫描 root 下的 *.g3dj
//!   * GET /api/runtime          → 查找模型对应的 G3DArmy 配置（兼容旧路径名）
//!   * GET /api/health           → 健康检查
//!   * GET /files/<相对路径>      → 提供 g3dj / png（带路径穿越防护）
//!
//! 用法：
//!   cargo run --bin g3d-web -- --root ../age3mudels/G3DArmy
//!   cargo run --bin g3d-web -- --root ../ww1models/G3DArmy --port 8787 --open
//!   g3d-web.exe --root ..            （工作区，同时发现两个 G3DArmy 项目）
//!
//! 说明：`<root>/G3DArmy` 这类资源目录直接扫描 `models/main/g3d`，project 标签
//! 使用 `父目录/G3DArmy`（如 `age3mudels/G3DArmy`）。也兼容旧的 `combos`、`ww1`
//! 模型项目；加 `--all` 可把 `runtime/parts`、`library` 等目录里的单个 g3dj 也列出来。
//! 检测到 G3DArmy 资源目录时始终按 loadSelect/attachments/assembly 规则装配，
//! 不再需要 -runtime 开关。

use clap::{ArgAction, Parser};
use std::collections::{BTreeMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

const INDEX_HTML: &str = include_str!("../../web/index.html");
const APP_JS: &str = include_str!("../../web/app.js");
const MATH_JS: &str = include_str!("../../web/math.js");
const G3DJ_JS: &str = include_str!("../../web/g3dj.js");
const RENDERER_JS: &str = include_str!("../../web/renderer.js");
const PARTICLES_JS: &str = include_str!("../../web/particles.js");
const ANIM_EVENTS_JS: &str = include_str!("../../web/anim_events.js");
const UNIT_STATE_MACHINE_JS: &str = include_str!("../../web/unit_state_machine.js");
const RUNTIME_RULES_JS: &str = include_str!("../../web/runtime_rules.js");
const LAYOUT_DRAWERS_JS: &str = include_str!("../../web/layout_drawers.js");
const STYLE_CSS: &str = include_str!("../../web/style.css");

#[derive(Parser, Debug)]
#[command(
    name = "g3d-web",
    version,
    about = "age3mudels 调试器：在浏览器里复刻 G3DArmy 管线，调试 g3dj 模型与四态动画"
)]
struct Args {
    /// 模型根目录 / 工作区（默认优先探测 ./G3DArmy、../G3DArmy，再回退 age3mudels）
    #[arg(short, long, value_name = "DIR")]
    root: Option<PathBuf>,

    /// 监听端口（被占用时自动向后尝试最多 20 个端口）
    #[arg(short, long, default_value_t = 8787)]
    port: u16,

    /// 监听地址（默认只监听本机）
    #[arg(long, default_value = "127.0.0.1")]
    host: String,

    /// 启动后自动打开浏览器
    #[arg(long)]
    open: bool,

    /// 扫描整个 root（含 runtime/parts、library 等），而不只是自动发现的模型项目
    #[arg(long)]
    all: bool,

    /// 开发模式：前端资源从 web/ 目录实时读取（不重启即可改 UI）
    #[arg(long)]
    dev: bool,

    /// 无请求多少秒后自动退出并回收端口（0=关闭自动回收）
    #[arg(long, default_value_t = 300)]
    idle_timeout: u64,

    /// 打印每个请求（-v）
    #[arg(short, long, action = ArgAction::Count)]
    verbose: u8,
}

#[derive(Debug, Clone)]
struct ModelEntry {
    /// 相对 root 的路径（统一使用 '/'）
    path: String,
    /// 项目（combos 为 default；ww1、ww2… 为目录名）
    project: String,
    /// 项目内类别（foot/mounted/artillery/...）
    category: String,
    /// UI 分组键：default 项目为 category，其他项目为 project/category
    group: String,
    name: String,
    size: u64,
    mtime_ms: u64,
}

fn main() {
    let args = Args::parse();
    let root = match resolve_root(args.root.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[g3d-web] {e}");
            std::process::exit(1);
        }
    };
    let root = match fs::canonicalize(&root) {
        Ok(p) => p,
        Err(e) => {
            eprintln!("[g3d-web] cannot resolve root {}: {e}", root.display());
            std::process::exit(1);
        }
    };
    let (targets, scan_label) = match build_targets(&root, args.all) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[g3d-web] scan setup failed: {e}");
            std::process::exit(1);
        }
    };
    let models = match scan_targets(&targets, &root) {
        Ok(v) => Arc::new(v),
        Err(e) => {
            eprintln!("[g3d-web] scan failed: {e}");
            std::process::exit(1);
        }
    };
    println!("[g3d-web] root   = {}", display_path(&root));
    println!("[g3d-web] scan   = {} ({} models)", scan_label, models.len());
    let mut project_counts: BTreeMap<&str, usize> = BTreeMap::new();
    for m in models.iter() {
        *project_counts.entry(m.project.as_str()).or_insert(0) += 1;
    }
    let project_text = project_counts
        .iter()
        .map(|(p, n)| format!("{p}={n}"))
        .collect::<Vec<_>>()
        .join(", ");
    println!("[g3d-web] projects = [{project_text}]");
    println!("[g3d-web] parse  = G3DArmy (loadSelect / attachments / assembly / civilization)");
    println!("[g3d-web] hint   = auto-discovers project dirs; --all includes runtime/library");

    // ---- bind（端口占用时向后顺延） ----
    let mut bound = None;
    let mut last_err = None;
    let tries = if args.port == 0 { 1 } else { 20 };
    for offset in 0..tries {
        let port = args.port.saturating_add(offset);
        match TcpListener::bind((args.host.as_str(), port)) {
            Ok(listener) => {
                bound = Some((listener, port));
                break;
            }
            Err(e) => last_err = Some(e),
        }
    }
    let (listener, port) = match bound {
        Some(v) => v,
        None => {
            eprintln!(
                "[g3d-web] cannot bind {}:{}: {}",
                args.host,
                args.port,
                last_err.map(|e| e.to_string()).unwrap_or_default()
            );
            std::process::exit(1);
        }
    };

    let shown_host = if args.host == "0.0.0.0" || args.host == "::" {
        "127.0.0.1"
    } else {
        args.host.as_str()
    };
    let url = format!("http://{}:{}/", shown_host, port);
    println!("[g3d-web] listening: {url}");
    println!("[g3d-web] Ctrl+C to stop");
    if args.idle_timeout > 0 {
        println!("[g3d-web] idle   = {}s 无请求自动退出（自动回收端口）", args.idle_timeout);
    }

    if args.open {
        open_browser(&url);
    }

    let last_activity = Arc::new(AtomicU64::new(now_secs()));
    if args.idle_timeout > 0 {
        let last = Arc::clone(&last_activity);
        let timeout = args.idle_timeout;
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(5));
            let now = now_secs();
            let last = last.load(Ordering::Relaxed);
            if now.saturating_sub(last) >= timeout {
                eprintln!("[g3d-web] idle timeout {timeout}s，自动退出并回收端口 {port}");
                std::process::exit(0);
            }
        });
    }

    let root = Arc::new(root);
    for conn in listener.incoming() {
        last_activity.store(now_secs(), Ordering::Relaxed);
        let stream = match conn {
            Ok(s) => s,
            Err(e) => {
                eprintln!("[g3d-web] accept: {e}");
                continue;
            }
        };
        let root = Arc::clone(&root);
        let models = Arc::clone(&models);
        let verbose = args.verbose;
        let dev = args.dev;
        std::thread::spawn(move || {
            if let Err(e) = handle_connection(stream, &root, &models, verbose, dev) {
                if verbose > 0 {
                    eprintln!("[g3d-web] connection: {e}");
                }
            }
        });
    }
}

fn resolve_root(arg: Option<&Path>) -> Result<PathBuf, String> {
    if let Some(p) = arg {
        if !p.is_dir() {
            return Err(format!("root is not a directory: {}", p.display()));
        }
        return Ok(p.to_path_buf());
    }
    // 优先直接使用当前目录下的 G3DArmy 资源目录；否则再回退到 age3mudels 工作区。
    let candidates = [
        "G3DArmy",
        "../G3DArmy",
        "../../G3DArmy",
        "../../../G3DArmy",
        "age3mudels",
        "../age3mudels",
        "../../age3mudels",
        "../../../age3mudels",
        ".",
    ];
    for c in candidates {
        let p = PathBuf::from(c);
        if p.is_dir() {
            return Ok(p);
        }
    }
    std::env::current_dir().map_err(|e| format!("cannot determine current dir: {e}"))
}

/// 一个扫描目标：目录 + 项目提示 + 相对 root 的前缀。
#[derive(Debug, Clone)]
struct ScanTarget {
    dir: PathBuf,
    /// Some("default") = 默认 combos 项目；Some("ww1") = 子项目；None = --all 自动推断
    project: Option<String>,
    /// target.dir 相对 root 的路径（用于算 target 内相对路径）
    rel_prefix: String,
}

fn build_targets(root: &Path, all: bool) -> Result<(Vec<ScanTarget>, String), String> {
    let has_combos = root.join("combos").is_dir();
    let root_layout = has_g3darmy_layout(root);
    let children = discover_child_projects(root);
    let has_g3darmy_child = children.iter().any(|p| has_g3darmy_layout(p));
    // 某个父目录下已有 G3DArmy 资源目录时，它的旧同级目录（ww1、ww1_climate、
    // combos 等）只是导出源，不再作为独立项目重复列出。
    let g3darmy_parents: Vec<PathBuf> = children
        .iter()
        .filter(|p| has_g3darmy_layout(p))
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .collect();
    // 没有 combos，或 root 下没有其他项目：把 root 本身当成一个项目
    // 只要发现子项目，root 就是工作区；否则 root 本身是一个项目
    let root_is_project = children.is_empty();
    let root_name = root_project_name(root);

    let mut project_targets = Vec::new();
    for child in &children {
        // G3DArmy 资源目录直接作为项目：用 "父目录/G3DArmy" 作为标签，
        // 例如 ww1models/G3DArmy、age3mudels/G3DArmy，避免多个项目同名。
        let name = project_dir_label(child);
        // 已生成 G3DArmy 新布局时，同一父目录下的旧项目/导出源不再重复列一遍。
        if has_g3darmy_child
            && !has_g3darmy_layout(child)
            && child.parent().is_some_and(|p| g3darmy_parents.iter().any(|q| q == p))
        {
            continue;
        }
        let scan_dir = project_scan_dir(child);
        let rel_prefix = rel_path_string(&scan_dir, root);
        project_targets.push(ScanTarget {
            dir: scan_dir,
            project: Some(name),
            rel_prefix,
        });
    }

    let mut targets = Vec::new();
    if all {
        if root_is_project {
            // 根项目：先按项目名扫直接模型/combos，再用 root 原始扫描补齐
            // runtime/library（重复的 g3dj 路径会被 scan_target_recursive 去重，
            // 先加入的项目名优先）。
            if root_layout {
                targets.push(ScanTarget {
                    dir: root.join("models/main/g3d"),
                    project: Some(root_name.clone()),
                    rel_prefix: "models/main/g3d".to_string(),
                });
            } else if has_combos {
                targets.push(ScanTarget {
                    dir: root.join("combos"),
                    project: Some(root_name.clone()),
                    rel_prefix: "combos".to_string(),
                });
            } else {
                targets.push(ScanTarget {
                    dir: root.to_path_buf(),
                    project: Some(root_name.clone()),
                    rel_prefix: String::new(),
                });
            }
            targets.push(ScanTarget {
                dir: root.to_path_buf(),
                project: None,
                rel_prefix: String::new(),
            });
        } else {
            // 已识别项目优先（例如 _work/preview_ww1），再做一次 root 原始扫描
            targets.extend(project_targets);
            targets.push(ScanTarget {
                dir: root.to_path_buf(),
                project: None,
                rel_prefix: String::new(),
            });
        }
    } else if root_is_project {
        if root_layout {
            targets.push(ScanTarget {
                dir: root.join("models/main/g3d"),
                project: Some(root_name.clone()),
                rel_prefix: "models/main/g3d".to_string(),
            });
        } else if has_combos {
            targets.push(ScanTarget {
                dir: root.join("combos"),
                project: Some(root_name.clone()),
                rel_prefix: "combos".to_string(),
            });
        } else {
            targets.push(ScanTarget {
                dir: root.to_path_buf(),
                project: Some(root_name.clone()),
                rel_prefix: String::new(),
            });
        }
    } else {
        // 项目（ww1、combos/ww1、_work/preview_ww1…）优先；默认 combos 最后，
        // 这样嵌套在 combos 下的项目不会被默认分类抢走。
        targets.extend(project_targets);
        // 已有 G3DArmy 新布局时不再把旧 combos 重复列一遍
        if has_combos && !has_g3darmy_child {
            targets.push(ScanTarget {
                dir: root.join("combos"),
                project: Some("default".to_string()),
                rel_prefix: "combos".to_string(),
            });
        }
    }
    if targets.is_empty() {
        targets.push(ScanTarget {
            dir: root.to_path_buf(),
            project: Some(root_name),
            rel_prefix: String::new(),
        });
    }

    let names = targets
        .iter()
        .map(|t| {
            let p = t.project.clone().unwrap_or_else(|| "auto".to_string());
            if t.rel_prefix.is_empty() {
                p
            } else {
                format!("{p}:{}", t.rel_prefix)
            }
        })
        .collect::<Vec<_>>();
    let label = if all {
        format!("all ({})", names.join(", "))
    } else {
        names.join(", ")
    };
    Ok((targets, label))
}

fn discover_child_projects(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    discover_projects_rec(root, 0, &mut out);
    out.sort();
    out.dedup();
    out
}

fn discover_projects_rec(dir: &Path, depth: usize, out: &mut Vec<PathBuf>) {
    if depth > 3 {
        return;
    }
    let rd = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_discovery_skip(&name) {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if !ft.is_dir() {
            continue;
        }
        let path = entry.path();
        let has_combos = path.join("combos").is_dir();
        let has_layout = has_g3darmy_layout(&path);
        let has_g3dj = contains_g3dj(&path, 2);
        let marker = has_project_marker(&path);
        let project_name = looks_like_project_name(&name);
        if has_combos || has_layout || (has_g3dj && (marker || project_name)) {
            // `ww1models/ww1` 这类“项目容器”：父目录本身也像项目，但直接子目录
            // 才是真正的项目。优先向下发现，避免把 runtime/测试模型都算进父项目。
            if has_direct_child_project(&path) {
                discover_projects_rec(&path, depth + 1, out);
            } else {
                out.push(path);
            }
            continue;
        }
        // 容器目录（_work、projects、mods 等）继续向下找项目；模型/类别目录没有项目标记，不会误判
        discover_projects_rec(&path, depth + 1, out);
    }
}

fn has_direct_child_project(dir: &Path) -> bool {
    let rd = match fs::read_dir(dir) {
        Ok(v) => v,
        Err(_) => return false,
    };
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if is_discovery_skip(&name) {
            continue;
        }
        if !entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if path.join("combos").is_dir()
            || has_g3darmy_layout(&path)
            || (contains_g3dj(&path, 2)
                && (has_project_marker(&path) || looks_like_project_name(&name)))
        {
            return true;
        }
    }
    false
}

fn is_discovery_skip(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    if name.starts_with('_') && !name.eq_ignore_ascii_case("_work") {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "target" | "node_modules" | "__pycache__" | "hotplugins" | "runtime" | "library"
            | "textures" | "tools" | "parts"
    )
}

fn has_project_marker(dir: &Path) -> bool {
    if has_g3darmy_layout(dir) {
        return true;
    }
    let fixed = ["readme.md", "parts.json", "report.txt", "unitselect.json"];
    for name in fixed {
        if dir.join(name).is_file() {
            return true;
        }
    }
    if let Ok(rd) = fs::read_dir(dir) {
        for entry in rd.flatten() {
            let n = entry.file_name().to_string_lossy().to_ascii_lowercase();
            if n.ends_with("unitselect.json") {
                return true;
            }
        }
    }
    false
}

/// `ww1`、`ww2` 这类项目目录名；也接受 `ww1_foo`。
fn looks_like_project_name(name: &str) -> bool {
    let low = name.to_ascii_lowercase();
    if !low.starts_with("ww") {
        return false;
    }
    low.chars().any(|c| c.is_ascii_digit())
}

fn project_scan_dir(project: &Path) -> PathBuf {
    let main = project.join("models/main/g3d");
    if main.is_dir() {
        return main;
    }
    let combos = project.join("combos");
    if combos.is_dir() {
        combos
    } else {
        project.to_path_buf()
    }
}

/// G3DArmy v4.2+ 资源布局：models/main/g3d。
fn has_g3darmy_layout(dir: &Path) -> bool {
    dir.join("models/main/g3d").is_dir()
}

fn is_skip_dir(name: &str) -> bool {
    if name.starts_with('.') {
        return true;
    }
    matches!(
        name.to_ascii_lowercase().as_str(),
        "target" | "node_modules" | "_work" | "__pycache__" | "hotplugins"
    )
}

fn contains_g3dj(dir: &Path, max_depth: usize) -> bool {
    if !dir.is_dir() {
        return false;
    }
    let mut stack = vec![(dir.to_path_buf(), 0usize)];
    while let Some((cur, depth)) = stack.pop() {
        if depth > max_depth {
            continue;
        }
        let rd = match fs::read_dir(&cur) {
            Ok(v) => v,
            Err(_) => continue,
        };
        for entry in rd.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with('.') {
                continue;
            }
            let ft = match entry.file_type() {
                Ok(t) => t,
                Err(_) => continue,
            };
            let path = entry.path();
            if ft.is_dir() {
                if is_skip_dir(&name) {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if ft.is_file()
                && path
                    .extension()
                    .map(|e| e.eq_ignore_ascii_case("g3dj"))
                    .unwrap_or(false)
            {
                return true;
            }
        }
    }
    false
}

fn project_dir_label(path: &Path) -> String {
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "project".to_string());
    if name.eq_ignore_ascii_case("g3darmy") {
        if let Some(parent) = path.parent().and_then(|p| p.file_name()) {
            let parent = parent.to_string_lossy();
            if !parent.is_empty() {
                return format!("{parent}/{name}");
            }
        }
    }
    name
}

fn root_project_name(root: &Path) -> String {
    project_dir_label(root)
}

fn scan_targets(targets: &[ScanTarget], root: &Path) -> std::io::Result<Vec<ModelEntry>> {
    let mut out = Vec::new();
    let mut seen = HashSet::new();
    for target in targets {
        scan_target_recursive(&target.dir, target, root, 0, &mut out, &mut seen)?;
    }
    out.sort_by(|a, b| {
        a.project
            .cmp(&b.project)
            .then_with(|| a.category.cmp(&b.category))
            .then_with(|| a.name.cmp(&b.name))
            .then_with(|| a.path.cmp(&b.path))
    });
    Ok(out)
}

fn scan_target_recursive(
    dir: &Path,
    target: &ScanTarget,
    root: &Path,
    depth: usize,
    out: &mut Vec<ModelEntry>,
    seen: &mut HashSet<String>,
) -> std::io::Result<()> {
    if depth > 12 {
        return Ok(());
    }
    for entry in fs::read_dir(dir)? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_dir() {
            if is_skip_dir(&name) {
                continue;
            }
            scan_target_recursive(&path, target, root, depth + 1, out, seen)?;
        } else if ft.is_file() {
            let is_g3dj = path
                .extension()
                .map(|e| e.eq_ignore_ascii_case("g3dj"))
                .unwrap_or(false);
            if !is_g3dj {
                continue;
            }
            let rel_root = match path.strip_prefix(root) {
                Ok(p) => rel_components(p),
                Err(_) => continue,
            };
            let rel_target = match path.strip_prefix(&target.dir) {
                Ok(p) => rel_components(p),
                Err(_) => continue,
            };
            let rel_path = rel_root.join("/");
            if rel_path.is_empty() || !seen.insert(rel_path.clone()) {
                continue;
            }
            let root_dirs: Vec<String> = rel_root[..rel_root.len().saturating_sub(1)].to_vec();
            let target_dirs: Vec<String> = rel_target[..rel_target.len().saturating_sub(1)].to_vec();
            let (project, mut category, mut group) =
                classify(&root_dirs, &target_dirs, target.project.as_deref());
            let model_name = path
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| rel_path.clone());
            // G3DArmy 新布局 models/main/g3d 是平铺文件，没有类别目录 → 按模型名前缀推断
            if category == "default" {
                let inferred = infer_category(&model_name);
                if inferred != "default" {
                    category = inferred;
                    group = if project.eq_ignore_ascii_case("default") {
                        category.clone()
                    } else {
                        format!("{project}/{category}")
                    };
                }
            }
            let meta = entry.metadata().ok();
            let size = meta.as_ref().map(|m| m.len()).unwrap_or(0);
            let mtime_ms = meta
                .as_ref()
                .and_then(|m| m.modified().ok())
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            out.push(ModelEntry {
                path: rel_path,
                project,
                category,
                group,
                name: model_name,
                size,
                mtime_ms,
            });
        }
    }
    Ok(())
}

fn rel_components(path: &Path) -> Vec<String> {
    path.components()
        .filter_map(|c| match c {
            Component::Normal(s) => Some(s.to_string_lossy().to_string()),
            _ => None,
        })
        .collect()
}

fn rel_path_string(path: &Path, root: &Path) -> String {
    path.strip_prefix(root)
        .map(|p| rel_components(p).join("/"))
        .unwrap_or_default()
}

/// 把相对路径分类成 (project, category, group)。
///
/// - `combos/foot/...`                → default / foot / foot
/// - `ww1/combos/foot/...`            → ww1 / foot / ww1/foot
/// - `ww1/foot_ww1_afr/...`           → ww1 / foot / ww1/foot
/// - `ww1/tank_ww1_a7v/...`           → ww1 / tank / ww1/tank
/// - `ww1/model.g3dj`                 → ww1 / default / ww1
/// - `runtime/parts/...` (--all)      → runtime / runtime / runtime
/// - `library/...` (--all)            → library / library / library
fn classify(
    rel_root_dirs: &[String],
    rel_target_dirs: &[String],
    project_hint: Option<&str>,
) -> (String, String, String) {
    let (project, mut p) = match project_hint {
        Some(h) => (h.to_string(), 0usize),
        None => {
            if rel_root_dirs.is_empty() {
                ("default".to_string(), 0usize)
            } else {
                let first = &rel_root_dirs[0];
                let low = first.to_ascii_lowercase();
                if low == "combos" {
                    ("default".to_string(), 0usize)
                } else if low == "runtime" || low == "library" {
                    (low, 0usize)
                } else {
                    (first.clone(), 1usize)
                }
            }
        }
    };

    let src: &[String] = if project_hint.is_some() {
        rel_target_dirs
    } else {
        rel_root_dirs
    };
    if p < src.len() && src[p].eq_ignore_ascii_case("combos") {
        p += 1;
    }

    if project.eq_ignore_ascii_case("runtime") || project.eq_ignore_ascii_case("library") {
        let cat = project.to_ascii_lowercase();
        return (project, cat.clone(), cat);
    }

    let mut category = "default".to_string();
    if p < src.len() {
        let first = &src[p];
        if let Some(cat) = canonical_category(first) {
            category = cat.to_string();
        } else {
            category = infer_category(first);
        }
    }

    let group = if project.eq_ignore_ascii_case("default") {
        category.clone()
    } else if category == "default" {
        project.clone()
    } else {
        format!("{project}/{category}")
    };
    (project, category, group)
}

fn canonical_category(raw: &str) -> Option<&'static str> {
    match raw.to_ascii_lowercase().as_str() {
        "foot" | "infantry" | "inf" => Some("foot"),
        "mounted" | "cavalry" | "cav" | "horse" | "camel" | "camelry" | "mount" => {
            Some("mounted")
        }
        "artillery" | "cannon" | "mortar" | "siege" | "arty" => Some("artillery"),
        "ship" | "ships" | "naval" | "boat" | "galley" => Some("ship"),
        "tank" | "tanks" => Some("tank"),
        "mech" | "mechanical" | "armored" | "armoured" => Some("mech"),
        "logistics" | "truck" | "supply" | "transport" => Some("logistics"),
        "mg" | "machinegun" | "machine_gun" => Some("mg"),
        "vehicle" | "vehicles" => Some("vehicle"),
        _ => None,
    }
}

/// 没有类别目录时，用模型目录名的第一个 token 推断类别：
/// `foot_ww1_afr` → foot；`cavalry_ww1_horse` → mounted；`tank_ww1_a7v` → tank。
fn infer_category(dir: &str) -> String {
    let lower = dir.to_ascii_lowercase();
    let token = lower
        .split(|c: char| c == '_' || c == '-' || c == '.')
        .next()
        .unwrap_or("");
    if let Some(cat) = canonical_category(token) {
        return cat.to_string();
    }
    if token.len() >= 2
        && token.len() <= 20
        && token.chars().all(|c| c.is_ascii_alphabetic())
    {
        return token.to_string();
    }
    "default".to_string()
}

// ---------------------------------------------------------------- HTTP

fn handle_connection(
    mut stream: TcpStream,
    root: &Path,
    models: &[ModelEntry],
    verbose: u8,
    dev: bool,
) -> std::io::Result<()> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    stream.set_write_timeout(Some(Duration::from_secs(30))).ok();
    stream.set_nodelay(true).ok();

    let mut buf = [0u8; 16384];
    let n = stream.read(&mut buf)?;
    if n == 0 {
        return Ok(());
    }
    let req = String::from_utf8_lossy(&buf[..n]);
    let mut lines = req.lines();
    let first = lines.next().unwrap_or("");
    let mut parts = first.split_whitespace();
    let method = parts.next().unwrap_or("");
    let raw_target = parts.next().unwrap_or("/");
    if verbose > 0 {
        println!("[g3d-web] {method} {raw_target}");
    }
    if method != "GET" && method != "HEAD" {
        return respond_text(&mut stream, 405, "Method Not Allowed", "只支持 GET/HEAD\n", method == "HEAD");
    }
    let head_only = method == "HEAD";
    let target = raw_target.split('#').next().unwrap_or("/");
    let (path_part, query) = match target.split_once('?') {
        Some((p, q)) => (p, q),
        None => (target, ""),
    };

    match path_part {
        "/" | "/index.html" => respond_web(&mut stream, "index.html", "text/html; charset=utf-8", INDEX_HTML, dev, head_only),
        "/app.js" => respond_web(&mut stream, "app.js", "text/javascript; charset=utf-8", APP_JS, dev, head_only),
        "/math.js" => respond_web(&mut stream, "math.js", "text/javascript; charset=utf-8", MATH_JS, dev, head_only),
        "/g3dj.js" => respond_web(&mut stream, "g3dj.js", "text/javascript; charset=utf-8", G3DJ_JS, dev, head_only),
        "/renderer.js" => respond_web(&mut stream, "renderer.js", "text/javascript; charset=utf-8", RENDERER_JS, dev, head_only),
        "/particles.js" => respond_web(&mut stream, "particles.js", "text/javascript; charset=utf-8", PARTICLES_JS, dev, head_only),
        "/anim_events.js" => respond_web(&mut stream, "anim_events.js", "text/javascript; charset=utf-8", ANIM_EVENTS_JS, dev, head_only),
        "/unit_state_machine.js" => respond_web(&mut stream, "unit_state_machine.js", "text/javascript; charset=utf-8", UNIT_STATE_MACHINE_JS, dev, head_only),
        "/runtime_rules.js" => respond_web(&mut stream, "runtime_rules.js", "text/javascript; charset=utf-8", RUNTIME_RULES_JS, dev, head_only),
        "/layout_drawers.js" => respond_web(&mut stream, "layout_drawers.js", "text/javascript; charset=utf-8", LAYOUT_DRAWERS_JS, dev, head_only),
        "/style.css" => respond_web(&mut stream, "style.css", "text/css; charset=utf-8", STYLE_CSS, dev, head_only),
        "/api/ping" => respond_json(&mut stream, "{\"ok\":true}", head_only),
        "/api/health" => {
            let body = format!(
                "{{\"ok\":true,\"root\":\"{}\",\"models\":{},\"g3darmy\":true}}",
                json_escape(&display_path(root)),
                models.len()
            );
            respond_json(&mut stream, &body, head_only)
        }
        "/api/models" => {
            let body = models_json(root, models);
            respond_json(&mut stream, &body, head_only)
        }
        "/api/runtime" | "/api/g3darmy" => {
            let model = query_param(query, "model").unwrap_or_default();
            let body = runtime_json(root, &model);
            respond_json(&mut stream, &body, head_only)
        }
        _ if path_part.starts_with("/files/") => {
            let encoded = &path_part["/files/".len()..];
            serve_file(&mut stream, root, encoded, head_only)
        }
        "/favicon.ico" => respond_text(&mut stream, 204, "No Content", "", head_only),
        _ => respond_text(&mut stream, 404, "Not Found", "404 Not Found\n", head_only),
    }
}

fn display_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    s.strip_prefix(r"\\?\").unwrap_or(&s).to_string()
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn models_json(root: &Path, models: &[ModelEntry]) -> String {
    let mut s = String::with_capacity(models.len() * 128 + 128);
    s.push_str("{\"root\":\"");
    s.push_str(&json_escape(&display_path(root)));
    s.push_str("\",\"g3darmy\":true,\"models\":[");
    for (i, m) in models.iter().enumerate() {
        if i > 0 {
            s.push(',');
        }
        s.push_str("{\"path\":\"");
        s.push_str(&json_escape(&m.path));
        s.push_str("\",\"project\":\"");
        s.push_str(&json_escape(&m.project));
        s.push_str("\",\"category\":\"");
        s.push_str(&json_escape(&m.category));
        s.push_str("\",\"group\":\"");
        s.push_str(&json_escape(&m.group));
        s.push_str("\",\"name\":\"");
        s.push_str(&json_escape(&m.name));
        s.push_str("\",\"size\":");
        s.push_str(&m.size.to_string());
        s.push_str(",\"mtime_ms\":");
        s.push_str(&m.mtime_ms.to_string());
        s.push('}');
    }
    s.push_str("]}");
    s
}

/// 查找模型所属项目/工作区的 runtime 目录与 unitSelect。
///
/// 从模型所在目录向上找，最近的 `runtime/attachments.json` 生效；
/// 同一路径上最近的一个 `*unitSelect.json` 作为兵种映射。
fn runtime_json(root: &Path, model: &str) -> String {
    let clean = model.replace('\\', "/");
    let rel = Path::new(&clean);
    let mut cur = root.to_path_buf();
    if !clean.is_empty()
        && !rel.is_absolute()
        && rel
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
    {
        let full = root.join(rel);
        if full.is_file() {
            if let Some(parent) = full.parent() {
                cur = parent.to_path_buf();
            }
        }
    }

    let mut unit_select: Option<PathBuf> = None;
    let mut runtime_dir: Option<PathBuf> = None;
    let mut layout = "";
    loop {
        if unit_select.is_none() {
            unit_select = find_unit_select(&cur);
            if unit_select.is_none() && cur.join("loadSelect.json").is_file() {
                unit_select = Some(cur.join("loadSelect.json"));
            }
        }
        // G3DArmy v4.2+: models/attachments.json + models/parts + models/main
        if cur.join("models/attachments.json").is_file() {
            runtime_dir = Some(cur.clone());
            layout = "g3darmy";
            break;
        }
        // G3DArmy 旧版: runtime/attachments.json + runtime/parts
        let legacy = cur.join("runtime");
        if legacy.join("attachments.json").is_file() {
            runtime_dir = Some(legacy);
            layout = "legacy";
            break;
        }
        if cur == root {
            break;
        }
        if !cur.pop() {
            break;
        }
    }

    let mut s = String::with_capacity(640);
    s.push_str("{\"enabled\":true,\"available\":");
    let Some(resource_dir) = runtime_dir else {
        s.push_str("false,\"model\":\"");
        s.push_str(&json_escape(model));
        s.push_str("\"}");
        return s;
    };
    let (attachments, parts, parts_png, index, main, assembly) = if layout == "g3darmy" {
        (
            resource_dir.join("models/attachments.json"),
            resource_dir.join("models/parts/g3d"),
            resource_dir.join("models/parts/png"),
            resource_dir.join("models/parts/index.json"),
            resource_dir.join("models/main/g3d"),
            resource_dir.join("models/assembly.json"),
        )
    } else {
        (
            resource_dir.join("attachments.json"),
            resource_dir.join("parts"),
            resource_dir.join("parts"),
            resource_dir.join("parts/index.json"),
            PathBuf::new(),
            PathBuf::new(),
        )
    };
    s.push_str("true,\"model\":\"");
    s.push_str(&json_escape(model));
    s.push_str("\",\"layout\":\"");
    s.push_str(layout);
    s.push_str("\",\"base\":\"");
    s.push_str(&json_escape(&rel_path_string(&resource_dir, root)));
    s.push_str("\",\"attachments\":\"");
    s.push_str(&json_escape(&rel_path_string(&attachments, root)));
    s.push_str("\",\"parts\":\"");
    s.push_str(&json_escape(&rel_path_string(&parts, root)));
    s.push_str("\",\"partsPng\":\"");
    s.push_str(&json_escape(&rel_path_string(&parts_png, root)));
    if index.is_file() {
        s.push_str("\",\"index\":\"");
        s.push_str(&json_escape(&rel_path_string(&index, root)));
    }
    if !assembly.as_os_str().is_empty() && assembly.is_file() {
        s.push_str("\",\"assembly\":\"");
        s.push_str(&json_escape(&rel_path_string(&assembly, root)));
        s.push_str("\",\"main\":\"");
        s.push_str(&json_escape(&rel_path_string(&main, root)));
    }
    if let Some(select) = unit_select {
        s.push_str("\",\"unitSelect\":\"");
        s.push_str(&json_escape(&rel_path_string(&select, root)));
    }
    // v4.5.0: loadSelect.override.json（byId 等手写覆盖）
    let override_path = ["loadSelect.override.json", "unitSelect.override.json"]
        .iter()
        .map(|name| resource_dir.join(name))
        .find(|p| p.is_file());
    if let Some(path) = override_path {
        s.push_str("\",\"override\":\"");
        s.push_str(&json_escape(&rel_path_string(&path, root)));
    }
    // v4.5.0: civilization/<tag>.json 文明覆盖。返回 tag → 路径，前端按需加载。
    let civ_dir = resource_dir.join("civilization");
    let mut civs_written = false;
    if civ_dir.is_dir() {
        let mut civs: Vec<(String, PathBuf)> = fs::read_dir(&civ_dir)
            .map(|rd| {
                rd.flatten()
                    .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
                    .filter_map(|e| {
                        let name = e.file_name().to_string_lossy().to_string();
                        if !name.to_ascii_lowercase().ends_with(".json") {
                            return None;
                        }
                        let tag = name[..name.len() - 5].to_ascii_lowercase();
                        Some((tag, e.path()))
                    })
                    .collect()
            })
            .unwrap_or_default();
        civs.sort_by(|a, b| a.0.cmp(&b.0));
        if !civs.is_empty() {
            s.push_str("\",\"civs\":{");
            civs_written = true;
            for (i, (tag, path)) in civs.iter().enumerate() {
                if i > 0 {
                    s.push(',');
                }
                s.push('"');
                s.push_str(&json_escape(tag));
                s.push_str("\":\"");
                s.push_str(&json_escape(&rel_path_string(path, root)));
                s.push('"');
            }
            s.push('}');
        }
    }
    if civs_written {
        s.push('}');
    } else {
        s.push_str("\"}");
    }
    s
}

fn find_unit_select(dir: &Path) -> Option<PathBuf> {
    let rd = fs::read_dir(dir).ok()?;
    for entry in rd.flatten() {
        let name = entry.file_name().to_string_lossy().to_ascii_lowercase();
        if name.ends_with("unitselect.json")
            && entry.file_type().map(|t| t.is_file()).unwrap_or(false)
        {
            return Some(entry.path());
        }
    }
    None
}

fn query_param(query: &str, key: &str) -> Option<String> {
    for pair in query.split('&') {
        let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
        if k == key {
            return percent_decode(v);
        }
    }
    None
}

fn serve_file(stream: &mut TcpStream, root: &Path, encoded: &str, head_only: bool) -> std::io::Result<()> {
    let rel = match percent_decode(encoded) {
        Some(v) => v,
        None => return respond_text(stream, 400, "Bad Request", "URL 解码失败\n", head_only),
    };
    // 只允许普通相对路径组件（拒绝 .. / 绝对路径 / Windows 盘符）
    let rel_path = Path::new(&rel);
    if rel_path.is_absolute() {
        return respond_text(stream, 403, "Forbidden", "禁止绝对路径\n", head_only);
    }
    for comp in rel_path.components() {
        match comp {
            Component::Normal(_) => {}
            _ => return respond_text(stream, 403, "Forbidden", "禁止路径穿越\n", head_only),
        }
    }
    let full = root.join(rel_path);
    let canon = match fs::canonicalize(&full) {
        Ok(p) => p,
        Err(_) => return respond_text(stream, 404, "Not Found", "文件不存在\n", head_only),
    };
    let root_canon = match fs::canonicalize(root) {
        Ok(p) => p,
        Err(_) => return respond_text(stream, 500, "Internal Server Error", "根目录不可用\n", head_only),
    };
    if !canon.starts_with(&root_canon) {
        return respond_text(stream, 403, "Forbidden", "禁止访问根目录之外的文件\n", head_only);
    }
    if !canon.is_file() {
        return respond_text(stream, 404, "Not Found", "不是文件\n", head_only);
    }
    let data = match fs::read(&canon) {
        Ok(d) => d,
        Err(_) => return respond_text(stream, 404, "Not Found", "读取失败\n", head_only),
    };
    let mime = mime_for(&canon);
    let cache = if mime.starts_with("image/") {
        "public, max-age=600"
    } else {
        "no-cache"
    };
    write_response(stream, 200, "OK", mime, cache, &data, head_only)
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'%' => {
                if i + 2 >= bytes.len() {
                    return None;
                }
                let hi = hex_val(bytes[i + 1])?;
                let lo = hex_val(bytes[i + 2])?;
                out.push((hi << 4) | lo);
                i += 3;
            }
            b'+' => {
                out.push(b'+');
                i += 1;
            }
            b => {
                out.push(b);
                i += 1;
            }
        }
    }
    String::from_utf8(out).ok()
}

fn hex_val(b: u8) -> Option<u8> {
    match b {
        b'0'..=b'9' => Some(b - b'0'),
        b'a'..=b'f' => Some(b - b'a' + 10),
        b'A'..=b'F' => Some(b - b'A' + 10),
        _ => None,
    }
}

fn mime_for(path: &Path) -> &'static str {
    match path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .as_deref()
    {
        Some("g3dj") | Some("json") => "application/json; charset=utf-8",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("gif") => "image/gif",
        Some("html") | Some("htm") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("txt") | Some("md") => "text/plain; charset=utf-8",
        _ => "application/octet-stream",
    }
}

fn json_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out
}

/// 内嵌资源；`dev=true` 时优先从源码目录 web/<name> 读取（改了前端不用重编译）。
fn respond_web(
    stream: &mut TcpStream,
    name: &str,
    mime: &str,
    embedded: &str,
    dev: bool,
    head_only: bool,
) -> std::io::Result<()> {
    if dev {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("web").join(name);
        if let Ok(data) = fs::read(&path) {
            return write_response(stream, 200, "OK", mime, "no-cache", &data, head_only);
        }
        eprintln!("[g3d-web] dev asset missing: {}", path.display());
    }
    write_response(stream, 200, "OK", mime, "no-cache", embedded.as_bytes(), head_only)
}

fn respond_json(stream: &mut TcpStream, body: &str, head_only: bool) -> std::io::Result<()> {
    write_response(
        stream,
        200,
        "OK",
        "application/json; charset=utf-8",
        "no-cache",
        body.as_bytes(),
        head_only,
    )
}

fn respond_text(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    body: &str,
    head_only: bool,
) -> std::io::Result<()> {
    write_response(
        stream,
        status,
        reason,
        "text/plain; charset=utf-8",
        "no-cache",
        body.as_bytes(),
        head_only,
    )
}

fn write_response(
    stream: &mut TcpStream,
    status: u16,
    reason: &str,
    mime: &str,
    cache: &str,
    body: &[u8],
    head_only: bool,
) -> std::io::Result<()> {
    let header = format!(
        "HTTP/1.1 {status} {reason}\r\n\
         Content-Type: {mime}\r\n\
         Content-Length: {}\r\n\
         Cache-Control: {cache}\r\n\
         Access-Control-Allow-Origin: *\r\n\
         X-Content-Type-Options: nosniff\r\n\
         Connection: close\r\n\
         \r\n",
        body.len()
    );
    stream.write_all(header.as_bytes())?;
    if !head_only {
        stream.write_all(body)?;
    }
    stream.flush()
}

fn open_browser(url: &str) {
    #[cfg(windows)]
    {
        let _ = std::process::Command::new("cmd")
            .args(["/C", "start", "", url])
            .spawn();
    }
    #[cfg(target_os = "macos")]
    {
        let _ = std::process::Command::new("open").arg(url).spawn();
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = std::process::Command::new("xdg-open").arg(url).spawn();
    }
}

#[cfg(test)]
mod tests {
    use super::project_dir_label;
    use std::path::Path;

    #[test]
    fn g3darmy_label_keeps_parent_directory() {
        assert_eq!(
            project_dir_label(Path::new("A:/android/model/age3mudels/G3DArmy")),
            "age3mudels/G3DArmy"
        );
        assert_eq!(
            project_dir_label(Path::new("A:/android/model/ww1models/G3DArmy")),
            "ww1models/G3DArmy"
        );
        assert_eq!(
            project_dir_label(Path::new("A:/android/model/combos")),
            "combos"
        );
    }
}
