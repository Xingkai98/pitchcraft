//! P124 探针纪律（design §4）——**本 change 的血泪继承**。
//!
//! ## 为什么单独一个模块
//!
//! P16 期间**探针本身出过两次假证据**，两次都不是分析错，是**探针错**：
//!
//! 1. 比较函数对数组误用 `.x`/`.y` 得 `NaN`，而 `NaN > max` **恒假** ⇒ 打出
//!    「`max|Δ| = 0.000000`」——一个看起来完美的通过。
//! 2. 主 session 在净化探针里用 `flatten()` 丢 `None` ⇒ **压缩了索引空间**，
//!    参考集下标与特征下标错位，`final_third` 的 **0.855 被算成 0.493**。
//!
//! ⇒ 本模块把这些纪律**做成结构性**的，而不是靠「记得小心」：
//!
//! | 纪律（design §4） | 本模块怎么保证 |
//! |---|---|
//! | NaN / 非有限显式判红 | [`require_finite`]：逐值判，**不依赖 `>`/`max` 的静默语义** |
//! | 报「跳过几个 / 比较几个」 | [`RateAuc`] 同时带 `pos_n` / `neg_n` / `skipped_in_set` |
//! | 反证条（已知应给高分） | 调用侧的对照臂（见 `purify.rs` 的 counter-proof） |
//! | 参考集与特征**同一索引空间** | [`Pooled`]：`feats` 与 `facts` **同长同索引**，构造时断言；**无 `flatten`** |
//!
//! ## 索引空间为什么能做成结构性的
//!
//! P16 的 join bug 之所以发生，是因为参考集与特征**各自**用自己的下标（一个全局、
//! 一个逐场本地），二者只在 `separability` 内部相遇——中间任何一次「顺手过滤」
//! 都能让它们错位。本模块把二者**绑成同一个 `Vec` 下标**：`feats[i]` 与 `facts[i]`
//! 恒指**同一个 episode**，构造时 `assert_eq!` 守住。于是「错位」不是一个需要小心
//! 避免的动作，而是一个**写不出来的**状态。
//!
//! ⚠️ **本模块只吃 `ActionFacts` / `EpisodeFeature`**（两者都无位置字段），
//! 故它结构上不可能把位置偷偷带进判别（见 `p16/reference.rs` 的类型隔离说明）。

use crate::gate::{action_facts, episode_features, EpisodeFeature};
use crate::reference::ActionFacts;

/// **显式判红**：非有限值（`NaN` / `±Inf`）一律 panic。
///
/// 为什么不能只靠下游的 `>` / `max`：`NaN > max` 恒假、`f64::max(NaN, x) = x`
/// ——非有限值会**静默消失**，留下一个「看起来通过」的空结论（P16 的假证据形态 1）。
///
/// 逐值调用（不是只判最终统计量）：一个 NaN 混在 3000 个值里，聚合后就看不见了。
pub fn require_finite(label: &str, v: f64) -> f64 {
    assert!(
        v.is_finite(),
        "探针判红：`{label}` 出现非有限值 {v}。NaN/Inf 会让 `>`/`max` 静默为假，\
         使下游打出「全部通过」的假证据（P16 假证据形态 1）。\
         先查上游：是不是除零（时长 0）、下标错位（join bug）或空集合上的统计。"
    );
    v
}

/// 一次被测收集的**完整账**——不只报分母。
///
/// P16 的教训是「N 点通过」会被读成「大部分点通过了」；故**跳过数与比较数并列报**
/// （`pos_n` / `neg_n` / `skipped_in_set` 三个数一起读，不是只报分母）。
#[derive(Debug, Clone, PartialEq)]
pub struct RateAuc {
    /// 秩基 AUC。任一侧为空 → `None`（**不猜 0.5**）。
    pub auc: Option<f64>,
    /// 应属侧参与比较的样本数。
    pub pos_n: usize,
    /// 不应属侧参与比较的样本数。
    pub neg_n: usize,
    /// 两侧合计**因特征缺失而跳过**的样本数（`None` / 非有限）。
    ///
    /// ## 为什么只有一个跳过计数（第 5 轮审阅纠正了一处夸大声明）
    ///
    /// 本结构曾**并列**两个字段（`skipped_missing` / `skipped_in_set`），doc 声称二者
    /// 「有区别」。**代码里它们恒等**：所有 `rate_auc*` 实现都只遍历「属于 pos 或 neg 集合」
    /// 的 episode（`if !a && !b { continue; }`），故**每一个跳过都在集合内**——
    /// `let skipped_missing = skipped_in_set;` 是恒等赋值。留两个字段是**死字段 + 假声明**
    /// （本 change 第 2/3/4/5 轮各抓到一次同族缺陷：doc 声称的机制代码里不存在）。
    ///
    /// ⇒ 只保留本栏。缺失若在两侧分布不均，AUC 会被**选择效应**污染——
    /// 由 [`Self::require_clean`] 断言它为 0 来守。
    pub skipped_in_set: usize,
}

