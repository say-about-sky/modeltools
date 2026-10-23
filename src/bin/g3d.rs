//! `g3d` 二进制入口。
//!
//! 全部实现位于同目录的 [`g3d_mod`] 模块树(`g3d_mod/mod.rs` 为模块根,
//! 其余文件为该文件夹内的同级子模块);本文件只负责装载模块并调用 `g3d_mod::cli_main`。
//!
//! 用法示例:
//!   g3d unit_weapon_zweihander.mesh
//!   g3d unit_skeleton.mesh -j -o out.g3dj -v
//!   g3d unit_torso.mesh --lod all --anim x_idle.anim --anim x_walk.anim

mod g3d_mod;

fn main() {
    g3d_mod::cli_main();
}
