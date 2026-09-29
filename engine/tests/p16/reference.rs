//! P16 **判别参考集**（phaseability gate 的「应属该档」定义）。
//!
//! ## ⚠️ 本文件的头号纪律：**不得读任何位置量**
//!
//! 契约：判别参考集**不得只用区域构造**（否则循环论证）。本模块把三档 phase 的参考集
//! **只由动作链 motif** 构造——动作类型 / `result` / `detail`（是否定位球）/
//! `EpisodeStartReason`（由控制权转换决定），**零位置**。
//!
//! ## 为什么单独一个文件（这是**结构性**保证，不是纪律声明）
//!
//! 守卫 `reference_set_source_references_no_position_quantity` 扫的正是**本文件全文**。
//! 早先 `reference_set` 与其它分析函数同处 `gate.rs`，守卫只能扫它的**函数体**——
//! 实测（2026-09-29 独立审阅 P1-1）把位置读取放进**体外 helper** 再在体内调用，
//! **全套 32 条仍绿**，而参考集已经真的用上了位置。
//! 拆成独立文件后，**任何** helper 都必须落在本文件内，因此**全文扫描覆盖调用闭包**。
//!
//! ⚠️ **代价（如实记录）**：这仍不是形式化证明（没有真正的调用图分析）。
//! 它挡的是「混进一句位置读取」，挡不住「刻意用晦涩别名读位置」。
//! 对「防止自己不小心写循环论证」这个目的够用；对「防恶意构造」不够——
//! 那需要类型级隔离（把位置量封进一个 `Position` newtype，参考集侧不导入它）。

use std::collections::BTreeMap;

// ============================== 参考集（纯动作链 motif） ==============================

/// 参考集的一档：一个具名 motif + 它的谓词**逐条**（含「是否用位置」标注）。
pub struct ReferenceMotif {
    /// 档名（**不得**叫 `Phase`——见契约）。
    pub name: &'static str,
    /// 谓词的逐条子句：`(子句说明, 是否使用位置/区域)`。
    pub clauses: &'static [(&'static str, bool)],
}

/// 三档的参考 motif。**每一条子句都标注是否用位置**——这是本模块的审计核心。
///
/// ⚠️ 若某条子句的 `bool` 为 `true`，该档参考集**失去判别力**：
/// 用它去检验位置特征 = 用位置验证位置（循环论证）。
pub const REFERENCE_MOTIFS: &[ReferenceMotif] = &[
    ReferenceMotif {
        name: "final_third_candidate",
        clauses: &[
            ("episode 的**最后一个决策动作**是 `shot`", false),
            ("（不看该 shot 的 x/y，也不看 x2/y2）", false),
        ],
    },
    ReferenceMotif {
        name: "build_up_candidate",
        clauses: &[
            ("`start_reason` ∈ {kickoff, restart_control}（由控制权转换决定）", false),
            ("开放比赛成功传球数 ≥ 3", false),
            ("不含 `shot`（未进入射门）", false),
        ],
    },
    ReferenceMotif {
        name: "progression_candidate",
        clauses: &[
            ("开放比赛成功传球数 ≥ 1", false),
            ("不含 `shot`", false),
            ("`start_reason` ∉ {kickoff, restart_control}（不是从重开开始）", false),
        ],
    },
];

/// 一个 episode 的**动作链事实**——参考集的**唯一**输入。
///
/// ## 为什么是这样一个类型（这是**结构性**隔离，不是纪律声明）
///
/// 契约要求判别参考集**不得由位置构造**（否则循环论证）。
/// 文本扫描做不到这件事：实测（2026-09-29 第二轮独立审阅）把位置读取放进
/// **另一个模块**的 helper、再用 `use` 在本文件调用，扫描**看不见**——
/// 参考集已按位置剪裁，全套测试仍绿。
///
/// ⇒ 改为**类型级隔离**：本结构体**没有任何位置字段**，
/// 且 [`reference_set`] 的签名**不接收观测层对象**（只接收 `&[ActionFacts]`）。
/// 于是本文件里**任何** helper（无论定义在哪）都拿不到位置——
/// 没有 `dm`，也没有可回推位置的字段。构造侧（`action_facts`）住在 `gate.rs`，
/// 那里读事件、但**只提取动作类型/结果**这些非位置事实。
///
/// ⚠️ **剩余风险（如实记录）**：若有人往本结构体**加一个位置派生字段**，
/// 类型隔离就被破坏。这一条由 `reference_set_source_references_no_position_quantity`
/// 的**全文扫描**兜底（扫描本文件，位置 token 命中即红）——两层合起来才完整。
/// （本 doc 刻意不写出那个字段名，否则会与扫描器自己的 token 表冲突——
/// 本 change 已知的「注释里出现被扫字面量会红」形态。）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActionFacts {
    /// 开放比赛（排除定位球交付）的**成功**传球数。
    pub open_success_passes: usize,
    /// episode 内是否出现过 `shot`。
    pub has_shot: bool,
    /// **最后一个**决策动作是否是 `shot`。
    pub ends_shot: bool,
    /// episode 是否从重开开始（`start_reason ∈ {kickoff, restart_control}`）。
    pub from_restart: bool,
}

/// 构造某档参考集的 episode 下标集。
///
/// **只吃 [`ActionFacts`]**——签名里没有观测层对象，故本函数及其任何 helper
/// 都无法读到位置（见 [`ActionFacts`] 的说明）。
pub fn reference_set(facts: &[ActionFacts], name: &str) -> Vec<usize> {
    facts
        .iter()
        .enumerate()
        .filter(|(_, f)| match name {
            "final_third_candidate" => f.ends_shot,
            "build_up_candidate" => f.from_restart && f.open_success_passes >= 3 && !f.has_shot,
            "progression_candidate" => {
                f.open_success_passes >= 1 && !f.has_shot && !f.from_restart
            }
            _ => false,
        })
        .map(|(i, _)| i)
        .collect()
}

/// 一档参考集的规模（覆盖率）。
pub fn reference_share(refs: &[usize], total: usize) -> Option<f64> {
    if total == 0 {
        return None;
    }
    Some(refs.len() as f64 / total as f64)
}

/// 参考集之间是否**互斥**（同一 episode 只能属一档）。
pub fn overlaps(a: &[usize], b: &[usize]) -> usize {
    let sb: std::collections::BTreeSet<usize> = b.iter().copied().collect();
    a.iter().filter(|i| sb.contains(i)).count()
}