impl RateAuc {
    /// 断言这次比较**非空且无静默跳过**——不适用的地方调用方自行选择是否用。
    pub fn require_clean(&self, label: &str) {
        assert!(
            self.auc.is_some(),
            "探针判红：`{label}` 算不出 AUC（pos={}, neg={}）——空组不得静默通过",
            self.pos_n,
            self.neg_n
        );
        assert!(
            self.skipped_in_set == 0,
            "探针判红：`{label}` 在参考集内有 {} 个样本缺特征（pos={}, neg={}）——\
             缺失分布在两侧不均时 AUC 会被选择效应污染。若这是预期的，请**显式记录**\
             （`RateAuc` 的 `skipped_in_set` 已可读），不要让它在默认路径里静默发生。",
            self.skipped_in_set,
            self.pos_n,
            self.neg_n
        );
    }
}

/// 池化的 episode 特征 + 参考集事实，**同一个下标空间**。
///
/// ## 索引空间契约（本 change 的 P0 防护）
///
/// - `feats[i]` 与 `facts[i]` 恒指 **第 `i` 个池化 episode**（全局下标）；
/// - 构造时断言 `feats.len() == facts.len()`，不等即红；
/// - **不提供 `flatten` 一类的压缩入口**——参考集谓词只接受 `&ActionFacts` 并返回
///   `bool`，故「丢掉一个 `None`」在类型上就**不能**改变下标。
///
/// 任一 seed 的 episode 数与 `possession_episodes` 不等时（`episode_features` 跳过缺
/// caliber 的 episode），构造**当场 panic**——那正是 P16 join bug 的入口
/// （`feats.len()` 与参考集下标空间不同步）。此时必须改 offset 口径，不是忽略。
#[derive(Debug, Clone)]
pub struct Pooled {
    /// 逐 episode 的特征（全局下标）。
    pub feats: Vec<(usize, EpisodeFeature)>,
    /// 逐 episode 的动作链事实（全局下标，与 `feats` **同长同序**）。
    pub facts: Vec<Option<ActionFacts>>,
    /// 本次池化的 seed 区间（**口径，必须随任何数字一起引用**——P16 的
    /// `0.855 / 0.862` 之争就是 seed 数没写明）。`u64` 的区间记作 `(first, last)`。
    pub seeds: (u64, u64),
}

impl Pooled {
    /// 池化 episode 数（= 样本量分母）。
    pub fn len(&self) -> usize {
        self.facts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.facts.is_empty()
    }

    /// seed 数（口径的一部分）。
    pub fn seed_count(&self) -> u64 {
        self.seeds.1 - self.seeds.0 + 1
    }

    /// 口径描述行——**任何打印数字的地方都该带上它**。
    pub fn caliber_line(&self) -> String {
        format!(
            "{} seed（{}..={}）/ {} episode",
            self.seed_count(),
            self.seeds.0,
            self.seeds.1,
            self.len()
        )
    }
}

/// 把若干 seed 的比赛池化成**单一全局下标空间**。
///
/// `observe` = 调用侧的观察入口（`simulate_with_behavior_observations` 的薄包装，
/// 带 `is_coherent` 断言）——传进来是为了让本模块不直接依赖引擎入口，
/// 便于单测用 fixture 构造。
pub fn pool_episodes(
    seeds: (u64, u64),
    observe: impl Fn(u64) -> fm_engine::observation::DiagnosticMatch,
) -> Pooled {
    let mut feats: Vec<(usize, EpisodeFeature)> = Vec::new();
    let mut facts: Vec<Option<ActionFacts>> = Vec::new();
    let mut offset = 0usize;
    for seed in seeds.0..=seeds.1 {
        let dm = observe(seed);
        let n_eps = dm.possession_episodes.len();
        let f = episode_features(&dm);
        let a = action_facts(&dm);
        // ⚠️ 三处下标空间必须**逐 seed**对齐——任一处不同步，offset 就会把下一 seed
        // 的标签与本 seed 的高位重叠（P16 的 join bug 形态）。
        assert_eq!(
            f.len(),
            n_eps,
            "seed {seed}：`episode_features` 给出的 {} 条与 `possession_episodes` 的 {n_eps} 条不等\
             ——offset 口径必须改成逐 seed 的实际条数，否则参考集标签会跨 seed 重叠",
            f.len()
        );
        assert_eq!(
            a.len(),
            n_eps,
            "seed {seed}：`action_facts` 给出的 {} 条与 `possession_episodes` 的 {n_eps} 条不等",
            a.len()
        );
        feats.extend(f.into_iter().map(|(i, ef)| (i + offset, ef)));
        facts.extend(a);
        offset += n_eps;
    }
    // 结构性契约：两个向量同长，且下标连续覆盖 `0..len`。
    assert_eq!(
        feats.len(),
        facts.len(),
        "池化后 `feats` 与 `facts` 长度不等——索引空间已错位（P16 的 join bug 形态）"
    );
    for (k, (i, _)) in feats.iter().enumerate() {
        assert_eq!(
            *i, k,
            "池化后 `feats` 的下标不连续（第 {k} 项标着 {i}）——参考集与特征已不在同一索引空间"
        );
    }
    Pooled { feats, facts, seeds }
}

