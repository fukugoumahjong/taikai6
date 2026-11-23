import 'server-only';
import { HttpError } from './authz';

// ---- 汎用 ----
// 選手IDは UUID を想定しているが、旧データの形式差を考えて「英数字・_・-」の64文字まで許可する（SQL インジェクション等の余地を残さない範囲）
export const UUID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export function asId(v: unknown, label = 'id'): string {
  if (typeof v !== 'string' || !UUID_RE.test(v)) throw new HttpError(400, `${label} が不正です`);
  return v;
}
export function asText(v: unknown, label: string, min = 1, max = 100): string {
  if (typeof v !== 'string') throw new HttpError(400, `${label} が不正です`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new HttpError(400, `${label} は${min}〜${max}文字で入力してください`);
  return s;
}
export function asNum(v: unknown, label: string, min: number, max: number, integer = false): number {
  const n = typeof v === 'number' ? v : NaN;
  if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) {
    throw new HttpError(400, `${label} が不正です（${min}〜${max}${integer ? ' の整数' : ''}）`);
  }
  return n;
}
export const asBool = (v: unknown, label: string): boolean => {
  if (typeof v !== 'boolean') throw new HttpError(400, `${label} が不正です`);
  return v;
};
export const round1 = (n: number) => Math.round(n * 10) / 10;

// ---- 卓・得点（クライアントの計算結果は信用せず、サーバーで再計算する） ----
// ルール: 持ち点30000・返し30000（100点単位で300）・順位点 +30/+10/-10/-30（最高位戦ルール）
export const RULE = { returnPoint: 300, uma: [30, 10, -10, -30], total: 1200 } as const;
export const CHONBO_PENALTY = 20;

export type ScoreInput = { playerId: string; score: number; chonbo: number };

export function asScoreInputs(v: unknown): ScoreInput[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 4) throw new HttpError(400, 'players が不正です');
  const seen = new Set<string>();
  return v.map((p: any) => {
    const playerId = asId(p?.playerId, 'playerId');
    if (seen.has(playerId)) throw new HttpError(400, '同じ選手が重複しています');
    seen.add(playerId);
    return {
      playerId,
      score: asNum(p?.score, 'score', -3000, 3000, true),   // 100点単位（±300,000点まで）
      chonbo: asNum(p?.chonbo ?? 0, 'chonbo', 0, 10, true),
    };
  });
}

// クライアントの calculateTablePoints と同じ計算（供託・不足分はトップへ、同点は順位点を等分、チョンボは減算）
export function computeTablePoints(inputs: ScoreInput[]): number[] {
  const sum = inputs.reduce((a, p) => a + p.score, 0);
  const diff = RULE.total - sum;
  if (diff < 0) throw new HttpError(400, '得点の合計が120,000点を超えています');
  if (diff % 10 !== 0) throw new HttpError(400, '不足分が1,000点単位ではありません');

  const sorted = inputs.map((p, index) => ({ score: p.score, index })).sort((a, b) => b.score - a.score);
  const topScore = sorted[0].score;
  const topTied = sorted.filter(p => p.score === topScore).length;
  const out: number[] = new Array(inputs.length).fill(0);

  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
    let umaSum = 0;
    for (let k = i; k < j; k++) umaSum += RULE.uma[k] ?? 0;
    const splitUma = umaSum / (j - i);
    for (let k = i; k < j; k++) {
      const it = sorted[k];
      let pt = (it.score - RULE.returnPoint) / 10 + splitUma;
      if (it.score === topScore) pt += diff / 10 / topTied;
      pt -= CHONBO_PENALTY * inputs[it.index].chonbo;
      out[it.index] = round1(pt);
    }
    i = j;
  }
  return out;
}

// ---- 大会データ（管理者が保存するブロブ）の整形・検証 ----
const num = (v: any, d = 0) => (Number.isFinite(Number(v)) ? Number(v) : d);

export function sanitizeSeating(raw: unknown): any[] {
  if (!Array.isArray(raw) || raw.length > 30) throw new HttpError(400, 'seating が不正です');
  return raw.map((r: any) => {
    const tables = Array.isArray(r?.tables) ? r.tables : [];
    if (tables.length > 40) throw new HttpError(400, 'tables が多すぎます');
    return {
      round: asNum(r?.round, 'round', 0, 50, true),
      mode: ['normal', 'rankTopFirst', 'rankBottomFirst'].includes(r?.mode) ? r.mode : 'normal',
      ...(r?.isPending ? { isPending: true } : {}),
      ...(Array.isArray(r?.sitOutIds) ? { sitOutIds: r.sitOutIds.filter((x: any) => typeof x === 'string' && UUID_RE.test(x)).slice(0, 100) } : {}),
      tables: tables.map((t: any) => {
        const players = Array.isArray(t?.players) ? t.players : [];
        if (players.length > 4) throw new HttpError(400, 'players が多すぎます');
        return {
          tableNumber: asNum(t?.tableNumber, 'tableNumber', 0, 100, true),
          isCalculated: !!t?.isCalculated,
          isSubmitted: !!t?.isSubmitted,
          players: players.map((p: any) => ({
            playerId: asId(p?.playerId, 'playerId'),
            wind: typeof p?.wind === 'string' ? p.wind.slice(0, 4) : '',
            name: typeof p?.name === 'string' ? p.name.slice(0, 60) : '',
            score: asNum(num(p?.score), 'score', -3000, 3000, true),
            point: asNum(num(p?.point), 'point', -2000, 2000),
            chonbo: asNum(num(p?.chonbo), 'chonbo', 0, 10, true),
          })),
        };
      }),
    };
  });
}

