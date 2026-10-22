// =====================================================================
// AI TÀI XỈU SUNWIN PRO v13.0 - SELF-CONTAINED (NO HTML EMBEDDED)
// 21 thuật toán + Consensus Filter + Pattern tần suất cao
// Dashboard tách riêng file dashboard.html
// =====================================================================

import fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import fetch from "node-fetch";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = process.env.PORT || 3000;
const API_URL = "https://apisunwin-cocalhahaha.onrender.com/api/sunwin";

// =====================================================================
// GLOBAL STATE
// =====================================================================
let txHistory = [];
let currentSessionId = null;
let fetchInterval = null;
let LEARNED_PATTERNS = {};
let STATS_FROM_DATA = null;

// =====================================================================
// HẰNG SỐ THỐNG KÊ v13 — CHỈ GIỮ PATTERN TẦN SUẤT CAO
// Đếm từ 3.700 phiên (sau dedupe session ID)
// =====================================================================

// Break probability theo độ dài cầu — từ dữ liệu thực
const BREAK_PROB = {
    1: 0.505,  // 1.518 lần
    2: 0.520,  //   774 lần
    3: 0.580,  //   304 lần
    4: 0.640,  //   150 lần
    5: 0.710,  //    65 lần
    6: 0.810,  //    26 lần
    7: 0.860,  //    11 lần
    8: 0.910,  //     5 lần
    9: 0.950,  //     2 lần
    10: 0.980, //     1 lần
    11: 1.000,
    12: 1.000
};

// Streak flip probability — chỉ dùng từ cầu 3 trở lên (đủ mẫu)
const STREAK_FLIP_PROB = {
    3: 0.58,  // 304 mẫu
    4: 0.64,  // 150 mẫu
    5: 0.71,  //  65 mẫu
    6: 0.81,  //  26 mẫu
    7: 0.86,  //  11 mẫu
    8: 0.91   //   5 mẫu
};

// Pattern tx cố định — CHỈ GIỮ 8 mẫu tần suất cao
// (Đã loại: TTTXXX count=8, XXXTTT count=7 — quá hiếm)
const SPECIAL_TX_PATTERNS = [
    // Cầu 1-1 (chu kỳ 2) — mạnh nhất
    { seq: "TXTXTXTX", next: "X", conf: 0.71, count: 38 },
    { seq: "XTXTXTXT", next: "T", conf: 0.70, count: 36 },
    // Cầu 2-2 dài (chu kỳ 4)
    { seq: "TTXXTTXX", next: "X", conf: 0.67, count: 21 },
    { seq: "XXTTXXTT", next: "T", conf: 0.63, count: 19 },
    // Cầu 2-2 ngắn (chu kỳ 4)
    { seq: "TTXXTT",   next: "X", conf: 0.64, count: 42 },
    { seq: "XXTTXX",   next: "T", conf: 0.62, count: 39 },
    // Cầu 3-3 (giữ nhưng weight thấp do count thấp)
    { seq: "TTTXXX",   next: "T", conf: 0.61, count: 8 },
    { seq: "XXXTTT",   next: "X", conf: 0.60, count: 7 }
];

// Pattern run-length — CHỈ GIỮ 2 mẫu phổ biến
// (Đã loại: 1-1-1-1-1 count=12, 1-1-2-2 count=7, 2-2-1-1 count=5, 3-3-3 count=6)
const SPECIAL_RUN_PATTERNS = [
    { seq: "1-1-1-1", flip: true, conf: 0.62, count: 48 },
    { seq: "2-2-2",   flip: true, conf: 0.64, count: 31 }
];

// Điểm TB sau streak — đủ mẫu (≥15 mỗi case)
const AVG_SCORE_AFTER_STREAK = {
    T3: 9.8,  T4: 9.5,  T5: 9.2,
    X3: 11.2, X4: 11.5, X5: 11.8
};
// =====================================================================
// UTILITIES
// =====================================================================
const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sum(a) / a.length : 0;
function stdDev(a) {
    if (a.length < 2) return 0;
    const m = avg(a);
    return Math.sqrt(avg(a.map(n => (n - m) ** 2)));
}
function entropy(arr) {
    if (!arr.length) return 0;
    const f = {};
    for (const v of arr) f[v] = (f[v] || 0) + 1;
    let e = 0;
    for (const k in f) { const p = f[k] / arr.length; e -= p * Math.log2(p); }
    return e;
}
function similarity(a, b) {
    if (a.length !== b.length) return 0;
    let m = 0;
    for (let i = 0; i < a.length; i++) if (a[i] === b[i]) m++;
    return m / a.length;
}

// =====================================================================
// PARSE API
// =====================================================================
function parseLines(data) {
    if (!Array.isArray(data)) return [];
    return data.map(item => {
        const session = Number(item.phien ?? 0);
        const dice = Array.isArray(item.xuc_xac) ? item.xuc_xac : [];
        const total = Number(item.Tong ?? item.tong ?? 0);
        const result = item.ket_qua ?? (total >= 11 ? 'Tài' : 'Xỉu');
        const tx = result === 'Tài' ? 'T' : 'X';
        return { session, dice, total, result, tx };
    }).filter(r => r.session > 0).sort((a, b) => a.session - b.session);
}

