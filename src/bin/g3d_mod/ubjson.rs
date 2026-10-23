//! g3db(UBJSON)写入器 —— fbx-conv `src/json/UBJSONWriter.h` 行为移植。
//!
//! 大端编码:`'i'`=int16(2B)、`'I'`=int32(4B)、`'d'`=float32(4B);
//! 字符串 `'s'`(1 字节长度,<256)/`'S'`(4 字节长度);
//! 数值数组用强类型容器 `'a'`(个数 <255,1 字节)/`'A'`(4 字节) + 类型 + 个数;
//! 空数组回退为普通 `[]`。与 libgdx `UBJsonReader`(oldFormat=true)兼容。

use super::writer::G3dW;

pub struct UbjW {
    out: Vec<u8>,
    stack: Vec<bool>, // true = 数组
}

impl UbjW {
    pub fn new() -> Self {
        UbjW {
            out: Vec::new(),
            stack: Vec::new(),
        }
    }
    /// 取走序列化结果
    pub fn finish(self) -> Vec<u8> {
        self.out
    }
    fn u8(&mut self, b: u8) {
        self.out.push(b);
    }
    fn be16(&mut self, v: i16) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn be32(&mut self, v: i32) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn be_u32(&mut self, v: u32) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn be_f32(&mut self, v: f32) {
        self.out.extend_from_slice(&v.to_be_bytes());
    }
    fn write_string(&mut self, s: &str) {
        let b = s.as_bytes();
        if b.len() < 256 {
            self.u8(b's');
            self.u8(b.len() as u8);
        } else {
            self.u8(b'S');
            self.be_u32(b.len() as u32);
        }
        self.out.extend_from_slice(b);
    }
    /// 强类型数组头:'a'/'A' + 类型 + 个数(与 fbx-conv writeOpenData 一致)
    fn data_header(&mut self, ty: u8, count: usize) {
        if count < 255 {
            self.u8(b'a');
            self.u8(ty);
            self.u8(count as u8);
        } else {
            self.u8(b'A');
            self.u8(ty);
            self.be_u32(count as u32);
        }
    }
    /// 空数组按普通数组写出(与 values() 的空数组回退一致)
    fn empty_array(&mut self) {
        self.u8(b'[');
        self.u8(b']');
    }
}

impl G3dW for UbjW {
    fn obj(&mut self) {
        self.u8(b'{');
        self.stack.push(false);
    }
    fn obj_cap(&mut self, _cap: i64) {
        self.u8(b'{');
        self.stack.push(false);
    }
    fn arr(&mut self) {
        self.u8(b'[');
        self.stack.push(true);
    }
    fn arr_cap(&mut self, _cap: i64) {
        self.u8(b'[');
        self.stack.push(true);
    }
    fn arr_cap_line(&mut self, _cap: i64, _line: u64) {
        self.u8(b'[');
        self.stack.push(true);
    }
    fn end(&mut self) {
        let was_array = self.stack.pop().expect("end 时栈为空");
        self.u8(if was_array { b']' } else { b'}' });
    }
    fn key(&mut self, s: &str) {
        self.write_string(s);
    }
    fn sval(&mut self, s: &str) {
        self.write_string(s);
    }
    fn fval(&mut self, v: f32) {
        self.u8(b'd');
        self.be_f32(v);
    }
    fn ival(&mut self, v: i32) {
        self.u8(b'I');
        self.be32(v);
    }
    fn fdata(&mut self, v: &[f32], _line: u64) {
        if v.is_empty() {
            self.empty_array();
            return;
        }
        self.data_header(b'd', v.len());
        for &x in v {
            self.be_f32(x);
        }
    }
    fn idata(&mut self, v: &[i32], _line: u64) {
        if v.is_empty() {
            self.empty_array();
            return;
        }
        self.data_header(b'I', v.len());
        for &x in v {
            self.be32(x);
        }
    }
    fn i16data(&mut self, v: &[i16]) {
        if v.is_empty() {
            self.empty_array();
            return;
        }
        self.data_header(b'i', v.len());
        for &x in v {
            self.be16(x);
        }
    }
}
