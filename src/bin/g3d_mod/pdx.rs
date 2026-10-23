//! PDX 二进制容器解析(移植自 JoroDox `pdxDataService.js`)。
//!
//! 文件结构:
//! ```text
//! "@@b@"                       4 字节头
//! 对象  = '['×depth + 名字 + '\0' + (属性|子对象)*
//! 属性  = '!' + u8 名字长 + 名字 + 值
//! 值    = 'i' + u32 个数 + i32×n   (小端)
//!       | 'f' + u32 个数 + f32×n   (小端)
//!       | 's' + u32 类型(=1) + u32 字节长 + 字节(可含结尾 NUL)
//! ```
//! `.mesh` 与 `.anim` 均为该容器格式。

#[derive(Debug, Clone)]
pub enum PdxProp {
    Int(Vec<i32>),
    Float(Vec<f32>),
    Str(String),
}

impl PdxProp {
    pub fn as_ints(&self) -> Option<&[i32]> {
        match self {
            PdxProp::Int(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_floats(&self) -> Option<&[f32]> {
        match self {
            PdxProp::Float(v) => Some(v),
            _ => None,
        }
    }
    pub fn as_str(&self) -> Option<&str> {
        match self {
            PdxProp::Str(s) => Some(s),
            _ => None,
        }
    }
    pub fn first_i32(&self) -> Option<i32> {
        self.as_ints().and_then(|v| v.first().copied())
    }
    pub fn first_f32(&self) -> Option<f32> {
        self.as_floats().and_then(|v| v.first().copied())
    }
}

#[derive(Debug, Default)]
pub struct PdxObj {
    pub name: String,
    pub props: Vec<(String, PdxProp)>,
    pub children: Vec<PdxObj>,
}

impl PdxObj {
    pub fn prop(&self, name: &str) -> Option<&PdxProp> {
        self.props.iter().find(|(n, _)| n == name).map(|(_, p)| p)
    }
    pub fn child(&self, name: &str) -> Option<&PdxObj> {
        self.children.iter().find(|c| c.name == name)
    }
    pub fn prop_i32(&self, name: &str) -> Option<i32> {
        self.prop(name).and_then(|p| p.first_i32())
    }
    pub fn prop_f32(&self, name: &str) -> Option<f32> {
        self.prop(name).and_then(|p| p.first_f32())
    }
    pub fn prop_str(&self, name: &str) -> Option<&str> {
        self.prop(name).and_then(|p| p.as_str())
    }
    pub fn prop_i32s(&self, name: &str) -> Option<&[i32]> {
        self.prop(name).and_then(|p| p.as_ints())
    }
    pub fn prop_f32s(&self, name: &str) -> Option<&[f32]> {
        self.prop(name).and_then(|p| p.as_floats())
    }
}

const PDX_HEADER: &[u8; 4] = b"@@b@";

pub fn pdx_parse(buf: &[u8]) -> Result<PdxObj, String> {
    if buf.len() < 4 || &buf[0..4] != PDX_HEADER {
        return Err("不是有效的 pdx 文件(缺少 @@b@ 头)".into());
    }
    let mut root = PdxObj::default();
    let (pos, child) = pdx_read_object(buf, 4, -1)?;
    if let Some(c) = child {
        // 顶层对象(通常无名,属性挂在其上)
        root = c;
    }
    if pos > buf.len() {
        return Err("解析越界".into());
    }
    Ok(root)
}

fn pdx_read_cstr(buf: &[u8], mut pos: usize) -> Result<(String, usize), String> {
    let start = pos;
    while pos < buf.len() && buf[pos] != 0 {
        pos += 1;
    }
    if pos >= buf.len() {
        return Err("字符串未以 0 结尾".into());
    }
    let s = String::from_utf8_lossy(&buf[start..pos]).into_owned();
    Ok((s, pos + 1))
}

fn pdx_read_object(buf: &[u8], mut pos: usize, object_depth: i32) -> Result<(usize, Option<PdxObj>), String> {
    // 记录 '[' 的层数
    let mut depth = 0i32;
    while pos < buf.len() && buf[pos] == b'[' {
        depth += 1;
        pos += 1;
    }
    if depth <= object_depth {
        // 超出作用域:回退所有 '[' 字节,交由上层 break
        return Ok((pos - depth as usize, None));
    }
    // 创建本层对象(depth == 0 时为匿名根对象)
    let mut obj = PdxObj::default();
    if depth > 0 {
        let (name, np) = pdx_read_cstr(buf, pos)?;
        obj.name = name;
        pos = np;
    }
    loop {
        if pos >= buf.len() {
            break;
        }
        match buf[pos] {
            b'!' => {
                pos = pdx_read_property(&mut obj, buf, pos)?;
            }
            b'[' => {
                let (np, child) = pdx_read_object(buf, pos, depth)?;
                if np == pos {
                    // 子对象超出作用域:结束
                    break;
                }
                if let Some(c) = child {
                    obj.children.push(c);
                }
                pos = np;
            }
            other => {
                return Err(format!("偏移 {} 处出现未知字节 0x{:02X}", pos, other));
            }
        }
    }
    Ok((pos, Some(obj)))
}

fn pdx_read_property(obj: &mut PdxObj, buf: &[u8], mut pos: usize) -> Result<usize, String> {
    pos += 1; // '!'
    if pos >= buf.len() {
        return Err("属性名长度缺失".into());
    }
    let name_len = buf[pos] as usize;
    pos += 1;
    if pos + name_len > buf.len() {
        return Err("属性名越界".into());
    }
    let name = String::from_utf8_lossy(&buf[pos..pos + name_len]).into_owned();
    pos += name_len;
    let (value, np) = pdx_read_value(buf, pos)?;
    obj.props.push((name, value));
    Ok(np)
}

fn pdx_read_value(buf: &[u8], pos: usize) -> Result<(PdxProp, usize), String> {
    if pos >= buf.len() {
        return Err("属性值缺失".into());
    }
    match buf[pos] {
        b'i' => {
            let mut p = pos + 1;
            let count = read_u32_le(buf, &mut p)? as usize;
            if count > (buf.len() - p) / 4 {
                return Err("int 数组长度非法".into());
            }
            let mut v = Vec::with_capacity(count);
            for _ in 0..count {
                v.push(read_i32_le(buf, &mut p)?);
            }
            Ok((PdxProp::Int(v), p))
        }
        b'f' => {
            let mut p = pos + 1;
            let count = read_u32_le(buf, &mut p)? as usize;
            if count > (buf.len() - p) / 4 {
                return Err("float 数组长度非法".into());
            }
            let mut v = Vec::with_capacity(count);
            for _ in 0..count {
                v.push(read_f32_le(buf, &mut p)?);
            }
            Ok((PdxProp::Float(v), p))
        }
        b's' => {
            let mut p = pos + 1;
            let _string_type = read_u32_le(buf, &mut p)?; // 通常为 1
            let len = read_u32_le(buf, &mut p)? as usize;
            if p + len > buf.len() {
                return Err("字符串越界".into());
            }
            let mut s = String::from_utf8_lossy(&buf[p..p + len]).into_owned();
            if s.ends_with('\0') {
                s.pop();
            }
            Ok((PdxProp::Str(s), p + len))
        }
        other => Err(format!("未知属性类型 0x{:02X}", other)),
    }
}

fn read_u32_le(buf: &[u8], pos: &mut usize) -> Result<u32, String> {
    if *pos + 4 > buf.len() {
        return Err("读取 u32 越界".into());
    }
    let v = u32::from_le_bytes([buf[*pos], buf[*pos + 1], buf[*pos + 2], buf[*pos + 3]]);
    *pos += 4;
    Ok(v)
}

fn read_i32_le(buf: &[u8], pos: &mut usize) -> Result<i32, String> {
    Ok(read_u32_le(buf, pos)? as i32)
}

fn read_f32_le(buf: &[u8], pos: &mut usize) -> Result<f32, String> {
    Ok(f32::from_bits(read_u32_le(buf, pos)?))
}