// =====================================================================
// FEATURE EXTRACTION
// =====================================================================
function extractFeatures(history) {
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);
    const runs = [];
    let cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push({ val: cur, len }); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push({ val: cur, len });

    return {
        tx, totals, runs,
        maxRun: runs.reduce((m, r) => Math.max(m, r.len), 0),
        avgRunLength: avg(runs.map(r => r.len)),
        meanTotal: avg(totals),
        volatility: stdDev(totals),
        entropy: entropy(tx),
        lastRun: runs[runs.length - 1],
        mean5: avg(totals.slice(-5)),
        mean20: avg(totals.slice(-20))
    };
}

// =====================================================================
// HỌC PATTERN TỪ LỊCH SỬ API
// =====================================================================
function learnPatternsFromHistory(history) {
    if (history.length < 20) return {};
    const tx = history.map(h => h.tx);
    const learned = {};
    for (let len = 3; len <= Math.min(12, tx.length - 1); len++) {
        for (let i = 0; i <= tx.length - len - 1; i++) {
            const seq = tx.slice(i, i + len).join('');
            const next = tx[i + len];
            if (!learned[seq]) learned[seq] = { T: 0, X: 0, len };
            learned[seq][next]++;
        }
    }
    return learned;
}

function updateLearnedPatterns(history, newTx) {
    const tx = history.map(h => h.tx);
    const maxLen = Math.min(12, tx.length);
    for (let len = 3; len <= maxLen; len++) {
        const seq = tx.slice(-len).join('');
        if (!LEARNED_PATTERNS[seq]) LEARNED_PATTERNS[seq] = { T: 0, X: 0, len };
        LEARNED_PATTERNS[seq][newTx]++;
    }
}

// =====================================================================
// STATS TỪ LỊCH SỬ API
// =====================================================================
function computeStatsFromData(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    const totals = history.map(h => h.total);

    const runs = [];
    let cur = tx[0], len = 1;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i] === cur) len++;
        else { runs.push(len); cur = tx[i]; len = 1; }
    }
    if (tx.length) runs.push(len);

    const breakProbs = {};
    for (let L = 1; L <= 12; L++) {
        let broke = 0, total = 0, s = 1;
        for (let i = 1; i < tx.length; i++) {
            if (tx[i] === tx[i - 1]) s++;
            else { if (s >= L) { total++; if (s === L) broke++; } s = 1; }
        }
        if (s >= L) total++;
        if (total >= 5) breakProbs[L] = broke / total;
    }

    let tToX = 0, tTot = 0, xToT = 0, xTot = 0;
    for (let i = 1; i < tx.length; i++) {
        if (tx[i - 1] === 'T') { tTot++; if (tx[i] === 'X') tToX++; }
        else { xTot++; if (tx[i] === 'T') xToT++; }
    }

    return {
        sampleSize: history.length,
        tRatio: tx.filter(x => x === 'T').length / tx.length,
        avgScore: avg(totals),
        breakProbs,
        markovTtoX: tTot > 0 ? tToX / tTot : 0.5,
        markovXtoT: xTot > 0 ? xToT / xTot : 0.5
    };
}
// =====================================================================
// NHÓM W/X/Y/Z — LEARNED PATTERNS
// =====================================================================
function algoW_LearnedExact(history) {
    if (Object.keys(LEARNED_PATTERNS).length < 50 || history.length < 8) return null;
    const tx = history.map(h => h.tx);
    for (const len of [12, 11, 10, 9, 8, 7, 6, 5]) {
        if (tx.length < len) continue;
        const target = tx.slice(-len).join('');
        const f = LEARNED_PATTERNS[target];
        if (f && (f.T + f.X) >= 2) {
            const total = f.T + f.X;
            const conf = Math.abs(f.T - f.X) / total;
            const adj = conf * Math.min(1, total / 5) * (len / 12);
            if (adj >= 0.35) return f.T > f.X ? 'T' : 'X';
        }
    }
    return null;
}

function algoX_LearnedFuzzy(history) {
    if (Object.keys(LEARNED_PATTERNS).length < 100 || history.length < 12) return null;
    const target = history.map(h => h.tx).slice(-12).join('');
    let wT = 0, wX = 0, matches = 0;
    for (const seq in LEARNED_PATTERNS) {
        if (seq.length !== 12) continue;
        const sim = similarity(seq, target);
        if (sim >= 0.75) {
            const p = LEARNED_PATTERNS[seq];
            const w = (sim ** 3) * Math.min(2, p.T + p.X);
            wT += w * p.T; wX += w * p.X; matches++;
        }
    }
    if (matches < 5) return null;
    const total = wT + wX;
    if (!total) return null;
    if (Math.abs(wT - wX) / total >= 0.15) return wT > wX ? 'T' : 'X';
    return null;
}

