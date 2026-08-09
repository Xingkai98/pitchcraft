//! WASM 接口层（P0，`#[no_mangle]` extern "C"，零依赖）。
//!
//! 导出给 JS 的接口（见 viewer/app.js）：
//! - `alloc_json(ptr, len)`：把 config JSON 字符串拷入 wasm 内存
//! - `simulate(seed, cfg_ptr, cfg_len)`：跑模拟，把结果 JSON 放进导出缓冲区
//! - `get_json_ptr()` / `get_json_length()`：取结果指针/长度
//! - `free_json()`：释放（P0 简化，静态缓冲区即可）
//!
//! 约定：config 传入格式 `{ "match_duration_seconds": 5400 }`（P7 默认 90 分钟）。
//! 返回：整场事件流 JSON（含 lineup 事件）。

use crate::MatchConfig;

/// 静态结果缓冲区（P0 简化：单次 simulate 结果）。wasm 线性内存可见。
static mut RESULT_BUFFER: Vec<u8> = Vec::new();

/// 解析 config JSON（手写极简解析，只取 match_duration_seconds）。
fn parse_config(json: &str) -> MatchConfig {
    // 默认 5400（90 分钟，P7）
    let mut cfg = MatchConfig::default_();
    // 查找 "match_duration_seconds": <number>
    if let Some(idx) = json.find("match_duration_seconds") {
        if let Some(colon) = json[idx..].find(':') {
            let start = idx + colon + 1;
            let rest = &json[start..];
            let mut num = String::new();
            for c in rest.chars() {
                if c.is_ascii_digit() || c == '.' {
                    num.push(c);
                } else {
                    break;
                }
            }
            if let Ok(v) = num.parse::<f64>() {
                cfg.match_duration_seconds = v;
            }
        }
    }
    // 查找 "demo_mode": true/false
    if json.contains("\"demo_mode\":true") || json.contains("\"demo_mode\": true") {
        cfg.demo_mode = true;
    }
    cfg
}

#[no_mangle]
pub extern "C" fn simulate(seed: u64, cfg_ptr: *const u8, cfg_len: usize) {
    // 读 config JSON：cfg_ptr 为真实非零指针（app.js 写入 SCRATCH_OFFSET 后传入）
    assert!(!cfg_ptr.is_null(), "cfg_ptr must be non-null (write config to SCRATCH_OFFSET first)");
    let cfg_bytes = unsafe { std::slice::from_raw_parts(cfg_ptr, cfg_len) };
    let cfg_json = String::from_utf8_lossy(cfg_bytes).into_owned();
    let cfg = parse_config(&cfg_json);

    // 跑模拟，得到事件流 JSON（显式限定 crate::simulate，避免与本模块 extern fn 歧义）
    let result = crate::simulate(seed, cfg);

    // 存入静态缓冲区
    unsafe {
        RESULT_BUFFER = result.into_bytes();
    }
}

#[no_mangle]
pub extern "C" fn get_json_ptr() -> *const u8 {
    unsafe { RESULT_BUFFER.as_ptr() }
}

#[no_mangle]
pub extern "C" fn get_json_length() -> usize {
    unsafe { RESULT_BUFFER.len() }
}

#[no_mangle]
pub extern "C" fn free_json() {
    unsafe {
        RESULT_BUFFER = Vec::new();
    }
}
