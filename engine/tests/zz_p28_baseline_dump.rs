//! P28 临时工具（收尾前删除）：接线前后事件流逐 seed 字节指纹。
//! 用法：cargo test --test zz_p28_baseline_dump -- --nocapture
//! 接线前输出存盘 → 接线后重跑 diff 必须零差异（D5 逐字节等价证据）。
use fm_engine::{simulate, MatchConfig};

fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

#[test]
fn dump_baseline() {
    for seed in 1..=100u64 {
        let json = simulate(seed, MatchConfig::default_());
        println!("BASELINE {} {} {}", seed, fnv1a(json.as_bytes()), json.len());
    }
}