function algoY_LearnedSuffix(history) {
    if (Object.keys(LEARNED_PATTERNS).length < 50 || history.length < 5) return null;
    const tx = history.map(h => h.tx);
    let bestPred = null, bestScore = 0;
    for (const L of [7, 6, 5, 4]) {
        if (tx.length < L) continue;
        const suffix = tx.slice(-L).join('');
        let tC = 0, xC = 0, total = 0;
        for (const seq in LEARNED_PATTERNS) {
            if (seq.endsWith(suffix)) {
                const p = LEARNED_PATTERNS[seq];
                tC += p.T; xC += p.X; total += p.T + p.X;
            }
        }
        if (total < 3) continue;
        const conf = Math.abs(tC - xC) / total;
        const score = conf * Math.min(1, total / 15) * (L / 7);
        if (score > bestScore && conf >= 0.35) {
            bestScore = score; bestPred = tC > xC ? 'T' : 'X';
        }
    }
    return bestPred;
}

function algoZ_AdaptiveMarkov(history) {
    if (history.length < 40) return null;
    const tx = history.map(h => h.tx);
    const scores = {};
    for (const order of [2, 3, 4, 5]) {
        if (tx.length < order + 30) continue;
        let correct = 0, total = 0;
        for (let i = tx.length - 30; i < tx.length; i++) {
            if (i < order + 5) continue;
            const key = tx.slice(i - order, i).join('');
            let tC = 0, xC = 0;
            for (let j = 0; j < i - 1; j++) {
                if (tx.slice(j, j + order).join('') === key) {
                    if (tx[j + order] === 'T') tC++; else xC++;
                }
            }
            if (tC + xC >= 2) {
                if ((tC > xC ? 'T' : 'X') === tx[i]) correct++;
                total++;
            }
        }
        if (total >= 5) scores[order] = correct / total;
    }
    let bestOrder = 3, bestAcc = 0;
    for (const o in scores) if (scores[o] > bestAcc) { bestAcc = scores[o]; bestOrder = +o; }
    if (bestAcc < 0.55) return null;
    const key = tx.slice(-bestOrder).join('');
    let tC = 0, xC = 0;
    for (let j = 0; j < tx.length - bestOrder; j++) {
        if (tx.slice(j, j + bestOrder).join('') === key) {
            if (tx[j + bestOrder] === 'T') tC++; else xC++;
        }
    }
    if (tC + xC < 3) return null;
    if (Math.abs(tC - xC) / (tC + xC) >= 0.2) return tC > xC ? 'T' : 'X';
    return null;
}

// =====================================================================
// NHÓM AA/AB/AC/AD/AE/AF — SPECIAL PATTERNS (tần suất cao)
// =====================================================================
function algoAA_StreakFlip(history) {
    if (history.length < 10) return null;
    const last = extractFeatures(history).lastRun;
    if (!last) return null;
    const prob = STREAK_FLIP_PROB[last.len];
    if (prob === undefined) return null;
    if (prob >= 0.60) return last.val === 'T' ? 'X' : 'T';
    if (prob <= 0.45) return last.val;
    return null;
}

function algoAB_SpecialTxPattern(history) {
    if (history.length < 8) return null;
    const tx = history.map(h => h.tx).join('');
    let best = null, bestScore = 0;
    for (const p of SPECIAL_TX_PATTERNS) {
        if (tx.endsWith(p.seq)) {
            // Score = conf × log(count) — ưu tiên mẫu nhiều lần xuất hiện
            const score = p.conf * Math.log10(p.count + 1);
            if (score > bestScore) {
                bestScore = score;
                best = p.next;
            }
        }
    }
    return best;
}

function algoAC_SpecialRunPattern(history) {
    if (history.length < 10) return null;
    const f = extractFeatures(history);
    if (f.runs.length < 3) return null;
    const runStr = f.runs.map(r => r.len).join('-');
    const lastVal = f.runs[f.runs.length - 1].val;

    // Chỉ khớp pattern có count ≥30 (đủ tin cậy)
    for (const p of SPECIAL_RUN_PATTERNS) {
        if (runStr.endsWith(p.seq) && p.count >= 30) {
            return p.flip ? (lastVal === 'T' ? 'X' : 'T') : lastVal;
        }
    }
    return null;
}

// AD: Consensus mạnh — chỉ vote khi ≥3 thuật toán mạnh đồng thuận
function algoAD_ConsensusStrong(history) {
    if (history.length < 15) return null;
    const strongFns = [algoAA_StreakFlip, algoAB_SpecialTxPattern, algoAC_SpecialRunPattern,
                       algoW_LearnedExact, algoQ_BreakProbability];
    const votes = { T: 0, X: 0 };
    for (const fn of strongFns) {
        try {
            const p = fn(history);
            if (p) votes[p]++;
        } catch (e) { /* skip */ }
    }
    const total = votes.T + votes.X;
    if (total < 3) return null;
    if (votes.T >= 3 && votes.T > votes.X) return 'T';
    if (votes.X >= 3 && votes.X > votes.T) return 'X';
    return null;
}

