//! 确定性种子 RNG（xorshift64，零依赖）。
//! 同种子 → 同随机序列 → 同事件流。供 P0 确定性验证（票据 06，先简单种子 RNG）。

/// 确定性伪随机数生成器（xorshift64*）。
/// 不依赖外部 crate，从零实现，保证跨平台一致（纯整数运算）。
#[derive(Debug, Clone)]
pub struct SeededRng {
    state: u64,
}

impl SeededRng {
    pub fn new(seed: u64) -> Self {
        // 避免 0 状态（xorshift 需要非零）
        let state = if seed == 0 { 0x9E3779B97F4A7C15 } else { seed };
        let mut rng = SeededRng { state };
        // 预热几轮，打散种子相关性
        for _ in 0..8 {
            rng.next_u64();
        }
        rng
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x >> 12;
        x ^= x << 25;
        x ^= x >> 27;
        self.state = x;
        x.wrapping_mul(0x2545F4914F6CDD1D)
    }

    pub fn next_u32(&mut self) -> u32 {
        (self.next_u64() >> 32) as u32
    }

    /// 返回 [0,1) 的 f64（用于坐标等）
    #[allow(dead_code)]
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = SeededRng::new(42);
        let mut b = SeededRng::new(42);
        for _ in 0..100 {
            assert_eq!(a.next_u64(), b.next_u64());
        }
    }

    #[test]
    fn different_seed_different_sequence() {
        let mut a = SeededRng::new(42);
        let mut b = SeededRng::new(43);
        let mut same = 0;
        for _ in 0..100 {
            if a.next_u64() == b.next_u64() { same += 1; }
        }
        assert!(same < 100, "不同种子不应全相同");
    }

    #[test]
    fn never_zero_state() {
        let mut rng = SeededRng::new(0);
        let first = rng.next_u64();
        assert_ne!(first, 0);
    }
}