export function sanitizeTimer(raw: any) {
  const startAts: Record<string, number> = {};
  if (raw?.startAts && typeof raw.startAts === 'object') {
    Object.entries(raw.startAts).forEach(([k, v]) => {
      const n = Number(k), t = Number(v);
      if (Number.isInteger(n) && n >= 1 && n <= 50 && Number.isFinite(t) && t > 1e12 && t < 4e12) startAts[String(n)] = t;
    });
  }
  return {
    breakMinutes: asNum(num(raw?.breakMinutes, 10), 'breakMinutes', 0, 180),
    startAts,
    stamp: asNum(num(raw?.stamp, 0), 'stamp', 0, 4e12),
  };
}

export function sanitizeTournamentBlob(raw: any) {
  if (!raw || typeof raw !== 'object') throw new HttpError(400, '大会データが不正です');
  const limits: Record<string, { rounds: number[] }> = {};
  if (raw.playerLimits && typeof raw.playerLimits === 'object') {
    Object.entries(raw.playerLimits).slice(0, 300).forEach(([id, v]: [string, any]) => {
      if (UUID_RE.test(id) && Array.isArray(v?.rounds)) {
        limits[id] = { rounds: v.rounds.map((n: any) => Math.floor(Number(n))).filter((n: number) => Number.isInteger(n) && n >= 1 && n <= 50).slice(0, 50) };
      }
    });
  }
  return {
    tournamentPhase: ['entry', 'drawing', 'playing'].includes(raw.tournamentPhase) ? raw.tournamentPhase : 'entry',
    entryPlayerIds: (Array.isArray(raw.entryPlayerIds) ? raw.entryPlayerIds : []).filter((x: any) => typeof x === 'string' && UUID_RE.test(x)).slice(0, 300),
    roundsCount: asNum(num(raw.roundsCount, 1), 'roundsCount', 1, 50, true),
    seating: sanitizeSeating(raw.seating ?? []),
    playerLimits: limits,
    timer: sanitizeTimer(raw.timer),
    tournamentNo: typeof raw.tournamentNo === 'string' || typeof raw.tournamentNo === 'number' ? String(raw.tournamentNo).slice(0, 10) : '',
    drawingAnnounced: !!raw.drawingAnnounced,
  };
}

// ---- 過去大会の半荘（POST / PATCH で共通）----
const idStr = (x: unknown) => { if (typeof x !== 'string' || !UUID_RE.test(x)) throw new HttpError(400, 'playerId が不正です'); return x; };
export function sanitizeHanchans(raw: unknown): any[] {
  if (!Array.isArray(raw) || raw.length > 3000) throw new HttpError(400, 'hanchans が不正です');
  return raw.map((h: any) => {
    const results = h?.results;
    if (!Array.isArray(results) || results.length > 4) throw new HttpError(400, 'results が不正です');
    return {
      no: asNum(h?.no, 'no', 0, 100000, true),
      ...(h?.round !== undefined ? { round: asNum(h.round, 'round', 1, 100, true) } : {}),
      ...(h?.table !== undefined ? { table: asNum(h.table, 'table', 0, 100, true) } : {}),
      deposit: asNum(h?.deposit ?? 0, 'deposit', -1000, 1000),
      results: results.map((r: any) => ({
        playerId: idStr(r?.playerId),
        name: typeof r?.name === 'string' ? r.name.slice(0, 60) : '',
        rank: asNum(r?.rank, 'rank', 0, 4, true),
        score: asNum(r?.score, 'score', -3000, 3000),
        point: asNum(r?.point, 'point', -2000, 2000),
        excluded: !!r?.excluded,
      })),
    };
  });
}

// ---- 過去大会の最終成績・ペナルティ（POST / PATCH で共通）----
export function sanitizeStandings(raw: unknown): any[] {
  if (!Array.isArray(raw) || raw.length > 400) throw new HttpError(400, 'standings が不正です');
  return raw.map((s: any) => ({
    playerId: idStr(s?.playerId),
    name: typeof s?.name === 'string' ? s.name.slice(0, 60) : '',
    totalPoint: asNum(s?.totalPoint, 'totalPoint', -100000, 100000),
    gameCount: asNum(s?.gameCount, 'gameCount', 0, 1000, true),
    rank: asNum(s?.rank, 'rank', 0, 1000, true),
  }));
}
export function sanitizePenalties(raw: unknown): any[] {
  if (!Array.isArray(raw) || raw.length > 1000) throw new HttpError(400, 'penalties が不正です');
  return raw.map((p: any) => ({
    playerId: idStr(p?.playerId),
    name: typeof p?.name === 'string' ? p.name.slice(0, 60) : '',
    point: asNum(p?.point, 'point', -2000, 2000),
    reason: typeof p?.reason === 'string' ? p.reason.slice(0, 200) : '',
    ...(p?.applied ? { applied: true } : {}),
  }));
}