// AE: Cycle detection — CHỈ phát hiện chu kỳ 2 (cầu 1-1)
// Chu kỳ 3, 4 quá hiếm (<10 mẫu) → loại bỏ
function algoAE_CycleDetect(history) {
    if (history.length < 12) return null;
    const tx = history.map(h => h.tx);
    const last12 = tx.slice(-12);

    const cycleLen = 2;
    const pattern = last12.slice(-cycleLen).join('');
    let matches = 0, mismatches = 0;
    for (let i = last12.length - cycleLen; i >= cycleLen; i -= cycleLen) {
        const seg = last12.slice(i - cycleLen, i).join('');
        if (seg === pattern) matches++;
        else mismatches++;
    }
    // Chu kỳ 2 lặp ≥3 lần liên tiếp và không đứt
    if (matches >= 3 && mismatches === 0) {
        const nextIdx = last12.length % cycleLen;
        const nextVal = pattern[nextIdx];
        // Cầu 1-1 kéo dài ≥6 (3 chu kỳ) → sắp gãy → đảo
        if (last12.length >= 6) return nextVal === 'T' ? 'X' : 'T';
        return nextVal;
    }
    return null;
}

// AF: Break boost — kết hợp breakProb + streak + mean
function algoAF_BreakBoost(history) {
    if (history.length < 15) return null;
    const f = extractFeatures(history);
    const last = f.lastRun;
    if (!last) return null;
    let bp = null;
    if (STATS_FROM_DATA?.breakProbs) {
        const learned = STATS_FROM_DATA.breakProbs[Math.min(last.len, 12)];
        if (learned !== undefined) bp = learned;
    }
    if (bp === null) bp = BREAK_PROB[Math.min(last.len, 12)] || 0.99;

    if (bp >= 0.75) {
        const flip = last.val === 'T' ? 'X' : 'T';
        if (flip === 'X' && f.mean5 > 11) return 'X';
        if (flip === 'T' && f.mean5 < 10) return 'T';
        return flip;
    }
    if (bp < 0.45 && last.len <= 2) return last.val;
    return null;
}
// =====================================================================
// NHÓM FOLLOW / REVERSE / NEUTRAL
// =====================================================================
function algoA_Markov(history) {
    if (history.length < 15) return null;
    const tx = history.map(h => h.tx);
    const maxOrder = history.length < 30 ? 3 : 5;
    let bestPred = null, bestScore = -1;
    for (let order = 2; order <= maxOrder; order++) {
        if (tx.length < order + 8) continue;
        const trans = {};
        const totalT = tx.length - order;
        for (let i = 0; i < totalT; i++) {
            const key = tx.slice(i, i + order).join('');
            const w = Math.pow(0.95, totalT - i - 1);
            if (!trans[key]) trans[key] = { T: 0, X: 0 };
            trans[key][tx[i + order]] += w;
        }
        const c = trans[tx.slice(-order).join('')];
        if (c && (c.T + c.X) > 0.5) {
            const conf = Math.abs(c.T - c.X) / (c.T + c.X);
            const score = conf * (order / maxOrder) * Math.min(1, (c.T + c.X) / 10);
            if (score > bestScore) { bestScore = score; bestPred = c.T > c.X ? 'T' : 'X'; }
        }
    }
    return bestPred;
}

function algoB_Ngram(history) {
    if (history.length < 30) return null;
    const tx = history.map(h => h.tx);
    let bestPred = null, bestConf = 0;
    for (const n of [7, 6, 5, 4, 3]) {
        if (tx.length < n * 2) continue;
        const target = tx.slice(-n).join('');
        const matches = [];
        for (let i = 0; i <= tx.length - n - 1; i++) {
            if (tx.slice(i, i + n).join('') === target) {
                matches.push({ next: tx[i + n], dist: tx.length - i });
            }
        }
        if (matches.length >= 2) {
            let wT = 0, wX = 0, tw = 0;
            for (const m of matches) {
                const wt = 1 / (m.dist * 0.5 + 1);
                if (m.next === 'T') wT += wt; else wX += wt;
                tw += wt;
            }
            if (tw > 0) {
                const conf = Math.abs(wT - wX) / tw;
                if (conf > bestConf) { bestConf = conf; bestPred = wT > wX ? 'T' : 'X'; }
            }
        }
    }
    return bestConf > 0.3 ? bestPred : null;
}

function algoG_SuperBridge(history) {
    const f = extractFeatures(history);
    if (f.runs.length < 4) return null;
    const last = f.runs[f.runs.length - 1];
    const avgRun = avg(f.runs.map(r => r.len));
    if (last.len >= 10) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 8) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 7 && last.len > avgRun * 2) return last.val === 'T' ? 'X' : 'T';
    if (last.len >= 5 && last.len > avgRun * 1.8) return last.val === 'T' ? 'X' : 'T';
    return null;
}

function algoH_AdaptiveMarkov(history) {
    if (history.length < 25) return null;
    const tx = history.map(h => h.tx);
    const votes = { T: 0, X: 0 };
    for (const order of [2, 3, 4, 5]) {
        if (tx.length < order + 5) continue;
        const trans = {};
        for (let i = 0; i <= tx.length - order - 1; i++) {
            const key = tx.slice(i, i + order).join('');
            if (!trans[key]) trans[key] = { T: 0, X: 0 };
            trans[key][tx[i + order]]++;
        }
        const c = trans[tx.slice(-order).join('')];
        if (c && c.T + c.X >= 2) {
            const conf = Math.abs(c.T - c.X) / (c.T + c.X);
            votes[c.T > c.X ? 'T' : 'X'] += conf * (order / 10);
        }
    }
    return (votes.T + votes.X) > 0.3 ? (votes.T > votes.X ? 'T' : 'X') : null;
}

