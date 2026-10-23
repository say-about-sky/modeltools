//! g3dj(JSON)写入器 —— fbx-conv `src/json/JSONWriter.h` 行为移植。
//!
//! 格式要点:CRLF 换行、制表符缩进、`": "`/`", "` 分隔;
//! 整数用 C 的 `"% 3i"`(空格符号 + 宽度 3),浮点用 `"% 8f"`(8 位小数,正数带前导空格;
//! NaN/Inf 先按 fbx-conv 用 `0xFEFFFFFF` 掩码);
//! 容器内联规则 = `capacity >= 0 && capacity <= maxLineSize`;
//! 数据数组按行宽换行(vertices 每顶点一行、indices 每 12 个一行)。

use super::writer::G3dW;

pub struct JsonW {
    out: String,
    stack: Vec<JCtx>,
    after_key: bool,
}

struct JCtx {
    is_array: bool,
    inline: bool,
    first: bool,
    line_count: u64,
    max_line: u64,
}

impl JsonW {
    pub fn new() -> Self {
        JsonW {
            out: String::new(),
            stack: Vec::new(),
            after_key: false,
        }
    }
    /// 取走序列化结果
    pub fn finish(self) -> String {
        self.out
    }
    fn newline(&mut self) {
        self.out.push_str("\r\n");
        for _ in 0..self.stack.len() {
            self.out.push('\t');
        }
    }
    /// 对应 C++ nextValue()(数组元素 / 对象键)
    fn next_value(&mut self) {
        let depth = self.stack.len();
        if depth == 0 {
            return;
        }
        let ctx = self.stack.last_mut().unwrap();
        let first = ctx.first;
        ctx.first = false;
        ctx.line_count += 1;
        let nl = ctx.line_count > ctx.max_line;
        if ctx.line_count > ctx.max_line {
            ctx.line_count = 1;
        }
        if !first {
            self.out.push_str(", ");
            if nl {
                self.newline();
            }
        }
    }
    fn begin(&mut self, is_array: bool, cap: i64, max_line: u64) {
        if !self.stack.is_empty() {
            if self.after_key {
                self.after_key = false;
            } else {
                self.next_value();
            }
        }
        let inline = cap >= 0 && (cap as u64) <= max_line;
        self.out.push(if is_array { '[' } else { '{' });
        self.stack.push(JCtx {
            is_array,
            inline,
            first: true,
            line_count: 0,
            max_line,
        });
        if !inline {
            self.newline();
        }
    }
    fn write_key(&mut self, s: &str) {
        self.next_value();
        self.json_string(s);
        self.out.push_str(": ");
        self.after_key = true;
    }
    fn write_string_value(&mut self, s: &str) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.next_value();
        }
        self.json_string(s);
    }
    fn json_string(&mut self, s: &str) {
        self.out.push('"');
        for c in s.chars() {
            match c {
                '"' => self.out.push_str("\\\""),
                '\\' => self.out.push_str("\\\\"),
                _ => self.out.push(c),
            }
        }
        self.out.push('"');
    }
    fn write_raw_value(&mut self, s: &str) {
        if self.after_key {
            self.after_key = false;
        } else {
            self.next_value();
        }
        self.out.push_str(s);
    }
    /// C 的 "% 3i"(空格符号 + 宽度 3)
    fn fmt_int(v: i32) -> String {
        if v >= 0 {
            format!(" {:>2}", v)
        } else {
            format!("{:>3}", v)
        }
    }
    /// C 的 "% 8f"(8 位小数,正数前导空格;NaN/Inf 先按 fbx-conv 掩码)
    fn fmt_float(v: f32) -> String {
        let masked = if !(v * 0.0 == 0.0) {
            f32::from_bits(v.to_bits() & 0xfeff_ffff)
        } else {
            v
        };
        if masked.is_sign_negative() {
            format!("{:.8}", masked)
        } else {
            format!(" {:.8}", masked)
        }
    }
}

impl G3dW for JsonW {
    fn obj(&mut self) {
        self.begin(false, -1, 0);
    }
    fn obj_cap(&mut self, cap: i64) {
        self.begin(false, cap, 0);
    }
    fn arr(&mut self) {
        self.begin(true, -1, 0);
    }
    fn arr_cap(&mut self, cap: i64) {
        self.begin(true, cap, 0);
    }
    fn arr_cap_line(&mut self, cap: i64, line: u64) {
        self.begin(true, cap, line);
    }
    fn end(&mut self) {
        let ctx = self.stack.pop().expect("end 时没有打开的块");
        if !ctx.inline {
            self.newline();
        }
        self.out.push(if ctx.is_array { ']' } else { '}' });
    }
    fn key(&mut self, s: &str) {
        self.write_key(s);
    }
    fn sval(&mut self, s: &str) {
        self.write_string_value(s);
    }
    fn fval(&mut self, v: f32) {
        let s = JsonW::fmt_float(v);
        self.write_raw_value(&s);
    }
    fn ival(&mut self, v: i32) {
        let s = JsonW::fmt_int(v);
        self.write_raw_value(&s);
    }
    fn fdata(&mut self, v: &[f32], line: u64) {
        self.begin(true, v.len() as i64, line.max(1));
        for &x in v {
            self.fval(x);
        }
        self.end();
    }
    fn idata(&mut self, v: &[i32], line: u64) {
        self.begin(true, v.len() as i64, line);
        for &x in v {
            self.ival(x);
        }
        self.end();
    }
    fn i16data(&mut self, v: &[i16]) {
        self.begin(true, v.len() as i64, 32);
        for &x in v {
            self.ival(x as i32);
        }
        self.end();
    }
}