/// 按谓词取全局下标集。`None` 条目**不参与**（它没有动作链），
/// 但**下标本身不被压缩**——`i` 始终是池化空间的原始下标。
pub fn set_where(p: &Pooled, pred: impl Fn(&ActionFacts) -> bool) -> Vec<usize> {
    p.facts
        .iter()
        .enumerate()
        .filter_map(|(i, f)| f.as_ref().filter(|f| pred(f)).map(|_| i))
        .collect()
}

/// 全集的补集（在池化空间内）。
pub fn complement(p: &Pooled, set: &[usize]) -> Vec<usize> {
    let s: std::collections::BTreeSet<usize> = set.iter().copied().collect();
    (0..p.len()).filter(|i| !s.contains(i)).collect()
}

/// 两档在某个特征上的**取值向量逐位是否相等**（**结构性**无偏证据，比 AUC≈0.5 更强）。
///
/// 用途：空对照（两臂谓词逐字相同）里，两侧必须取出**逐位相同**的取值序列。
/// 这条检查**不受任何浮点容差影响**——它直接抓「某一侧被额外过滤 / 下标不同步」，
/// 且**无论偏置多小都会红**（AUC 的偏差可能小到藏在容差里）。
pub fn values_are_identical(
    p: &Pooled,
    set_a: &[usize],
    set_b: &[usize],
    f: fn(&EpisodeFeature) -> Option<f64>,
) -> Result<(), String> {
    let a: std::collections::BTreeSet<usize> = set_a.iter().copied().collect();
    let b: std::collections::BTreeSet<usize> = set_b.iter().copied().collect();
    let mut va: Vec<(usize, f64)> = Vec::new();
    let mut vb: Vec<(usize, f64)> = Vec::new();
    for (i, ef) in &p.feats {
        let in_a = a.contains(i);
        let in_b = b.contains(i);
        if !in_a && !in_b {
            continue;
        }
        let Some(v) = f(ef) else {
            // 缺失必须**在两侧同时发生**——只在一侧缺失就是选择效应的来源。
            if in_a != in_b {
                return Err(format!("episode {i} 只在一侧出现"));
            }
            continue;
        };
        if in_a {
            va.push((*i, v));
        }
        if in_b {
            vb.push((*i, v));
        }
    }
    if va.len() != vb.len() {
        return Err(format!("两侧取值数不等：{} vs {}", va.len(), vb.len()));
    }
    for (x, y) in va.iter().zip(vb.iter()) {
        if x.0 != y.0 || x.1 != y.1 {
            return Err(format!("首个分歧：{x:?} vs {y:?}"));
        }
    }
    Ok(())
}

/// 对两个全局下标集算某特征的秩基 AUC，并记全账。
///
/// **逐值判红**（[`require_finite`]）——这是 P16 假证据形态 1 的直接防线。
pub fn rate_auc(
    p: &Pooled,
    set_a: &[usize],
    set_b: &[usize],
    label: &str,
    f: fn(&EpisodeFeature) -> Option<f64>,
) -> RateAuc {
    let in_a: std::collections::BTreeSet<usize> = set_a.iter().copied().collect();
    let in_b: std::collections::BTreeSet<usize> = set_b.iter().copied().collect();
    let mut pos = Vec::new();
    let mut neg = Vec::new();
    let mut skipped_in_set = 0usize;
    for (i, ef) in &p.feats {
        let a = in_a.contains(i);
        let b = in_b.contains(i);
        if !a && !b {
            continue;
        }
        match f(ef).map(|v| require_finite(&format!("{label}@ep{i}"), v)) {
            Some(v) => {
                if a {
                    pos.push(v);
                }
                if b {
                    neg.push(v);
                }
            }
            None => skipped_in_set += 1,
        }
    }
    RateAuc {
        auc: crate::gate::auc(&pos, &neg),
        pos_n: pos.len(),
        neg_n: neg.len(),
        skipped_in_set,
    }
}

/// 「球门向推进速率」（米/秒）——P16 净化与裁决**共用**的那条特征。
///
/// 定义与 `p16_spatial_features.rs` 的裁决测试逐字一致：`forward_m / duration_s`。
/// **`None` 不填 0**——缺时长的 episode 直接不参与（由 [`RateAuc::skipped_in_set`] 记账）。
///
/// ⚠️ **在这里集中定义**（而不是各处写闭包）是为了让「反证条」与「净化臂」**结构上
/// 走同一个函数**——P16 的教训之一是同一口径在两处各写一遍会分叉。
pub fn forward_rate(e: &EpisodeFeature) -> Option<f64> {
    Some(e.forward_m? / e.duration_s?)
}