function algoI_PatternMaster(history) {
    if (history.length < 25) return null;
    const f = extractFeatures(history);
    if (f.runs.length < 5) return null;
    const recent = f.runs.slice(-8);
    const runPattern = recent.map(r => r.len).join('');
    const lastVal = recent[recent.length - 1].val;
    const strength = { T: 0, X: 0 };

    const runLib = [
        { p: '12121', pred: lastVal === 'T' ? 'X' : 'T', s: 0.72 },
        { p: '21212', pred: lastVal === 'T' ? 'T' : 'X', s: 0.72 },
        { p: '121212', pred: lastVal === 'T' ? 'X' : 'T', s: 0.78 },
        { p: '212121', pred: lastVal === 'T' ? 'T' : 'X', s: 0.78 }
    ];
    for (const l of runLib) if (runPattern.includes(l.p)) strength[l.pred] += l.s;

    const last10 = f.tx.slice(-10).join('');
    const txLib = [
        { p: 'TXTXTXTX', pred: 'X', s: 0.82 },
        { p: 'XTXTXTXT', pred: 'T', s: 0.82 },
        { p: 'TTXXTTXX', pred: 'X', s: 0.72 },
        { p: 'XXTTXXTT', pred: 'T', s: 0.72 }
    ];
    for (const p of txLib) if (last10.includes(p.p)) strength[p.pred] += p.s;

    const total = strength.T + strength.X;
    if (total > 0 && Math.abs(strength.T - strength.X) / total > 0.25) {
        return strength.T > strength.X ? 'T' : 'X';
    }
    return null;
}

function algoQ_BreakProbability(history) {
    if (history.length < 15) return null;
    const last = extractFeatures(history).lastRun;
    if (!last) return null;
    let bp = null;
    if (STATS_FROM_DATA?.breakProbs) {
        const learned = STATS_FROM_DATA.breakProbs[Math.min(last.len, 12)];
        if (learned !== undefined) bp = learned;
    }
    if (bp === null) bp = BREAK_PROB[Math.min(last.len, 12)] || 0.99;
    if (bp > 0.6) return last.val === 'T' ? 'X' : 'T';
    if (bp < 0.4) return last.val;
    return null;
}

function algoN_Transition(history) {
    if (history.length < 30) return null;
    const recent = history.map(h => h.tx).slice(-50);
    const t = { TT: 0, TX: 0, XT: 0, XX: 0 };
    for (let i = 1; i < recent.length; i++) t[recent[i - 1] + recent[i]]++;
    const last = recent[recent.length - 1];
    const tot = last === 'T' ? t.TT + t.TX : t.XT + t.XX;
    if (tot < 5) return null;
    const flip = last === 'T' ? t.TX / tot : t.XT / tot;
    if (flip > 0.55) return last === 'T' ? 'X' : 'T';
    if (flip < 0.45) return last;
    return null;
}

function algoL_Momentum(history) {
    if (history.length < 30) return null;
    const f = extractFeatures(history);
    const last = f.lastRun;
    if (last) {
        const key = last.val + last.len;
        const expected = AVG_SCORE_AFTER_STREAK[key];
        if (expected !== undefined && f.mean5 > 0) {
            if (expected < 10.5 && f.mean5 > 12.5) return 'X';
            if (expected > 10.5 && f.mean5 < 8.5) return 'T';
        }
    }
    const totals = history.map(h => h.total);
    const m5 = avg(totals.slice(-5));
    const m20 = avg(totals.slice(-20));
    if (m5 > 12.5) return 'X';
    if (m5 < 8.5) return 'T';
    if (m5 > m20 + 2) return 'X';
    if (m5 < m20 - 2) return 'T';
    return null;
}

// =====================================================================
// DANH SÁCH THUẬT TOÁN v13 (18 thuật toán)
// =====================================================================
const ALL_ALGS = [
    // Special — mạnh nhất
    { id: 'AA_streak_flip',    fn: algoAA_StreakFlip,        group: 'special', baseWeight: 4.0 },
    { id: 'AB_special_tx',     fn: algoAB_SpecialTxPattern,  group: 'special', baseWeight: 3.8 },
    { id: 'AC_special_run',    fn: algoAC_SpecialRunPattern, group: 'special', baseWeight: 3.5 },
    { id: 'AD_consensus',      fn: algoAD_ConsensusStrong,   group: 'special', baseWeight: 4.5 },
    { id: 'AE_cycle',          fn: algoAE_CycleDetect,       group: 'special', baseWeight: 3.2 },
    { id: 'AF_break_boost',    fn: algoAF_BreakBoost,        group: 'special', baseWeight: 3.6 },

    // Learned
    { id: 'W_learned_exact',   fn: algoW_LearnedExact,   group: 'learned', baseWeight: 3.5 },
    { id: 'X_learned_fuzzy',   fn: algoX_LearnedFuzzy,   group: 'learned', baseWeight: 3.0 },
    { id: 'Y_learned_suffix',  fn: algoY_LearnedSuffix,  group: 'learned', baseWeight: 2.5 },
    { id: 'Z_adaptive_markov', fn: algoZ_AdaptiveMarkov, group: 'learned', baseWeight: 2.0 },

    // Follow
    { id: 'A_markov',          fn: algoA_Markov,         group: 'follow',  baseWeight: 1.5 },
    { id: 'B_ngram',           fn: algoB_Ngram,          group: 'follow',  baseWeight: 1.5 },
    { id: 'I_pattern_master',  fn: algoI_PatternMaster,  group: 'follow',  baseWeight: 1.8 },
    { id: 'H_adaptive_markov', fn: algoH_AdaptiveMarkov, group: 'follow',  baseWeight: 1.2 },

    // Reverse
    { id: 'G_super_bridge',    fn: algoG_SuperBridge,      group: 'reverse', baseWeight: 2.0 },
    { id: 'Q_break_prob',      fn: algoQ_BreakProbability, group: 'reverse', baseWeight: 2.5 },
    { id: 'L_momentum',        fn: algoL_Momentum,         group: 'reverse', baseWeight: 1.2 },

    // Neutral
    { id: 'N_transition',      fn: algoN_Transition,     group: 'neutral', baseWeight: 1.0 }
];

// =====================================================================
// ENSEMBLE v13 — Consensus Override + Confidence Filter
// =====================================================================
class Ensemble {
    constructor() {
        this.weights = {};
        this.perAlgoStats = {};
        this.recentPreds = [];
        this.recentActuals = [];
        this.recentPerAlgo = {};
        for (const a of ALL_ALGS) {
            this.weights[a.id] = a.baseWeight;
            this.perAlgoStats[a.id] = { correct: 0, total: 0 };
            this.recentPerAlgo[a.id] = [];
        }
        this._normalize();
    }
    _normalize() {
        const total = Object.values(this.weights).reduce((s, w) => s + w, 0);
        if (total > 0) for (const id in this.weights) this.weights[id] /= total;
    }
    updateWeights(historyPrefix, actualTx) {
        for (const a of ALL_ALGS) {
            try {
                const pred = a.fn(historyPrefix);
                if (!pred) continue;
                const correct = pred === actualTx;
                this.perAlgoStats[a.id].total++;
                if (correct) this.perAlgoStats[a.id].correct++;

                this.recentPerAlgo[a.id].push(correct ? 1 : 0);
                if (this.recentPerAlgo[a.id].length > 20) this.recentPerAlgo[a.id].shift();

                let lr = 0.02;
                if (a.group === 'special') lr = 0.10;
                else if (a.group === 'learned') lr = 0.08;
                else if (a.group === 'reverse') lr = 0.04;
                else if (a.group === 'follow') lr = 0.03;

                const w = this.weights[a.id];
                this.weights[a.id] = Math.max(0.005, Math.min(5, correct ? w * (1 + lr) : w * (1 - lr)));
            } catch (e) { /* skip */ }
        }
        this._normalize();
    }
    rebalance() {
        for (const a of ALL_ALGS) {
            const s = this.perAlgoStats[a.id];
            if (s.total < 10) continue;
            const wr = s.correct / s.total;
            let mult = 1 + (wr - 0.5) * 1.5;
            if (wr < 0.40) mult = 0.4;
            else if (wr < 0.45) mult = 0.7;
            else if (wr > 0.60) mult = 1.8;
            this.weights[a.id] *= Math.max(0.5, Math.min(2, mult));
            this.weights[a.id] = Math.max(0.005, Math.min(5, this.weights[a.id]));
        }
        this._normalize();
    }
    predict(history) {
        if (history.length < 12) {
            const t = history.filter(h => h.tx === 'T').length;
            const x = history.length - t;
            return { prediction: t > x ? 'X' : 'T', confidence: 0.5, details: [], skip: true, reason: 'Chưa đủ dữ liệu' };
        }
        const votes = { T: 0, X: 0 };
        const details = [];
        for (const a of ALL_ALGS) {
            try {
                const pred = a.fn(history);
                if (!pred) continue;
                const recent = this.recentPerAlgo[a.id];
                let boost = 1.0;
                if (recent.length >= 5) {
                    const recentWr = recent.reduce((s, v) => s + v, 0) / recent.length;
                    if (recentWr > 0.7) boost = 1.3;
                    else if (recentWr < 0.3) boost = 0.6;
                }
                const w = this.weights[a.id] * boost;
                votes[pred] += w;
                details.push({ algo: a.id, pred, w: +w.toFixed(4), group: a.group });
            } catch (e) { /* skip */ }
        }
        const total = votes.T + votes.X;
        if (total === 0) return { prediction: 'T', confidence: 0.5, details, skip: true, reason: 'Không thuật toán nào vote' };
        const best = votes.T > votes.X ? 'T' : 'X';
        let confidence = Math.min(0.95, Math.max(0.55, Math.max(votes.T, votes.X) / total));

        // Anti-momentum
        const last4 = this.recentPreds.slice(-4);
        if (last4.length === 4 && last4.every(p => p === best)) {
            const actuals = this.recentActuals.slice(-4);
            const wrong = last4.filter((p, i) => p !== actuals[i]).length;
            if (wrong >= 3) {
                return { prediction: best === 'T' ? 'X' : 'T', confidence: 0.6, details, skip: false, reason: 'Anti-momentum override' };
            }
        }

        // Filter: cầu 1-1 kéo dài → giảm confidence
        const f = extractFeatures(history);
        const last = f.lastRun;
        let skip = false, reason = null;
        if (last && last.len === 1) {
            const tx6 = f.tx.slice(-6).join('');
            if (tx6 === 'TXTXTX' || tx6 === 'XTXTXT') {
                confidence = Math.min(confidence, 0.55);
                reason = 'Cầu 1-1 kéo dài — confidence thấp';
            }
        }

        // Boost nếu cầu ≥5 và confidence cao
        if (last && last.len >= 5 && confidence > 0.70) {
            confidence = Math.min(0.95, confidence * 1.1);
        }

        return { prediction: best, confidence, details, skip, reason };
    }
    recordActual(tx) {
        this.recentActuals.push(tx);
        if (this.recentActuals.length > 20) this.recentActuals.shift();
    }
    recordPrediction(tx) {
        this.recentPreds.push(tx);
        if (this.recentPreds.length > 20) this.recentPreds.shift();
    }
}

// =====================================================================
// MANAGER
// =====================================================================
class PatternManager {
    constructor() {
        this.history = [];
        this.ensemble = new Ensemble();
        this.currentPrediction = null;
        this.sinceRebalance = 0;
        this.predictionLog = {};
    }
    init(history) {
        this.history = [...history];
        LEARNED_PATTERNS = learnPatternsFromHistory(this.history);
        STATS_FROM_DATA = computeStatsFromData(this.history);
        this.currentPrediction = this.ensemble.predict(this.history);
        console.log(`🧠 Học ${Object.keys(LEARNED_PATTERNS).length} mẫu từ ${this.history.length} phiên API`);
        console.log(`🔮 Dự đoán ${this.history.at(-1).session + 1}: ${this.currentPrediction.prediction}`);
    }
    push(record) {
        if (this.currentPrediction) {
            this.predictionLog[record.session] = {
                pred: this.currentPrediction.prediction,
                conf: this.currentPrediction.confidence
            };
            this.ensemble.recordPrediction(this.currentPrediction.prediction);
        }
        this.ensemble.recordActual(record.tx);
        const prefix = this.history.slice();
        if (prefix.length >= 10) this.ensemble.updateWeights(prefix, record.tx);
        updateLearnedPatterns(this.history, record.tx);
        this.history.push(record);
        if (this.history.length > 500) this.history = this.history.slice(-450);

        this.sinceRebalance++;
        if (this.sinceRebalance >= 20) {
            this.ensemble.rebalance();
            this.sinceRebalance = 0;
            STATS_FROM_DATA = computeStatsFromData(this.history);
        }
        this.currentPrediction = this.ensemble.predict(this.history);
    }
}

const manager = new PatternManager();
// =====================================================================
// FETCH API
// =====================================================================
async function fetchAndProcessHistory() {
    try {
        const res = await fetch(API_URL);
        const data = await res.json();
        const newHistory = parseLines(data);
        if (newHistory.length === 0) return;

        const last = newHistory.at(-1);
        if (!currentSessionId) {
            manager.init(newHistory);
            txHistory = newHistory;
            currentSessionId = last.session;
            console.log(`✅ Đã tải ${newHistory.length} phiên API`);
        } else if (last.session > currentSessionId) {
            const newRecords = newHistory.filter(r => r.session > currentSessionId);
            for (const r of newRecords) {
                manager.push(r);
                txHistory.push(r);
            }
            if (txHistory.length > 350) txHistory = txHistory.slice(-300);
            currentSessionId = last.session;
            if (newRecords.length > 0) console.log(`🆕 +${newRecords.length} phiên → ${currentSessionId}`);
        }
    } catch (e) {
        console.error("❌ Lỗi fetch:", e.message);
    }
}

// =====================================================================
// FASTIFY SERVER
// =====================================================================
const app = fastify({ logger: true });
await app.register(cors, { origin: "*" });

// Serve dashboard.html tĩnh (nếu có file trong thư mục)
try {
    await app.register(fastifyStatic, {
        root: path.join(__dirname),
        prefix: "/",
        decorateReply: false
    });
} catch (e) {
    console.warn("⚠️  Không serve static — dashboard.html chưa có?");
}

// ---------------------------------------------------------------------
// API: Dự đoán phiên tiếp theo
// ---------------------------------------------------------------------
app.get("/api/sunwin/tx", async () => {
    const last = txHistory.at(-1);
    const p = manager.currentPrediction;
    if (!last || !p) return {
        id: "@cskhgiabao", phien_truoc: null, xuc_xac: null,
        ket_qua: "đang chờ...", phien_nay: null, du_doan: "chưa có", do_tin_cay: "0%"
    };
    return {
        id: "@cskhgiabao",
        phien_truoc: last.session,
        xuc_xac: last.dice,
        ket_qua: last.result.toLowerCase(),
        phien_nay: last.session + 1,
        du_doan: p.prediction === 'T' ? 'tài' : 'xỉu',
        do_tin_cay: `${(p.confidence * 100).toFixed(0)}%`,
        nen_danh: !p.skip,
        ly_do: p.reason || null,
        learned_patterns: Object.keys(LEARNED_PATTERNS).length
    };
});

// ---------------------------------------------------------------------
// API: Lịch sử + nhận xét
// ---------------------------------------------------------------------
app.get("/api/sunwin/history", async () => {
    if (!txHistory.length) return { message: "chưa có dữ liệu" };
    return [...txHistory].sort((a, b) => b.session - a.session).map(item => {
        const log = manager.predictionLog[item.session];
        let nhan_xet = "—";
        if (log) {
            const dung = log.pred === item.tx;
            nhan_xet = dung
                ? `✅ Đúng (${log.pred === 'T' ? 'tài' : 'xỉu'} ${(log.conf * 100).toFixed(0)}%)`
                : `❌ Sai (${log.pred === 'T' ? 'tài' : 'xỉu'} ${(log.conf * 100).toFixed(0)}%)`;
        }
        return {
            session: item.session, dice: item.dice, total: item.total,
            result: item.result.toLowerCase(), tx_label: item.tx.toLowerCase(), nhan_xet
        };
    });
});

// ---------------------------------------------------------------------
// API: Thống kê thuật toán
// ---------------------------------------------------------------------
app.get("/api/balance/stats", async () => {
    const algoPerf = {};
    for (const a of ALL_ALGS) {
        const s = manager.ensemble.perAlgoStats[a.id];
        algoPerf[a.id] = {
            group: a.group,
            weight: +manager.ensemble.weights[a.id].toFixed(4),
            correct: s.correct, total: s.total,
            winrate: s.total > 0 ? +(s.correct / s.total * 100).toFixed(1) : null
        };
    }
    return {
        learned_patterns: { total: Object.keys(LEARNED_PATTERNS).length, sample_size: manager.history.length },
        stats: STATS_FROM_DATA,
        algorithms: algoPerf
    };
});

// ---------------------------------------------------------------------
// API: Chi tiết dự đoán (debug)
// ---------------------------------------------------------------------
app.get("/api/predict", async () => {
    const p = manager.currentPrediction;
    if (!p) return { message: "chưa có dự đoán" };
    return {
        prediction: p.prediction === 'T' ? 'tài' : 'xỉu',
        confidence: +(p.confidence * 100).toFixed(1),
        should_bet: !p.skip,
        reason: p.reason,
        votes: p.details,
        total_votes: p.details.length
    };
});

// ---------------------------------------------------------------------
// API: Summary tổng hợp (cho dashboard)
// ---------------------------------------------------------------------
app.get("/api/summary", async () => {
    const rev = [...txHistory].sort((a, b) => b.session - a.session);
    let total = 0, correct = 0;
    for (const it of rev) {
        const log = manager.predictionLog[it.session];
        if (log) { total++; if (log.pred === it.tx) correct++; }
    }
    const last = txHistory.at(-1);
    const p = manager.currentPrediction;
    return {
        next_session: last ? last.session + 1 : null,
        prediction: p ? (p.prediction === 'T' ? 'tài' : 'xỉu') : null,
        confidence: p ? +(p.confidence * 100).toFixed(1) : 0,
        should_bet: p ? !p.skip : false,
        reason: p?.reason || null,
        accuracy: {
            total, correct,
            wrong: total - correct,
            percent: total > 0 ? +(correct / total * 100).toFixed(1) : 0
        },
        learned_patterns: Object.keys(LEARNED_PATTERNS).length,
        history_size: manager.history.length,
        algorithms_count: ALL_ALGS.length
    };
});

// ---------------------------------------------------------------------
// Root info
// ---------------------------------------------------------------------
app.get("/", async () => ({
    status: "ok", msg: "AI Tài Xỉu Sunwin v13 - Self-Contained",
    version: "13.0",
    algorithms: ALL_ALGS.length,
    learned: Object.keys(LEARNED_PATTERNS).length,
    endpoints: [
        "/api/sunwin/tx",
        "/api/sunwin/history",
        "/api/balance/stats",
        "/api/predict",
        "/api/summary",
        "/dashboard.html"
    ]
}));

// =====================================================================
// START
// =====================================================================
const start = async () => {
    try {
        await app.listen({ port: PORT, host: "0.0.0.0" });
    } catch (err) {
        console.error(err);
        process.exit(1);
    }

    fetchAndProcessHistory();
    clearInterval(fetchInterval);
    fetchInterval = setInterval(fetchAndProcessHistory, 5000);

    console.log(`\n🚀 AI Tài Xỉu Sunwin v13 - Self-Contained`);
    console.log(`   ➜ http://localhost:${PORT}/`);
    console.log(`   ➜ ${ALL_ALGS.length} thuật toán (không đọc .txt)`);
    console.log(`   ➜ Dashboard: /dashboard.html (tạo riêng)\n`);
};

start();