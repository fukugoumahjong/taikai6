'use client';

import React, { useState, useEffect, useRef } from 'react';
import { signIn, signOut, useSession } from "next-auth/react";
import { supabase } from '@/lib/supabase';

// ==========================================
// 0. 定数
// ==========================================
// 大会名はここだけ変えれば全画面・PDF・画像に反映されます
const APP_TITLE = '高等学校複合麻雀競技大会';
const RULE_NAME = '最高位戦ルール';
const CHONBO_PENALTY = 20.0;
// シーズン区分: 第4回以降が「今季」。それより前（第1〜3回＝昨年度）は「前季」として、
// 今季成績（今季ポイント・半荘数など）には含めず、生涯成績にだけ反映する。
const CURRENT_SEASON_FIRST_TOURNAMENT_NO = 4;
// 名前に数字を含む選手。MMCテキストの読み取りでは、順位・点数の数字と区別するため、
// 読み取り中だけ全角数字に置き換え、読み取り後に元の名前へ戻す。
const NAMES_WITH_DIGITS = ['sotaro1934'];
// 年間チャンピオン大会 出場権の「対象」判定基準:
// 「7半荘以上出場した大会」が2大会以上あること（各大会優勝は別枠で手動付与）
const CHAMPIONSHIP_MIN_HANCHAN_PER_TOURNAMENT = 7;
const CHAMPIONSHIP_MIN_TOURNAMENTS = 2;
// 各回戦の開始時刻（あくまで目安）
const ROUND_START_TIMES = ['08:40', '10:00', '11:15', '12:30', '13:45', '15:00', '16:20', '17:35', '19:50'];
// 大会（第N回）ごとに開始目安が決まっている場合はこちらを優先する。無い回は上の ROUND_START_TIMES を使う。
const ROUND_START_TIMES_BY_TOURNAMENT: Record<number, string[]> = {
  7: ['09:15', '10:25', '11:35', '12:45', '13:50', '15:00', '16:10', '17:20'],
};
// 次に入力する大会の回（運営都合で第7回が第6回より先に開催される）。管理者が画面から手動で変更できる。
const DEFAULT_TOURNAMENT_NO = '7';
// 第7回のみ、卓の名前を「1卓・2卓・3卓」ではなく色名で呼ぶ（12名・3卓のため）。
// 1卓目が白卓。順位順で決まる回戦では上位の卓が1卓目になるので、自動的に上位が白卓になる。
const TABLE_NAMES_BY_TOURNAMENT: Record<number, string[]> = {
  7: ['白卓', '橙卓', '黒卓'],
};
// 卓の色（アイコン）。badge=卓ヘッダーの色、dot=小さな丸いアイコン、emoji=文字だけの場所用
const TABLE_COLORS_BY_TOURNAMENT: Record<number, { badge: string; dot: string; emoji: string }[]> = {
  7: [
    { badge: 'bg-white text-[#2d2721] border-2 border-[#d4c9b7]', dot: 'bg-white border-[#a99d8c]', emoji: '⚪' },
    { badge: 'bg-orange-500 text-white border-2 border-orange-500', dot: 'bg-orange-500 border-orange-600', emoji: '🟠' },
    { badge: 'bg-[#1c1814] text-white border-2 border-[#1c1814]', dot: 'bg-[#1c1814] border-[#1c1814]', emoji: '⚫' },
  ],
};
const tableColorFor = (tournamentNo: string, tableNo?: number) =>
  tableNo ? TABLE_COLORS_BY_TOURNAMENT[Number(tournamentNo)]?.[tableNo - 1] || null : null;
const tableNameFor = (tournamentNo: string, tableNo?: number): string => {
  if (!tableNo) return '';
  return TABLE_NAMES_BY_TOURNAMENT[Number(tournamentNo)]?.[tableNo - 1] || `${tableNo}卓`;
};
const scheduleFor = (tournamentNo: string): string[] => ROUND_START_TIMES_BY_TOURNAMENT[Number(tournamentNo)] || ROUND_START_TIMES;

// 大会規定 (Google ドキュメント)
const RULES_DOC_URL = 'https://docs.google.com/document/d/1gnUvQFS7stf_LjJg7G2Nb4AglvrBcx1sd3v27xPCVwc/edit?usp=sharing';

// 謝辞（参考にさせていただいたツール）
const CREDIT_AUTHOR = '園田賢プロ';
const CREDIT_TOOL_NAME = 'mahjong-manage.com（mmc）';
const CREDIT_TOOL_URL = 'https://mahjong-manage.com/';

// ==========================================
// 1. 型定義
// ==========================================
type Player = {
  id: string;
  name: string;
  totalPoint: number;
  totalGames: number;
  championshipRight?: boolean; // 年間チャンピオン大会 出場権（手動付与）
  loginCode?: string; // 選手ログイン用のパスワード（英数字6桁程度・ランダム発行）
};

type PlayerScore = {
  playerId: string;
  wind: string;
  name: string;
  score: number; // 100点単位
  point: number;
  chonbo: number; // チョンボ回数 (1回につき -20.0pt)
};

type Table = {
  tableNumber: number;
  players: PlayerScore[];
  isCalculated: boolean;
  isSubmitted: boolean;
};

type Round = {
  round: number;
  tables: Table[];
  // 'normal'          : 大会開始時にローテーションで自動生成
  // 'rankTopFirst'    : 順位順(1234/5678)・卓内上位から東南西北  (最後から2つ目)
  // 'rankBottomFirst' : 順位順(1234/5678)・卓内下位から東南西北  (最終戦)
  mode?: 'normal' | 'rankTopFirst' | 'rankBottomFirst';
  isPending?: boolean;  // 卓組がまだ決定していない
  sitOutIds?: string[]; // 抜け番
};

// 出場試合数の限定。出場する回戦を個別に指定する（例: 1〜3回戦と7〜9回戦、2・5・8回戦 など、連続していなくてもよい）。
// 今大会ごとに設定する。
type PlayerLimit = { rounds: number[] };

// 次の大会の参加選手の事前登録（今の大会が進行中・終了後でも、先に登録しておける）。
// 保存先は、現在の大会（id='current'）とは別の行（id='next_entry'）なので、現在の大会をリセットしても消えない。
type NextEntry = { no: string; playerIds: string[]; limits?: Record<string, PlayerLimit>; roundsCount?: number };
const normalizeNextEntry = (raw: any): NextEntry | null => {
  if (!raw || !Array.isArray(raw.playerIds)) return null;
  const ids: string[] = raw.playerIds.filter((x: any) => typeof x === 'string');
  const limits = normalizePlayerLimits(raw.limits);
  Object.keys(limits).forEach(id => { if (!ids.includes(id)) delete limits[id]; }); // 登録されていない選手の限定は捨てる
  const rc = Math.floor(Number(raw.roundsCount));
  return { no: String(raw.no ?? ''), playerIds: ids, limits, roundsCount: Number.isFinite(rc) && rc >= 1 ? rc : undefined };
};

// 保存データの読み込み用。旧形式 { from, to }（連続範囲）も rounds 形式に変換して受け入れる。
const normalizePlayerLimits = (raw: any): Record<string, PlayerLimit> => {
  const out: Record<string, PlayerLimit> = {};
  if (!raw || typeof raw !== 'object') return out;
  Object.entries(raw).forEach(([id, v]: [string, any]) => {
    if (!v) return;
    let rounds: number[] = [];
    if (Array.isArray(v.rounds)) {
      rounds = v.rounds.map((n: any) => Math.floor(Number(n))).filter((n: number) => Number.isFinite(n) && n >= 1);
    } else if (Number.isFinite(Number(v.from)) && Number.isFinite(Number(v.to))) {
      for (let n = Math.floor(Number(v.from)); n <= Math.floor(Number(v.to)); n++) rounds.push(n);
    }
    rounds = Array.from(new Set(rounds)).sort((a, b) => a - b);
    if (rounds.length > 0) out[id] = { rounds };
  });
  return out;
};

// [1,2,3,7,8,9] → "1〜3・7〜9回戦のみ" / [2,5] → "2・5回戦のみ"
const formatLimitRounds = (rounds: number[]): string => {
  const sorted = Array.from(new Set(rounds)).sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    const len = j - i + 1;
    parts.push(len === 1 ? `${sorted[i]}` : len === 2 ? `${sorted[i]}・${sorted[j]}` : `${sorted[i]}〜${sorted[j]}`);
    i = j + 1;
  }
  return `${parts.join('・')}回戦のみ`;
};

// ==========================================
// 次の回戦までのタイマー
// ==========================================
// 2回戦以降の開始時刻 = 「前の回戦の全卓の送信が完了した瞬間」＋ 休憩時間。
// breakMinutes: 休憩時間（分）。管理者が途中で変更できる
// startAts    : 回戦番号 → 開始時刻（エポックms）
// stamp       : 最終更新時刻（端末間で新しい方を採用するための印）
type TimerState = { breakMinutes: number; startAts: Record<number, number>; stamp: number };
const DEFAULT_BREAK_MINUTES = 4;
const TIMER_SHOW_AFTER_START_MS = 10 * 60 * 1000; // 開始時刻を過ぎてもバナーを残す時間

const normalizeTimer = (raw: any): TimerState => {
  const bm = Number(raw?.breakMinutes);
  const startAts: Record<number, number> = {};
  if (raw?.startAts && typeof raw.startAts === 'object') {
    Object.entries(raw.startAts).forEach(([k, v]) => {
      const n = Number(k), t = Number(v);
      if (Number.isFinite(n) && Number.isFinite(t)) startAts[n] = t;
    });
  }
  return {
    breakMinutes: Number.isFinite(bm) && bm >= 0 ? bm : DEFAULT_BREAK_MINUTES,
    startAts,
    stamp: Number.isFinite(Number(raw?.stamp)) ? Number(raw.stamp) : 0,
  };
};

// 開始時刻（エポックms）→ "HH:MM"（日本時間）
const formatClock = (ms: number) =>
  new Intl.DateTimeFormat('ja-JP', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Tokyo' }).format(new Date(ms));

// ヘッダー下に全ページ共通で出すカウントダウン。1秒ごとの再描画はこの部品の中だけで完結させる
function NextRoundTimerBar({ round, startAt, seatText, isAdmin, onOpenSettings }: {
  round: number; startAt: number; seatText?: string; isAdmin: boolean; onOpenSettings: () => void;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const remainMs = startAt - now;
  if (remainMs < -TIMER_SHOW_AFTER_START_MS) return null;
  const started = remainMs <= 0;
  const sec = Math.max(0, Math.ceil(remainMs / 1000));
  const text = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
  const urgent = !started && sec <= 60;
  const tone = started
    ? 'from-emerald-600 to-teal-600'
    : urgent
      ? 'from-amber-500 to-orange-600'
      : 'from-[#a62b17] to-[#274066]';
  return (
    <div className={`sticky top-0 md:top-24 z-30 w-full bg-gradient-to-r ${tone} text-white text-center px-3 py-1.5 sm:py-2.5 shadow-lg`}>
      <div className="text-[11px] sm:text-xs font-bold tracking-widest opacity-90">
        {started ? `${round}回戦 開始時刻です` : `次の回戦まで（${round}回戦）`}
      </div>
      <div className={`font-black font-mono tabular-nums leading-none text-4xl sm:text-6xl my-0.5 ${urgent ? 'animate-pulse' : ''}`}>
        {started ? '対局開始！' : text}
      </div>
      {seatText && <div className="text-base sm:text-xl font-black">{seatText}</div>}
      {isAdmin && (
        <button
          onClick={onOpenSettings}
          className="absolute right-2 top-2 w-10 h-10 rounded-full bg-black/25 hover:bg-black/40 active:bg-black/50 text-lg leading-none transition"
          title="休憩時間・タイマーの設定"
          aria-label="タイマー設定"
        >⚙️</button>
      )}
    </div>
  );
}

// ---- 過去大会（アーカイブ）まわりの型 ----
type ArchiveHanchanResult = {
  playerId: string;
  name: string;
  rank: number;
  score: number;   // 100点単位（既存のPlayerScore.scoreと同じ単位）
  point: number;
  excluded: boolean; // 「順位には含みません」(黒子など)
};
type ArchiveHanchan = {
  no: number;
  round?: number; // 何半荘目（回戦）か。同じ回戦の全卓が同じ値。取り込み済みの古い記録には無い
  table?: number; // 何卓か
  deposit: number;
  results: ArchiveHanchanResult[];
};
type ArchiveStanding = {
  playerId: string;
  name: string;
  totalPoint: number;
  gameCount: number;
  rank: number; // その大会での最終順位（黒子除く）
};
type ArchivePenalty = {
  playerId: string;
  name: string;
  point: number;  // 通常マイナス。例: -20.0
  reason: string; // 例: チョンボ、遅刻 など
  applied?: boolean; // 「後からペナルティを追加」で付けたもの（最終成績・今季ポイントに反映済み。削除すると元に戻す）
};
type TournamentArchive = {
  id: string;
  name: string;        // 例: "第4回"
  ruleName?: string;
  notes?: string;
  standings: ArchiveStanding[];
  hanchans: ArchiveHanchan[];
  penalties: ArchivePenalty[];
  createdAt?: string;
};

// ==========================================
// 2. 共通ヘルパー
// ==========================================
const isKuroko = (name: string) => name.includes('黒子');
// 「第N回」から回数N（無ければ null）
const archiveTournamentNo = (name: string): number | null => {
  const m = name.match(/第(\d+)回/);
  return m ? parseInt(m[1], 10) : null;
};
// 過去大会の半荘を「N半荘目」ごとにまとめる（保存順は新しい半荘が先なので、反転して古い順にする）。
// 回戦・卓の情報がある大会は、同じ回戦の全卓を1つにまとめる。無い（取り込み済みの）大会は、1半荘ずつ。
type HanchanGroup = { no: number; items: ArchiveHanchan[] };
const groupArchiveHanchans = (hanchans: ArchiveHanchan[]): HanchanGroup[] => {
  const chrono = [...hanchans].reverse();
  const hasRound = chrono.length > 0 && chrono.every(h => typeof h.round === 'number');
  if (!hasRound) return chrono.map((h, i) => ({ no: i + 1, items: [h] }));
  const map = new Map<number, ArchiveHanchan[]>();
  chrono.forEach(h => { const r = h.round as number; map.set(r, [...(map.get(r) || []), h]); });
  return [...map.entries()].sort((a, b) => a[0] - b[0])
    .map(([no, items]) => ({ no, items: [...items].sort((x, y) => (x.table ?? 0) - (y.table ?? 0)) }));
};
// 年間チャンピオン戦などの「別大会」（名前に「年間チャンピオン」を含む記録）。
// 通常の大会とは別に記録し、順位分布・半荘数には含めるが、生涯ポイントには加算しない（true にすると加算する）。
const SEPARATE_EVENT_KEYWORD = '年間チャンピオン';
const SEPARATE_EVENT_COUNTS_FOR_LIFETIME_POINT = false;
const isSeparateEventArchive = (a: { name: string }) => a.name.includes(SEPARATE_EVENT_KEYWORD);
// 最高位戦ルール以外の大会は、生涯ポイントでは「最高位戦ルールに換算した参考値」として合算する。
// 換算 = （素点 − 持ち点）÷ 1000 ＋ 最高位戦ルールの順位点（30／10／−10／−30）。オカ・供託は考慮しない。
// 持ち点が30000点以外のルールだけ、ここに登録する（登録が無いルールは30000点持ちとして換算）。
const RULE_START_SCORE: Record<string, number> = { '日本プロ麻雀協会ルール': 25000 };
const DEFAULT_START_SCORE = 30000;
const SAIKOI_UMA = [30, 10, -10, -30];
// 1半荘分（4名）のスコア（100点単位）から、最高位戦ルール換算のポイントを求める（同点は順位点を等分）
const calcConvertedPoints = (scores100: number[], startScore: number): number[] => {
  const idx = scores100.map((_, i) => i).sort((a, b) => scores100[b] - scores100[a]);
  const out: number[] = new Array(scores100.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j < idx.length && scores100[idx[j]] === scores100[idx[i]]) j++;
    let umaSum = 0;
    for (let k = i; k < j; k++) umaSum += SAIKOI_UMA[k] ?? 0;
    for (let k = i; k < j; k++) out[idx[k]] = (scores100[idx[k]] * 100 - startScore) / 1000 + umaSum / (j - i);
    i = j;
  }
  return out;
};
// 既知の大会のルール。ここに載っている回は、保存されているルール名より優先する
// （取り込み時にルール名を入れ忘れても、生涯ポイントに他ルールの大会が混ざらないようにするため）
const RULE_NAME_BY_TOURNAMENT_NO: Record<number, string> = {
  1: '日本プロ麻雀協会ルール',
  2: 'WRCルール',
  3: RULE_NAME,
};
const effectiveArchiveRuleName = (a: { name: string; ruleName?: string }): string => {
  const n = archiveTournamentNo(a.name);
  return (n !== null && RULE_NAME_BY_TOURNAMENT_NO[n]) || a.ruleName || RULE_NAME;
};
// 前季（今季より前）の大会か
const isPreviousSeasonArchive = (a: { name: string }) => {
  const n = archiveTournamentNo(a.name);
  return n !== null && n < CURRENT_SEASON_FIRST_TOURNAMENT_NO;
};
const toFullWidthDigits = (t: string) => t.replace(/[0-9]/g, c => String.fromCharCode(c.charCodeAt(0) + 0xFEE0));
const fromFullWidthDigits = (t: string) => t.replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
const encodeNamesWithDigits = (raw: string) =>
  NAMES_WITH_DIGITS.reduce((acc, n) => acc.split(n).join(toFullWidthDigits(n)), raw);
const fmtPt = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

// 選手ログイン用コードの生成（見間違えやすい 0/O, 1/I/L を除いた英数字6桁）
const LOGIN_CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const generateLoginCode = (existing: Set<string>): string => {
  let code = '';
  do {
    code = Array.from({ length: 6 }, () => LOGIN_CODE_CHARS[Math.floor(Math.random() * LOGIN_CODE_CHARS.length)]).join('');
  } while (existing.has(code));
  existing.add(code);
  return code;
};

// 名前の末尾が P の選手は麻雀プロ（"プロ"という文字を含むだけでは判定しない）
const PRO_SUFFIX = /[PＰⓅⓟ]$/;
const isPro = (name: string) => PRO_SUFFIX.test((name || '').trim());
const baseName = (name: string) => (name || '').trim().replace(PRO_SUFFIX, '');
const proMarkedName = (name: string) => (isPro(name) ? `${baseName(name)}Ⓟ` : name);

// 今季の各大会での入賞（優勝・2位・3位）を、名前の横に出すバッジ。どの大会かを「第7回優勝」のように表示する。
// 各リストは入賞した大会の回数（回数が無い大会は大会名）。
type PodiumCount = { first: string[]; second: string[]; third: string[] };
const podiumLabel = (list: string[], suffix: string) => {
  const sorted = [...list].sort((a, b) => (parseInt(a, 10) || 0) - (parseInt(b, 10) || 0) || a.localeCompare(b, 'ja'));
  const allNumeric = sorted.every(x => /^\d+$/.test(x));
  return allNumeric ? `第${sorted.join('・')}回${suffix}` : `${sorted.map(x => (/^\d+$/.test(x) ? `第${x}回` : x)).join('・')}${suffix}`;
};
const PodiumBadges = ({ podium }: { podium?: PodiumCount }) => {
  if (!podium || (podium.first.length + podium.second.length + podium.third.length) === 0) return null;
  const base = 'inline-flex items-center gap-0.5 whitespace-nowrap rounded-full px-2 py-[2px] text-[10px] md:text-[11px] font-black leading-none tracking-tight ring-1 ';
  return (
    <span className="inline-flex flex-wrap items-center gap-1 ml-1.5 align-middle">
      {podium.first.length > 0 && (
        <span className={base + 'bg-gradient-to-r from-amber-400 via-yellow-200 to-amber-500 text-amber-950 ring-amber-300 shadow-[0_1px_8px_rgba(245,158,11,0.55)]'}>
          <span aria-hidden>🏆</span>{podiumLabel(podium.first, '優勝')}
        </span>
      )}
      {podium.second.length > 0 && (
        <span className={base + 'bg-gradient-to-r from-[#d4c9b7] via-[#faf7f1] to-[#d4c9b7] text-[#473f36] ring-[#d4c9b7] shadow-[0_1px_6px_rgba(100,116,139,0.35)]'}>
          <span aria-hidden>🥈</span>{podiumLabel(podium.second, '2位')}
        </span>
      )}
      {podium.third.length > 0 && (
        <span className={base + 'bg-gradient-to-r from-orange-300 via-amber-100 to-orange-400 text-orange-950 ring-orange-300 shadow-[0_1px_6px_rgba(234,88,12,0.35)]'}>
          <span aria-hidden>🥉</span>{podiumLabel(podium.third, '3位')}
        </span>
      )}
    </span>
  );
};

// 名前表示用（プロバッジ付き）
const PlayerLabel = ({ name, className = '', badgeClass = '' }: { name: string; className?: string; badgeClass?: string }) => (
  <span className={className}>
    {baseName(name)}
    {isPro(name) && (
      <span
        title="麻雀プロ"
        className={`ml-1 inline-flex items-center justify-center align-middle w-[18px] h-[18px] rounded-full text-[10px] font-black text-white bg-gradient-to-br from-amber-400 to-amber-600 shadow-sm ring-1 ring-amber-200 ${badgeClass}`}
      >P</span>
    )}
  </span>
);

// 大会別成績などで1〜3位をいい感じに見せる小さなバッジ
const RankPill = ({ rank, playerCount }: { rank: number; playerCount?: number }) => {
  if (rank === 1) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-xs font-black bg-gradient-to-r from-yellow-400 to-amber-500 shadow-sm whitespace-nowrap">
        🏆 1位
      </span>
    );
  }
  if (rank === 2) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-xs font-black bg-gradient-to-r from-[#d4c9b7] to-[#a99d8c] shadow-sm whitespace-nowrap">
        🥈 2位
      </span>
    );
  }
  if (rank === 3) {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-white text-xs font-black bg-gradient-to-r from-amber-600 to-amber-700 shadow-sm whitespace-nowrap">
        🥉 3位
      </span>
    );
  }
  return (
    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{rank}{playerCount ? `/${playerCount}` : ''}位</span>
  );
};

// 通算成績タブの行の下に出す、大会別成績のみのコンパクト表示（2列）
const ArchiveHistoryMini = ({
  history,
  onOpenDetail,
}: {
  history: { archiveId: string; name: string; point: number; gameCount: number; rank: number; playerCount: number }[];
  onOpenDetail: () => void;
}) => {
  return (
    <div className="px-4 md:px-6 py-4">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-xs font-black text-[#82786b]">大会別成績</h4>
        <button
          onClick={onOpenDetail}
          className="text-xs font-bold text-[#c8361e] hover:text-[#822213] transition inline-flex items-center gap-1"
        >
          個人成績 →
        </button>
      </div>
      {history.length === 0 ? (
        <p className="text-xs text-[#a99d8c]">記録がありません。</p>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {history.map(h => (
            <div key={h.archiveId} className="flex items-center justify-between gap-2 bg-white border border-[#e7dfd1] rounded-lg px-3 py-2 text-xs">
              <span className="text-[#625a4f] font-bold truncate">{h.name}</span>
              <RankPill rank={h.rank} playerCount={h.playerCount} />
              <span className="text-[#a99d8c] whitespace-nowrap">{h.gameCount}戦</span>
              <span className={`font-black tabular-nums whitespace-nowrap ${h.point > 0 ? 'text-blue-600' : h.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(h.point)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

// ==========================================
// 学校別成績（管理者のみ・非公開）。1卓の1半荘を1件の「対局」として、学校ごとに集計する
// ==========================================
type SGPlayer = { key: string; name: string; school: string; rank: number; score: number; point: number };
type SGame = { id: string; tKey: string; tName: string; tOrder: number; season: boolean; round: number | null; label: string; players: SGPlayer[] };
type SchoolScope = 'season' | 'all';
type SchoolTournament = { tKey: string; tName: string; order: number; games: number; point: number; members: number; rank: number; total: number };
type SchoolSummary = {
  school: string;
  members: Map<string, { name: string; games: number; point: number }>;
  games: number; // 延べ半荘数（選手ごとの半荘の合計）
  point: number;
  rankSum: number;
  dist: number[];
  maxScore: { score: number; label: string } | null;
  tournaments: SchoolTournament[]; // 新しい大会が先頭
  tables: SGame[]; // その学校の選手がいた対局
};
type SchoolVs = { school: string; games: number; wins: number; losses: number; draws: number; diffSum: number };

const schoolInScope = (g: SGame, scope: SchoolScope) => scope === 'all' || g.season;
const schoolAvg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const schoolR1 = (v: number) => Math.round(v * 10) / 10;

const emptySchoolSummary = (school: string): SchoolSummary => ({
  school, members: new Map(), games: 0, point: 0, rankSum: 0, dist: [0, 0, 0, 0], maxScore: null, tournaments: [], tables: [],
});

const buildSchoolSummaries = (games: SGame[], scope: SchoolScope): Map<string, SchoolSummary> => {
  const out = new Map<string, SchoolSummary>();
  const tmap = new Map<string, Map<string, SchoolTournament & { memberSet: Set<string> }>>();
  games.filter(g => schoolInScope(g, scope)).forEach(g => {
    const seen = new Set<string>();
    g.players.forEach(pl => {
      if (!pl.school) return;
      let s = out.get(pl.school);
      if (!s) { s = emptySchoolSummary(pl.school); out.set(pl.school, s); }
      const m = s.members.get(pl.key) || { name: pl.name, games: 0, point: 0 };
      m.games += 1; m.point += pl.point;
      s.members.set(pl.key, m);
      s.games += 1; s.point += pl.point; s.rankSum += pl.rank;
      if (pl.rank >= 1 && pl.rank <= 4) s.dist[pl.rank - 1] += 1;
      if (!s.maxScore || pl.score > s.maxScore.score) s.maxScore = { score: pl.score, label: `${g.label}・${pl.name}` };
      if (!seen.has(pl.school)) { seen.add(pl.school); s.tables.push(g); }
      let tm = tmap.get(pl.school);
      if (!tm) { tm = new Map(); tmap.set(pl.school, tm); }
      let t = tm.get(g.tKey);
      if (!t) { t = { tKey: g.tKey, tName: g.tName, order: g.tOrder, games: 0, point: 0, members: 0, rank: 0, total: 0, memberSet: new Set<string>() }; tm.set(g.tKey, t); }
      t.games += 1; t.point += pl.point; t.memberSet.add(pl.key);
    });
  });
  // 大会ごとの、学校どうしの順位（その大会の合計ポイント順。同点は同順位）
  const byT = new Map<string, { school: string; point: number }[]>();
  tmap.forEach((tm, school) => tm.forEach((t, k) => {
    const arr = byT.get(k) || [];
    arr.push({ school, point: schoolR1(t.point) });
    byT.set(k, arr);
  }));
  byT.forEach((arr, k) => {
    arr.sort((x, y) => y.point - x.point);
    arr.forEach((x, i) => {
      const rank = i > 0 && arr[i - 1].point === x.point ? (tmap.get(arr[i - 1].school)!.get(k)!.rank) : i + 1;
      const t = tmap.get(x.school)!.get(k)!;
      t.rank = rank; t.total = arr.length; t.members = t.memberSet.size;
    });
  });
  out.forEach((s, school) => {
    const tm = tmap.get(school);
    s.tournaments = tm ? Array.from(tm.values()).map(({ memberSet: _ms, ...rest }) => rest).sort((x, y) => y.order - x.order) : [];
    s.tables.sort((x, y) => (y.tOrder === x.tOrder ? 0 : y.tOrder - x.tOrder));
  });
  return out;
};

// 同じ卓にいた2校の比較: その卓での、各校の選手のポイント平均（人数が違っても公平になるよう平均で比べる）
const schoolTablePair = (g: SGame, a: string, b: string) => {
  const pa = g.players.filter(p => p.school === a);
  const pb = g.players.filter(p => p.school === b);
  if (pa.length === 0 || pb.length === 0) return null;
  return { a: schoolAvg(pa.map(p => p.point)), b: schoolAvg(pb.map(p => p.point)) };
};

const buildSchoolVs = (games: SGame[], scope: SchoolScope, school: string): SchoolVs[] => {
  const m = new Map<string, SchoolVs>();
  games.filter(g => schoolInScope(g, scope)).forEach(g => {
    if (!g.players.some(p => p.school === school)) return;
    const others = new Set(g.players.map(p => p.school).filter(s => s && s !== school));
    others.forEach(o => {
      const r = schoolTablePair(g, school, o);
      if (!r) return;
      const cur = m.get(o) || { school: o, games: 0, wins: 0, losses: 0, draws: 0, diffSum: 0 };
      const d = r.a - r.b;
      cur.games += 1; cur.diffSum += d;
      if (Math.abs(d) < 0.05) cur.draws += 1; else if (d > 0) cur.wins += 1; else cur.losses += 1;
      m.set(o, cur);
    });
  });
  return Array.from(m.values()).map(x => ({ ...x, diffSum: schoolR1(x.diffSum) })).sort((x, y) => y.diffSum - x.diffSum);
};

type SchoolH2H = { rows: { g: SGame; a: number; b: number }[]; aWins: number; bWins: number; draws: number; diffSum: number };
const buildSchoolH2H = (games: SGame[], scope: SchoolScope, a: string, b: string): SchoolH2H => {
  const rows: { g: SGame; a: number; b: number }[] = [];
  let aWins = 0, bWins = 0, draws = 0, diffSum = 0;
  games.filter(g => schoolInScope(g, scope)).forEach(g => {
    const r = schoolTablePair(g, a, b);
    if (!r) return;
    rows.push({ g, a: r.a, b: r.b });
    const d = r.a - r.b;
    diffSum += d;
    if (Math.abs(d) < 0.05) draws += 1; else if (d > 0) aWins += 1; else bWins += 1;
  });
  rows.sort((x, y) => (y.g.tOrder === x.g.tOrder ? 0 : y.g.tOrder - x.g.tOrder));
  return { rows, aWins, bWins, draws, diffSum: schoolR1(diffSum) };
};

const ptClass = (v: number) => (v > 0 ? 'text-blue-600' : v < 0 ? 'text-red-600' : 'text-[#a99d8c]');
const SCHOOL_RANK_LABELS = ['1着', '2着', '3着', '4着'];
const SCHOOL_RANK_COLORS = ['bg-yellow-400', 'bg-[#a99d8c]', 'bg-amber-700', 'bg-[#d4c9b7]'];

// 卓の中身（同卓者）を表示する小さな部品。指定した学校の選手を強調する
const SchoolTablePlayers = ({ players, highlight }: { players: SGPlayer[]; highlight: string[] }) => (
  <div className="px-3 py-2 bg-[#faf7f1] space-y-1">
    {[...players].sort((x, y) => x.rank - y.rank).map((p, i) => (
      <div key={`${p.key}-${i}`} className={`flex items-center gap-2 text-xs ${highlight.includes(p.school) ? 'font-black text-[#2d2721]' : 'text-[#82786b]'}`}>
        <span className="w-8">{p.rank}着</span>
        <PlayerLabel name={p.name} className="flex-1 truncate" />
        <span className={`text-[10px] px-1.5 rounded-full border ${highlight.includes(p.school) ? 'bg-[#fdf1ed] border-[#f7bcab] text-[#a62b17]' : 'bg-white border-[#e7dfd1] text-[#a99d8c]'}`}>{p.school || '学校なし'}</span>
        <span className="tabular-nums w-16 text-right">{p.score.toLocaleString()}</span>
        <span className={`tabular-nums w-14 text-right font-black ${ptClass(p.point)}`}>{fmtPt(p.point)}</span>
      </div>
    ))}
  </div>
);

// 学校別成績（モーダル）。個人成績と同じ構成: 今季/通算のタブ・大会別成績・着順分布・半荘ごとの成績・対戦相性
const SchoolDetailModal = ({
  school, summaries, ranks, vs, initialScope, onCompare, onClose,
}: {
  school: string;
  summaries: Record<SchoolScope, SchoolSummary | null>;
  ranks: Record<SchoolScope, { rank: number; total: number } | null>;
  vs: Record<SchoolScope, SchoolVs[]>;
  initialScope: SchoolScope;
  onCompare: (other: string) => void;
  onClose: () => void;
}) => {
  const [tab, setTab] = useState<SchoolScope>(initialScope);
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const [openGame, setOpenGame] = useState<string | null>(null);
  const s = summaries[tab] || emptySchoolSummary(school);
  const rk = ranks[tab];
  const vsList = vs[tab];
  const total = schoolR1(s.point);
  const groups = (() => {
    const m = new Map<string, { key: string; label: string; rows: SGame[] }>();
    s.tables.forEach(g => {
      const cur: { key: string; label: string; rows: SGame[] } = m.get(g.tKey) || { key: g.tKey, label: g.tName, rows: [] };
      cur.rows.push(g);
      m.set(g.tKey, cur);
    });
    return Array.from(m.values());
  })();
  const sum = s.dist.reduce((a, b) => a + b, 0);

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3 md:p-6" onClick={onClose}>
      <div className="bg-white w-full max-w-3xl max-h-[94vh] sm:max-h-[90vh] rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150" onClick={e => e.stopPropagation()}>
        <div className="bg-gradient-to-r from-[#a62b17] to-[#5e190e] text-white px-4 md:px-8 py-4 md:py-6 flex items-start justify-between flex-shrink-0">
          <div>
            <p className="text-[#f7bcab] text-xs font-bold mb-1">学校別成績 <span className="ml-1 text-[10px] border border-white/30 rounded px-1.5 py-0.5">非公開</span></p>
            <h2 className="text-2xl md:text-3xl font-black">🏫 {school}</h2>
            <p className={`mt-2 text-2xl font-black tabular-nums ${total > 0 ? 'text-emerald-300' : total < 0 ? 'text-rose-300' : 'text-[#f7bcab]'}`}>
              {fmtPt(total)} <span className="text-sm font-bold text-[#f7bcab]">（{tab === 'season' ? '今季' : '通算'} {s.games}半荘・{s.members.size}名）</span>
              {rk ? (
                <span className="ml-2 inline-flex items-baseline gap-0.5 align-middle bg-white/15 ring-1 ring-white/25 rounded-full px-2.5 py-0.5 text-white">
                  <span className="text-lg font-black tabular-nums">{rk.rank}</span>
                  <span className="text-xs font-bold">位</span>
                  <span className="text-[10px] font-bold text-[#f7bcab] ml-1">/ {rk.total}校</span>
                </span>
              ) : null}
            </p>
            {s.maxScore && (
              <p className="mt-2 text-xs font-bold text-[#f7bcab]">
                🎯 最高スコア <span className="text-white text-sm">{s.maxScore.score.toLocaleString()}点</span>（{s.maxScore.label}）
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-[#f7bcab] hover:text-white text-2xl leading-none font-bold px-2">✕</button>
        </div>

        <div className="flex border-b border-[#e7dfd1] bg-white flex-shrink-0">
          {([['season', '今季成績'], ['all', '通算成績']] as const).map(([k, label]) => (
            <button
              key={k}
              onClick={() => setTab(k)}
              className={`flex-1 py-3 text-sm font-black transition border-b-4 ${tab === k ? 'border-[#c8361e] text-[#a62b17] bg-[#fdf1ed]/50' : 'border-transparent text-[#a99d8c] hover:text-[#625a4f]'}`}
            >{label}</button>
          ))}
        </div>

        <div className="overflow-y-auto p-5 md:p-8 space-y-8">
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">大会別成績</h3>
            {s.tournaments.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-2">
                {s.tournaments.map(t => (
                  <div key={t.tKey} className="flex items-center justify-between gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2.5 text-sm">
                    <span className="text-[#473f36] font-bold">{t.tName}</span>
                    <RankPill rank={t.rank} playerCount={t.total} />
                    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{t.members}名・{t.games}戦</span>
                    <span className={`font-black tabular-nums whitespace-nowrap ${ptClass(t.point)}`}>{fmtPt(schoolR1(t.point))}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-[#a99d8c] mt-2">順位は、その大会に出場した学校どうしの合計ポイントの順位です。</p>
          </section>

          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🎯 着順分布（{tab === 'season' ? '今季' : '通算'}合計 {sum}戦）</h3>
            {sum === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="space-y-2">
                {s.dist.map((count, idx) => {
                  const pct = Math.round((count / sum) * 100);
                  return (
                    <div key={idx} className="flex items-center gap-3 text-sm">
                      <span className="w-10 font-bold text-[#82786b]">{SCHOOL_RANK_LABELS[idx]}</span>
                      <div className="flex-1 h-4 bg-[#f3eee4] rounded-full overflow-hidden">
                        <div className={`h-full ${SCHOOL_RANK_COLORS[idx]}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-28 flex-shrink-0 flex items-baseline justify-end tabular-nums text-[#82786b]">
                        <span className="inline-block w-7 text-right">{count}</span>
                        <span className="text-[11px] text-[#a99d8c] ml-0.5 mr-1.5">回</span>
                        <span className="inline-block w-11 text-right text-xs text-[#a99d8c]">({pct}%)</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">👥 所属選手別の成績</h3>
            {s.members.size === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="space-y-1.5">
                {Array.from(s.members.values()).sort((a, b) => b.point - a.point).map(m => (
                  <div key={m.name} className="flex items-center justify-between gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2 text-sm">
                    <PlayerLabel name={m.name} className="text-[#473f36] font-bold truncate flex-1" />
                    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{m.games}戦</span>
                    <span className={`font-black tabular-nums whitespace-nowrap ${ptClass(m.point)}`}>{fmtPt(schoolR1(m.point))}</span>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🀄 半荘ごとの成績</h3>
            {groups.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="space-y-2">
                {groups.map(g => {
                  const open = !!openGroups[g.key];
                  return (
                    <div key={g.key} className="border border-[#e7dfd1] rounded-lg overflow-hidden">
                      <button
                        onClick={() => setOpenGroups(prev => ({ ...prev, [g.key]: !prev[g.key] }))}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-[#faf7f1] hover:bg-[#f3eee4] transition text-left"
                      >
                        <span className="text-sm font-bold text-[#473f36]">{g.label}</span>
                        <span className="text-xs text-[#a99d8c] flex items-center gap-2">{g.rows.length}卓<span className="font-bold">{open ? '▲' : '▼'}</span></span>
                      </button>
                      {open && (
                        <div className="divide-y divide-[#f3eee4]">
                          {g.rows.map(game => {
                            const mine = game.players.filter(p => p.school === school);
                            const pt = schoolR1(mine.reduce((a, p) => a + p.point, 0));
                            const isOpen = openGame === game.id;
                            return (
                              <div key={game.id}>
                                <button onClick={() => setOpenGame(isOpen ? null : game.id)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#faf7f1] text-xs">
                                  <span className="font-bold text-[#625a4f] truncate">{game.label}</span>
                                  <span className="text-[#a99d8c] truncate flex-1 text-right">{mine.map(p => `${p.name} ${p.rank}着`).join('・')}</span>
                                  <span className={`font-black tabular-nums whitespace-nowrap ${ptClass(pt)}`}>{fmtPt(pt)}</span>
                                </button>
                                {isOpen && <SchoolTablePlayers players={game.players} highlight={[school]} />}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🤝 対戦相性（他校との直接対決）</h3>
            {vsList.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">他校と同卓した記録がありません。</p>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                {vsList.map(o => (
                  <div key={o.school} className="flex items-center justify-between gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2 text-sm">
                    <span className="text-[#473f36] font-bold truncate flex-1">{o.school}</span>
                    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{o.games}卓 {o.wins}勝{o.losses}敗{o.draws > 0 ? `${o.draws}分` : ''}</span>
                    <span className={`font-black tabular-nums whitespace-nowrap ${ptClass(o.diffSum)}`}>{fmtPt(o.diffSum)}</span>
                    <button onClick={() => onCompare(o.school)} className="text-[11px] font-bold bg-[#fdf1ed] hover:bg-[#fbddd3] text-[#a62b17] px-2 py-1 rounded-md whitespace-nowrap">比較</button>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-[#a99d8c] mt-2">同じ卓になった半荘ごとに、各校の選手のポイント平均を比べています。プラスは「この学校が相手より合計で勝っている」ことを表します。</p>
          </section>
        </div>
      </div>
    </div>
  );
};

// 2校の直対成績・成績比較
const SchoolH2HPanel = ({
  schools, games, scope, a, b, setA, setB,
}: {
  schools: string[];
  games: SGame[];
  scope: SchoolScope;
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
}) => {
  const [showTables, setShowTables] = useState(false);
  const [openGame, setOpenGame] = useState<string | null>(null);
  const label = scope === 'season' ? '今季' : '通算';
  const ready = !!a && !!b && a !== b;
  const sums = ready ? buildSchoolSummaries(games, scope) : new Map<string, SchoolSummary>();
  const sa = sums.get(a) || emptySchoolSummary(a);
  const sb = sums.get(b) || emptySchoolSummary(b);
  const h2h = ready ? buildSchoolH2H(games, scope, a, b) : null;

  type Metric = { label: string; av: number; bv: number; fmt: (v: number) => string; better: 'high' | 'low' | 'none'; skip?: boolean };
  const rate = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
  const metrics: Metric[] = [
    { label: '出場人数', av: sa.members.size, bv: sb.members.size, fmt: v => `${v}名`, better: 'none' },
    { label: '半荘数（延べ）', av: sa.games, bv: sb.games, fmt: v => `${v}`, better: 'none' },
    { label: '合計ポイント', av: schoolR1(sa.point), bv: schoolR1(sb.point), fmt: fmtPt, better: 'high' },
    { label: '1半荘あたり', av: sa.games ? schoolR1(sa.point / sa.games) : 0, bv: sb.games ? schoolR1(sb.point / sb.games) : 0, fmt: fmtPt, better: 'high', skip: !sa.games || !sb.games },
    { label: '平均着順', av: sa.games ? sa.rankSum / sa.games : 0, bv: sb.games ? sb.rankSum / sb.games : 0, fmt: v => v.toFixed(2), better: 'low', skip: !sa.games || !sb.games },
    { label: '1着率', av: rate(sa.dist[0], sa.games), bv: rate(sb.dist[0], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'high', skip: !sa.games || !sb.games },
    { label: '連対率（1・2着）', av: rate(sa.dist[0] + sa.dist[1], sa.games), bv: rate(sb.dist[0] + sb.dist[1], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'high', skip: !sa.games || !sb.games },
    { label: 'ラス率（4着）', av: rate(sa.dist[3], sa.games), bv: rate(sb.dist[3], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'low', skip: !sa.games || !sb.games },
    { label: '最高スコア', av: sa.maxScore?.score ?? 0, bv: sb.maxScore?.score ?? 0, fmt: v => (v ? `${v.toLocaleString()}点` : '-'), better: 'high', skip: !sa.maxScore || !sb.maxScore },
  ];
  const winner = (m: Metric): 'a' | 'b' | null => {
    if (m.better === 'none' || m.skip || m.av === m.bv) return null;
    return (m.better === 'high' ? m.av > m.bv : m.av < m.bv) ? 'a' : 'b';
  };
  const aWinCount = metrics.filter(m => winner(m) === 'a').length;
  const bWinCount = metrics.filter(m => winner(m) === 'b').length;

  const tourneys = (() => {
    const m = new Map<string, { tName: string; order: number; a?: SchoolTournament; b?: SchoolTournament }>();
    sa.tournaments.forEach(t => m.set(t.tKey, { tName: t.tName, order: t.order, a: t }));
    sb.tournaments.forEach(t => { const cur = m.get(t.tKey) || { tName: t.tName, order: t.order }; cur.b = t; m.set(t.tKey, cur); });
    return Array.from(m.entries()).map(([k, v]) => ({ key: k, ...v })).sort((x, y) => y.order - x.order);
  })();
  const distMax = Math.max(1, ...sa.dist.map(c => rate(c, sa.games)), ...sb.dist.map(c => rate(c, sb.games)));
  const total = h2h ? h2h.aWins + h2h.bWins + h2h.draws : 0;

  return (
    <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-[#faf7f1]">
        <h4 className="text-sm font-black text-[#2d2721]">⚔️ 学校対決（直対成績・成績比較）<span className="ml-2 text-[10px] font-bold text-rose-500 border border-rose-200 rounded px-1.5 py-0.5 align-middle">非公開</span></h4>
        <p className="text-[11px] text-[#a99d8c] leading-snug">2つの学校を選ぶと、{label}の直接対決と成績の比較が見られます（上の「今季／通算」に連動します）。</p>
      </div>
      <div className="p-3 md:p-4 space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <select value={a} onChange={e => setA(e.target.value)} className="flex-1 min-w-[8rem] p-2 border rounded-lg bg-white text-sm font-bold">
            <option value="">学校Aを選ぶ</option>
            {schools.map(sc => <option key={sc} value={sc} disabled={sc === b}>{sc}</option>)}
          </select>
          <span className="text-sm font-black text-[#a99d8c]">VS</span>
          <select value={b} onChange={e => setB(e.target.value)} className="flex-1 min-w-[8rem] p-2 border rounded-lg bg-white text-sm font-bold">
            <option value="">学校Bを選ぶ</option>
            {schools.map(sc => <option key={sc} value={sc} disabled={sc === a}>{sc}</option>)}
          </select>
          <button onClick={() => { setA(b); setB(a); }} disabled={!a && !b} className="text-xs font-bold px-3 py-2 rounded-lg border border-[#d4c9b7] text-[#82786b] hover:bg-[#f3eee4] disabled:opacity-40">⇄ 入れ替え</button>
        </div>

        {!ready ? (
          <p className="text-xs text-[#a99d8c] py-4 text-center">{schools.length < 2 ? '学校が2つ以上設定されると比較できます。' : '異なる2つの学校を選んでください。'}</p>
        ) : (
          <>
            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🥊 直接対決（同じ卓になった半荘）</h5>
              {total === 0 ? (
                <p className="text-xs text-[#a99d8c]">{label}に、この2校が同卓した記録はありません。</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-sm font-black mb-1">
                    <span className="text-[#a62b17]">{a} <span className="tabular-nums">{h2h!.aWins}勝</span></span>
                    <span className="text-[#a99d8c] text-xs">{total}卓{h2h!.draws > 0 ? `（引分${h2h!.draws}）` : ''}</span>
                    <span className="text-rose-600"><span className="tabular-nums">{h2h!.bWins}勝</span> {b}</span>
                  </div>
                  <div className="flex h-4 rounded-full overflow-hidden bg-[#f3eee4]">
                    <div className="bg-[#d9452b]" style={{ width: `${(h2h!.aWins / total) * 100}%` }} />
                    <div className="bg-[#d4c9b7]" style={{ width: `${(h2h!.draws / total) * 100}%` }} />
                    <div className="bg-rose-500" style={{ width: `${(h2h!.bWins / total) * 100}%` }} />
                  </div>
                  <p className="text-xs text-[#82786b] mt-2">
                    ポイント差の合計（{a}−{b}）：<span className={`font-black tabular-nums ${ptClass(h2h!.diffSum)}`}>{fmtPt(h2h!.diffSum)}</span>
                    　1卓あたり：<span className={`font-black tabular-nums ${ptClass(h2h!.diffSum)}`}>{fmtPt(schoolR1(h2h!.diffSum / total))}</span>
                  </p>
                </>
              )}
              <p className="text-[11px] text-[#a99d8c] mt-1">同卓した半荘ごとに、各校の選手のポイント平均を比べて勝敗を決めています（人数が違っても公平になるよう平均です）。</p>
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">📊 成績比較（{label}）</h5>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#f3eee4] text-[#625a4f] text-xs">
                      <th className="p-2 text-right font-bold w-1/3 text-[#a62b17]">{a}</th>
                      <th className="p-2 text-center font-bold">項目</th>
                      <th className="p-2 text-left font-bold w-1/3 text-rose-600">{b}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(m => {
                      const w = winner(m);
                      return (
                        <tr key={m.label} className="border-b border-[#f3eee4]">
                          <td className={`p-2 text-right tabular-nums ${w === 'a' ? 'font-black text-[#a62b17] bg-[#fdf1ed]' : 'text-[#625a4f]'}`}>{m.skip ? '-' : m.fmt(m.av)}{w === 'a' ? ' ◀' : ''}</td>
                          <td className="p-2 text-center text-xs text-[#82786b] whitespace-nowrap">{m.label}</td>
                          <td className={`p-2 text-left tabular-nums ${w === 'b' ? 'font-black text-rose-600 bg-rose-50' : 'text-[#625a4f]'}`}>{w === 'b' ? '▶ ' : ''}{m.skip ? '-' : m.fmt(m.bv)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-[#a99d8c] mt-1">優勢な項目数（人数・半荘数を除く）：{a} {aWinCount} ／ {b} {bWinCount}</p>
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🎯 着順分布の比較</h5>
              {sa.games === 0 && sb.games === 0 ? (
                <p className="text-xs text-[#a99d8c]">記録がありません。</p>
              ) : (
                <div className="space-y-1.5">
                  {[0, 1, 2, 3].map(i => {
                    const pa = rate(sa.dist[i], sa.games);
                    const pb = rate(sb.dist[i], sb.games);
                    return (
                      <div key={i} className="grid grid-cols-[1fr_2.5rem_1fr] items-center gap-2 text-xs">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="tabular-nums text-[#82786b]">{pa.toFixed(0)}%</span>
                          <div className="w-full max-w-[10rem] h-3 bg-[#f3eee4] rounded-full overflow-hidden flex justify-end"><div className="h-full bg-[#d9452b]" style={{ width: `${(pa / distMax) * 100}%` }} /></div>
                        </div>
                        <span className="text-center font-bold text-[#82786b]">{SCHOOL_RANK_LABELS[i]}</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-full max-w-[10rem] h-3 bg-[#f3eee4] rounded-full overflow-hidden"><div className="h-full bg-rose-500" style={{ width: `${(pb / distMax) * 100}%` }} /></div>
                          <span className="tabular-nums text-[#82786b]">{pb.toFixed(0)}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🏆 大会別の比較（合計ポイントと、学校どうしの順位）</h5>
              {tourneys.length === 0 ? (
                <p className="text-xs text-[#a99d8c]">記録がありません。</p>
              ) : (
                <div className="space-y-1.5">
                  {tourneys.map(t => {
                    const ap = t.a ? schoolR1(t.a.point) : null;
                    const bp = t.b ? schoolR1(t.b.point) : null;
                    const aw = ap !== null && bp !== null && ap > bp;
                    const bw = ap !== null && bp !== null && bp > ap;
                    return (
                      <div key={t.key} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2 text-xs">
                        <div className={`text-right tabular-nums ${aw ? 'font-black text-[#a62b17]' : 'text-[#82786b]'}`}>
                          {t.a ? <>{fmtPt(ap!)} <span className="text-[10px] text-[#a99d8c]">（{t.a.rank}/{t.a.total}位）</span></> : <span className="text-[#d4c9b7]">不参加</span>}
                        </div>
                        <span className="font-bold text-[#625a4f] whitespace-nowrap">{t.tName}</span>
                        <div className={`text-left tabular-nums ${bw ? 'font-black text-rose-600' : 'text-[#82786b]'}`}>
                          {t.b ? <>{fmtPt(bp!)} <span className="text-[10px] text-[#a99d8c]">（{t.b.rank}/{t.b.total}位）</span></> : <span className="text-[#d4c9b7]">不参加</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {h2h && h2h.rows.length > 0 && (
              <div>
                <button onClick={() => setShowTables(!showTables)} className="text-xs font-black text-[#473f36] flex items-center gap-1">
                  🀄 同卓した半荘の一覧（{h2h.rows.length}卓） <span className="text-[#a99d8c]">{showTables ? '▲' : '▼'}</span>
                </button>
                {showTables && (
                  <div className="mt-2 border border-[#e7dfd1] rounded-lg divide-y divide-[#f3eee4] max-h-96 overflow-y-auto">
                    {h2h.rows.map(r => {
                      const isOpen = openGame === r.g.id;
                      return (
                        <div key={r.g.id}>
                          <button onClick={() => setOpenGame(isOpen ? null : r.g.id)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#faf7f1] text-xs">
                            <span className="font-bold text-[#625a4f] truncate flex-1">{r.g.label}</span>
                            <span className={`tabular-nums font-black ${r.a > r.b ? 'text-[#a62b17]' : 'text-[#a99d8c]'}`}>{fmtPt(schoolR1(r.a))}</span>
                            <span className="text-[#d4c9b7]">-</span>
                            <span className={`tabular-nums font-black ${r.b > r.a ? 'text-rose-600' : 'text-[#a99d8c]'}`}>{fmtPt(schoolR1(r.b))}</span>
                          </button>
                          {isOpen && <SchoolTablePlayers players={r.g.players} highlight={[a, b]} />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};

// ==========================================
// 同卓数の分析・個人対決・管理用データの部品（管理者のみ）
// ==========================================
type PlayerOption = { key: string; name: string };
type TourneyStanding = { key: string; name: string; tKey: string; tName: string; tOrder: number; season: boolean; separate: boolean; point: number; rank: number; total: number; gameCount: number };

// ---- 同卓数: 「ともに参加した大会で、同じ卓になった回数」が、ランダムな卓組での期待値からどれだけ外れているか ----
// 1回戦あたり N 人が出場、1卓 k 人のとき、2人が同じ卓になる確率は (k-1)/(N-1)。
// 大会 t で A が a 回戦、B が b 回戦（全 R 回戦のうち）出場していれば、期待値 E = a·b/R × (k-1)/(N-1)。
// 分散は各回戦を独立な試行とみなして V = R·q(1-q)（q = 1回戦あたりの同卓確率）。標準化スコア z = (実際 − E) / √V。
type CoSeatPair = { ka: string; kb: string; na: string; nb: string; o: number; e: number; v: number; z: number; ratio: number; tours: number };
const coSeatKey = (a: string, b: string) => (a < b ? `${a}\u0001${b}` : `${b}\u0001${a}`);

const buildCoSeatStats = (games: SGame[], scope: SchoolScope): CoSeatPair[] => {
  const byT = new Map<string, SGame[]>();
  games.filter(g => schoolInScope(g, scope)).forEach(g => {
    const arr = byT.get(g.tKey);
    if (arr) arr.push(g); else byT.set(g.tKey, [g]);
  });
  const acc = new Map<string, CoSeatPair>();
  const names = new Map<string, string>();
  const getPair = (ka: string, kb: string) => {
    const key = coSeatKey(ka, kb);
    let p = acc.get(key);
    if (!p) {
      const [x, y] = ka < kb ? [ka, kb] : [kb, ka];
      p = { ka: x, kb: y, na: names.get(x) || x, nb: names.get(y) || y, o: 0, e: 0, v: 0, z: 0, ratio: 0, tours: 0 };
      acc.set(key, p);
    }
    return p;
  };
  byT.forEach(tg => {
    const cnt = new Map<string, number>();
    let pg = 0;
    tg.forEach(g => g.players.forEach(p => { cnt.set(p.key, (cnt.get(p.key) || 0) + 1); names.set(p.key, p.name); pg += 1; }));
    if (cnt.size < 2) return;
    // 回戦数: 回戦の情報があればその種類数、なければ最も多く出場した選手の半荘数
    const R = Math.max(1, tg.every(g => g.round !== null) ? new Set(tg.map(g => g.round)).size : Math.max(...Array.from(cnt.values())));
    const kbar = pg / tg.length; // 1卓の平均人数
    const N = pg / R;            // 1回戦あたりの出場人数
    if (N <= 1 || kbar <= 1) return;
    const base = (kbar - 1) / (N - 1);
    const keys = Array.from(cnt.keys());
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const q = Math.min(1, ((cnt.get(keys[i])! * cnt.get(keys[j])!) / (R * R)) * base);
        const p = getPair(keys[i], keys[j]);
        p.e += R * q;
        p.v += R * q * (1 - q);
        p.tours += 1;
      }
    }
    tg.forEach(g => {
      for (let i = 0; i < g.players.length; i++) {
        for (let j = i + 1; j < g.players.length; j++) {
          if (g.players[i].key !== g.players[j].key) getPair(g.players[i].key, g.players[j].key).o += 1;
        }
      }
    });
  });
  const out = Array.from(acc.values());
  out.forEach(p => {
    p.z = p.v > 0 ? (p.o - p.e) / Math.sqrt(p.v) : 0;
    p.ratio = p.e > 0 ? p.o / p.e : 0;
  });
  return out;
};

const coSeatVerdict = (z: number) =>
  z >= 2 ? { label: 'かなり多く同卓', cls: 'bg-rose-100 text-rose-700 border-rose-200' }
  : z >= 1 ? { label: 'やや多め', cls: 'bg-orange-100 text-orange-700 border-orange-200' }
  : z <= -2 ? { label: 'ほとんど同卓せず', cls: 'bg-sky-100 text-sky-700 border-sky-200' }
  : z <= -1 ? { label: 'やや少なめ', cls: 'bg-cyan-100 text-cyan-700 border-cyan-200' }
  : { label: '想定どおり', cls: 'bg-[#f3eee4] text-[#82786b] border-[#e7dfd1]' };
const fmtSigned = (v: number, d = 1) => `${v > 0 ? '+' : ''}${v.toFixed(d)}`;

const poissonPmf = (k: number, lambda: number) => {
  if (lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return p;
};

const CoSeatRow = ({ p, focus, i }: { p: CoSeatPair; focus: string; i: number }) => {
  const v = coSeatVerdict(p.z);
  const [left, right] = focus && p.kb === focus ? [p.nb, p.na] : [p.na, p.nb];
  const width = Math.min(100, (Math.abs(p.z) / 4) * 100);
  return (
    <li className="px-3 py-2 text-sm">
      <div className="flex items-center gap-2">
        <span className="w-5 text-right text-xs font-black text-[#a99d8c] tabular-nums">{i + 1}</span>
        <span className="flex-1 min-w-0 truncate font-bold text-[#473f36]">
          {focus ? <PlayerLabel name={right} /> : <><PlayerLabel name={left} /><span className="mx-1 text-[#d4c9b7]">×</span><PlayerLabel name={right} /></>}
        </span>
        <span className={`text-[10px] font-black px-1.5 py-0.5 rounded-full border whitespace-nowrap ${v.cls}`}>{v.label}</span>
        <span className={`w-14 text-right font-black tabular-nums ${p.z > 0 ? 'text-rose-600' : p.z < 0 ? 'text-sky-600' : 'text-[#a99d8c]'}`}>{fmtSigned(p.z)}σ</span>
      </div>
      <div className="mt-1 ml-7 flex items-center gap-2">
        <div className="flex-1 h-1.5 rounded-full bg-[#f3eee4] overflow-hidden">
          <div className={`h-full rounded-full ${p.z >= 0 ? 'bg-gradient-to-r from-orange-400 to-rose-500' : 'bg-gradient-to-r from-cyan-400 to-sky-500'}`} style={{ width: `${width}%` }} />
        </div>
        <span className="text-[11px] text-[#a99d8c] tabular-nums whitespace-nowrap">実際 {p.o}回 / 期待 {p.e.toFixed(1)}回（{fmtSigned(p.o - p.e)}）・共通{p.tours}大会</span>
      </div>
    </li>
  );
};

const CoSeatPanel = ({ games, scope, players }: { games: SGame[]; scope: SchoolScope; players: PlayerOption[] }) => {
  const [minE, setMinE] = useState(2);
  const [focus, setFocus] = useState('');
  const label = scope === 'season' ? '今季' : '通算';
  const stats = buildCoSeatStats(games, scope);
  const eligible = stats.filter(p => p.e >= minE && (!focus || p.ka === focus || p.kb === focus));
  const more = [...eligible].filter(p => p.z > 0).sort((x, y) => y.z - x.z || y.o - x.o).slice(0, 10);
  const less = [...eligible].filter(p => p.z < 0).sort((x, y) => x.z - y.z || y.e - x.e).slice(0, 10);

  // 同卓回数の分布: 実際の組数 と、ランダムな卓組なら期待される組数（各組の同卓回数をポアソン分布とみなして合計）
  const BINS = 7; // 0,1,2,3,4,5,6回以上
  const actual = new Array(BINS).fill(0) as number[];
  const expected = new Array(BINS).fill(0) as number[];
  eligible.forEach(p => {
    actual[Math.min(BINS - 1, p.o)] += 1;
    let cum = 0;
    for (let k = 0; k < BINS - 1; k++) { const pk = poissonPmf(k, p.e); expected[k] += pk; cum += pk; }
    expected[BINS - 1] += Math.max(0, 1 - cum);
  });
  const hMax = Math.max(1, ...actual, ...expected);
  const sd = eligible.length ? Math.sqrt(eligible.reduce((a, p) => a + p.z * p.z, 0) / eligible.length) : 0;
  const strong = eligible.filter(p => p.z >= 2).length;
  const weak = eligible.filter(p => p.z <= -2).length;

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-[#e7dfd1] p-3 md:p-4 space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#82786b]">
            期待同卓回数が
            <select value={minE} onChange={e => setMinE(Number(e.target.value))} className="p-1 border rounded-md bg-white text-xs font-bold">
              {[1, 2, 3, 4].map(n => <option key={n} value={n}>{n}回以上</option>)}
            </select>
            の組が対象
          </label>
          <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#82786b]">
            選手で絞る
            <select value={focus} onChange={e => setFocus(e.target.value)} className="p-1 border rounded-md bg-white text-xs font-bold max-w-[10rem]">
              <option value="">全員</option>
              {players.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}
            </select>
          </label>
          <span className="text-[11px] text-[#a99d8c]">{label}・対象 {eligible.length}組 ／ 全{stats.length}組</span>
        </div>
        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-lg bg-[#faf7f1] border border-[#e7dfd1] py-2"><p className="text-[10px] font-bold text-[#a99d8c]">偏りの大きさ（標準偏差）</p><p className="text-xl font-black tabular-nums text-[#2d2721]">{sd.toFixed(2)}<span className="text-xs text-[#a99d8c]">σ</span></p><p className="text-[10px] text-[#a99d8c]">1.0に近いほど均等</p></div>
          <div className="rounded-lg bg-rose-50 border border-rose-100 py-2"><p className="text-[10px] font-bold text-rose-400">かなり多く同卓（+2σ以上）</p><p className="text-xl font-black tabular-nums text-rose-600">{strong}<span className="text-xs">組</span></p></div>
          <div className="rounded-lg bg-sky-50 border border-sky-100 py-2"><p className="text-[10px] font-bold text-sky-400">ほとんど同卓せず（−2σ以下）</p><p className="text-xl font-black tabular-nums text-sky-600">{weak}<span className="text-xs">組</span></p></div>
        </div>
        <div>
          <h5 className="text-xs font-black text-[#473f36] mb-2">📊 同卓回数の分布（実際 vs ランダムな卓組での期待）</h5>
          {eligible.length === 0 ? (
            <p className="text-xs text-[#a99d8c]">対象の組がありません。</p>
          ) : (
            <div className="flex items-end gap-2 h-36">
              {actual.map((a, k) => (
                <div key={k} className="flex-1 flex flex-col items-center justify-end h-full min-w-0">
                  <div className="flex items-end gap-0.5 w-full flex-1">
                    <div className="flex-1 rounded-t bg-gradient-to-t from-[#c8361e] to-[#b8892b]" style={{ height: `${(a / hMax) * 100}%` }} title={`実際 ${a}組`} />
                    <div className="flex-1 rounded-t bg-gradient-to-t from-[#d4c9b7] to-[#e7dfd1] border border-[#d4c9b7]" style={{ height: `${(expected[k] / hMax) * 100}%` }} title={`期待 ${expected[k].toFixed(1)}組`} />
                  </div>
                  <span className="mt-1 text-[10px] font-bold text-[#82786b]">{k === BINS - 1 ? `${k}+` : k}回</span>
                  <span className="text-[9px] text-[#a99d8c] tabular-nums">{a} / {expected[k].toFixed(0)}</span>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-[#a99d8c] mt-1 flex flex-wrap gap-x-3">
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-gradient-to-t from-[#c8361e] to-[#b8892b] align-middle mr-1" />実際の組数</span>
            <span><span className="inline-block w-2.5 h-2.5 rounded-sm bg-[#e7dfd1] border border-[#d4c9b7] align-middle mr-1" />期待される組数</span>
            <span>下の数字は「実際 / 期待」</span>
          </p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-gradient-to-r from-rose-50 to-white">
            <h4 className="text-sm font-black text-[#2d2721]">🔥 通常より同卓している組</h4>
            <p className="text-[11px] text-[#a99d8c] leading-snug">期待値を上回っている順（標準化スコア σ）</p>
          </div>
          {more.length === 0 ? <p className="px-3 py-4 text-center text-xs text-[#a99d8c]">該当する組がありません。</p> : <ol className="divide-y divide-[#f3eee4]">{more.map((p, i) => <CoSeatRow key={`${p.ka}-${p.kb}`} p={p} focus={focus} i={i} />)}</ol>}
        </section>
        <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
          <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-gradient-to-r from-sky-50 to-white">
            <h4 className="text-sm font-black text-[#2d2721]">🧊 通常より同卓していない組</h4>
            <p className="text-[11px] text-[#a99d8c] leading-snug">期待値を下回っている順（標準化スコア σ）</p>
          </div>
          {less.length === 0 ? <p className="px-3 py-4 text-center text-xs text-[#a99d8c]">該当する組がありません。</p> : <ol className="divide-y divide-[#f3eee4]">{less.map((p, i) => <CoSeatRow key={`${p.ka}-${p.kb}`} p={p} focus={focus} i={i} />)}</ol>}
        </section>
      </div>
      <p className="text-[11px] text-[#a99d8c] leading-relaxed">
        ともに参加した大会ごとに「ランダムに卓を組んだときの同卓回数の期待値」を計算し、実際の同卓回数との差を標準化したものです（+は期待より多く、−は少なく同卓）。
        抜け番・出場回戦数の違いも考慮しています。大会の序盤は回転式、終盤は順位順の卓組のため完全なランダムではなく、あくまで偏りの目安です（±2σを超えると、かなり珍しい偏りです）。
      </p>
    </div>
  );
};

// ---- 個人対決 ----
type PlayerSummary = { key: string; name: string; games: number; point: number; rankSum: number; dist: number[]; maxScore: { score: number; label: string } | null };
const buildPlayerSummary = (games: SGame[], scope: SchoolScope, key: string, name: string): PlayerSummary => {
  const s: PlayerSummary = { key, name, games: 0, point: 0, rankSum: 0, dist: [0, 0, 0, 0], maxScore: null };
  games.filter(g => schoolInScope(g, scope)).forEach(g => {
    const p = g.players.find(x => x.key === key);
    if (!p) return;
    s.games += 1; s.point += p.point; s.rankSum += p.rank;
    if (p.rank >= 1 && p.rank <= 4) s.dist[p.rank - 1] += 1;
    if (!s.maxScore || p.score > s.maxScore.score) s.maxScore = { score: p.score, label: g.label };
  });
  return s;
};

const PlayerH2HPanel = ({
  players, games, standings, scope, a, b, setA, setB,
}: {
  players: PlayerOption[];
  games: SGame[];
  standings: TourneyStanding[];
  scope: SchoolScope;
  a: string;
  b: string;
  setA: (v: string) => void;
  setB: (v: string) => void;
}) => {
  const [showTables, setShowTables] = useState(false);
  const [openGame, setOpenGame] = useState<string | null>(null);
  const label = scope === 'season' ? '今季' : '通算';
  const ready = !!a && !!b && a !== b;
  const na = players.find(p => p.key === a)?.name || '';
  const nb = players.find(p => p.key === b)?.name || '';
  const sa = ready ? buildPlayerSummary(games, scope, a, na) : null;
  const sb = ready ? buildPlayerSummary(games, scope, b, nb) : null;

  const h2h = (() => {
    if (!ready) return null;
    const rows: { g: SGame; a: SGPlayer; b: SGPlayer }[] = [];
    let aWins = 0, bWins = 0, draws = 0, diffSum = 0;
    games.filter(g => schoolInScope(g, scope)).forEach(g => {
      const pa = g.players.find(x => x.key === a);
      const pb = g.players.find(x => x.key === b);
      if (!pa || !pb) return;
      rows.push({ g, a: pa, b: pb });
      diffSum += pa.point - pb.point;
      if (pa.rank < pb.rank) aWins += 1; else if (pa.rank > pb.rank) bWins += 1; else draws += 1;
    });
    rows.sort((x, y) => (y.g.tOrder === x.g.tOrder ? 0 : y.g.tOrder - x.g.tOrder));
    return { rows, aWins, bWins, draws, diffSum: schoolR1(diffSum) };
  })();
  const co = ready ? buildCoSeatStats(games, scope).find(p => coSeatKey(p.ka, p.kb) === coSeatKey(a, b)) || null : null;

  type Metric = { label: string; av: number; bv: number; fmt: (v: number) => string; better: 'high' | 'low' | 'none'; skip?: boolean };
  const rate = (n: number, d: number) => (d > 0 ? (n / d) * 100 : 0);
  const metrics: Metric[] = sa && sb ? [
    { label: '半荘数', av: sa.games, bv: sb.games, fmt: v => `${v}`, better: 'none' },
    { label: '合計ポイント', av: schoolR1(sa.point), bv: schoolR1(sb.point), fmt: fmtPt, better: 'high' },
    { label: '1半荘あたり', av: sa.games ? schoolR1(sa.point / sa.games) : 0, bv: sb.games ? schoolR1(sb.point / sb.games) : 0, fmt: fmtPt, better: 'high', skip: !sa.games || !sb.games },
    { label: '平均着順', av: sa.games ? sa.rankSum / sa.games : 0, bv: sb.games ? sb.rankSum / sb.games : 0, fmt: v => v.toFixed(2), better: 'low', skip: !sa.games || !sb.games },
    { label: '1着率', av: rate(sa.dist[0], sa.games), bv: rate(sb.dist[0], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'high', skip: !sa.games || !sb.games },
    { label: '連対率（1・2着）', av: rate(sa.dist[0] + sa.dist[1], sa.games), bv: rate(sb.dist[0] + sb.dist[1], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'high', skip: !sa.games || !sb.games },
    { label: 'ラス率（4着）', av: rate(sa.dist[3], sa.games), bv: rate(sb.dist[3], sb.games), fmt: v => `${v.toFixed(1)}%`, better: 'low', skip: !sa.games || !sb.games },
    { label: '最高スコア', av: sa.maxScore?.score ?? 0, bv: sb.maxScore?.score ?? 0, fmt: v => (v ? `${v.toLocaleString()}点` : '-'), better: 'high', skip: !sa.maxScore || !sb.maxScore },
  ] : [];
  const winner = (m: Metric): 'a' | 'b' | null => {
    if (m.better === 'none' || m.skip || m.av === m.bv) return null;
    return (m.better === 'high' ? m.av > m.bv : m.av < m.bv) ? 'a' : 'b';
  };
  const aWinCount = metrics.filter(m => winner(m) === 'a').length;
  const bWinCount = metrics.filter(m => winner(m) === 'b').length;

  const tourneys = (() => {
    if (!ready) return [];
    const m = new Map<string, { tName: string; order: number; a?: TourneyStanding; b?: TourneyStanding }>();
    standings.filter(s => scope === 'all' || s.season).forEach(s => {
      if (s.key !== a && s.key !== b) return;
      const cur = m.get(s.tKey) || { tName: s.tName, order: s.tOrder };
      if (s.key === a) cur.a = s; else cur.b = s;
      m.set(s.tKey, cur);
    });
    return Array.from(m.entries()).map(([k, v]) => ({ key: k, ...v })).sort((x, y) => y.order - x.order);
  })();
  const total = h2h ? h2h.aWins + h2h.bWins + h2h.draws : 0;
  const distMax = sa && sb ? Math.max(1, ...sa.dist.map(c => rate(c, sa.games)), ...sb.dist.map(c => rate(c, sb.games))) : 1;

  return (
    <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
      <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-[#faf7f1]">
        <h4 className="text-sm font-black text-[#2d2721]">🥊 個人対決（直対成績・成績比較）<span className="ml-2 text-[10px] font-bold text-rose-500 border border-rose-200 rounded px-1.5 py-0.5 align-middle">管理者のみ</span></h4>
        <p className="text-[11px] text-[#a99d8c] leading-snug">2人の選手を選ぶと、{label}の直接対決（同卓した半荘の着順の勝敗）と成績の比較が見られます。</p>
      </div>
      <div className="p-3 md:p-4 space-y-5">
        <div className="flex flex-wrap items-center gap-2">
          <select value={a} onChange={e => setA(e.target.value)} className="flex-1 min-w-[8rem] p-2 border rounded-lg bg-white text-sm font-bold">
            <option value="">選手Aを選ぶ</option>
            {players.map(p => <option key={p.key} value={p.key} disabled={p.key === b}>{p.name}</option>)}
          </select>
          <span className="text-sm font-black text-[#a99d8c]">VS</span>
          <select value={b} onChange={e => setB(e.target.value)} className="flex-1 min-w-[8rem] p-2 border rounded-lg bg-white text-sm font-bold">
            <option value="">選手Bを選ぶ</option>
            {players.map(p => <option key={p.key} value={p.key} disabled={p.key === a}>{p.name}</option>)}
          </select>
          <button onClick={() => { setA(b); setB(a); }} disabled={!a && !b} className="text-xs font-bold px-3 py-2 rounded-lg border border-[#d4c9b7] text-[#82786b] hover:bg-[#f3eee4] disabled:opacity-40">⇄ 入れ替え</button>
        </div>

        {!ready || !sa || !sb ? (
          <p className="text-xs text-[#a99d8c] py-4 text-center">異なる2人の選手を選んでください。</p>
        ) : (
          <>
            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">⚔️ 直接対決（同じ卓になった半荘）</h5>
              {total === 0 ? (
                <p className="text-xs text-[#a99d8c]">{label}に、この2人が同卓した記録はありません。</p>
              ) : (
                <>
                  <div className="flex items-center justify-between text-sm font-black mb-1">
                    <span className="text-[#a62b17]">{na} <span className="tabular-nums">{h2h!.aWins}勝</span></span>
                    <span className="text-[#a99d8c] text-xs">{total}戦{h2h!.draws > 0 ? `（引分${h2h!.draws}）` : ''}</span>
                    <span className="text-rose-600"><span className="tabular-nums">{h2h!.bWins}勝</span> {nb}</span>
                  </div>
                  <div className="flex h-4 rounded-full overflow-hidden bg-[#f3eee4]">
                    <div className="bg-[#d9452b]" style={{ width: `${(h2h!.aWins / total) * 100}%` }} />
                    <div className="bg-[#d4c9b7]" style={{ width: `${(h2h!.draws / total) * 100}%` }} />
                    <div className="bg-rose-500" style={{ width: `${(h2h!.bWins / total) * 100}%` }} />
                  </div>
                  <p className="text-xs text-[#82786b] mt-2">
                    ポイント差の合計（{na}−{nb}）：<span className={`font-black tabular-nums ${ptClass(h2h!.diffSum)}`}>{fmtPt(h2h!.diffSum)}</span>
                    　1戦あたり：<span className={`font-black tabular-nums ${ptClass(h2h!.diffSum)}`}>{fmtPt(schoolR1(h2h!.diffSum / total))}</span>
                  </p>
                </>
              )}
              <p className="text-[11px] text-[#a99d8c] mt-1">同じ卓の半荘ごとに、着順が上だった方の勝ちとしています。</p>
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🎲 同卓の回数（期待値との比較）</h5>
              {!co ? (
                <p className="text-xs text-[#a99d8c]">ともに参加した大会がないため、期待値を計算できません。</p>
              ) : (
                <div className="rounded-lg border border-[#e7dfd1] bg-[#faf7f1] px-3 py-2.5 flex flex-wrap items-center gap-x-5 gap-y-1">
                  <span className="text-sm text-[#625a4f]">実際 <span className="text-xl font-black tabular-nums text-[#2d2721]">{co.o}</span>回</span>
                  <span className="text-sm text-[#625a4f]">期待 <span className="text-xl font-black tabular-nums text-[#82786b]">{co.e.toFixed(1)}</span>回</span>
                  <span className={`text-sm font-black tabular-nums ${co.z > 0 ? 'text-rose-600' : co.z < 0 ? 'text-sky-600' : 'text-[#a99d8c]'}`}>{fmtSigned(co.o - co.e)}回（{fmtSigned(co.z)}σ）</span>
                  <span className={`text-[11px] font-black px-2 py-0.5 rounded-full border ${coSeatVerdict(co.z).cls}`}>{coSeatVerdict(co.z).label}</span>
                  <span className="text-[11px] text-[#a99d8c]">共通の大会 {co.tours}</span>
                </div>
              )}
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">📊 成績比較（{label}）</h5>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-[#f3eee4] text-[#625a4f] text-xs">
                      <th className="p-2 text-right font-bold w-1/3 text-[#a62b17]">{na}</th>
                      <th className="p-2 text-center font-bold">項目</th>
                      <th className="p-2 text-left font-bold w-1/3 text-rose-600">{nb}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {metrics.map(m => {
                      const w = winner(m);
                      return (
                        <tr key={m.label} className="border-b border-[#f3eee4]">
                          <td className={`p-2 text-right tabular-nums ${w === 'a' ? 'font-black text-[#a62b17] bg-[#fdf1ed]' : 'text-[#625a4f]'}`}>{m.skip ? '-' : m.fmt(m.av)}{w === 'a' ? ' ◀' : ''}</td>
                          <td className="p-2 text-center text-xs text-[#82786b] whitespace-nowrap">{m.label}</td>
                          <td className={`p-2 text-left tabular-nums ${w === 'b' ? 'font-black text-rose-600 bg-rose-50' : 'text-[#625a4f]'}`}>{w === 'b' ? '▶ ' : ''}{m.skip ? '-' : m.fmt(m.bv)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p className="text-[11px] text-[#a99d8c] mt-1">優勢な項目数（半荘数を除く）：{na} {aWinCount} ／ {nb} {bWinCount}</p>
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🎯 着順分布の比較</h5>
              {sa.games === 0 && sb.games === 0 ? (
                <p className="text-xs text-[#a99d8c]">記録がありません。</p>
              ) : (
                <div className="space-y-1.5">
                  {[0, 1, 2, 3].map(i => {
                    const pa = rate(sa.dist[i], sa.games);
                    const pb = rate(sb.dist[i], sb.games);
                    return (
                      <div key={i} className="grid grid-cols-[1fr_2.5rem_1fr] items-center gap-2 text-xs">
                        <div className="flex items-center justify-end gap-1.5">
                          <span className="tabular-nums text-[#82786b]">{pa.toFixed(0)}%</span>
                          <div className="w-full max-w-[10rem] h-3 bg-[#f3eee4] rounded-full overflow-hidden flex justify-end"><div className="h-full bg-[#d9452b]" style={{ width: `${(pa / distMax) * 100}%` }} /></div>
                        </div>
                        <span className="text-center font-bold text-[#82786b]">{SCHOOL_RANK_LABELS[i]}</span>
                        <div className="flex items-center gap-1.5">
                          <div className="w-full max-w-[10rem] h-3 bg-[#f3eee4] rounded-full overflow-hidden"><div className="h-full bg-rose-500" style={{ width: `${(pb / distMax) * 100}%` }} /></div>
                          <span className="tabular-nums text-[#82786b]">{pb.toFixed(0)}%</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div>
              <h5 className="text-xs font-black text-[#473f36] mb-2">🏆 大会別の比較（最終スコアと順位）</h5>
              {tourneys.length === 0 ? (
                <p className="text-xs text-[#a99d8c]">記録がありません。</p>
              ) : (
                <div className="space-y-1.5">
                  {tourneys.map(t => {
                    const ap = t.a ? schoolR1(t.a.point) : null;
                    const bp = t.b ? schoolR1(t.b.point) : null;
                    const aw = ap !== null && bp !== null && ap > bp;
                    const bw = ap !== null && bp !== null && bp > ap;
                    return (
                      <div key={t.key} className="grid grid-cols-[1fr_auto_1fr] items-center gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2 text-xs">
                        <div className={`text-right tabular-nums ${aw ? 'font-black text-[#a62b17]' : 'text-[#82786b]'}`}>
                          {t.a ? <>{fmtPt(ap!)} <span className="text-[10px] text-[#a99d8c]">（{t.a.rank}/{t.a.total}位）</span></> : <span className="text-[#d4c9b7]">不参加</span>}
                        </div>
                        <span className="font-bold text-[#625a4f] whitespace-nowrap">{t.tName}</span>
                        <div className={`text-left tabular-nums ${bw ? 'font-black text-rose-600' : 'text-[#82786b]'}`}>
                          {t.b ? <>{fmtPt(bp!)} <span className="text-[10px] text-[#a99d8c]">（{t.b.rank}/{t.b.total}位）</span></> : <span className="text-[#d4c9b7]">不参加</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {h2h && h2h.rows.length > 0 && (
              <div>
                <button onClick={() => setShowTables(!showTables)} className="text-xs font-black text-[#473f36] flex items-center gap-1">
                  🀄 同卓した半荘の一覧（{h2h.rows.length}戦） <span className="text-[#a99d8c]">{showTables ? '▲' : '▼'}</span>
                </button>
                {showTables && (
                  <div className="mt-2 border border-[#e7dfd1] rounded-lg divide-y divide-[#f3eee4] max-h-96 overflow-y-auto">
                    {h2h.rows.map(r => {
                      const isOpen = openGame === r.g.id;
                      return (
                        <div key={r.g.id}>
                          <button onClick={() => setOpenGame(isOpen ? null : r.g.id)} className="w-full flex items-center justify-between gap-2 px-3 py-2 text-left hover:bg-[#faf7f1] text-xs">
                            <span className="font-bold text-[#625a4f] truncate flex-1">{r.g.label}</span>
                            <span className={`tabular-nums font-black ${r.a.rank < r.b.rank ? 'text-[#a62b17]' : 'text-[#a99d8c]'}`}>{r.a.rank}着 {fmtPt(r.a.point)}</span>
                            <span className="text-[#d4c9b7]">-</span>
                            <span className={`tabular-nums font-black ${r.b.rank < r.a.rank ? 'text-rose-600' : 'text-[#a99d8c]'}`}>{r.b.rank}着 {fmtPt(r.b.point)}</span>
                          </button>
                          {isOpen && <SchoolTablePlayers players={r.g.players} highlight={[]} />}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
};

// 管理用データのセクション見出し（アンカー付き）
const AdminSection = ({ id, icon, title, desc, right, children }: { id: string; icon: string; title: string; desc?: string; right?: React.ReactNode; children: React.ReactNode }) => (
  <section id={id} className="scroll-mt-4 space-y-3">
    <div className="flex items-center gap-3">
      <span className="flex-shrink-0 w-10 h-10 rounded-xl bg-gradient-to-br from-[#1c1814] via-[#5e190e] to-[#274066] text-xl flex items-center justify-center shadow-md shadow-[#5e190e]/30 ring-1 ring-white/20">{icon}</span>
      <div className="min-w-0">
        <h3 className="text-lg font-black text-[#1c1814] tracking-wide leading-tight">{title}</h3>
        {desc && <p className="text-[11px] text-[#82786b] leading-snug">{desc}</p>}
      </div>
      <span className="flex-1 h-px bg-gradient-to-r from-[#ef937c]/70 to-transparent" />
      {right}
    </div>
    {children}
  </section>
);

// ==========================================
// 卓組抽選（通常回戦の卓組と席順）
// 優先順位: ① 席順（東南西北）を全員できるだけ公平に → ② 同じ相手とできるだけ同卓しない
// ③ 過去の大会の同卓の偏り（期待値との差）は、同点のときに効く程度の、ごくわずかな参考
// 卓の分け方（誰と同卓するか）と席順（卓内の東南西北）は独立に決められるので、
//   手順1: 焼きなまし法で「同卓の重複が最小になる卓分け」を探す
//   手順2: その卓分けのまま、卓内の席順を入れ替えて「全員の東南西北の回数が均等」になるよう調整する
// を何度も繰り返し、席順の偏りが最小（なるべく0）のものの中から、同卓の重複が最小のものを採用する
// ==========================================
type SeatPlan = {
  tables: string[][][]; // [回戦][卓] = 東南西北の順の選手ID
  windPenalty: number;  // 0 = 全員の東南西北の回数が、可能な限り均等
  pairSq: number;       // 同卓回数の二乗和（小さいほど、同じ相手との同卓が少ない）
  maxPair: number;      // 同じ相手との同卓の最大回数
  repeatPairs: number;  // 2回以上同卓する組の数
  attempts: number;
};

const planSeating = ({ rounds, specialIds, banPair, histBias, timeBudgetMs = 1200, maxAttempts = 80 }: {
  rounds: string[][];                      // 各回戦の出場者（抜け番を除いた4の倍数）
  specialIds: Set<string>;                 // プロ・黒子（1卓に1人まで）
  banPair?: [string, string] | null;       // 同卓は通算1回までの組
  histBias: (a: string, b: string) => number; // 過去の同卓の偏りによる、ごくわずかな加点（正=避けたい、負=歓迎）
  timeBudgetMs?: number;
  maxAttempts?: number;
}): SeatPlan => {
  const ids = Array.from(new Set(rounds.flat()));
  const P = ids.length;
  const idx = new Map(ids.map((id, i) => [id, i] as [string, number]));
  const R = rounds.length;
  const act = rounds.map(r => r.map(id => idx.get(id)!));
  const isSp = ids.map(id => specialIds.has(id));
  const hist = new Float64Array(P * P);
  for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) { const h = histBias(ids[i], ids[j]); hist[i * P + j] = h; hist[j * P + i] = h; }
  const banA = banPair && idx.has(banPair[0]) ? idx.get(banPair[0])! : -1;
  const banB = banPair && idx.has(banPair[1]) ? idx.get(banPair[1])! : -1;
  const WP = 100, HEAVY = 100000;
  const spPen = (n: number) => (n > 1 ? HEAVY * (n - 1) : 0);
  const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const gamesOf = new Int32Array(P);
  act.forEach(a => a.forEach(i => { gamesOf[i] += 1; }));
  const minWindSq = (g: number) => { const q = Math.floor(g / 4), r = g % 4; return (4 - r) * q * q + r * (q + 1) * (q + 1); };

  const attempt = () => {
    const seat = act.map(a => shuffle([...a]));
    const cnt = new Int32Array(P * P);
    const spCount = seat.map(s => { const arr: number[] = []; for (let t = 0; t < s.length / 4; t++) arr.push(0); return arr; });
    seat.forEach((s, r) => {
      for (let t = 0; t < s.length / 4; t++) {
        for (let u = 0; u < 4; u++) {
          if (isSp[s[t * 4 + u]]) spCount[r][t] += 1;
          for (let v = u + 1; v < 4; v++) { const a = s[t * 4 + u], b = s[t * 4 + v]; cnt[a * P + b] += 1; cnt[b * P + a] += 1; }
        }
      }
    });
    const isBan = (i: number, j: number) => (i === banA && j === banB) || (i === banB && j === banA);
    const change = (i: number, j: number, d: number) => {
      const k = i * P + j; const old = cnt[k]; const nw = old + d;
      let delta = WP * (nw * nw - old * old) + hist[k] * d;
      if (isBan(i, j)) delta += HEAVY * (Math.max(0, nw - 1) - Math.max(0, old - 1));
      cnt[k] = nw; cnt[j * P + i] = nw;
      return delta;
    };
    const movable: number[] = [];
    seat.forEach((s, r) => { if (s.length >= 8) movable.push(r); });
    const iters = movable.length ? 2500 * R + 4000 : 0;
    const T0 = 45, T1 = 0.6;
    for (let it = 0; it < iters; it++) {
      const T = T0 * Math.pow(T1 / T0, it / iters);
      const r = movable[Math.floor(Math.random() * movable.length)];
      const s = seat[r];
      const nT = s.length / 4;
      const t1 = Math.floor(Math.random() * nT);
      let t2 = Math.floor(Math.random() * (nT - 1)); if (t2 >= t1) t2 += 1;
      const u1 = Math.floor(Math.random() * 4), u2 = Math.floor(Math.random() * 4);
      const a = s[t1 * 4 + u1], b = s[t2 * 4 + u2];
      let delta = 0;
      for (let u = 0; u < 4; u++) {
        if (u !== u1) { const m = s[t1 * 4 + u]; delta += change(a, m, -1); delta += change(b, m, +1); }
        if (u !== u2) { const m = s[t2 * 4 + u]; delta += change(b, m, -1); delta += change(a, m, +1); }
      }
      const sa = isSp[a] ? 1 : 0, sb = isSp[b] ? 1 : 0;
      const c1 = spCount[r][t1], c2 = spCount[r][t2];
      delta += spPen(c1 - sa + sb) + spPen(c2 - sb + sa) - spPen(c1) - spPen(c2);
      if (delta <= 0 || Math.random() < Math.exp(-delta / T)) {
        s[t1 * 4 + u1] = b; s[t2 * 4 + u2] = a;
        spCount[r][t1] = c1 - sa + sb; spCount[r][t2] = c2 - sb + sa;
      } else {
        for (let u = 0; u < 4; u++) {
          if (u !== u1) { const m = s[t1 * 4 + u]; change(a, m, +1); change(b, m, -1); }
          if (u !== u2) { const m = s[t2 * 4 + u]; change(b, m, +1); change(a, m, -1); }
        }
      }
    }
    // 手順2: 卓分けはそのままで、卓内の席順（東南西北）を調整して、全員の風の回数を均等にする
    let bestWind = Infinity; let bestSeat: number[][] = seat;
    for (let w = 0; w < 4 && bestWind > 0; w++) {
      const cur = seat.map(s => { const c = [...s]; for (let t = 0; t < c.length / 4; t++) { const g = shuffle(c.slice(t * 4, t * 4 + 4)); for (let u = 0; u < 4; u++) c[t * 4 + u] = g[u]; } return c; });
      const wc = new Int32Array(P * 4);
      cur.forEach(s => s.forEach((p, k) => { wc[p * 4 + (k % 4)] += 1; }));
      const tablesList: [number, number][] = [];
      cur.forEach((s, r) => { for (let t = 0; t < s.length / 4; t++) tablesList.push([r, t]); });
      const wIters = 1500 + tablesList.length * 400;
      for (let it = 0; it < wIters; it++) {
        const [r, t] = tablesList[Math.floor(Math.random() * tablesList.length)];
        const u = Math.floor(Math.random() * 4); let v = Math.floor(Math.random() * 3); if (v >= u) v += 1;
        const s = cur[r]; const a = s[t * 4 + u], b = s[t * 4 + v];
        const ca = wc[a * 4 + u], cav = wc[a * 4 + v], cb = wc[b * 4 + v], cbu = wc[b * 4 + u];
        const delta = ((cav + 1) * (cav + 1) - cav * cav) + ((ca - 1) * (ca - 1) - ca * ca) + ((cbu + 1) * (cbu + 1) - cbu * cbu) + ((cb - 1) * (cb - 1) - cb * cb);
        if (delta < 0 || (delta === 0 && Math.random() < 0.5) || (delta === 2 && Math.random() < 0.02)) {
          s[t * 4 + u] = b; s[t * 4 + v] = a;
          wc[a * 4 + u] -= 1; wc[a * 4 + v] += 1; wc[b * 4 + v] -= 1; wc[b * 4 + u] += 1;
        }
      }
      let pen = 0;
      for (let p = 0; p < P; p++) { let sq = 0; for (let k = 0; k < 4; k++) sq += wc[p * 4 + k] * wc[p * 4 + k]; pen += sq - minWindSq(gamesOf[p]); }
      if (pen < bestWind) { bestWind = pen; bestSeat = cur.map(s => [...s]); }
    }
    let pairSq = 0, maxPair = 0, repeatPairs = 0, histSum = 0;
    for (let i = 0; i < P; i++) for (let j = i + 1; j < P; j++) {
      const c = cnt[i * P + j]; pairSq += c * c; if (c > maxPair) maxPair = c; if (c > 1) repeatPairs += 1; histSum += hist[i * P + j] * c;
      if (isBan(i, j) && c > 1) pairSq += 1000;
    }
    return { seat: bestSeat, windPenalty: bestWind, pairSq, repeatPairs, maxPair, histSum };
  };

  const started = Date.now();
  let best: ReturnType<typeof attempt> | null = null;
  let attempts = 0;
  while (attempts < maxAttempts && (attempts < 3 || Date.now() - started < timeBudgetMs)) {
    const a = attempt(); attempts += 1;
    // 席順の偏り → 同卓の重複 → （ごくわずかな参考）過去の同卓の偏り の順に比べる
    if (!best || a.windPenalty < best.windPenalty
      || (a.windPenalty === best.windPenalty && (a.pairSq < best.pairSq || (a.pairSq === best.pairSq && a.histSum < best.histSum)))) best = a;
  }
  const b = best!;
  return {
    tables: b.seat.map(s => { const out: string[][] = []; for (let t = 0; t < s.length / 4; t++) out.push(s.slice(t * 4, t * 4 + 4).map(i => ids[i])); return out; }),
    windPenalty: b.windPenalty, pairSq: b.pairSq, maxPair: b.maxPair, repeatPairs: b.repeatPairs, attempts,
  };
};

// 大会の表彰台（上位3名）。1位を中央に高く、2位を左・3位を右に置く
type PodiumEntry = { rank: number; name: string; point: number; gameCount: number };
const PODIUM_STYLE = [
  { plinth: 'from-[#f6dc8a] via-[#e2b84a] to-[#b8892b]', h: 'h-24', num: 'text-[#5c4315]' },
  { plinth: 'from-[#f1eee8] via-[#d2ccc1] to-[#a39c90]', h: 'h-16', num: 'text-[#473f36]' },
  { plinth: 'from-[#f2bd99] via-[#da8d5e] to-[#a8562f]', h: 'h-12', num: 'text-[#5e2a12]' },
];
const Podium = ({ entries }: { entries: PodiumEntry[] }) => {
  if (entries.length === 0) return <p className="text-xs text-[#a99d8c] text-center py-3">成績がありません。</p>;
  const order = [entries[1], entries[0], entries[2]].filter(Boolean) as PodiumEntry[];
  return (
    <div>
      <div className="flex items-end gap-1.5 sm:gap-2">
        {order.map(e => {
          const st = PODIUM_STYLE[Math.min(2, Math.max(0, e.rank - 1))];
          return (
            <div key={`${e.rank}-${e.name}`} className="flex-1 min-w-0 flex flex-col items-center justify-end">
              {e.rank === 1 && <span className="text-xl leading-none mb-0.5" aria-hidden="true">👑</span>}
              <div className="w-full text-center px-0.5">
                <div className="text-xs sm:text-sm font-black text-[#2d2721] truncate"><PlayerLabel name={e.name} /></div>
                <div className={`font-black tabular-nums text-xl sm:text-2xl leading-tight ${e.point > 0 ? 'text-blue-600' : e.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(e.point)}</div>
                <div className="text-[10px] text-[#a99d8c]">{e.gameCount}半荘</div>
              </div>
              <div className={`mt-1.5 w-full ${st.h} rounded-t-lg bg-gradient-to-b ${st.plinth} flex items-start justify-center pt-1.5`}>
                <span className={`text-3xl font-black leading-none ${st.num}`} style={{ fontFamily: "'Shippori Mincho B1', serif" }}>{e.rank}</span>
              </div>
            </div>
          );
        })}
      </div>
      <div className="h-1.5 rounded-b bg-[#1c1814]" />
    </div>
  );
};

// 個人成績（モーダル）：通算成績・大会別成績・着順分布・半荘ごとの成績・対戦相性・ペナルティ履歴をまとめて表示
type PlayerDetailTableRow = { playerId: string; name: string; rank: number; score: number; point: number; isMe?: boolean };
type PlayerDetailHanchanRow = { rank: number; score: number; point: number; table: PlayerDetailTableRow[] };
type PlayerDetailHanchanGroup = { key: string; label: string; rows: PlayerDetailHanchanRow[] };
// ログイン中の本人だけに見せる「この後の対局」
type UpcomingMatch = {
  key: string;
  roundNo: number;
  time: string | null;
  status: 'ready' | 'pending' | 'sitout';
  tableNo?: number;
  tableLabel?: string; // 卓の表示名（例: 白卓）。無ければ「◯卓」
  wind?: string;
  isFinal?: boolean;
  opponents?: { name: string; wind: string }[];
};

// ==========================================
// 成績表（最高位戦のリーグ戦と同じ形式）。管理者画面に表示し、画像にして X に投稿する
//   列: 順位 / 選手名 / ポイント（今大会の合計）/ 対局数（今大会）/ 各回戦（得失点・着順・合計点）/ 今季通算（今季ここまでの通算ポイント）
//   ・順位・ポイント・対局数は今大会の成績（今大会に出場していない選手・黒子・プロは載せない）
//   ・順位の数字: 4位まで緑、8位まで青、それ以下は黒。ポイントがマイナスの選手は赤
// ==========================================
type SheetRound = { raw: number; rank: number; total: number } | null;
type SheetRow = { rank: number; name: string; point: number; games: number; rounds: SheetRound[]; season: number };
const SHEET = {
  yellow: '#ffffcc',   // 各回戦の欄
  blue: '#c9e4f2',     // 今季通算
  border: '#bdbdbd',
  green: '#1b9a43',
  blueText: '#1f5fd1',
  red: '#e11d1d',
  text: '#111111',
};
const sheetRankColor = (rank: number, point: number) =>
  point < 0 ? SHEET.red : rank <= 4 ? SHEET.green : rank <= 8 ? SHEET.blueText : SHEET.text;
const fmt1 = (v: number) => (Math.round(v * 10) / 10).toFixed(1);
const sheetNumColor = (v: number) => (v < 0 ? SHEET.red : SHEET.text);
// 1卓分のスコアから、順位点（同点は等分）を選手ごとに返す
const tableUmaShares = (scores: number[], uma: number[]): number[] => {
  const idx = scores.map((_, i) => i).sort((a, b) => scores[b] - scores[a]);
  const out: number[] = new Array(scores.length).fill(0);
  let i = 0;
  while (i < idx.length) {
    let j = i;
    while (j < idx.length && scores[idx[j]] === scores[idx[i]]) j++;
    let sum = 0;
    for (let k = i; k < j; k++) sum += uma[k] ?? 0;
    for (let k = i; k < j; k++) out[idx[k]] = sum / (j - i);
    i = j;
  }
  return out;
};
// X の文字数（日本語などは2文字分）の目安
const xWeightedLength = (t: string) => Array.from(t).reduce((n, ch) => n + (ch.charCodeAt(0) <= 0x10ff ? 1 : 2), 0);

// 成績表を画像（canvas）に描く
const renderStandingsSheetCanvas = (rows: SheetRow[], opt: { roundNos: number[]; title: string }): HTMLCanvasElement => {
  const scale = 1.5;
  const rc = opt.roundNos.length; // 表示する回戦の数（最新の4半荘まで）
  const W = { rank: 52, name: 184, point: 88, games: 62, raw: 66, rk: 48, tot: 70, total: 100 };
  const roundW = W.raw + W.rk + W.tot;
  const width = W.rank + W.name + W.point + W.games + roundW * rc + W.total;
  const titleH = 46, hr = 28, rowH = 32;
  const height = titleH + hr * 3 + rowH * rows.length + 8;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  const font = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  // タイトル
  ctx.fillStyle = '#111111';
  ctx.font = `bold 21px ${font}`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  ctx.fillText(opt.title, 8, titleH / 2);

  const cell = (x: number, y: number, w: number, h: number, o: { fill?: string; text?: string; align?: 'left' | 'center' | 'right'; color?: string; bold?: boolean; size?: number }) => {
    ctx.fillStyle = o.fill || '#ffffff';
    ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = SHEET.border;
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (o.text !== undefined && o.text !== '') {
      ctx.fillStyle = o.color || SHEET.text;
      ctx.font = `${o.bold ? 'bold ' : ''}${o.size || 15}px ${font}`;
      ctx.textBaseline = 'middle';
      const align = o.align || 'center';
      ctx.textAlign = align;
      const tx = align === 'left' ? x + 8 : align === 'right' ? x + w - 8 : x + w / 2;
      ctx.fillText(o.text, tx, y + h / 2 + 1);
    }
  };

  let y = titleH;
  // ヘッダー（3段）
  let x = 0;
  const head = (w: number, label: string, fill?: string) => { cell(x, y, w, hr * 3, { text: label, fill, bold: true, size: 15 }); x += w; };
  head(W.rank, '順位'); head(W.name, '選手名'); head(W.point, 'ポイント'); head(W.games, '対局数');
  cell(x, y, roundW * rc, hr, { text: opt.title.split(' ')[0], bold: true, size: 15 });
  for (let r = 0; r < rc; r++) {
    const rx = x + roundW * r;
    cell(rx, y + hr, roundW, hr, { text: `${opt.roundNos[r]}回戦`, size: 14 });
    cell(rx, y + hr * 2, W.raw, hr, { text: '得失点', size: 13 });
    cell(rx + W.raw, y + hr * 2, W.rk, hr, { text: '着順', size: 13 });
    cell(rx + W.raw + W.rk, y + hr * 2, W.tot, hr, { text: '合計点', size: 13 });
  }
  x += roundW * rc;
  head(W.total, '今季通算', SHEET.blue);
  y += hr * 3;

  // 本体
  rows.forEach(row => {
    let cx = 0;
    cell(cx, y, W.rank, rowH, { text: String(row.rank), bold: true, color: sheetRankColor(row.rank, row.point) }); cx += W.rank;
    cell(cx, y, W.name, rowH, { text: row.name, bold: true, align: 'left' }); cx += W.name;
    cell(cx, y, W.point, rowH, { text: fmt1(row.point), bold: true, align: 'right', color: sheetNumColor(row.point) }); cx += W.point;
    cell(cx, y, W.games, rowH, { text: String(row.games), align: 'right' }); cx += W.games;
    for (let r = 0; r < rc; r++) {
      const d = row.rounds[opt.roundNos[r] - 1];
      cell(cx, y, W.raw, rowH, { fill: SHEET.yellow, text: d ? fmt1(d.raw) : '', align: 'right', color: d ? sheetNumColor(d.raw) : undefined }); cx += W.raw;
      cell(cx, y, W.rk, rowH, { fill: SHEET.yellow, text: d ? String(d.rank) : '' }); cx += W.rk;
      cell(cx, y, W.tot, rowH, { fill: SHEET.yellow, text: d ? fmt1(d.total) : '', align: 'right', bold: true, color: d ? sheetNumColor(d.total) : undefined }); cx += W.tot;
    }
    cell(cx, y, W.total, rowH, { fill: SHEET.blue, text: fmt1(row.season), align: 'right', bold: true, color: sheetNumColor(row.season) });
    y += rowH;
  });
  return canvas;
};

// 成績表（画面表示用）
const StandingsSheetTable = ({ rows, roundNos, title }: { rows: SheetRow[]; roundNos: number[]; title: string }) => {
  const th = 'border px-2 py-1 text-center font-bold bg-white whitespace-nowrap';
  const td = 'border px-2 py-1 whitespace-nowrap';
  const bc = { borderColor: SHEET.border };
  return (
    <div>
      <p className="text-sm font-black text-[#473f36] mb-1.5">{title}</p>
      <div className="overflow-x-auto rounded-lg border border-[#e7dfd1] bg-white">
        <table className="border-collapse text-[13px] text-[#1c1814]" style={{ color: SHEET.text }}>
          <thead>
            <tr>
              <th rowSpan={3} className={th} style={bc}>順位</th>
              <th rowSpan={3} className={th} style={bc}>選手名</th>
              <th rowSpan={3} className={th} style={bc}>ポイント</th>
              <th rowSpan={3} className={th} style={bc}>対局数</th>
              <th colSpan={roundNos.length * 3} className={th} style={bc}>{title.split(' ')[0]}</th>
              <th rowSpan={3} className={th} style={{ ...bc, background: SHEET.blue }}>今季通算</th>
            </tr>
            <tr>
              {roundNos.map(n => <th key={n} colSpan={3} className={th} style={bc}>{n}回戦</th>)}
            </tr>
            <tr>
              {roundNos.map(n => (
                <React.Fragment key={n}>
                  <th className={`${th} text-[11px]`} style={bc}>得失点</th>
                  <th className={`${th} text-[11px]`} style={bc}>着順</th>
                  <th className={`${th} text-[11px]`} style={bc}>合計点</th>
                </React.Fragment>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.name + row.rank}>
                <td className={`${td} text-center font-black`} style={{ ...bc, color: sheetRankColor(row.rank, row.point) }}>{row.rank}</td>
                <td className={`${td} font-bold`} style={bc}>{row.name}</td>
                <td className={`${td} text-right font-bold tabular-nums`} style={{ ...bc, color: sheetNumColor(row.point) }}>{fmt1(row.point)}</td>
                <td className={`${td} text-right tabular-nums`} style={bc}>{row.games}</td>
                {roundNos.map(n => {
                  const d = row.rounds[n - 1];
                  return (
                    <React.Fragment key={n}>
                      <td className={`${td} text-right tabular-nums`} style={{ ...bc, background: SHEET.yellow, color: d ? sheetNumColor(d.raw) : undefined }}>{d ? fmt1(d.raw) : ''}</td>
                      <td className={`${td} text-center tabular-nums`} style={{ ...bc, background: SHEET.yellow }}>{d ? d.rank : ''}</td>
                      <td className={`${td} text-right font-bold tabular-nums`} style={{ ...bc, background: SHEET.yellow, color: d ? sheetNumColor(d.total) : undefined }}>{d ? fmt1(d.total) : ''}</td>
                    </React.Fragment>
                  );
                })}
                <td className={`${td} text-right font-bold tabular-nums`} style={{ ...bc, background: SHEET.blue, color: sheetNumColor(row.season) }}>{fmt1(row.season)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// 管理用データの順位表（軽く表示するため簡素な作り）
// 登録済みの学校をクリックで選べるチップ（同じ学校を何度も打ち込まなくて済む）。選択中をもう一度押すと解除
const SchoolChips = ({ options, value, onPick, compact }: { options: string[]; value: string; onPick: (school: string) => void; compact?: boolean }) => {
  if (options.length === 0) return null;
  return (
    <div className={`flex flex-wrap gap-1 ${compact ? 'mt-1 max-h-24 overflow-y-auto' : 'mt-2'}`}>
      {options.map(sc => {
        const on = value.trim() === sc;
        return (
          <button
            key={sc}
            type="button"
            onClick={() => onPick(on ? '' : sc)}
            className={`rounded-full border font-bold transition ${compact ? 'px-2 py-0.5 text-[10px]' : 'px-3 py-1 text-xs'} ${on ? 'bg-[#c8361e] text-white border-[#c8361e]' : 'bg-white text-[#625a4f] border-[#d4c9b7] hover:border-[#e5664c] hover:text-[#a62b17]'}`}
          >{sc}</button>
        );
      })}
    </div>
  );
};

type AdminRow = { rank: number; name: string; value: string; sub?: string };
const AdminRankList = ({ title, desc, rows, extra, emptyText }: { title: string; desc: string; rows: AdminRow[]; extra?: React.ReactNode; emptyText?: string }) => (
  <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
    <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-gradient-to-r from-[#faf7f1] to-white">
      <h4 className="text-sm font-black text-[#2d2721]">{title}</h4>
      <p className="text-[11px] text-[#a99d8c] leading-snug">{desc}</p>
      {extra && <div className="mt-2">{extra}</div>}
    </div>
    {rows.length === 0 ? (
      <p className="px-3 py-4 text-center text-xs text-[#a99d8c]">{emptyText || 'データがありません。'}</p>
    ) : (
      <ol className="divide-y divide-[#f3eee4]">
        {rows.map((r, i) => (
          <li key={`${r.name}-${i}`} className={`flex items-center gap-2 px-3 py-1.5 text-sm ${r.rank === 1 ? 'bg-gradient-to-r from-amber-50/80 to-transparent' : ''}`}>
            <span className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center text-[11px] font-black tabular-nums ${r.rank === 1 ? 'bg-gradient-to-br from-yellow-300 to-amber-500 text-white shadow-sm' : r.rank === 2 ? 'bg-gradient-to-br from-[#d4c9b7] to-[#a99d8c] text-white' : r.rank === 3 ? 'bg-gradient-to-br from-orange-300 to-orange-500 text-white' : 'text-[#a99d8c]'}`}>{r.rank}</span>
            <span className="flex-1 min-w-0 truncate font-bold text-[#473f36]"><PlayerLabel name={r.name} /></span>
            {r.sub && <span className="text-[11px] text-[#a99d8c] whitespace-nowrap">{r.sub}</span>}
            <span className={`w-20 text-right font-black tabular-nums ${r.value.startsWith('-') ? 'text-red-600' : 'text-[#2d2721]'}`}>{r.value}</span>
          </li>
        ))}
      </ol>
    )}
  </section>
);

// 生涯成績（全シーズン通し）の表示用
type LifetimeSummary = {
  key: string;        // 選手ID（選手登録の無い前季のみの選手は legacy:名前）
  name: string;
  registered: boolean; // 選手として登録されているか（個人ページを開けるか）
  games: number;
  dist: number[];      // 1着〜4着の回数
  rankSum: number;
  point: number;       // 生涯ポイント（最高位戦ルール以外の大会は、最高位戦ルールに換算した参考値を合算）
  convertedPart: number; // 生涯ポイントのうち、他ルールの大会を換算して加えた分
  tournaments: number;
  rank: number;        // 生涯順位（同ポイントは同順位）
  rankTotal: number;   // 順位の対象人数
};
type LifetimeHistoryItem = {
  archiveId: string; name: string; ruleName: string; point: number; gameCount: number; rank: number;
  playerCount: number;     // その大会の参加人数（「◯人中」の表示用）
  kind: 'actual' | 'converted' | 'excluded'; // actual=そのまま反映 / converted=最高位戦ルールに換算して反映 / excluded=反映しない
  convertedPoint?: number; // kind が converted のとき、換算後のポイント（参考値）
  previousSeason: boolean; // 前季の大会か
};

// 生涯成績の表示範囲: all=全ルール（最高位戦ルール以外は換算した参考値を含む） / saikoi=最高位戦ルールの大会のみ
type LifetimeScope = 'all' | 'saikoi';
type LifetimeScopeData = Record<LifetimeScope, { summary: LifetimeSummary | null; history: LifetimeHistoryItem[]; groups: PlayerDetailHanchanGroup[] }>;

const PlayerDetailModal = ({
  player,
  totalGames,
  history,
  rankDist,
  headToHead,
  penalties,
  maxScore,
  hanchanGroups,
  upcoming,
  lifetimeData,
  lifetimeOnly,
  seasonRank,
  seasonRankTotal,
  onClose,
}: {
  player: Player;
  totalGames: number;
  history: { archiveId: string; name: string; point: number; gameCount: number; rank: number; playerCount: number }[];
  rankDist: { dist: number[]; total: number };
  headToHead: { id: string; name: string; games: number; diffSum: number; avgDiff: number }[];
  penalties: { archiveId: string; archiveName: string; point: number; reason: string }[];
  maxScore: { score: number; label: string } | null;
  hanchanGroups: PlayerDetailHanchanGroup[];
  upcoming?: UpcomingMatch[];
  lifetimeData: LifetimeScopeData;
  lifetimeOnly?: boolean; // 選手登録のない選手（今季の成績が無い）: 生涯成績だけを表示
  seasonRank?: number | null; // 今季成績ランキングでの順位（ランキングに載っていなければ null）
  seasonRankTotal?: number; // 今季成績ランキングの人数
  onClose: () => void;
}) => {
  const rankLabels = ['1着', '2着', '3着', '4着'];
  const rankColors = ['bg-yellow-400', 'bg-[#a99d8c]', 'bg-amber-700', 'bg-[#d4c9b7]'];
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>({});
  const toggleGroup = (key: string) => setOpenGroups(prev => ({ ...prev, [key]: !prev[key] }));
  const [openHanchan, setOpenHanchan] = useState<string | null>(null);
  // 個人成績のタブ（今季成績 / 生涯成績）
  const [tab, setTab] = useState<'season' | 'lifetime'>(lifetimeOnly ? 'lifetime' : 'season');
  // 生涯成績の表示範囲（初期値は全ルール。「最高位戦ルールのみ」に切り替えられる）
  const [lifeScope, setLifeScope] = useState<LifetimeScope>('all');
  const lifetimeAny = lifetimeData.all.summary;
  const lifetime = lifetimeData[lifeScope].summary;
  const lifetimeHistory = lifetimeData[lifeScope].history;
  const lifetimeHanchanGroups = lifetimeData[lifeScope].groups;
  const showLifetime = tab === 'lifetime' && !!lifetimeAny;
  const headPoint = showLifetime ? (lifetime?.point ?? 0) : player.totalPoint;
  const toggleHanchan = (key: string) => setOpenHanchan(prev => (prev === key ? null : key));

  // 半荘ごとの成績（大会ごとにプルダウン。対局をクリックすると同卓者が見られる）。今季・生涯の両タブで使う
  const renderHanchanGroups = (groups: PlayerDetailHanchanGroup[], prefix: string) => (
    <>
            {groups.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="space-y-2">
                {groups.map(g0 => {
                  const g = { ...g0, key: `${prefix}${g0.key}` };
                  const isGroupOpen = !!openGroups[g.key];
                  return (
                    <div key={g.key} className="border border-[#e7dfd1] rounded-lg overflow-hidden">
                      <button
                        onClick={() => toggleGroup(g.key)}
                        className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-[#faf7f1] hover:bg-[#f3eee4] transition text-left"
                      >
                        <span className="text-sm font-bold text-[#473f36]">{g.label}</span>
                        <span className="text-xs text-[#a99d8c] flex items-center gap-2">
                          {g.rows.length}半荘
                          <span className="font-bold">{isGroupOpen ? '▲' : '▼'}</span>
                        </span>
                      </button>
                      {isGroupOpen && (
                        <div className="divide-y divide-[#f3eee4]">
                          {g.rows.map((r, i) => {
                            const hKey = `${g.key}-${i}`;
                            const isHOpen = openHanchan === hKey;
                            return (
                              <div key={hKey}>
                                <button
                                  onClick={() => toggleHanchan(hKey)}
                                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 text-xs text-left transition ${isHOpen ? 'bg-[#fdf1ed]/60' : 'hover:bg-[#faf7f1]'}`}
                                >
                                  <span className="text-[#a99d8c] w-10">#{i + 1}</span>
                                  <span className="text-[#625a4f] font-bold w-10">{r.rank}位</span>
                                  <span className="text-[#82786b] tabular-nums flex-1 text-right">{(r.score * 100).toLocaleString()}点</span>
                                  <span className={`font-black tabular-nums w-16 text-right ${r.point > 0 ? 'text-blue-600' : r.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(r.point)}</span>
                                </button>
                                {isHOpen && (
                                  <div className="px-3 pb-3 pt-1 bg-white">
                                    <div className="border border-[#e7dfd1] rounded-lg overflow-hidden">
                                      {r.table.map(tp => (
                                        <div key={tp.playerId} className={`flex items-center justify-between px-3 py-1.5 text-xs ${(tp.isMe ?? tp.playerId === player.id) ? 'bg-[#fdf1ed]' : 'bg-white'}`}>
                                          <span className="text-[#625a4f] font-bold truncate flex-1">
                                            <span className="text-[#a99d8c] font-mono mr-1.5">{tp.rank}位</span>
                                            <PlayerLabel name={tp.name} />
                                          </span>
                                          <span className="text-[#a99d8c] mr-3 tabular-nums">{(tp.score * 100).toLocaleString()}点</span>
                                          <span className={`font-bold tabular-nums ${tp.point > 0 ? 'text-blue-600' : tp.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(tp.point)}</span>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
    </>
  );

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-3 md:p-6" onClick={onClose}>
      <div
        className="bg-white w-full max-w-3xl max-h-[94vh] sm:max-h-[90vh] rounded-t-3xl sm:rounded-2xl shadow-2xl overflow-hidden flex flex-col animate-in fade-in zoom-in-95 duration-150"
        onClick={(e) => e.stopPropagation()}
      >
        {/* ヘッダー */}
        <div className="bg-gradient-to-r from-[#a62b17] to-[#5e190e] text-white px-4 md:px-8 py-4 md:py-6 flex items-start justify-between flex-shrink-0">
          <div>
            <p className="text-[#f7bcab] text-xs font-bold mb-1">個人成績</p>
            <h2 className="text-2xl md:text-3xl font-black flex items-center">
              <PlayerLabel name={player.name} badgeClass="text-[#5e190e]" />
            </h2>
            <p className={`mt-2 text-2xl font-black tabular-nums ${headPoint > 0 ? 'text-emerald-300' : headPoint < 0 ? 'text-rose-300' : 'text-[#f7bcab]'}`}>
              {fmtPt(headPoint)} <span className="text-sm font-bold text-[#f7bcab]">{showLifetime ? (lifeScope === 'all' ? `（生涯 ${lifetime?.games ?? 0}半荘・※換算の参考値）` : `（最高位戦ルール ${lifetime?.games ?? 0}半荘）`) : `（今季 ${totalGames}半荘）`}</span>
              {!showLifetime && seasonRank ? (
                <span className="ml-2 inline-flex items-baseline gap-0.5 align-middle bg-white/15 ring-1 ring-white/25 rounded-full px-2.5 py-0.5 text-white">
                  <span className="text-lg font-black tabular-nums">{seasonRank}</span>
                  <span className="text-xs font-bold">位</span>
                  {seasonRankTotal ? <span className="text-[10px] font-bold text-[#f7bcab] ml-1">/ {seasonRankTotal}名</span> : null}
                </span>
              ) : null}
            </p>
            {maxScore && !showLifetime && (
              <p className="mt-2 text-xs font-bold text-[#f7bcab]">
                🎯 最高スコア <span className="text-white text-sm">{(maxScore.score * 100).toLocaleString()}点</span>（{maxScore.label}）
              </p>
            )}
          </div>
          <button onClick={onClose} className="text-[#f7bcab] hover:text-white text-2xl leading-none font-bold px-2">✕</button>
        </div>

        {/* タブ: 今季成績 / 生涯成績 */}
        {lifetimeAny && !lifetimeOnly && (
          <div className="flex border-b border-[#e7dfd1] bg-white flex-shrink-0">
            {([['season', '今季成績'], ['lifetime', '生涯成績']] as const).map(([k, label]) => (
              <button
                key={k}
                onClick={() => setTab(k)}
                className={`flex-1 py-3 text-sm font-black transition border-b-4 ${tab === k ? 'border-[#c8361e] text-[#a62b17] bg-[#fdf1ed]/50' : 'border-transparent text-[#a99d8c] hover:text-[#625a4f]'}`}
              >{label}</button>
            ))}
          </div>
        )}
        {/* 本文 */}
        <div className="overflow-y-auto p-5 md:p-8 space-y-8">
          {tab === 'season' && (
          <>
          {/* この後の対局（ログイン中の本人のみ） */}
          {upcoming && (
            <section>
              <h3 className="text-sm font-black text-[#473f36] mb-3">📌 この後の対局</h3>
              {upcoming.length === 0 ? (
                <p className="text-xs text-[#a99d8c]">この後の対局はありません。</p>
              ) : (
                <div className="space-y-2">
                  {upcoming.map(u => (
                    <div
                      key={u.key}
                      className={`rounded-lg border px-3 py-2.5 text-sm ${u.isFinal ? 'border-amber-300 bg-amber-50' : u.status === 'ready' ? 'border-[#f7bcab] bg-[#fdf1ed]/50' : 'border-[#e7dfd1] bg-[#faf7f1]'}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-black text-[#2d2721]">
                          {u.roundNo}回戦
                          {u.time && <span className="ml-2 text-[11px] font-bold text-[#a99d8c]">{u.time}〜</span>}
                        </span>
                        {u.status === 'ready' && (
                          <span className="text-xs font-black text-[#a62b17]">
                            {u.isFinal && '👑 決勝卓 '}{u.tableLabel || `${u.tableNo}卓`}・{u.wind}家
                          </span>
                        )}
                        {u.status === 'pending' && <span className="text-xs font-bold text-[#a99d8c]">卓組未定</span>}
                        {u.status === 'sitout' && <span className="text-xs font-bold text-[#a99d8c]">抜け番</span>}
                      </div>
                      {u.status === 'ready' && u.opponents && (
                        <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-[#625a4f]">
                          {u.opponents.map((o, i) => (
                            <span key={i}><span className="text-[#a99d8c] mr-1">{o.wind}</span><PlayerLabel name={o.name} className="font-bold" /></span>
                          ))}
                        </div>
                      )}
                      {u.status === 'pending' && (
                        <p className="mt-1 text-[11px] text-[#a99d8c]">前の回戦が全て終了した時点で、順位順に卓組が決まります。</p>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* 大会別成績 */}
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">大会別成績</h3>
            {history.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="grid sm:grid-cols-2 gap-2">
                {history.map(h => (
                  <div key={h.archiveId} className="flex items-center justify-between gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2.5 text-sm">
                    <span className="text-[#473f36] font-bold">{h.name}</span>
                    <RankPill rank={h.rank} playerCount={h.playerCount} />
                    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{h.gameCount}戦</span>
                    <span className={`font-black tabular-nums whitespace-nowrap ${h.point > 0 ? 'text-blue-600' : h.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(h.point)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>


          {/* 着順分布 */}
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🎯 着順分布（今季合計 {rankDist.total}戦）</h3>
            {rankDist.total === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="space-y-2">
                {rankDist.dist.map((count, idx) => {
                  const pct = rankDist.total > 0 ? Math.round((count / rankDist.total) * 100) : 0;
                  return (
                    <div key={idx} className="flex items-center gap-3 text-sm">
                      <span className="w-10 font-bold text-[#82786b]">{rankLabels[idx]}</span>
                      <div className="flex-1 h-4 bg-[#f3eee4] rounded-full overflow-hidden">
                        <div className={`h-full ${rankColors[idx]}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-28 flex-shrink-0 flex items-baseline justify-end tabular-nums text-[#82786b]">
                        <span className="inline-block w-7 text-right">{count}</span>
                        <span className="text-[11px] text-[#a99d8c] ml-0.5 mr-1.5">回</span>
                        <span className="inline-block w-11 text-right text-xs text-[#a99d8c]">({pct}%)</span>
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </section>

          {/* 半荘ごとの成績（大会ごとにプルダウン。対局をクリックすると同卓者が見られる） */}
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🀄 半荘ごとの成績</h3>
            {renderHanchanGroups(hanchanGroups, '')}
          </section>

          {/* 対戦相性 */}
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🤝 対戦相性（合計ポイント差）</h3>
            {headToHead.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録がありません。</p>
            ) : (
              <div className="max-h-72 overflow-y-auto space-y-1.5 pr-1">
                {headToHead.map(o => (
                  <div key={o.id} className="flex items-center justify-between gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg px-3 py-2 text-sm">
                    <PlayerLabel name={o.name} className="text-[#473f36] font-bold truncate flex-1" />
                    <span className="text-[#a99d8c] text-xs whitespace-nowrap">{o.games}戦</span>
                    <span className={`font-black tabular-nums whitespace-nowrap ${o.diffSum > 0 ? 'text-blue-600' : o.diffSum < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(o.diffSum)}</span>
                  </div>
                ))}
              </div>
            )}
            <p className="text-[11px] text-[#a99d8c] mt-2">プラスは「この選手が相手より合計で勝っている」ことを表します。</p>
          </section>

          {/* ペナルティ履歴 */}
          <section>
            <h3 className="text-sm font-black text-[#473f36] mb-3">🚫 ペナルティ履歴</h3>
            {penalties.length === 0 ? (
              <p className="text-xs text-[#a99d8c]">記録はありません。</p>
            ) : (
              <div className="space-y-1.5">
                {penalties.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-sm">
                    <span className="text-red-700 font-bold">{p.archiveName}</span>
                    <span className="text-red-500 text-xs flex-1 truncate">{p.reason}</span>
                    <span className="font-black tabular-nums text-red-600">{fmtPt(p.point)}</span>
                  </div>
                ))}
              </div>
            )}
          </section>
          </>
          )}

          {/* 生涯成績（今季より前の大会も含む） */}
          {tab === 'lifetime' && lifetimeAny && (
            <section className="rounded-xl border-2 border-amber-200 bg-amber-50/40 p-4">
              <h3 className="text-sm font-black text-amber-800 mb-3">🏅 生涯成績（全シーズン通算）</h3>
              <div className="flex gap-1 p-1 bg-white/80 border border-amber-100 rounded-xl mb-4">
                {([['all', '全ルール（換算込み）'], ['saikoi', '最高位戦ルールのみ']] as const).map(([k, label]) => (
                  <button
                    key={k}
                    onClick={() => setLifeScope(k)}
                    className={`flex-1 py-2 rounded-lg text-xs font-black transition ${lifeScope === k ? 'bg-gradient-to-b from-amber-500 to-amber-600 text-white shadow' : 'text-[#82786b] hover:bg-amber-50'}`}
                  >{label}</button>
                ))}
              </div>
              {lifetime ? (
              <>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
                <div className="bg-white rounded-lg border border-amber-100 p-2.5 text-center">
                  <div className="text-[10px] font-bold text-[#a99d8c]">生涯順位</div>
                  <div className="text-lg font-black tabular-nums text-[#2d2721]">{lifetime.rank}<span className="text-xs font-bold text-[#a99d8c]">位</span></div>
                  <div className="text-[9px] text-[#a99d8c] leading-tight">{lifetime.rankTotal}人中</div>
                </div>
                <div className="bg-white rounded-lg border border-amber-100 p-2.5 text-center">
                  <div className="text-[10px] font-bold text-[#a99d8c]">{lifeScope === 'all' ? <>生涯ポイント<span className="text-amber-500">※換算・参考</span></> : '最高位戦ルールのpt'}</div>
                  <div className={`text-lg font-black tabular-nums ${lifetime.point > 0 ? 'text-blue-600' : lifetime.point < 0 ? 'text-red-600' : 'text-[#82786b]'}`}>{fmtPt(lifetime.point)}</div>
                  {lifetime.convertedPart !== 0 && <div className="text-[9px] text-[#a99d8c] leading-tight">うち他ルール換算分 {fmtPt(lifetime.convertedPart)}</div>}
                </div>
                <div className="bg-white rounded-lg border border-amber-100 p-2.5 text-center">
                  <div className="text-[10px] font-bold text-[#a99d8c]">半荘数</div>
                  <div className="text-lg font-black tabular-nums text-[#473f36]">{lifetime.games}</div>
                </div>
                <div className="bg-white rounded-lg border border-amber-100 p-2.5 text-center">
                  <div className="text-[10px] font-bold text-[#a99d8c]">平均着順</div>
                  <div className="text-lg font-black tabular-nums text-[#473f36]">{lifetime.games > 0 ? (lifetime.rankSum / lifetime.games).toFixed(2) : '-'}</div>
                </div>
              </div>
              {lifeScope === 'all' ? (
                <p className="text-[11px] font-bold text-amber-700 bg-amber-100/60 border border-amber-200 rounded-lg px-3 py-2 mb-4 leading-relaxed">
                  ※ 生涯ポイントは、最高位戦ルール以外の大会（第1回・第2回など）を最高位戦ルールに換算して合算した「あくまで参考の値」です。実際のポイントではありません。
                </p>
              ) : (
                <p className="text-[11px] font-bold text-[#625a4f] bg-white/70 border border-[#e7dfd1] rounded-lg px-3 py-2 mb-4 leading-relaxed">最高位戦ルールの大会だけを集計しています（換算なし・実際のポイント）。年間チャンピオン戦のポイントは含みません（半荘数・着順分布には含みます）。</p>
              )}
              <div className="space-y-2 mb-4">
                {lifetime.dist.map((count, idx) => {
                  const pct = lifetime.games > 0 ? Math.round((count / lifetime.games) * 100) : 0;
                  return (
                    <div key={idx} className="flex items-center gap-3 text-sm">
                      <span className="w-10 font-bold text-[#82786b]">{rankLabels[idx]}</span>
                      <div className="flex-1 h-4 bg-white rounded-full overflow-hidden border border-[#f3eee4]">
                        <div className={`h-full ${rankColors[idx]}`} style={{ width: `${pct}%` }} />
                      </div>
                      <span className="w-28 flex-shrink-0 flex items-baseline justify-end tabular-nums text-[#82786b]">
                        <span className="inline-block w-7 text-right">{count}</span>
                        <span className="text-[11px] text-[#a99d8c] ml-0.5 mr-1.5">回</span>
                        <span className="inline-block w-11 text-right text-xs text-[#a99d8c]">({pct}%)</span>
                      </span>
                    </div>
                  );
                })}
              </div>
              {lifetimeHistory.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] font-bold text-[#82786b]">大会別（{lifetimeHistory.length}大会）<span className="font-normal text-[#a99d8c]">　ポイントはその大会のルールでの実際の値です（換算していません）</span></p>
                  {lifetimeHistory.map(h => (
                    <div key={h.archiveId} className="flex items-center gap-2 text-xs bg-white rounded-lg border border-[#f3eee4] px-3 py-2">
                      <span className="font-bold text-[#473f36] w-12 flex-shrink-0">{h.name}</span>
                      <span className="flex-1 min-w-0 truncate text-[11px] text-[#a99d8c]">{h.ruleName}{h.previousSeason ? '（前季）' : ''}</span>
                      <span className="text-[#82786b] whitespace-nowrap">{h.rank}位 / {h.playerCount}人中 <span className="text-[#a99d8c]">・{h.gameCount}戦</span></span>
                      <span className={`font-black tabular-nums whitespace-nowrap ${h.kind === 'excluded' ? 'text-[#a99d8c]' : h.point > 0 ? 'text-blue-600' : h.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(h.point)}</span>
                      {h.kind === 'converted' && (
                        <span className="text-[10px] font-bold text-amber-500 whitespace-nowrap border border-amber-200 rounded px-1">生涯へは換算 {fmtPt(h.convertedPoint ?? 0)}（参考）</span>
                      )}
                      {h.kind === 'excluded' && <span className="text-[10px] font-bold text-[#a99d8c] whitespace-nowrap border border-[#e7dfd1] rounded px-1">別大会・生涯pt加算なし</span>}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-5">
                <h4 className="text-sm font-black text-[#473f36] mb-1">🀄 半荘ごとの成績（全大会）</h4>
                <p className="text-[10px] text-[#a99d8c] mb-2">各半荘のポイントは、その大会のルールでの実際の値です（最高位戦ルールへの換算はしていません）。</p>
                {renderHanchanGroups(lifetimeHanchanGroups, 'lt-')}
              </div>
              {lifeScope === 'all' ? (
                <p className="text-[10px] text-[#82786b] mt-3 leading-relaxed">※ 生涯ポイントのうち、最高位戦ルール以外の大会の分は、最高位戦ルール（持ち点に対する素点差＋順位点 30／10／−10／−30、オカ・供託なし）に換算した「あくまで参考の値」です。年間チャンピオン戦などの別大会は生涯ポイントに含めません。各大会・各半荘に表示しているポイントは、すべてその大会のルールでの実際の値です。着順分布・平均着順・半荘数は、全ての大会の記録を含みます。</p>
              ) : (
                <p className="text-[10px] text-[#82786b] mt-3 leading-relaxed">※ 最高位戦ルールの大会のみの表示です。各大会・各半荘のポイントは実際の値です。</p>
              )}
              </>
              ) : (
                <p className="text-sm text-[#a99d8c] text-center py-6">最高位戦ルールの大会の記録がありません。</p>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
};


const RulesDocCard = () => (
  <a
    href={RULES_DOC_URL}
    target="_blank"
    rel="noopener noreferrer"
    className="group flex items-center gap-4 bg-white border border-[#e7dfd1] hover:border-[#ef937c] hover:bg-[#fdf1ed]/30 rounded-2xl p-4 md:p-5 shadow-sm transition"
    title="大会規定（Google ドキュメント）を別タブで開きます"
  >
    <span className="w-11 h-11 flex-shrink-0 rounded-xl bg-[#fdf1ed] text-[#c8361e] flex items-center justify-center text-xl">📖</span>
    <span className="flex-1 min-w-0">
      <span className="block font-black text-[#2d2721]">大会規定</span>
      <span className="block text-xs text-[#82786b] mt-0.5">
        競技ルール・順位点・チョンボ・出場権などの取り決めはこちらにまとめています。
      </span>
    </span>
    <span className="flex-shrink-0 text-[11px] font-bold text-[#c8361e] whitespace-nowrap">別タブで開く ↗</span>
  </a>
);

// 謝辞つきフッター（全タブ共通）
const SiteFooter = () => (
  <footer className="mt-12 border-t border-[#e7dfd1] bg-white">
    <div className="max-w-5xl mx-auto px-4 md:px-6 py-8">
      <h2 className="text-sm font-black text-[#473f36]">謝辞</h2>
      <p className="text-xs text-[#82786b] leading-relaxed mt-2">
        本サイトは、{CREDIT_AUTHOR}が制作・公開されている麻雀大会運営ツール{' '}
        <a
          href={CREDIT_TOOL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="font-bold text-[#c8361e] hover:text-[#a62b17] underline underline-offset-2"
        >
          {CREDIT_TOOL_NAME}
        </a>
        {' '}を参考にさせていただき、作成しました。
        卓組の管理からポイント集計まで、大会運営の流れを分かりやすい形にまとめてくださったおかげで、
        この大会の運営システムを形にすることができました。素晴らしいツールを公開してくださっていることに、心より感謝申し上げます。
      </p>
      <p className="text-xs text-[#82786b] leading-relaxed mt-3">
        また、大会の運営・進行にご協力いただいている全ての皆さま、そしてご参加いただく選手の皆さまに厚く御礼申し上げます。
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 mt-6 pt-4 border-t border-[#f3eee4]">
        <a
          href={RULES_DOC_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-bold text-[#c8361e] hover:text-[#a62b17]"
        >
          📖 大会規定
        </a>
        <a
          href={CREDIT_TOOL_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[11px] font-bold text-[#82786b] hover:text-[#473f36]"
        >
          🀄 {CREDIT_TOOL_NAME}
        </a>
        <span className="flex-1" />
        <span className="text-[11px] text-[#a99d8c]">{APP_TITLE} ／ {RULE_NAME}</span>
      </div>
    </div>
  </footer>
);

// ==========================================
// 2.5 過去大会テキスト(MMC)パーサー
// ==========================================
// MMCの「トータル成績」の各行（例: "1 あおい +200.1 10戦 1.90"）を抽出
type ParsedLeaderboardRow = { rank: number; name: string; point: number; gameCount: number; avgRank: number };
const parseMmcLeaderboard = (rawText: string): ParsedLeaderboardRow[] => {
  const raw = encodeNamesWithDigits(rawText);
  const rows: ParsedLeaderboardRow[] = [];
  const re = /(\d+)\s+([^\d\n]+?)\s+([+\-]\d+\.\d)\s+(\d+)\s*戦\s+(\d+\.\d+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    rows.push({
      rank: parseInt(m[1], 10),
      name: fromFullWidthDigits(m[2].replace(/\s+/g, ' ').trim()),
      point: parseFloat(m[3]),
      gameCount: parseInt(m[4], 10),
      avgRank: parseFloat(m[5]),
    });
  }
  return rows;
};

// MMCの「半荘ごと」ログを抽出する。
// 対局番号(N戦目)や日時・ルール名は使わないため一切読み取らず、「供託 X.X」だけを
// 半荘の区切りとして使う。これにより、PDF由来の改行が消えたテキストでも、
// MMCから直接コピー&ペーストした「項目ごとに改行される」テキストでも同じロジックで解析できる。
type ParsedHanchanRow = { rank: number; name: string; point: number; score: number; excluded: boolean };
type ParsedHanchan = { no: number; deposit: number; rows: ParsedHanchanRow[] };
const parseMmcHanchanLog = (rawText: string): ParsedHanchan[] => {
  const text = encodeNamesWithDigits(rawText).replace(/\r\n/g, '\n');
  const headerRe = /供託\s*(\d+\.\d)/g;
  const headers: { deposit: number; index: number; end: number }[] = [];
  let hm: RegExpExecArray | null;
  while ((hm = headerRe.exec(text))) {
    headers.push({ deposit: parseFloat(hm[1]), index: hm.index, end: hm.index + hm[0].length });
  }

  // 「1」「立直」「+33.0(33,000)」のように、同じ行でも別々の行でも拾えるよう \s (改行含む) で区切る
  const rowRe = /([1-4])\s+([^\d()]+?)\s*(\(順位には含みません\)\s*)?([+\-]\d+\.\d)\s*\(([-\d,]+)\)/g;

  const hanchans: ParsedHanchan[] = [];
  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const bodyEnd = i + 1 < headers.length ? headers[i + 1].index : text.length;
    const body = text.slice(h.end, bodyEnd);
    const rows: ParsedHanchanRow[] = [];
    rowRe.lastIndex = 0;
    let rm: RegExpExecArray | null;
    while ((rm = rowRe.exec(body))) {
      const rawScore = parseInt(rm[5].replace(/,/g, ''), 10);
      rows.push({
        rank: parseInt(rm[1], 10),
        name: fromFullWidthDigits(rm[2].replace(/\s+/g, ' ').trim()),
        excluded: !!rm[3],
        point: parseFloat(rm[4]),
        score: rawScore / 100,
      });
    }
    if (rows.length > 0) hanchans.push({ no: i + 1, deposit: h.deposit, rows });
  }
  return hanchans;
};


// ==========================================
// バックアップ形式（version 2）
//   選手・過去大会・今大会の進行状態・次の大会の事前登録を、1つのJSONにまとめる。
//   ログインコード（ハッシュ）は含めない。復元しても、選手のログインコードはそのまま。
// ==========================================
type BackupPlayer = { id: string; name: string; totalPoint: number; totalGames: number; championshipRight: boolean };
type BackupData = {
  app: 'mahjong-tournament';
  version: 2;
  exportedAt: string;
  players: BackupPlayer[];
  archives?: TournamentArchive[];     // 無い（旧形式）場合は、過去大会には触れない
  currentTournament?: any | null;     // null = バックアップ時点で大会なし / undefined = 触れない
  nextEntry?: NextEntry | null;       // null = 事前登録なし / undefined = 触れない
};
// バックアップファイルを読み取って検証する。旧形式（version なし: players と tournament だけ）も読める。
const parseBackup = (raw: any): BackupData => {
  if (!raw || typeof raw !== 'object') throw new Error('バックアップファイルの形式が正しくありません。');
  if (typeof raw.players === 'string') throw new Error('この形式のバックアップ（旧バージョン）は復元できません。');
  if (!Array.isArray(raw.players)) throw new Error('バックアップファイルに選手のデータがありません。');
  const isV2 = raw.version === 2;
  const players: BackupPlayer[] = raw.players.map((p: any, i: number) => {
    if (!p || typeof p.id !== 'string' || typeof p.name !== 'string') throw new Error(`選手データ（${i + 1}件目）が正しくありません。`);
    return {
      id: p.id, name: p.name,
      totalPoint: Number.isFinite(Number(p.totalPoint)) ? Number(p.totalPoint) : 0,
      totalGames: Number.isFinite(Number(p.totalGames)) ? Math.max(0, Math.floor(Number(p.totalGames))) : 0,
      championshipRight: !!p.championshipRight,
    };
  });
  let archives: TournamentArchive[] | undefined;
  if (isV2) {
    if (!Array.isArray(raw.archives)) throw new Error('バックアップファイルに過去大会のデータがありません。');
    archives = raw.archives.map((a: any, i: number) => {
      if (!a || typeof a.id !== 'string' || typeof a.name !== 'string' || !Array.isArray(a.standings) || !Array.isArray(a.hanchans) || !Array.isArray(a.penalties)) {
        throw new Error(`過去大会のデータ（${i + 1}件目）が正しくありません。`);
      }
      return a as TournamentArchive;
    });
  }
  const current = isV2 ? raw.currentTournament : raw.tournament;
  return {
    app: 'mahjong-tournament', version: 2,
    exportedAt: typeof raw.exportedAt === 'string' ? raw.exportedAt : '',
    players,
    archives,
    currentTournament: current === undefined ? undefined : (current && typeof current === 'object' ? current : null),
    nextEntry: isV2 ? (raw.nextEntry === undefined ? undefined : normalizeNextEntry(raw.nextEntry)) : undefined,
  };
};

const api = {
  getPlayers: async (): Promise<Player[]> => {
    const { data, error } = await supabase
      .from('players')
      .select('*')
      .order('created_at', { ascending: true });
    
    if (error) {
      console.error('プレイヤー取得エラー:', error);
      return [];
    }
    
    return data.map((p: any) => ({
      id: p.id,
      name: p.name,
      totalPoint: Number(p.total_point),
      totalGames: p.total_games,
      championshipRight: p.championship_right,
      loginCode: p.login_code || undefined,
    }));
  },

  savePlayer: async (player: Player) => {
    const { error } = await supabase
      .from('players')
      .insert([{
        id: player.id,
        name: player.name,
        total_point: player.totalPoint,
        total_games: player.totalGames,
        championship_right: player.championshipRight ?? false,
        login_code: player.loginCode || null,
      }]);
    if (error) console.error('プレイヤー保存エラー:', error);
    return !error;
  },

  // 選手の所属学校（非公開）。ブラウザからSupabaseへ直接は読み書きせず、管理者ログインを確認するサーバーAPI
  // （app/api/player-schools/route.ts）を経由する。テーブル player_schools はブラウザから一切アクセスできない（add_player_schools.sql）
  getPlayerSchools: async (): Promise<Record<string, string>> => {
    try {
      const res = await fetch('/api/player-schools', { cache: 'no-store' });
      if (!res.ok) { console.error('学校の取得エラー:', res.status, await res.text()); return {}; }
      const json = await res.json();
      return (json && json.schools) || {};
    } catch (err) {
      console.error('学校の取得エラー:', err);
      return {};
    }
  },

  setPlayerSchool: async (playerId: string, school: string): Promise<boolean> => {
    try {
      const res = await fetch('/api/player-schools', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ playerId, school: school.trim() }),
      });
      if (!res.ok) { console.error('学校の保存エラー:', res.status, await res.text()); return false; }
      return true;
    } catch (err) {
      console.error('学校の保存エラー:', err);
      return false;
    }
  },

  updatePlayer: async (updatedPlayer: Player) => {
    const { error } = await supabase
      .from('players')
      .update({
        name: updatedPlayer.name,
        total_point: updatedPlayer.totalPoint,
        total_games: updatedPlayer.totalGames,
        championship_right: updatedPlayer.championshipRight ?? false,
        login_code: updatedPlayer.loginCode || null,
      })
      .eq('id', updatedPlayer.id);
    if (error) console.error('プレイヤー更新エラー:', error);
    return !error;
  },

  // 通算対局数はもう手動で加減算しない（過去大会＋今大会から自動計算するため）。
  // ここではポイントの加減算のみ行う。失敗を握りつぶさず、1件でも失敗したら例外を投げる。
  updatePlayersScores: async (updates: { id: string; pointDelta: number }[]) => {
    const failures: string[] = [];
    for (const u of updates) {
      // 別の端末が同時に同じ選手のポイントを更新すると、読み取り→書き込みの間に値が変わり
      // 片方の加算が消える（通算がズレる）。更新時に「読み取った値のままか」を条件にして、
      // 変わっていたら読み取り直してやり直す。
      let done = false;
      for (let attempt = 0; attempt < 8 && !done; attempt++) {
        const { data: current, error: selectError } = await supabase
          .from('players')
          .select('total_point')
          .eq('id', u.id)
          .single();

        if (selectError || !current) {
          console.error('プレイヤー取得エラー:', u.id, selectError);
          break;
        }

        const newPoint = Math.round((Number(current.total_point) + u.pointDelta) * 10) / 10;
        const { data: updatedRows, error: updateError } = await supabase
          .from('players')
          .update({ total_point: newPoint })
          .eq('id', u.id)
          .eq('total_point', current.total_point)
          .select('id');

        if (updateError) {
          console.error('プレイヤー更新エラー:', u.id, updateError);
          break;
        }
        if (updatedRows && updatedRows.length > 0) done = true;
        else await new Promise(r => setTimeout(r, 80 + Math.random() * 120));
      }
      if (!done) failures.push(u.id);
    }
    if (failures.length > 0) {
      throw new Error(`通算ポイントの更新に失敗した選手があります（${failures.length}件）。players テーブルの update 権限（RLSポリシー）を確認してください。`);
    }
  },

  // 通算ポイントを指定の値に直接書き換える（再計算による修復用）
  setPlayerTotalPoints: async (items: { id: string; totalPoint: number }[]) => {
    const failures: string[] = [];
    for (const it of items) {
      const { error } = await supabase
        .from('players')
        .update({ total_point: Math.round(it.totalPoint * 10) / 10 })
        .eq('id', it.id);
      if (error) { console.error('通算ポイント修正エラー:', it.id, error); failures.push(it.id); }
    }
    if (failures.length > 0) throw new Error(`修正に失敗した選手があります（${failures.length}件）`);
  },

  getCurrentTournament: async (): Promise<any> => {
    const { data, error } = await supabase
      .from('tournaments')
      .select('data')
      .eq('id', 'current')
      .single();
    if (error || !data) return null;
    return data.data;
  },

  saveCurrentTournament: async (tournamentData: any) => {
    // すでに過去大会として登録済みの大会の進行データは保存しない。
    // （アーカイブ後に、古い画面を開いたままの端末が、クリアしたはずのデータを書き戻してしまうのを防ぐ）
    try {
      const no = parseInt(String(tournamentData?.tournamentNo), 10);
      const hasSeating = Array.isArray(tournamentData?.seating) && tournamentData.seating.length > 0;
      if (no && hasSeating) {
        const { data: hit } = await supabase.from('tournament_archives').select('id').like('name', `第${no}回%`).limit(1);
        if (hit && hit.length > 0) return;
      }
    } catch { /* 確認できなければ通常どおり保存 */ }
    const { error } = await supabase
      .from('tournaments')
      .upsert({
        id: 'current',
        data: tournamentData,
        updated_at: new Date().toISOString(),
      });
    if (error) console.error('大会状態保存エラー:', error);
  },

  clearCurrentTournament: async () => {
    const { error } = await supabase
      .from('tournaments')
      .delete()
      .eq('id', 'current');
    if (error) console.error('大会リセットエラー:', error);
  },

  // 次の大会の参加選手の事前登録（tournaments テーブルの別の行 id='next_entry' に保存）
  getNextEntry: async (): Promise<any> => {
    const { data, error } = await supabase.from('tournaments').select('data').eq('id', 'next_entry').single();
    if (error || !data) return null;
    return data.data;
  },
  saveNextEntry: async (entry: NextEntry): Promise<boolean> => {
    const { error } = await supabase.from('tournaments').upsert({ id: 'next_entry', data: entry, updated_at: new Date().toISOString() });
    if (error) { console.error('事前登録の保存エラー:', error); return false; }
    return true;
  },
  clearNextEntry: async (): Promise<boolean> => {
    const { error } = await supabase.from('tournaments').delete().eq('id', 'next_entry');
    if (error) { console.error('事前登録の削除エラー:', error); return false; }
    return true;
  },

  // バックアップの作成（ファイルのダウンロード）。選手・過去大会・今大会・事前登録を1ファイルに保存する。
  exportBackup: async (): Promise<BackupData> => {
    const [players, archives, currentTournament, nextEntryRaw] = await Promise.all([
      api.getPlayers(), api.getArchives(), api.getCurrentTournament(), api.getNextEntry(),
    ]);
    const data: BackupData = {
      app: 'mahjong-tournament', version: 2, exportedAt: new Date().toISOString(),
      players: players.map(p => ({ id: p.id, name: p.name, totalPoint: p.totalPoint, totalGames: p.totalGames, championshipRight: !!p.championshipRight })),
      archives,
      currentTournament: currentTournament ?? null,
      nextEntry: normalizeNextEntry(nextEntryRaw),
    };
    const d = new Date();
    const pad = (n: number) => String(n).padStart(2, '0');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mahjong_backup_${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return data;
  },

  // バックアップからの復元（管理者）。バックアップにある選手・過去大会は同じIDで上書き（無ければ作成）。
  // バックアップに無い選手・過去大会は削除しない。
  restoreBackup: async (b: BackupData) => {
    if (b.players.length > 0) {
      const rows = b.players.map(p => ({ id: p.id, name: p.name, total_point: p.totalPoint, total_games: p.totalGames, championship_right: p.championshipRight }));
      const { error } = await supabase.from('players').upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`選手の復元に失敗: ${error.message}`);
    }
    if (b.archives && b.archives.length > 0) {
      const rows = b.archives.map(a => ({
        id: a.id, name: a.name, rule_name: a.ruleName ?? null, notes: a.notes ?? null,
        standings: a.standings, hanchans: a.hanchans, penalties: a.penalties,
        ...(a.createdAt ? { created_at: a.createdAt } : {}),
      }));
      const { error } = await supabase.from('tournament_archives').upsert(rows, { onConflict: 'id' });
      if (error) throw new Error(`過去大会の復元に失敗: ${error.message}`);
    }
    if (b.currentTournament !== undefined) {
      const { error } = b.currentTournament === null
        ? await supabase.from('tournaments').delete().eq('id', 'current')
        : await supabase.from('tournaments').upsert({ id: 'current', data: b.currentTournament, updated_at: new Date().toISOString() });
      if (error) throw new Error(`今大会の復元に失敗: ${error.message}`);
    }
    if (b.nextEntry !== undefined) {
      const { error } = b.nextEntry === null
        ? await supabase.from('tournaments').delete().eq('id', 'next_entry')
        : await supabase.from('tournaments').upsert({ id: 'next_entry', data: b.nextEntry, updated_at: new Date().toISOString() });
      if (error) throw new Error(`事前登録の復元に失敗: ${error.message}`);
    }
  },

  // ---- 過去大会（アーカイブ） ----
  getArchives: async (): Promise<TournamentArchive[]> => {
    const { data, error } = await supabase
      .from('tournament_archives')
      .select('*')
      .order('created_at', { ascending: false });
    if (error) {
      console.error('過去大会取得エラー:', error);
      return [];
    }
    return (data || []).map((a: any) => ({
      id: a.id,
      name: a.name,
      ruleName: a.rule_name,
      notes: a.notes,
      standings: a.standings || [],
      hanchans: a.hanchans || [],
      penalties: a.penalties || [],
      createdAt: a.created_at,
    }));
  },

  saveArchive: async (archive: { name: string; ruleName?: string; notes?: string; standings: ArchiveStanding[]; hanchans: ArchiveHanchan[]; penalties: ArchivePenalty[] }) => {
    const { data, error } = await supabase
      .from('tournament_archives')
      .insert([{
        name: archive.name,
        rule_name: archive.ruleName || null,
        notes: archive.notes || null,
        standings: archive.standings,
        hanchans: archive.hanchans,
        penalties: archive.penalties,
      }])
      .select()
      .single();
    if (error) { console.error('過去大会保存エラー:', error); throw error; }
    return data;
  },

  // 過去大会の更新（管理者）: 最終成績・半荘・ペナルティのうち、渡したものだけを更新する
  updateArchive: async (id: string, patch: { standings?: ArchiveStanding[]; hanchans?: ArchiveHanchan[]; penalties?: ArchivePenalty[] }) => {
    const { data, error } = await supabase.from('tournament_archives').update(patch).eq('id', id).select();
    if (error) { console.error('過去大会更新エラー:', error); throw error; }
    if (!data || data.length === 0) throw new Error('更新できませんでした（0件）。tournament_archivesのUPDATEポリシーを確認してください。');
  },
  updateArchiveHanchans: async (id: string, hanchans: ArchiveHanchan[]) => api.updateArchive(id, { hanchans }),
  deleteArchive: async (id: string) => {
    const { data, error } = await supabase.from('tournament_archives').delete().eq('id', id).select();
    if (error) { console.error('過去大会削除エラー:', error); throw error; }
    if (!data || data.length === 0) {
      // RLSのDELETEポリシーが無い場合など、エラーにならず0件のまま「成功」扱いになることがあるための保険
      throw new Error('削除できませんでした（0件）。tournament_archivesのDELETEポリシーを確認してください。');
    }
    return data[0];
  },
};

// ==========================================
// 4. メインコンポーネント
// ==========================================
export default function Home() {
  const { data: session, status } = useSession();
  // 開発中ログインできない場合はここを true に一時変更することで管理者UIを確認できます。
  const adminEmails = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim());
  const isAdmin = !!session?.user?.email && adminEmails.includes(session.user.email);

  const [isLoaded, setIsLoaded] = useState(false);
  const [activeTab, setActiveTab] = useState<'tournament' | 'currentRanking' | 'totalRanking' | 'archives' | 'players' | 'data' | 'admin' | 'lifetime'>('tournament');

  // ---- 選手ログイン（Googleを使わない、コードだけの簡易ログイン） ----
  const [loggedInPlayerId, setLoggedInPlayerId] = useState<string | null>(null);
  const [showPlayerLogin, setShowPlayerLogin] = useState(false);
  const [loginCodeInput, setLoginCodeInput] = useState('');
  const [loginError, setLoginError] = useState('');
  // entry   : 参加者の選択
  // drawing : 卓組生成済み・運営確認中（管理者のみ卓組を閲覧/編集可。得点入力は不可。一般には「卓組抽選中」を表示）
  // playing : 大会進行中
  const [tournamentPhase, setTournamentPhase] = useState<'entry' | 'drawing' | 'playing'>('entry');
  
  const [dbPlayers, setDbPlayers] = useState<Player[]>([]);
  const [entryPlayerIds, setEntryPlayerIds] = useState<string[]>([]);
  // 出場試合数を限定する選手（playerId → 出場する回戦の範囲）。未設定の選手は全試合に出場
  const [playerLimits, setPlayerLimits] = useState<Record<string, PlayerLimit>>({});
  // 次の回戦までのタイマー（休憩時間と、2回戦以降の開始時刻）
  const [timerState, setTimerState] = useState<TimerState>({ breakMinutes: DEFAULT_BREAK_MINUTES, startAts: {}, stamp: 0 });
  const [showTimerSettings, setShowTimerSettings] = useState(false);
  const [showAdminMenu, setShowAdminMenu] = useState(false); // PC用ヘッダーの「管理」メニュー
  // 一般の画面に「卓組抽選中」を出すかどうか。管理者の「抽選」ボタンで切り替わる（見せかけのボタン。実際の卓組生成とは無関係）
  const [drawingAnnounced, setDrawingAnnounced] = useState(false);
  // 成績表（Xへは手動で投稿する。表を画面に出してスクリーンショットを撮る）
  const [showSheet, setShowSheet] = useState(true);
  // 成績表をどの回戦終了時点で出すか（null = 最新）。投稿し忘れた回戦に巻き戻すのに使う
  const [sheetRound, setSheetRound] = useState<number | null>(null);
  const [isArchivingCurrent, setIsArchivingCurrent] = useState(false);
  const [copyMsg, setCopyMsg] = useState('');
  // 次の大会の参加選手の事前登録
  const [nextEntry, setNextEntry] = useState<NextEntry | null>(null);
  const [nextEntryOpen, setNextEntryOpen] = useState(false);
  const [nextEntryFilter, setNextEntryFilter] = useState('');
  const [nextSaveState, setNextSaveState] = useState<'' | 'saving' | 'saved' | 'error'>('');
  const [nextLimitPlayerId, setNextLimitPlayerId] = useState(''); // 事前登録: 出場限定を設定する選手
  const [nextLimitRounds, setNextLimitRounds] = useState<number[]>([]); // 事前登録: 出場する回戦
  const nextEntryRef = useRef<NextEntry | null>(null);
  const nextSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [adminRateRank, setAdminRateRank] = useState(0); // 管理用データ: 順位別率（0=1位率 … 3=4位率）
  const [dataScope, setDataScope] = useState<'all' | 'season'>('season'); // データ・管理用データ: 集計範囲（今季=今季の大会のみ[初期値] / 通算=全大会）
  const [adminStreakAcross, setAdminStreakAcross] = useState(false); // 管理用データ: 連続記録を大会をまたいで数えるか（既定: 同じ大会のみ）
  const [adminSynergyMin, setAdminSynergyMin] = useState(5); // 管理用データ: 相性ランキングの対象にする、同卓した半荘数の下限
  const [breakInput, setBreakInput] = useState(String(DEFAULT_BREAK_MINUTES));
  // タイマーを変更する共通関数（変更時刻を stamp に残し、他端末より新しい内容として扱えるようにする）
  const updateTimer = (fn: (prev: TimerState) => TimerState) =>
    setTimerState(prev => ({ ...fn(prev), stamp: Date.now() }));
  
  // いま入力している大会の回（過去大会として登録するとき「第N回」になる）。管理者が手動で設定できる
  const [tournamentNo, setTournamentNo] = useState(DEFAULT_TOURNAMENT_NO);
  const [roundsCount, setRoundsCount] = useState(ROUND_START_TIMES_BY_TOURNAMENT[Number(DEFAULT_TOURNAMENT_NO)]?.length ?? 4);
  // この回の開始目安（回ごとに異なる）
  const scheduleTimes = scheduleFor(tournamentNo);
  // 卓の表示名（第7回は 白卓／橙卓／黒卓、それ以外は 1卓／2卓…）
  const tableName = (n?: number) => tableNameFor(tournamentNo, n);
  // 卓の色。色が決まっていない回は null
  const tableColor = (n?: number) => tableColorFor(tournamentNo, n);
  // 色つきの小さな丸アイコン＋卓名（画面表示用）
  const tableTag = (n?: number) => {
    const c = tableColor(n);
    return (
      <span className="inline-flex items-center gap-1 align-middle">
        {c && <span className={`inline-block w-3 h-3 rounded-full border ${c.dot}`} aria-hidden="true" />}
        {tableName(n)}
      </span>
    );
  };
  // 文字だけの場所用（色つきの丸の絵文字＋卓名）
  const tableTextWithIcon = (n?: number) => `${tableColor(n)?.emoji || ''}${tableName(n)}`;
  // 大会の回を変更する。開始目安が決まっている回で、まだエントリー中なら回戦数もそれに合わせる
  const handleChangeTournamentNo = (v: string) => {
    if (!isAdmin) return;
    const cleaned = v.replace(/[^0-9]/g, '').slice(0, 3);
    setTournamentNo(cleaned);
    const sched = ROUND_START_TIMES_BY_TOURNAMENT[Number(cleaned)];
    if (tournamentPhase === 'entry' && sched) setRoundsCount(sched.length);
  };
  const [seating, setSeating] = useState<Round[]>([]);
  
  const [isResetting, setIsResetting] = useState(false);
  const [resetCountdown, setResetCountdown] = useState(0);
  const [resetMessage, setResetMessage] = useState('リセット待機中...');

  // 今大会成績まわりの表示状態
  const [showKuroko, setShowKuroko] = useState(false); // デフォルトは非表示
  const [csOnly, setCsOnly] = useState(false); // 今季成績ランキング: 年間CS対象選手のみ表示
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
  const [openGameKey, setOpenGameKey] = useState<string | null>(null);

  // 折りたたみ状態（未設定なら「終了していれば畳む」）
  const [roundOpen, setRoundOpen] = useState<Record<number, boolean>>({});
  const [tableOpen, setTableOpen] = useState<Record<string, boolean>>({});

  // 過去大会（アーカイブ）
  const [archives, setArchives] = useState<TournamentArchive[]>([]);
  // 今大会（第N回）がすでに過去大会として登録済みなのに、進行データが残っている状態か。
  // この間は、過去大会と今大会の二重集計を防ぐため、今大会の分を集計から外す。
  const currentTournamentArchived =
    seating.some(r => r.tables.some(t => t.isSubmitted)) &&
    archives.some(a => archiveTournamentNo(a.name) === parseInt(String(tournamentNo), 10));
  const countedSeating: Round[] = currentTournamentArchived ? [] : seating;
  const [openTotalPlayerId, setOpenTotalPlayerId] = useState<string | null>(null);
  const [detailModalPlayerId, setDetailModalPlayerId] = useState<string | null>(null);
  const [openArchiveId, setOpenArchiveId] = useState<string | null>(null);
  const [podiumScope, setPodiumScope] = useState<'season' | 'all'>('season'); // 大会別の表彰台: 表示する範囲（今季が初期値）
  const [penaltyDrafts, setPenaltyDrafts] = useState<Record<string, { playerId: string; point: string; reason: string }>>({});
  const [openArchivePlayerId, setOpenArchivePlayerId] = useState<string | null>(null);
  const [openHanchanListIds, setOpenHanchanListIds] = useState<Record<string, boolean>>({});
  const [openArchiveHanchanIdx, setOpenArchiveHanchanIdx] = useState<number | null>(null);

  const rule = { originPoint: 300, returnPoint: 300, uma: [30, 10, -10, -30], name: RULE_NAME };

  // 出場試合数を限定されている選手か
  const isLimitedPlayer = (id: string) => !!playerLimits[id];
  // 指定の回戦に出場できる選手か（限定されていなければ常に true）
  const isAvailableInRound = (id: string, roundNo: number) => {
    const l = playerLimits[id];
    return !l || l.rounds.includes(roundNo);
  };
  // 卓組抽選中は、管理者以外には卓組を見せない
  const hideSeating = tournamentPhase === 'drawing' && !isAdmin;
  // 一般の画面で「抽選中」を出すのは、管理者が「抽選」ボタンを押した後だけ。押すまでは従来どおり（エントリー中と同じ表示）
  const generalDrawingScreen = !isAdmin && drawingAnnounced && (tournamentPhase === 'entry' || tournamentPhase === 'drawing');
  const generalEntryView = !isAdmin && tournamentPhase === 'drawing' && !drawingAnnounced;
  const handleToggleDrawingAnnounce = (on: boolean) => { if (isAdmin) setDrawingAnnounced(on); };
  // 今大会にエントリーしている、出場限定の選手一覧
  const limitEntries = (Object.entries(playerLimits) as [string, PlayerLimit][]).filter(([id]) => entryPlayerIds.includes(id));

  useEffect(() => {
    if (isLoaded && !isAdmin && (activeTab === 'players' || activeTab === 'admin')) {
      setActiveTab('tournament');
    }
  }, [isAdmin, activeTab, isLoaded]);

  // 選手ログインをブラウザに保持し、再読み込みしてもログイン状態を維持する
  const [loginRestored, setLoginRestored] = useState(false);
  useEffect(() => {
    const saved = localStorage.getItem('mahjong_player_login_id');
    if (saved) setLoggedInPlayerId(saved);
    setLoginRestored(true);
  }, []);
  useEffect(() => {
    if (!loginRestored) return; // 復元前に保存内容を消してしまわないようにする
    if (loggedInPlayerId) localStorage.setItem('mahjong_player_login_id', loggedInPlayerId);
    else localStorage.removeItem('mahjong_player_login_id');
  }, [loggedInPlayerId, loginRestored]);

  const loggedInPlayer = dbPlayers.find(p => p.id === loggedInPlayerId) || null;

  const handlePlayerLogin = () => {
    const code = loginCodeInput.trim().toUpperCase();
    if (!code) return;
    const found = dbPlayers.find(p => (p.loginCode || '').toUpperCase() === code);
    if (!found) {
      setLoginError('コードが正しくありません。もう一度確認してください。');
      return;
    }
    setLoggedInPlayerId(found.id);
    setShowPlayerLogin(false);
    setLoginCodeInput('');
    setLoginError('');
  };

  const handlePlayerLogout = () => {
    setLoggedInPlayerId(null);
  };

  useEffect(() => {
    const loadData = async () => {
      setDbPlayers(await api.getPlayers());
      setArchives(await api.getArchives());
      const current = await api.getCurrentTournament();
      applyTournamentData(current);
      const pre = normalizeNextEntry(await api.getNextEntry());
      nextEntryRef.current = pre;
      setNextEntry(pre);
      setIsLoaded(true);
    };
    loadData();
  }, []);

  // 大会状態（DB上のデータ）を画面の state に反映する
  const applyTournamentData = (current: any) => {
    if (!current) return;
    if (current.tournamentPhase) setTournamentPhase(current.tournamentPhase);
    if (current.entryPlayerIds) setEntryPlayerIds(current.entryPlayerIds);
    if (current.roundsCount) setRoundsCount(current.roundsCount);
    if (current.tournamentNo !== undefined && current.tournamentNo !== null) {
      setTournamentNo(String(current.tournamentNo));
    } else if ((current.tournamentPhase || 'entry') === 'entry') {
      // 回の設定が保存されていない（これから入力する）大会は、既定の回（第7回）にそろえる
      const sched = ROUND_START_TIMES_BY_TOURNAMENT[Number(DEFAULT_TOURNAMENT_NO)];
      if (sched) setRoundsCount(sched.length);
    }
    setPlayerLimits(normalizePlayerLimits(current.playerLimits));
    setDrawingAnnounced(!!current.drawingAnnounced);
    if (current.timer) setTimerState(normalizeTimer(current.timer));
    if (current.seating) {
      // 旧データ互換: chonbo / mode が無いデータを補完
      const migrated: Round[] = (current.seating as Round[]).map((r: Round) => ({
        ...r,
        mode: r.mode || 'normal',
        isPending: r.isPending || false,
        tables: (r.tables || []).map((t: Table) => ({
          ...t,
          players: (t.players || []).map((p: PlayerScore) => ({ ...p, chonbo: p.chonbo || 0 })),
        })),
      }));
      setSeating(migrated);
    }
  };

  // 管理者以外は、大会が始まる（playingになる）まで数秒おきに最新状態を確認する。
  // （「卓組抽選中」の画面から、大会開始と同時に自動で切り替わるようにするため）
  const lastPolledJson = useRef('');
  useEffect(() => {
    if (!isLoaded || isAdmin || tournamentPhase === 'playing') return;
    const timer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const current = await api.getCurrentTournament();
      if (!current) return;
      const json = JSON.stringify(current);
      if (json === lastPolledJson.current) return;
      lastPolledJson.current = json;
      applyTournamentData(current);
    }, 5000);
    return () => clearInterval(timer);
  }, [isLoaded, isAdmin, tournamentPhase]);

  useEffect(() => {
    if (!isLoaded) return;
    // 管理者以外が入力できるのは大会進行中だけ。それ以外の時間帯は保存しない
    // （古い画面の内容で、管理者が更新した最新状態を上書きしてしまうのを防ぐため）
    if (!isAdmin && tournamentPhase !== 'playing') return;
    api.saveCurrentTournament({ tournamentPhase, entryPlayerIds, roundsCount, seating, playerLimits, timer: timerState, tournamentNo, drawingAnnounced });
  }, [tournamentPhase, entryPlayerIds, roundsCount, seating, playerLimits, timerState, tournamentNo, drawingAnnounced, isLoaded, isAdmin]);

  // 大会進行中は5秒おきに最新状態を確認し、次の2点だけ取り込む（入力中の内容を壊さないため）
  //  ① タイマー（休憩時間・開始時刻）…新しい方を採用
  //  ② 他の端末で送信が済んだ卓／順位順で新しく決まった回戦
  useEffect(() => {
    if (!isLoaded || tournamentPhase !== 'playing') return;
    const timer = setInterval(async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      const current = await api.getCurrentTournament();
      if (!current) return;
      // 他の端末で大会がアーカイブ／リセットされていたら、古い内容を保存し続けないよう最新状態を読み込み直す
      if (current.tournamentPhase === 'entry' && Array.isArray(current.seating) && current.seating.length === 0) {
        window.location.reload();
        return;
      }
      if (current.timer) {
        const srv = normalizeTimer(current.timer);
        setTimerState(prev => (srv.stamp > prev.stamp ? srv : prev));
      }
      if (Array.isArray(current.seating)) {
        const server = current.seating as Round[];
        setSeating(prev => {
          let changed = false;
          const next = prev.map(lr => {
            const sr = server.find(x => x.round === lr.round);
            if (!sr) return lr;
            // 順位順の回戦がサーバー側で決定済みなら、その回戦をそのまま取り込む
            if ((lr.isPending || lr.tables.length === 0) && !sr.isPending && sr.tables.length > 0) {
              changed = true;
              return {
                ...sr,
                mode: sr.mode || 'normal',
                tables: sr.tables.map(t => ({ ...t, players: t.players.map(pl => ({ ...pl, chonbo: pl.chonbo || 0 })) })),
              };
            }
            // 未送信だった卓が、他の端末で送信済みになっていれば取り込む
            let tablesChanged = false;
            const tables = lr.tables.map(lt => {
              if (lt.isSubmitted) return lt;
              const st = sr.tables.find(x => x.tableNumber === lt.tableNumber);
              if (st && st.isSubmitted) {
                tablesChanged = true;
                return { ...st, players: st.players.map(pl => ({ ...pl, chonbo: pl.chonbo || 0 })) };
              }
              return lt;
            });
            if (tablesChanged) { changed = true; return { ...lr, tables }; }
            return lr;
          });
          return changed ? next : prev;
        });
      }
    }, 5000);
    return () => clearInterval(timer);
  }, [isLoaded, tournamentPhase]);

  // ----------------------------------------
  // A. プレイヤー管理 & 編集機能
  // ----------------------------------------
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerPoint, setNewPlayerPoint] = useState(0);
  const [newPlayerRight, setNewPlayerRight] = useState(false); // 出場権（デフォルトなし）
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', totalPoint: 0, championshipRight: false, school: '' });
  // 学校（非公開）: 管理者でログインしているときだけ取得する。一般の閲覧者の画面には読み込まない
  const [playerSchools, setPlayerSchools] = useState<Record<string, string>>({});
  const [newPlayerSchool, setNewPlayerSchool] = useState('');
  useEffect(() => {
    if (!isAdmin) { setPlayerSchools({}); return; }
    let alive = true;
    api.getPlayerSchools().then(m => { if (alive) setPlayerSchools(m); });
    return () => { alive = false; };
  }, [isAdmin]);
  const schoolOptions = Array.from(new Set(Object.values(playerSchools))).sort();
  // 選手タブの「学校の割り当て」: 今季の対局がない選手も含めて、全選手の学校を設定できる
  const [schoolEditId, setSchoolEditId] = useState<string | null>(null);
  const [schoolDraft, setSchoolDraft] = useState('');
  const [schoolUnsetOnly, setSchoolUnsetOnly] = useState(false);
  const [schoolModal, setSchoolModal] = useState<string | null>(null); // 学校別成績の詳細（モーダル）
  const [h2hA, setH2hA] = useState(''); // 学校対決で選んだ学校
  const [h2hB, setH2hB] = useState('');
  const [phA, setPhA] = useState(''); // 個人対決で選んだ選手（キー）
  const [phB, setPhB] = useState('');
  const [drawReport, setDrawReport] = useState<{ windPenalty: number; maxPair: number; repeatPairs: number; attempts: number; rounds: number } | null>(null); // 直近の卓組抽選の結果の要約（管理者向け）
  const [nameDraft, setNameDraft] = useState(''); // 選手の名前の編集（新規登録タブ）
  const saveSchoolFor = async (playerId: string, school: string) => {
    if (!isAdmin) return;
    const name = school.trim();
    const ok = await api.setPlayerSchool(playerId, name);
    if (!ok) {
      alert('学校の保存に失敗しました。add_player_schools.sql の実行と、app/api/player-schools/route.ts の配置・環境変数 SUPABASE_SERVICE_ROLE_KEY の設定を確認してください。（コンソールにエラーが出ています）');
      return;
    }
    setPlayerSchools(prev => {
      const next = { ...prev };
      if (name) next[playerId] = name; else delete next[playerId];
      return next;
    });
    setSchoolEditId(null);
  };
  // 選手の名前と学校をまとめて保存する（今季ランキングに載っていない選手も編集できる）。選手登録のない人は学校のみ
  const savePlayerProfile = async (row: { id: string; name: string; legacy: boolean }, name: string, school: string) => {
    if (!isAdmin) return;
    const newName = name.trim();
    if (!row.legacy && newName !== row.name) {
      if (!newName) { alert('選手名を入力してください。'); return; }
      if (dbPlayers.some(pl => pl.id !== row.id && pl.name === newName)) { alert(`「${newName}」は、すでに他の選手の名前として登録されています。`); return; }
      const target = dbPlayers.find(pl => pl.id === row.id);
      if (target) {
        await api.updatePlayer({ ...target, name: newName, championshipRight: isPro(newName) ? false : target.championshipRight });
        setDbPlayers(await api.getPlayers());
      }
    }
    const sc = school.trim();
    if (sc !== (playerSchools[row.id] || '')) {
      const ok = await api.setPlayerSchool(row.id, sc);
      if (ok) {
        setPlayerSchools(prev => {
          const next = { ...prev };
          if (sc) next[row.id] = sc; else delete next[row.id];
          return next;
        });
      } else {
        alert('学校の保存に失敗しました。add_player_schools.sql の実行と、app/api/player-schools/route.ts の配置・環境変数 SUPABASE_SERVICE_ROLE_KEY の設定を確認してください。（コンソールにエラーが出ています）');
      }
    }
    setSchoolEditId(null);
  };

  const handleRegisterPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!newPlayerName.trim()) return;
    const existingCodes = new Set<string>(dbPlayers.map(p => p.loginCode || '').filter(c => c !== ''));
    const newPlayer: Player = {
      id: crypto.randomUUID(),
      name: newPlayerName.trim(),
      totalPoint: newPlayerPoint,
      totalGames: 0,
      championshipRight: isPro(newPlayerName) ? false : newPlayerRight,
      loginCode: generateLoginCode(existingCodes),
    };
    const saved = await api.savePlayer(newPlayer);
    if (!saved) {
      alert('登録に失敗しました。Supabaseで add_player_login_code.sql を実行済みか確認してください。（コンソールにエラーが出ています）');
      return;
    }
    if (newPlayerSchool.trim()) {
      const ok = await api.setPlayerSchool(newPlayer.id, newPlayerSchool);
      if (ok) setPlayerSchools(prev => ({ ...prev, [newPlayer.id]: newPlayerSchool.trim() }));
      else alert('学校の保存に失敗しました。add_player_schools.sql の実行と、app/api/player-schools/route.ts の配置・環境変数 SUPABASE_SERVICE_ROLE_KEY の設定を確認してください。（コンソールにエラーが出ています）');
    }
    setDbPlayers(await api.getPlayers());
    setNewPlayerName(''); setNewPlayerPoint(0); setNewPlayerRight(false); setNewPlayerSchool('');
    alert(`${newPlayer.name} を登録しました！\nログインコード: ${newPlayer.loginCode}`);
  };

  // 既にログインコードを持っていない選手（旧データなど）にまとめて発行する
  const [isIssuingCodes, setIsIssuingCodes] = useState(false);
  const handleIssueMissingCodes = async () => {
    if (!isAdmin) return;
    const missing = dbPlayers.filter(p => !p.loginCode);
    if (missing.length === 0) { alert('未発行の選手はいません。'); return; }
    if (!window.confirm(`${missing.length}名にログインコードを発行します。よろしいですか？`)) return;
    setIsIssuingCodes(true);
    try {
      const existingCodes = new Set<string>(dbPlayers.map(p => p.loginCode || '').filter(c => c !== ''));
      let failed = 0;
      for (const p of missing) {
        const loginCode = generateLoginCode(existingCodes);
        const ok = await api.updatePlayer({ ...p, loginCode });
        if (!ok) failed++;
      }
      const refreshed = await api.getPlayers();
      setDbPlayers(refreshed);
      const stillMissing = refreshed.filter(p => !p.loginCode).length;
      if (failed > 0 || stillMissing > 0) {
        alert(`コードを保存できませんでした（未発行 ${stillMissing}名）。\n\nSupabaseのSQL Editorで add_player_login_code.sql を実行済みか確認してください。\n（playersテーブルにlogin_code列が無い、または更新権限が無い場合に発生します）`);
      } else {
        alert(`${missing.length}名分のログインコードを発行しました。`);
      }
    } catch (err) {
      console.error(err);
      alert('発行中にエラーが発生しました。コンソールを確認してください。');
    } finally {
      setIsIssuingCodes(false);
    }
  };

  // 発行済みコードの取り消し（1人分）
  const handleRevokeCode = async (p: Player) => {
    if (!isAdmin || !p.loginCode) return;
    if (!window.confirm(`${p.name} のログインコードを取り消しますか？\n取り消すと、この選手は現在のコードでログインできなくなります。`)) return;
    const ok = await api.updatePlayer({ ...p, loginCode: undefined });
    setDbPlayers(await api.getPlayers());
    if (!ok) alert('取り消しに失敗しました。コンソールを確認してください。');
  };

  // 発行済みコードの取り消し（全員分）
  const handleRevokeAllCodes = async () => {
    if (!isAdmin) return;
    const targets = dbPlayers.filter(p => !!p.loginCode);
    if (targets.length === 0) { alert('発行済みのコードはありません。'); return; }
    if (!window.confirm(`発行済みの ${targets.length}名分のログインコードを全て取り消しますか？\n取り消すと、全員が現在のコードでログインできなくなります。`)) return;
    setIsIssuingCodes(true);
    try {
      let failed = 0;
      for (const p of targets) {
        const ok = await api.updatePlayer({ ...p, loginCode: undefined });
        if (!ok) failed++;
      }
      setDbPlayers(await api.getPlayers());
      alert(failed > 0 ? `${failed}名分の取り消しに失敗しました。コンソールを確認してください。` : `${targets.length}名分のコードを取り消しました。`);
    } finally {
      setIsIssuingCodes(false);
    }
  };

  // 1人分のコードを新しく発行し直す（漏えい・紛失時など）
  const handleReissueCode = async (p: Player) => {
    if (!isAdmin) return;
    if (!window.confirm(`${p.name} のログインコードを${p.loginCode ? '再発行（古いコードは無効に）' : '発行'}しますか？`)) return;
    const existingCodes = new Set<string>(dbPlayers.map(x => x.loginCode || '').filter(c => c !== ''));
    const ok = await api.updatePlayer({ ...p, loginCode: generateLoginCode(existingCodes) });
    setDbPlayers(await api.getPlayers());
    if (!ok) alert('保存に失敗しました。add_player_login_code.sql を実行済みか確認してください。');
  };

  // 印刷対象から外す選手（デフォルトは全員が対象）
  const [printExcludedIds, setPrintExcludedIds] = useState<string[]>([]);
  const togglePrintTarget = (id: string) =>
    setPrintExcludedIds(prev => (prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]));
  const printTargets = dbPlayers.filter(p => !!p.loginCode && !isKuroko(p.name) && !printExcludedIds.includes(p.id));

  // コードを取り消された（または削除された）選手が端末に残っているログインは自動で解除する
  useEffect(() => {
    if (!isLoaded || !loggedInPlayerId) return;
    const me = dbPlayers.find(p => p.id === loggedInPlayerId);
    if (!me || !me.loginCode) setLoggedInPlayerId(null);
  }, [dbPlayers, isLoaded, loggedInPlayerId]);

  const startEditPlayer = (p: Player) => {
    if (!isAdmin) return;
    setEditingPlayerId(p.id);
    setEditForm({ name: p.name, totalPoint: p.totalPoint, championshipRight: !!p.championshipRight, school: playerSchools[p.id] || '' });
  };

  const saveEditPlayer = async () => {
    if (!editingPlayerId || !isAdmin) return;
    const player = dbPlayers.find(p => p.id === editingPlayerId);
    if (player) {
      const updated = {
        ...player,
        name: editForm.name,
        totalPoint: editForm.totalPoint,
        championshipRight: isPro(editForm.name) ? false : editForm.championshipRight,
      };
      await api.updatePlayer(updated);
      if (editForm.school.trim() !== (playerSchools[player.id] || '')) {
        const ok = await api.setPlayerSchool(player.id, editForm.school);
        if (ok) {
          setPlayerSchools(prev => {
            const next = { ...prev };
            if (editForm.school.trim()) next[player.id] = editForm.school.trim(); else delete next[player.id];
            return next;
          });
        } else {
          alert('学校の保存に失敗しました。add_player_schools.sql の実行と、app/api/player-schools/route.ts の配置・環境変数 SUPABASE_SERVICE_ROLE_KEY の設定を確認してください。（コンソールにエラーが出ています）');
        }
      }
      setDbPlayers(await api.getPlayers());
    }
    setEditingPlayerId(null);
  };

  const toggleEntry = (id: string) => {
    if (!isAdmin) return;
    if (entryPlayerIds.includes(id)) {
      setEntryPlayerIds(entryPlayerIds.filter(pid => pid !== id));
      // エントリーから外した選手の出場限定は解除する
      setPlayerLimits(prev => {
        if (!prev[id]) return prev;
        const next = { ...prev };
        delete next[id];
        return next;
      });
    } else {
      setEntryPlayerIds([...entryPlayerIds, id]);
    }
  };

  // ----------------------------------------
  // A-1. 次の大会の参加選手の事前登録（管理者用。今の大会の進行中・終了後でも登録できる）
  // ----------------------------------------
  // 登録されていない一番小さい回（今の大会の回も含めて除く）。例: 第1〜5回が登録済みで今が第7回なら、次は第6回
  const suggestNextTournamentNo = (): string => {
    const used = new Set<number>();
    archives.forEach(a => { const n = archiveTournamentNo(a.name); if (n !== null) used.add(n); });
    const cur = parseInt(tournamentNo, 10);
    if (Number.isFinite(cur)) used.add(cur);
    let n = 1;
    while (used.has(n)) n++;
    return String(n);
  };
  // 変更を反映して、少し待ってから（連続して押しても1回だけ）保存する
  const commitNextEntry = (next: NextEntry | null) => {
    nextEntryRef.current = next;
    setNextEntry(next);
    setNextSaveState('saving');
    if (nextSaveTimer.current) clearTimeout(nextSaveTimer.current);
    nextSaveTimer.current = setTimeout(async () => {
      const latest = nextEntryRef.current;
      const ok = latest ? await api.saveNextEntry(latest) : await api.clearNextEntry();
      setNextSaveState(ok ? 'saved' : 'error');
    }, 500);
  };
  const toggleNextEntry = (id: string) => {
    if (!isAdmin) return;
    const base: NextEntry = nextEntryRef.current ?? { no: suggestNextTournamentNo(), playerIds: [] };
    const removing = base.playerIds.includes(id);
    const ids = removing ? base.playerIds.filter(x => x !== id) : [...base.playerIds, id];
    const limits = { ...(base.limits || {}) };
    if (removing) delete limits[id]; // 参加を外した選手の出場限定は解除する
    commitNextEntry({ ...base, playerIds: ids, limits });
  };
  // 事前登録の回戦数（未設定なら、その回の開始目安が決まっていればその数、なければ今の大会の回戦数）
  const nextRoundsN = (): number => nextEntry?.roundsCount ?? ROUND_START_TIMES_BY_TOURNAMENT[Number(nextEntry?.no)]?.length ?? Math.max(roundsCount, 1);
  const setNextRoundsCount = (v: number) => {
    if (!isAdmin) return;
    const base: NextEntry = nextEntryRef.current ?? { no: suggestNextTournamentNo(), playerIds: [] };
    const n = Math.max(1, Math.min(20, Math.floor(v) || 1));
    // 回戦数が減ったら、範囲外の回戦を限定から外す（空になる限定は解除）
    const limits: Record<string, PlayerLimit> = {};
    Object.entries(base.limits || {}).forEach(([id, l]) => {
      const rounds = l.rounds.filter(r => r <= n);
      if (rounds.length > 0 && rounds.length < n) limits[id] = { rounds };
    });
    commitNextEntry({ ...base, roundsCount: n, limits });
  };
  const toggleNextLimitRound = (n: number) =>
    setNextLimitRounds(prev => (prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n].sort((a, b) => a - b)));
  const addNextLimit = () => {
    if (!isAdmin || !nextLimitPlayerId) return;
    const n = nextRoundsN();
    const rounds = nextLimitRounds.filter(r => r >= 1 && r <= n);
    if (rounds.length === 0) { alert('出場する回戦を1つ以上選択してください。'); return; }
    if (rounds.length === n) { alert('全試合に出場するため、限定の設定は不要です。'); return; }
    const base: NextEntry = nextEntryRef.current ?? { no: suggestNextTournamentNo(), playerIds: [] };
    commitNextEntry({ ...base, limits: { ...(base.limits || {}), [nextLimitPlayerId]: { rounds } } });
    setNextLimitPlayerId('');
    setNextLimitRounds([]);
  };
  const removeNextLimit = (id: string) => {
    if (!isAdmin) return;
    const base = nextEntryRef.current;
    if (!base) return;
    const limits = { ...(base.limits || {}) };
    delete limits[id];
    commitNextEntry({ ...base, limits });
  };
  const setNextEntryNo = (v: string) => {
    if (!isAdmin) return;
    const base: NextEntry = nextEntryRef.current ?? { no: '', playerIds: [] };
    commitNextEntry({ ...base, no: v.replace(/[^0-9]/g, '').slice(0, 3) });
  };
  const setNextEntryAll = (on: boolean) => {
    if (!isAdmin) return;
    const base: NextEntry = nextEntryRef.current ?? { no: suggestNextTournamentNo(), playerIds: [] };
    const emptyLimits: Record<string, PlayerLimit> = {};
    commitNextEntry({ ...base, playerIds: on ? dbPlayers.filter(pl => !isKuroko(pl.name)).map(pl => pl.id) : [], limits: on ? (base.limits ?? emptyLimits) : emptyLimits });
  };
  // いまのエントリー（今の大会の参加者）をコピーして、次の大会の候補にする
  const copyCurrentEntryToNext = () => {
    if (!isAdmin || entryPlayerIds.length === 0) return;
    const base: NextEntry = nextEntryRef.current ?? { no: suggestNextTournamentNo(), playerIds: [] };
    commitNextEntry({ ...base, playerIds: [...entryPlayerIds], limits: { ...playerLimits }, roundsCount });
  };
  const clearNextEntryAll = () => {
    if (!isAdmin || !nextEntry) return;
    if (!window.confirm('事前登録した参加選手を、すべて消しますか？')) return;
    commitNextEntry(null);
  };
  // 事前登録した参加選手を、いまのエントリーに読み込む（新しい大会のエントリー中のみ）
  const loadNextEntryIntoCurrent = () => {
    if (!isAdmin || tournamentPhase !== 'entry' || !nextEntry) return;
    const ids = nextEntry.playerIds.filter(id => dbPlayers.some(pl => pl.id === id));
    if (entryPlayerIds.length > 0 && !window.confirm(`いまのエントリー（${entryPlayerIds.length}名）を、事前登録した${ids.length}名に置き換えますか？`)) return;
    setEntryPlayerIds(ids);
    // 事前登録した出場限定も読み込む（登録されている選手の分だけ）
    const limits: Record<string, PlayerLimit> = {};
    (Object.entries(nextEntry.limits ?? {}) as [string, PlayerLimit][]).forEach(([id, l]) => { if (ids.includes(id)) limits[id] = l; });
    setPlayerLimits(limits);
    if (nextEntry.no) handleChangeTournamentNo(nextEntry.no);
    if (nextEntry.roundsCount) setRoundsCount(nextEntry.roundsCount); // 回戦数を指定していれば、それを優先
  };

  // ----------------------------------------
  // A-2. 出場試合数の限定（エントリー画面・管理者用）
  // ----------------------------------------
  const [limitPlayerId, setLimitPlayerId] = useState('');
  // 出場する回戦（トグルで個別に選択。連続していなくてもよい）
  const [limitRounds, setLimitRounds] = useState<number[]>([]);

  const toggleLimitRound = (n: number) => {
    setLimitRounds(prev => (prev.includes(n) ? prev.filter(x => x !== n) : [...prev, n].sort((a, b) => a - b)));
  };

  const handleAddLimit = () => {
    if (!isAdmin || !limitPlayerId) return;
    const rounds = limitRounds.filter(n => n >= 1 && n <= roundsCount);
    if (rounds.length === 0) {
      alert('出場する回戦を1つ以上選択してください。');
      return;
    }
    if (rounds.length === roundsCount) {
      alert('全試合に出場するため、限定の設定は不要です。');
      return;
    }
    setPlayerLimits(prev => ({ ...prev, [limitPlayerId]: { rounds } }));
    setLimitPlayerId('');
    setLimitRounds([]);
  };

  // 設定済みの選手の出場回戦を、編集用の入力欄に読み込む（変更して「追加」で上書き）
  const handleEditLimit = (id: string) => {
    if (!isAdmin || !playerLimits[id]) return;
    setLimitPlayerId(id);
    setLimitRounds(playerLimits[id].rounds);
  };

  const handleRemoveLimit = (id: string) => {
    if (!isAdmin) return;
    setPlayerLimits(prev => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const limitLabel = (l: PlayerLimit) => formatLimitRounds(l.rounds);

  // ----------------------------------------
  // B. 卓組生成
  //    ※ 最後の2半荘は「決定待ち(isPending)」として生成する
  // ----------------------------------------
  const handleGenerateTables = () => {
    if (!isAdmin) return;
    if (entryPlayerIds.length < 4) {
      alert('参加者は4名以上選択してください。');
      return;
    }
    const winds = ['東', '南', '西', '北'];

    // 出場限定の設定が、現在の回戦数と矛盾していないか確認
    for (const [id, l] of limitEntries) {
      if (l.rounds.length === 0 || l.rounds.some(n => n < 1 || n > roundsCount)) {
        const nm = dbPlayers.find(p => p.id === id)?.name || '不明';
        alert(`${nm} の出場限定（${formatLimitRounds(l.rounds)}）が全${roundsCount}回戦の範囲外です。設定を見直してください。`);
        return;
      }
    }
    // 各回戦で、卓を立てられるだけの人数（4名以上）が出場できるか確認
    for (let rn = 1; rn <= roundsCount; rn++) {
      const cnt = entryPlayerIds.filter(id => isAvailableInRound(id, rn)).length;
      if (cnt < 4) {
        alert(`${rn}回戦に出場できる選手が${cnt}名しかいません。（4名以上必要です）\n出場限定の設定を見直してください。`);
        return;
      }
    }

    // 通常生成する回戦数 (最後の2半荘は順位順で後決め。ただし最低1回戦は通常生成)
    const normalCount = Math.max(1, roundsCount - 2);
    const pendingCount = Math.max(0, roundsCount - normalCount);
    
    // プロ・黒子（この2種類は、2人以上を同卓にしない）
    const specialIds = new Set(entryPlayerIds.filter(id => isSpecialName(dbPlayers.find(p => p.id === id)?.name || '')));
    const rainfId = dbPlayers.find(p => p.name === 'れいんえふ')?.id;
    const tokuId = dbPlayers.find(p => p.name === 'toku')?.id;

    // 各回戦の出場者を決める（その回戦に出場できる選手のみ。抜け番は、抜け番の少ない人を優先して出場させて均等にする）
    const sitOuts: Record<string, number> = {};
    entryPlayerIds.forEach(id => { sitOuts[id] = 0; });
    const roundActive: string[][] = [];
    const roundSitOut: string[][] = [];
    for (let r = 0; r < normalCount; r++) {
      const eligibleIds = entryPlayerIds.filter(id => isAvailableInRound(id, r + 1));
      const numTables = Math.floor(eligibleIds.length / 4);
      const sortedForActive = [...eligibleIds].sort((a, b) => {
        if (sitOuts[a] !== sitOuts[b]) return sitOuts[a] - sitOuts[b];
        return Math.random() - 0.5;
      });
      roundActive.push(sortedForActive.slice(0, numTables * 4));
      const out = sortedForActive.slice(numTables * 4);
      out.forEach(id => { sitOuts[id]++; });
      roundSitOut.push(out);
    }

    // 過去の大会の同卓の偏り（期待値との差）。「ほんの少しだけ」参考にする（同じ条件の候補があるとき、よく同卓してきた組を避ける程度）
    const histMap = new Map<string, CoSeatPair>();
    try {
      buildCoSeatStats(buildTableGames(false), 'all').forEach(pr => histMap.set(coSeatKey(pr.ka, pr.kb), pr));
    } catch (err) {
      console.error('過去の同卓データの集計に失敗（参考情報なので、そのまま卓組を作ります）:', err);
    }
    const histBias = (a: string, b: string) => {
      const pr = histMap.get(coSeatKey(a, b));
      if (!pr || pr.e < 1) return 0;
      return 0.4 * Math.max(-3, Math.min(3, pr.z));
    };

    // ① 席順（東南西北）を全員できるだけ公平に ② 同じ相手となるべく同卓しない、を最適化して卓組を作る
    const plan = planSeating({ rounds: roundActive, specialIds, banPair: rainfId && tokuId ? [rainfId, tokuId] : null, histBias });
    const generatedRounds: Round[] = plan.tables.map((tablesIds, r) => ({
      round: r + 1,
      tables: tablesIds.map((ids, t) => ({
        tableNumber: t + 1, isCalculated: false, isSubmitted: false,
        players: ids.map((id, i) => ({
          playerId: id, wind: winds[i], name: dbPlayers.find(p => p.id === id)?.name || '不明', score: 300, point: 0.0, chonbo: 0,
        })),
      })),
      mode: 'normal' as const,
      isPending: false,
      sitOutIds: roundSitOut[r],
    }));
    setDrawReport({ windPenalty: plan.windPenalty, maxPair: plan.maxPair, repeatPairs: plan.repeatPairs, attempts: plan.attempts, rounds: normalCount });

    // 後決めの回戦
    for (let k = 0; k < pendingCount; k++) {
      const roundNo = normalCount + k + 1;
      const isFinal = roundNo === roundsCount;
      generatedRounds.push({
        round: roundNo,
        tables: [],
        mode: isFinal ? 'rankBottomFirst' : 'rankTopFirst',
        isPending: true,
        sitOutIds: [],
      });
    }

    // プロ・黒子が同卓する卓が避けられなかった場合は知らせる（人数の都合で、プロ・黒子が卓数より多いときなど）
    const clashes: string[] = [];
    generatedRounds.forEach(r => r.tables.forEach(t => {
      if (t.players.filter(p => specialIds.has(p.playerId)).length >= 2) clashes.push(`${r.round}回戦 ${t.tableNumber}卓`);
    }));
    if (clashes.length > 0) alert(`プロ・黒子が2人以上同卓する卓が避けられませんでした。\n（${clashes.join('、')}）\n人数の都合です。必要なら、卓組を作り直してください。`);

    setSeating(generatedRounds);
    setRoundOpen({});
    setTableOpen({});
    // 卓組を生成したら「抽選中」へ。管理者が「大会開始」を押すまで得点入力はできない
    updateTimer(prev => ({ ...prev, startAts: {} }));
    setTournamentPhase('drawing');
  };

  // 管理者が卓組を確認し終えたら、大会を開始する（ここから得点入力が可能になる）
  const handleStartTournament = () => {
    if (!isAdmin || tournamentPhase !== 'drawing') return;
    if (!window.confirm('大会を開始しますか？\n開始すると、全員に卓組が公開され、得点入力ができるようになります。')) return;
    setDrawingAnnounced(false);
    if (nextEntry && nextEntry.no === tournamentNo) commitNextEntry(null); // この大会の事前登録は使い終わったので消す
    setTournamentPhase('playing');
  };

  // ----------------------------------------
  // B-2. 順位順の卓組
  // ----------------------------------------
  // 「黒子」と「出場試合数を限定された選手」が上位8位(上位2卓)に入らないよう、その下を繰り上げる。
  // 弾かれた選手は順位順に9位のところへ差し込む。
  // 「プロ」と「黒子」: この2種類の選手は、2人以上を同じ卓にしない
  const isSpecialName = (name: string) => isKuroko(name) || isPro(name);
  // 上位2卓（8位まで）に入れない選手: 黒子・プロ・出場試合数を限定された選手
  const isTopExcluded = (id: string, name: string) => isSpecialName(name) || isLimitedPlayer(id);

  // 順位順の並び（queue）を、卓の数（tableCount）に分ける。基本は順位どおり上から4人ずつだが、
  // 「プロ・黒子は1卓に1人まで」を優先する。条件を満たせるよう、特別枠の人数を数えながら振り分ける。
  const arrangeLowerTables = <T extends { id: string; name: string }>(queue: T[], tableCount: number): T[][] => {
    const rest = [...queue];
    const groups: T[][] = [];
    for (let t = 0; t < tableCount; t++) {
      const tablesLeft = tableCount - t;
      const specialsLeft = rest.filter(p => isSpecialName(p.name)).length;
      // 残りの卓数で受けきれない人数のプロ・黒子がいるなら、この卓で1人受け持つ
      const mustTakeSpecial = specialsLeft > tablesLeft - 1;
      const group: T[] = [];
      let hasSpecial = false;
      for (let i = 0; i < rest.length && group.length < 4; ) {
        const p = rest[i];
        const sp = isSpecialName(p.name);
        const slotsLeft = 4 - group.length;
        const reserveForSpecial = mustTakeSpecial && !hasSpecial && slotsLeft <= 1;
        if ((sp && hasSpecial) || (!sp && reserveForSpecial)) { i++; continue; }
        group.push(p); if (sp) hasSpecial = true;
        rest.splice(i, 1);
      }
      // 人数の都合でどうしても満たせない場合は、順位順に埋める（同卓が避けられないケース）
      while (group.length < 4 && rest.length > 0) group.push(rest.shift() as T);
      groups.push(group);
    }
    return groups;
  };
  const applyKurokoRule = <T extends { id: string; name: string }>(ranked: T[]): T[] => {
    const nonKuroko = ranked.filter(p => !isTopExcluded(p.id, p.name));
    const top8 = nonKuroko.slice(0, 8);
    if (top8.length === 0) return ranked;
    const cutoffIndex = ranked.indexOf(top8[top8.length - 1]);
    const displacedKuroko = ranked.filter((p, i) => isTopExcluded(p.id, p.name) && i < cutoffIndex);
    const usedIds = new Set([...top8.map(p => p.id), ...displacedKuroko.map(p => p.id)]);
    const rest = ranked.filter(p => !usedIds.has(p.id));
    return [...top8, ...displacedKuroko, ...rest];
  };

  const buildRankedOrder = (data: Round[], beforeIdx: number, roundNo?: number) => {
    // roundNo を指定した場合は、その回戦に出場できる選手のみを順位付けの対象にする
    const rankTargetIds = roundNo ? entryPlayerIds.filter(id => isAvailableInRound(id, roundNo)) : entryPlayerIds;
    const stats: Record<string, { point: number; games: number }> = {};
    entryPlayerIds.forEach(id => { stats[id] = { point: 0, games: 0 }; });
    data.forEach((r, idx) => {
      if (idx >= beforeIdx) return;
      r.tables.forEach(t => {
        if (!t.isSubmitted) return;
        t.players.forEach(p => {
          if (stats[p.playerId]) {
            stats[p.playerId].point += p.point;
            stats[p.playerId].games += 1;
          }
        });
      });
    });
    const list = rankTargetIds.map(id => {
      const pl = dbPlayers.find(p => p.id === id);
      return {
        id,
        name: pl?.name || '不明',
        point: Math.round((stats[id]?.point || 0) * 10) / 10,
        games: stats[id]?.games || 0,
        total: pl?.totalPoint || 0,
      };
    });
    list.sort((a, b) => (b.point - a.point) || (b.total - a.total) || a.name.localeCompare(b.name));
    return applyKurokoRule(list);
  };

  const resolvePendingRound = (data: Round[], idx: number): Round => {
    const target = data[idx];
    const ordered = buildRankedOrder(data, idx, target.round);
    const numTables = Math.floor(ordered.length / 4);
    const active = ordered.slice(0, numTables * 4);
    const sitOut = ordered.slice(numTables * 4);
    const winds = ['東', '南', '西', '北'];

    // 上位2卓は順位どおり（黒子・プロ・限定選手は入らない）。残りは、プロ・黒子が同卓しないことを優先して振り分ける
    const topTables = Math.min(2, numTables);
    const groups: typeof active[] = [];
    for (let t = 0; t < topTables; t++) groups.push(active.slice(t * 4, t * 4 + 4));
    if (numTables > topTables) groups.push(...arrangeLowerTables(active.slice(topTables * 4), numTables - topTables));

    const tables: Table[] = [];
    for (let t = 0; t < numTables; t++) {
      const group = groups[t]; // 卓内の上位→下位
      const seatOrder = target.mode === 'rankBottomFirst' ? [...group].reverse() : group;
      tables.push({
        tableNumber: t + 1,
        isCalculated: false,
        isSubmitted: false,
        players: seatOrder.map((g, i) => ({
          playerId: g.id, wind: winds[i], name: g.name, score: 300, point: 0.0, chonbo: 0,
        })),
      });
    }
    return { ...target, tables, isPending: false, sitOutIds: sitOut.map(s => s.id) };
  };

  const isRoundFinished = (r: Round) => !r.isPending && r.tables.length > 0 && r.tables.every(t => t.isSubmitted);

  // ----------------------------------------
  // 成績表（リーグ戦と同じ形式）と、Xへの投稿
  // ----------------------------------------
  // 成績表の行を作る（今大会の成績）。
  //   載せる選手: 今大会に出場している選手のみ（黒子・プロ・出場試合数を限定された選手は載せない）
  //   順位・ポイント・対局数: 今大会の合計。今季通算: 選手データの通算ポイント（今大会の送信済みの分を含む）
  const buildSheetRows = (_roundNos: number[], players: Player[] = dbPlayers, upTo: number = effectiveSheetRound()): SheetRow[] => {
    // 今大会の回戦ごとの成績（送信済みの卓のみ）。得失点 = 合計点 − 順位点（チョンボなどは得失点に含む）
    const perRound = new Map<string, SheetRound[]>();
    // 巻き戻し時、upTo より後の回戦のポイント（今季通算から差し引く）
    const laterPoints = new Map<string, number>();
    seating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted || r.round < 1 || r.round > roundsCount) return;
      if (r.round > upTo) {
        t.players.forEach(pl => laterPoints.set(pl.playerId, (laterPoints.get(pl.playerId) || 0) + pl.point));
        return;
      }
      const scores = t.players.map(pl => pl.score);
      const shares = tableUmaShares(scores, rule.uma);
      const sortedScores = [...scores].sort((a, b) => b - a);
      t.players.forEach((pl, i) => {
        const arr = perRound.get(pl.playerId) || (new Array(roundsCount).fill(null) as SheetRound[]);
        arr[r.round - 1] = { raw: pl.point - shares[i], rank: sortedScores.indexOf(pl.score) + 1, total: pl.point };
        perRound.set(pl.playerId, arr);
      });
    }));
    const entrantIds = new Set<string>([...entryPlayerIds, ...Array.from(perRound.keys())]);
    const base = Array.from(entrantIds)
      .map(id => {
        const pl = players.find(x => x.id === id);
        if (!pl || isKuroko(pl.name) || isPro(pl.name) || isLimitedPlayer(id)) return null;
        const rounds = perRound.get(id) || (new Array(roundsCount).fill(null) as SheetRound[]);
        const point = rounds.reduce((sum, d) => sum + (d ? d.total : 0), 0);
        return { name: pl.name, rounds, point, season: pl.totalPoint - (laterPoints.get(id) || 0), games: rounds.filter(d => d).length };
      })
      .filter((x): x is { name: string; rounds: SheetRound[]; point: number; season: number; games: number } => x !== null)
      .sort((a, b) => b.point - a.point || a.name.localeCompare(b.name, 'ja'));
    let prevRank = 0;
    return base.map((x, i) => {
      const rank = i > 0 && Math.round(base[i - 1].point * 10) === Math.round(x.point * 10) ? prevRank : i + 1;
      prevRank = rank;
      const r1 = (v: number) => Math.round(v * 10) / 10;
      return { rank, name: x.name, point: r1(x.point), games: x.games, rounds: x.rounds, season: r1(x.season) };
    });
  };
  // 18人以内なら1ページ。それより多いときは、上位半分・下位半分の2ページに分ける
  const splitSheetPages = (rows: SheetRow[]): { label: string; rows: SheetRow[] }[] => {
    if (rows.length <= 18) return [{ label: '', rows }];
    const half = Math.ceil(rows.length / 2);
    return [{ label: '上位', rows: rows.slice(0, half) }, { label: '下位', rows: rows.slice(half) }].filter(pg => pg.rows.length > 0);
  };
  const sheetTitle = () => `第${tournamentNo || '?'}回 ${APP_TITLE} 成績表`;
  const pageTitle = (label: string) => `${sheetTitle()}${label ? `（${label}）` : ''}`;
  const latestFinishedRound = (): number => seating.filter(isRoundFinished).reduce((m, r) => Math.max(m, r.round), 0);
  // 成績表に出す回戦: 入力が始まっている回戦のうち最新の4つまで（横に長くなりすぎないように）
  // 1卓でも送信済みの回戦のうち最新のもの（全卓が終わる前でも、入力済みの卓の分が出るように）
  const latestStartedRound = (): number => seating.filter(r => r.tables.some(t => t.isSubmitted)).reduce((m, r) => Math.max(m, r.round), 0);
  // 成績表に使う回戦: 選んだ回戦（なければ最新）
  const effectiveSheetRound = (): number => {
    const latest = latestStartedRound();
    return sheetRound !== null && sheetRound >= 1 && sheetRound <= latest ? sheetRound : latest;
  };
  const sheetRoundNos = (): number[] => {
    const latest = Math.min(Math.max(effectiveSheetRound(), 1), Math.max(roundsCount, 1));
    const from = Math.max(1, latest - 3);
    return Array.from({ length: latest - from + 1 }, (_, i) => from + i);
  };
  const xPostText = (roundNo: number) =>
    `第${tournamentNo || '?'}回${APP_TITLE}\n全卓${roundNo}回戦が終了しました。\n優勝、通算上位3名：年間チャンピオン大会出場`;
  const handleSaveSheetImages = async () => {
    const roundNos = sheetRoundNos();
    let players = dbPlayers;
    try { players = await api.getPlayers(); setDbPlayers(players); } catch { /* 取得できなければ手元のデータで作る */ }
    const rows = buildSheetRows(roundNos, players);
    if (rows.length === 0) { alert('成績表に載せる選手がいません。'); return; }
    splitSheetPages(rows).forEach((pg, i) => {
      const canvas = renderStandingsSheetCanvas(pg.rows, { roundNos, title: pageTitle(pg.label) });
      setTimeout(() => {
        canvas.toBlob(blob => {
          if (!blob) return;
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = `standings_${tournamentNo}_${pg.label === '' ? 'all' : pg.label === '上位' ? 'top' : 'bottom'}.png`;
          a.click();
          setTimeout(() => URL.revokeObjectURL(url), 2000);
        }, 'image/png');
      }, i * 400);
    });
  };
  useEffect(() => {
    if (!isAdmin || tournamentPhase !== 'playing' || !showSheet) return;
    const refresh = async () => {
      if (typeof document !== 'undefined' && document.hidden) return;
      try { setDbPlayers(await api.getPlayers()); } catch { /* 次の回で再試行 */ }
    };
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, [isAdmin, tournamentPhase, showSheet]);

  // 文面をクリップボードにコピー（Xへは手動で貼り付けて投稿する）
  const copyText = async (text: string, label: string) => {
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = text; document.body.appendChild(ta); ta.select();
        ok = document.execCommand('copy'); document.body.removeChild(ta);
      } catch { ok = false; }
    }
    setCopyMsg(ok ? `${label}をコピーしました` : 'コピーできませんでした。文面を選択して手動でコピーしてください。');
    setTimeout(() => setCopyMsg(''), 2500);
  };

  // 前の回戦が全て終了した瞬間に自動で卓組を決定
  useEffect(() => {
    if (!isLoaded) return;
    if (tournamentPhase !== 'playing') return;
    const idx = seating.findIndex(r => r.isPending);
    if (idx < 0) return;
    const priorDone = seating.slice(0, idx).every(isRoundFinished);
    if (!priorDone) return;
    const updated = [...seating];
    updated[idx] = resolvePendingRound(updated, idx);
    setSeating(updated);
  }, [seating, isLoaded, tournamentPhase, dbPlayers, entryPlayerIds, playerLimits]);

  const handleReshufflePendingRound = (rIdx: number) => {
    if (!isAdmin) return;
    const r = seating[rIdx];
    if (r.tables.some(t => t.isSubmitted)) { alert('送信済みの卓があるため再決定できません。'); return; }
    if (!window.confirm('現在の順位をもとに、この回戦の卓組を決め直しますか？')) return;
    const updated = [...seating];
    updated[rIdx] = resolvePendingRound(updated, rIdx);
    setSeating(updated);
  };

  // ----------------------------------------
  // C. スコア計算 (供託のトップ取り + チョンボ)
  // ----------------------------------------
  // 管理者、または「その卓に座っていてまだ送信していない」ログイン中の選手なら編集可能。
  // 送信済みの卓は運営（管理者）にしか編集できない。
  // ※ 大会開始前（卓組抽選中）は、管理者を含め誰も入力できない
  const canEditTable = (table: Table) =>
    tournamentPhase === 'playing' && (isAdmin || (!!loggedInPlayerId && !table.isSubmitted && table.players.some(p => p.playerId === loggedInPlayerId)));

  const handleScoreChange = (rIdx: number, tIdx: number, pIdx: number, val: number) => {
    if (!canEditTable(seating[rIdx].tables[tIdx])) return;
    const updated = [...seating];
    if (updated[rIdx].tables[tIdx].isSubmitted) return;
    updated[rIdx].tables[tIdx].players[pIdx].score = val;
    updated[rIdx].tables[tIdx].isCalculated = false;
    setSeating(updated);
  };

  const handleChonboChange = (rIdx: number, tIdx: number, pIdx: number, delta: number) => {
    if (!canEditTable(seating[rIdx].tables[tIdx])) return;
    const updated = [...seating];
    const table = updated[rIdx].tables[tIdx];
    if (table.isSubmitted) return;
    const cur = table.players[pIdx].chonbo || 0;
    table.players[pIdx].chonbo = Math.max(0, Math.min(9, cur + delta));
    table.isCalculated = false;
    setSeating(updated);
  };

  const calculateTablePoints = (rIdx: number, tIdx: number) => {
    if (!canEditTable(seating[rIdx].tables[tIdx])) return;
    const updated = [...seating];
    const table = updated[rIdx].tables[tIdx];
    const sum = table.players.reduce((acc, p) => acc + (p.score || 0), 0);
    const diff = 1200 - sum;
    
    if (diff < 0) { alert('得点の合計が120,000点を超えています。'); return; }
    if (diff % 10 !== 0) { alert('不足分が1,000点単位ではありません。'); return; }

    const sorted = table.players.map((p, index) => ({ score: p.score, index })).sort((a, b) => b.score - a.score);
    
    const topScore = sorted[0].score;
    const topTiedCount = sorted.filter(p => p.score === topScore).length;
    
    let i = 0;
    while (i < sorted.length) {
      let j = i;
      while (j < sorted.length && sorted[j].score === sorted[i].score) j++;
      
      const tieCount = j - i;
      let umaSum = 0;
      for (let k = i; k < j; k++) umaSum += rule.uma[k];
      const splitUma = umaSum / tieCount;

      for (let k = i; k < j; k++) {
        const item = sorted[k];
        let pt = (item.score - rule.returnPoint) / 10;
        pt += splitUma;
        
        // 供託・不足分(diff)をトップ(同点トップなら等分)に加算
        if (item.score === topScore) pt += (diff / 10) / topTiedCount;

        // チョンボ罰符 (順位点計算のあとに減算)
        pt -= CHONBO_PENALTY * (table.players[item.index].chonbo || 0);
        
        table.players[item.index].point = Math.round(pt * 10) / 10;
      }
      i = j;
    }

    table.isCalculated = true;
    setSeating(updated);
  };

  // ----------------------------------------
  // D. 送信と「送信の取り消し(編集)」
  // ----------------------------------------
  // 送信・取消の処理中は同じ卓を再度処理しない（連打・二重タップによる二重加算を防ぐ）
  const submittingTables = useRef<Set<string>>(new Set());

  const handleSubmitTable = async (rIdx: number, tIdx: number) => {
    const table = seating[rIdx].tables[tIdx];
    if (!canEditTable(table)) return;
    if (table.isSubmitted) return;
    if (!table.isCalculated) { alert('先にスコアを計算してください。'); return; }
    const lockKey = `${seating[rIdx].round}-${table.tableNumber}`;
    if (submittingTables.current.has(lockKey)) return;
    const confirmMsg = isAdmin
      ? 'クラウドに送信しますか？'
      : '本当に送信しますか？\n\n卓内の1人が入力後、全員の確認を取ってから送信ボタンを押してください。\n送信後、一度確定すると自分では修正できません。間違いが発覚した場合は運営にお知らせください。';
    if (!window.confirm(confirmMsg)) return;

    submittingTables.current.add(lockKey);
    try {
      // 別の端末ですでに送信済みの卓なら、二重に加算しない
      try {
        const latest = await api.getCurrentTournament();
        const srv = (latest?.seating as Round[] | undefined)?.find(x => x.round === seating[rIdx].round)
          ?.tables.find(x => x.tableNumber === table.tableNumber);
        if (srv?.isSubmitted) {
          alert('この卓はすでに送信済みです（他の端末で送信されました）。画面を更新して確認してください。');
          return;
        }
      } catch { /* 取得できなければ手元の状態で続行 */ }

      const updates = table.players.map(p => ({ id: p.playerId, pointDelta: p.point }));
      await api.updatePlayersScores(updates);
    } catch (err) {
      console.error(err);
      alert('通算ポイントの更新に失敗しました。送信は完了していません。もう一度お試しください。');
      return;
    } finally {
      submittingTables.current.delete(lockKey);
    }
    setDbPlayers(await api.getPlayers());

    const updated = [...seating];
    updated[rIdx].tables[tIdx].isSubmitted = true;
    setSeating(updated);
    // 送信した卓は自動的に畳む
    setTableOpen(prev => ({ ...prev, [`${seating[rIdx].round}-${table.tableNumber}`]: false }));

    // この回戦の全卓の送信が終わった瞬間に、次の回戦の開始時刻（＝今 + 休憩時間）を決める。
    // 他の端末で送信された卓を見落とさないよう、サーバー上の最新状態も確認する。
    const thisRound = seating[rIdx];
    if (thisRound.round < roundsCount) {
      let serverRound: Round | undefined;
      try {
        const latest = await api.getCurrentTournament();
        serverRound = (latest?.seating as Round[] | undefined)?.find(x => x.round === thisRound.round);
      } catch { /* 取得できなくても手元の状態で判定する */ }
      const allSubmitted = thisRound.tables.length > 0 && thisRound.tables.every(t =>
        t.isSubmitted || !!serverRound?.tables.find(x => x.tableNumber === t.tableNumber)?.isSubmitted);
      if (allSubmitted) {
        const nextRound = thisRound.round + 1;
        updateTimer(prev => (prev.startAts[nextRound]
          ? prev
          : { ...prev, startAts: { ...prev.startAts, [nextRound]: Date.now() + prev.breakMinutes * 60 * 1000 } }));
      }
    }
  };

  const handleRevokeTable = async (rIdx: number, tIdx: number) => {
    if (!isAdmin) return;
    const table = seating[rIdx].tables[tIdx];
    if (!window.confirm('【警告】\nこの卓の送信を取り消し、成績を編集できるようにしますか？\n※通算成績に加算されたポイントは一旦マイナスされます。')) return;

    const reverses = table.players.map(p => ({ id: p.playerId, pointDelta: -p.point }));
    await api.updatePlayersScores(reverses);
    setDbPlayers(await api.getPlayers());

    const updated = [...seating];
    updated[rIdx].tables[tIdx].isSubmitted = false;
    updated[rIdx].tables[tIdx].isCalculated = false;
    setSeating(updated);
    // この回戦が未完了に戻ったので、次の回戦のタイマーは取り消す（再び全卓が送信されたら改めて開始）
    const revokedNext = seating[rIdx].round + 1;
    updateTimer(prev => {
      if (prev.startAts[revokedNext] === undefined) return prev;
      const startAts = { ...prev.startAts };
      delete startAts[revokedNext];
      return { ...prev, startAts };
    });
    alert('送信を取り消しました。スコアを修正してください。');
  };

  // ----------------------------------------
  // E. 大会全体のリセット
  // ----------------------------------------
  // 誤操作防止のための共通30秒待機処理
  const runResetCountdown = async (message: string) => {
    setResetMessage(message);
    setIsResetting(true);
    let count = 30;
    setResetCountdown(count);
    await new Promise<void>(resolve => {
      const timer = setInterval(() => {
        count -= 1;
        setResetCountdown(count);
        if (count <= 0) { clearInterval(timer); resolve(); }
      }, 1000);
    });
    setIsResetting(false);
  };

  const handleResetTournament = async () => {
    if (!isAdmin) return;
    if (!window.confirm('【警告】現在の大会の進行を全てリセットしますか？')) return;
    await runResetCountdown('大会の進行をリセット中...');
    setTimeout(async () => {
      if (window.confirm('【最終確認】待機時間が終了しました。\n本当に全てリセットしますか？')) {
        try {
          // 送信済みの卓は既に通算成績へ加算されているため、リセット前に取り消す
          const reverses: { id: string; pointDelta: number }[] = [];
          seating.forEach(r => r.tables.forEach(t => {
            if (!t.isSubmitted) return;
            t.players.forEach(p => {
              reverses.push({ id: p.playerId, pointDelta: -p.point });
            });
          }));
          // 今大会がすでに過去大会に登録済みなら、ポイントは過去大会側に含まれているので取り消さない
          if (reverses.length > 0 && !currentTournamentArchived) await api.updatePlayersScores(reverses);
          setDbPlayers(await api.getPlayers());
        } catch (err) {
          console.error(err);
          alert('通算成績の取り消し中にエラーが発生しました。処理を中断します。コンソールを確認してください。');
          return;
        }
        setSeating([]); setEntryPlayerIds([]); setPlayerLimits({}); setDrawingAnnounced(false); updateTimer(prev => ({ ...prev, startAts: {} })); setTournamentPhase('entry'); setActiveTab('tournament');
        await api.clearCurrentTournament();
        alert('大会状況をリセットしました。（送信済みだった分の通算成績も取り消し済みです）');
      }
    }, 100);
  };

  // 今大会を過去大会としてアーカイブする。
  //   ・送信済みの卓の成績から、最終成績・半荘ログ・チョンボ記録を作って保存する
  //   ・今季の通算ポイントには、送信のたびに加算済みなので、ここでは加算しない（二重加算を防ぐ）
  //   ・保存に成功したら、今大会の進行をクリアして、次の大会の準備状態に戻す
  const handleArchiveCurrentTournament = async () => {
    if (!isAdmin || isArchivingCurrent) return;
    const no = parseInt(String(tournamentNo), 10);
    if (!no) { alert('大会の回数（第何回か）が設定されていません。'); return; }
    const name = `第${no}回`;
    if (archives.some(a => archiveTournamentNo(a.name) === no)) {
      alert(`「${name}」はすでに過去大会に登録されています。\n大会の回数を確認するか、過去大会の登録を先に削除してください。`);
      return;
    }
    const submittedTables: { round: number; table: Table }[] = [];
    seating.forEach(r => {
      if (r.round < 1 || r.round > roundsCount) return;
      r.tables.forEach(t => { if (t.isSubmitted) submittedTables.push({ round: r.round, table: t }); });
    });
    if (submittedTables.length === 0) { alert('送信済みの卓がありません。成績を送信してからアーカイブしてください。'); return; }
    const totalTables = seating.filter(r => !r.isPending || r.tables.length > 0).reduce((n, r) => n + r.tables.length, 0);
    const unsubmitted = Math.max(0, totalTables - submittedTables.length);
    const pendingRounds = seating.filter(r => r.isPending || r.tables.length === 0).length;
    const incompleteNote = unsubmitted > 0 || pendingRounds > 0
      ? `\n\n⚠️ 未送信の卓（${unsubmitted}卓）や、卓組が決まっていない回戦（${pendingRounds}回戦）があります。送信済みの分だけが保存されます。`
      : '';

    // 半荘ログ（1卓 = 1半荘）
    submittedTables.sort((a, b) => a.round - b.round || a.table.tableNumber - b.table.tableNumber);
    const hanchans: ArchiveHanchan[] = submittedTables.map((x, i) => {
      const sortedScores = [...x.table.players.map(p => p.score)].sort((a, b) => b - a);
      return {
        no: i + 1,
        round: x.round,
        table: x.table.tableNumber,
        deposit: Math.round((getTableDeposit(x.table) / 10) * 10) / 10,
        results: x.table.players.map(p => ({
          playerId: p.playerId,
          name: p.name,
          rank: sortedScores.indexOf(p.score) + 1,
          score: p.score,
          point: Math.round(p.point * 10) / 10,
          excluded: isKuroko(p.name),
        })),
      };
    });

    // 最終成績（黒子は順位に含めない）
    const agg = new Map<string, { name: string; point: number; games: number }>();
    hanchans.forEach(h => h.results.forEach(r => {
      if (r.excluded) return;
      const cur = agg.get(r.playerId) || { name: r.name, point: 0, games: 0 };
      cur.point += r.point; cur.games += 1;
      agg.set(r.playerId, cur);
    }));
    const sorted = Array.from(agg.entries())
      .map(([playerId, v]) => ({ playerId, name: v.name, totalPoint: Math.round(v.point * 10) / 10, gameCount: v.games }))
      .sort((a, b) => b.totalPoint - a.totalPoint || a.name.localeCompare(b.name, 'ja'));
    let prevRank = 0;
    const standings: ArchiveStanding[] = sorted.map((x, i) => {
      const rank = i > 0 && Math.round(sorted[i - 1].totalPoint * 10) === Math.round(x.totalPoint * 10) ? prevRank : i + 1;
      prevRank = rank;
      return { ...x, rank };
    });

    // チョンボの記録（成績には織り込み済みなので、参考情報として保存）
    const penalties: ArchivePenalty[] = [];
    submittedTables.forEach(x => x.table.players.forEach(p => {
      if ((p.chonbo || 0) > 0) penalties.push({ playerId: p.playerId, name: p.name, point: -CHONBO_PENALTY * p.chonbo, reason: `チョンボ×${p.chonbo}（${x.round}回戦 ${x.table.tableNumber}卓）` });
    }));

    const mismatchNote = totalMismatches.length > 0
      ? `\n\n※今季ポイントがズレている選手がいます（${totalMismatches.length}名）。アーカイブ前に「🔧 通算を検算して修正」を実行することをおすすめします。`
      : '';
    if (!window.confirm(`今大会を「${name}」として過去大会に保存します。\n\n・最終成績: ${standings.length}名\n・半荘ログ: ${hanchans.length}卓分\n・チョンボ記録: ${penalties.length}件\n\n保存後、今大会の進行はクリアされ、次の大会の準備状態に戻ります。\n※今季ポイントには送信時に加算済みのため、再度の加算はしません。${incompleteNote}${mismatchNote}`)) return;

    setIsArchivingCurrent(true);
    try {
      // 1. 先にアーカイブを保存（失敗した場合は何も変更しない）
      // 保存順は、取り込み済みの過去大会と同じ「新しい半荘が先」にそろえる（画面は反転して古い順に表示するため）
      await api.saveArchive({ name, ruleName: RULE_NAME, standings, hanchans: [...hanchans].reverse().map((h, i) => ({ ...h, no: i + 1 })), penalties });
      // 2. 今大会の進行をクリア（通算ポイントは取り消さない）
      await api.clearCurrentTournament();
      setSeating([]); setEntryPlayerIds([]); setPlayerLimits({}); setDrawingAnnounced(false);
      updateTimer(prev => ({ ...prev, startAts: {} }));
      setTournamentPhase('entry'); setSheetRound(null);
      const latestArchives: TournamentArchive[] = await api.getArchives();
      setArchives(latestArchives);
      setDbPlayers(await api.getPlayers());
      // 3. 次に入力する回 = まだ登録されていない一番小さい回
      const done = new Set<number>();
      latestArchives.forEach(a => { const n = archiveTournamentNo(a.name); if (n !== null) done.add(n); });
      let next = 1; while (done.has(next)) next++;
      setTournamentNo(String(next));
      setActiveTab('tournament');
      alert(`「${name}」を過去大会に保存しました。\n今大会の進行をクリアしました（次は第${next}回）。`);
    } catch (err) {
      console.error(err);
      alert('アーカイブ中にエラーが発生しました。今大会のデータはそのまま残っています。コンソールを確認してください。\n（tournament_archivesテーブルのINSERTポリシーを確認してください）');
    } finally {
      setIsArchivingCurrent(false);
    }
  };

  // すでに過去大会へ登録済みの今大会の進行データだけをクリアする（通算ポイントは変更しない）
  const handleClearArchivedCurrent = async () => {
    if (!isAdmin || !currentTournamentArchived) return;
    const no = parseInt(String(tournamentNo), 10);
    if (!window.confirm(`第${no}回はすでに過去大会に登録済みです。\n残っている今大会の進行データをクリアします。\n\n※通算ポイントは変更しません（過去大会に含まれているため）。`)) return;
    try {
      await api.clearCurrentTournament();
      setSeating([]); setEntryPlayerIds([]); setPlayerLimits({}); setDrawingAnnounced(false);
      updateTimer(prev => ({ ...prev, startAts: {} }));
      setTournamentPhase('entry'); setSheetRound(null);
      const done = new Set<number>();
      archives.forEach(a => { const n = archiveTournamentNo(a.name); if (n !== null) done.add(n); });
      let next = 1; while (done.has(next)) next++;
      setTournamentNo(String(next));
      setActiveTab('tournament');
      alert(`クリアしました（次は第${next}回）。`);
    } catch (err) {
      console.error(err);
      alert('クリア中にエラーが発生しました。');
    }
  };

  // 全選手の通算ポイントを0にリセットする（過去大会の記録自体は削除しない）。
  // 通算対局数は過去大会＋今大会から自動計算される値なので、ここでは触らない
  // （半荘数もリセットしたい場合は、過去大会一覧から該当の大会を削除してください）。
  const handleResetAllTotals = async () => {
    if (!isAdmin) return;
    if (!window.confirm('【警告】全選手の通算ポイントを0にリセットしますか？\n※半荘数は過去大会の記録から自動計算されるため、この操作では変わりません。\n※過去大会一覧・今大会の記録自体は削除されません。')) return;
    await runResetCountdown('通算ポイントを全員リセット中...');
    setTimeout(async () => {
      if (window.confirm('【最終確認】待機時間が終了しました。\n本当に全選手の通算ポイントを0にリセットしますか？')) {
        try {
          for (const p of dbPlayers) {
            if (p.totalPoint === 0) continue;
            await api.updatePlayer({ ...p, totalPoint: 0 });
          }
          setDbPlayers(await api.getPlayers());
          alert('全選手の通算ポイントを0にリセットしました。');
        } catch (err) {
          console.error(err);
          alert('リセット中にエラーが発生しました。コンソールを確認してください。');
        }
      }
    }, 100);
  };

  // ----------------------------------------
  // F. 大会中の選手追加・差し替え（管理者用・誤操作防止つき）
  // ----------------------------------------
  const [showAdminTools, setShowAdminTools] = useState(false);
  const [addExistingId, setAddExistingId] = useState('');
  const [quickName, setQuickName] = useState('');
  const [replaceSeatKey, setReplaceSeatKey] = useState(''); // `${rIdx}-${tIdx}-${pIdx}`
  const [replaceWithId, setReplaceWithId] = useState('');
  const [swapSeatA, setSwapSeatA] = useState('');
  const [swapSeatB, setSwapSeatB] = useState('');

  // 編集可能（未送信）な席の一覧
  const editableSeats = seating.flatMap((r, rIdx) =>
    r.isPending ? [] : r.tables.flatMap((t, tIdx) =>
      t.isSubmitted ? [] : t.players.map((p, pIdx) => ({
        key: `${rIdx}-${tIdx}-${pIdx}`,
        label: `${r.round}回戦 ${tableName(t.tableNumber)} ${p.wind}家 : ${proMarkedName(p.name)}`,
        rIdx, tIdx, pIdx,
      }))
    )
  );

  const handleAddExistingToTournament = () => {
    if (!isAdmin || !addExistingId) return;
    const pl = dbPlayers.find(p => p.id === addExistingId);
    if (!pl) return;
    if (entryPlayerIds.includes(pl.id)) { alert('既に参加登録されています。'); return; }
    if (!window.confirm(`${pl.name} を今大会の参加者に追加しますか？\n（席への割り当ては「席の差し替え」から行ってください）`)) return;
    setEntryPlayerIds([...entryPlayerIds, pl.id]);
    setAddExistingId('');
    alert(`${pl.name} を参加者に追加しました。`);
  };

  const handleQuickRegister = async () => {
    if (!isAdmin) return;
    const name = quickName.trim();
    if (!name) return;
    if (!window.confirm(`「${name}」を新規登録して今大会の参加者に追加しますか？`)) return;
    const existingCodes = new Set<string>(dbPlayers.map(p => p.loginCode || '').filter(c => c !== ''));
    const newPlayer: Player = { id: crypto.randomUUID(), name, totalPoint: 0, totalGames: 0, championshipRight: false, loginCode: generateLoginCode(existingCodes) };
    await api.savePlayer(newPlayer);
    setDbPlayers(await api.getPlayers());
    setEntryPlayerIds([...entryPlayerIds, newPlayer.id]);
    setQuickName('');
    alert(`${name} を登録・参加者に追加しました。`);
  };

  const handleReplaceSeat = () => {
    if (!isAdmin || !replaceSeatKey || !replaceWithId) return;
    const seat = editableSeats.find(s => s.key === replaceSeatKey);
    if (!seat) { alert('対象の席が見つかりません。画面を確認してください。'); return; }
    const newPlayer = dbPlayers.find(p => p.id === replaceWithId);
    if (!newPlayer) return;

    const round = seating[seat.rIdx];
    const table = round.tables[seat.tIdx];
    if (table.isSubmitted) { alert('送信済みの卓は変更できません。'); return; }
    if (table.players.some((p, i) => p.playerId === newPlayer.id && i !== seat.pIdx)) {
      alert('その選手は同じ卓に既にいます。'); return;
    }
    const old = table.players[seat.pIdx];
    if (!window.confirm(`${round.round}回戦 ${tableName(table.tableNumber)} ${old.wind}家\n\n${proMarkedName(old.name)} → ${proMarkedName(newPlayer.name)}\n\nこの内容で差し替えますか？`)) return;

    const updated = [...seating];
    const t = updated[seat.rIdx].tables[seat.tIdx];
    t.players[seat.pIdx] = { ...t.players[seat.pIdx], playerId: newPlayer.id, name: newPlayer.name, chonbo: 0 };
    t.isCalculated = false;
    setSeating(updated);
    if (!entryPlayerIds.includes(newPlayer.id)) setEntryPlayerIds([...entryPlayerIds, newPlayer.id]);
    setReplaceSeatKey(''); setReplaceWithId('');
    alert('差し替えました。');
  };

  const handleSwapSeats = () => {
    if (!isAdmin || !swapSeatA || !swapSeatB) return;
    if (swapSeatA === swapSeatB) { alert('別々の席を選んでください。'); return; }
    const a = editableSeats.find(s => s.key === swapSeatA);
    const b = editableSeats.find(s => s.key === swapSeatB);
    if (!a || !b) { alert('対象の席が見つかりません。'); return; }
    if (a.rIdx !== b.rIdx) { alert('同じ回戦の席同士でのみ入れ替えられます。'); return; }

    const round = seating[a.rIdx];
    const pa = round.tables[a.tIdx].players[a.pIdx];
    const pb = round.tables[b.tIdx].players[b.pIdx];
    if (!window.confirm(`${round.round}回戦\n\n${tableName(round.tables[a.tIdx].tableNumber)} ${pa.wind}家 : ${proMarkedName(pa.name)}\n　　　　⇅\n${tableName(round.tables[b.tIdx].tableNumber)} ${pb.wind}家 : ${proMarkedName(pb.name)}\n\nこの2人を入れ替えますか？`)) return;

    const updated = [...seating];
    const ta = updated[a.rIdx].tables[a.tIdx];
    const tb = updated[b.rIdx].tables[b.tIdx];
    const tmp = { playerId: ta.players[a.pIdx].playerId, name: ta.players[a.pIdx].name };
    ta.players[a.pIdx] = { ...ta.players[a.pIdx], playerId: tb.players[b.pIdx].playerId, name: tb.players[b.pIdx].name };
    tb.players[b.pIdx] = { ...tb.players[b.pIdx], playerId: tmp.playerId, name: tmp.name };
    ta.isCalculated = false; tb.isCalculated = false;
    setSeating(updated);
    setSwapSeatA(''); setSwapSeatB('');
    alert('入れ替えました。');
  };

  // ----------------------------------------
  // G. 過去大会（アーカイブ）のインポート
  // ----------------------------------------
  const [showArchiveImport, setShowArchiveImport] = useState(false);
  const [archiveRoundNumber, setArchiveRoundNumber] = useState('');
  // 手で書き換えていない間は、いま入力している大会の回（tournamentNo）を自動で入れておく
  const archiveRoundTouched = useRef(false);
  useEffect(() => {
    if (!archiveRoundTouched.current) setArchiveRoundNumber(tournamentNo);
  }, [tournamentNo]);
  const [archiveNotes, setArchiveNotes] = useState('');
  const [lifetimeScope, setLifetimeScope] = useState<LifetimeScope>('all'); // 生涯成績一覧の表示範囲
  const [lifetimeSort, setLifetimeSort] = useState<{ key: string; dir: 'asc' | 'desc' } | null>(null); // 生涯成績一覧の並べ替え（null=元の順）
  const [archiveRuleName, setArchiveRuleName] = useState(RULE_NAME); // この大会で使ったルール（生涯ポイントは最高位戦ルールのみ反映）
  const archiveRuleTouched = useRef(false);
  const [archiveNameSuffix, setArchiveNameSuffix] = useState(''); // 例: 年間チャンピオン戦（別大会として登録するとき）
  useEffect(() => {
    if (archiveRuleTouched.current) return;
    const n = parseInt(archiveRoundNumber, 10);
    setArchiveRuleName((Number.isFinite(n) && RULE_NAME_BY_TOURNAMENT_NO[n]) || RULE_NAME);
  }, [archiveRoundNumber]);
  const [archiveRawText, setArchiveRawText] = useState('');
  const [archivePreview, setArchivePreview] = useState<{
    leaderboard: ParsedLeaderboardRow[];
    hanchans: ParsedHanchan[];
    newNames: string[];
  } | null>(null);
  const [penaltyRows, setPenaltyRows] = useState<{ name: string; point: string; reason: string }[]>([]);
  const [isImportingArchive, setIsImportingArchive] = useState(false);

  const handlePreviewArchiveText = () => {
    if (!isAdmin) return;
    const leaderboard = parseMmcLeaderboard(archiveRawText);
    const hanchans = parseMmcHanchanLog(archiveRawText);
    if (leaderboard.length === 0 && hanchans.length === 0) {
      alert('テキストからデータを読み取れませんでした。MMCの「トータル成績」〜「半荘ごと」の範囲をそのまま貼り付けてください。');
      setArchivePreview(null);
      return;
    }
    const existingNames = new Set(dbPlayers.map(p => p.name));
    const allNames = new Set<string>();
    leaderboard.forEach(r => allNames.add(r.name));
    hanchans.forEach(h => h.rows.forEach(r => allNames.add(r.name)));
    const newNames = [...allNames].filter(n => !existingNames.has(n));
    setArchivePreview({ leaderboard, hanchans, newNames });
    setPenaltyRows([]);
  };

  const addPenaltyRow = () => setPenaltyRows(prev => [...prev, { name: '', point: '-20', reason: '' }]);
  const updatePenaltyRow = (idx: number, patch: Partial<{ name: string; point: string; reason: string }>) => {
    setPenaltyRows(prev => prev.map((r, i) => (i === idx ? { ...r, ...patch } : r)));
  };
  const removePenaltyRow = (idx: number) => setPenaltyRows(prev => prev.filter((_, i) => i !== idx));

  const handleCommitArchiveImport = async () => {
    if (!isAdmin || !archivePreview) return;
    const roundNum = archiveRoundNumber.trim();
    if (!roundNum) { alert('第何回か入力してください。'); return; }
    if (archivePreview.leaderboard.length === 0) { alert('最終成績（トータル成績）が読み取れていません。'); return; }
    const archiveDisplayName = `第${roundNum}回${archiveNameSuffix.trim() ? ` ${archiveNameSuffix.trim()}` : ''}`;
    // 今季より前の大会（前季）は、今季のポイントに加算せず、選手の新規登録もしない（生涯成績にのみ反映）
    const isPrevSeason = isPreviousSeasonArchive({ name: archiveDisplayName });
    const ruleNameToSave = archiveRuleName.trim() || RULE_NAME;
    const validPenalties = penaltyRows.filter(p => p.name.trim() && p.point.trim());
    if (!window.confirm(isPrevSeason
      ? `「${archiveDisplayName}」（${ruleNameToSave}）を、前季の過去大会として登録しますか？\n\n・最終成績: ${archivePreview.leaderboard.length}名\n・半荘ログ: ${archivePreview.hanchans.length}半荘\n・ペナルティ記録: ${validPenalties.length}件\n\n※今季の通算ポイントには加算されません。選手の新規登録もされません。\n※生涯成績には反映されます（最高位戦ルール以外の大会は、生涯ポイントには最高位戦ルールに換算した参考値として反映されます）。`
      : `「${archiveDisplayName}」を過去大会として登録しますか？\n\n・最終成績: ${archivePreview.leaderboard.length}名\n・半荘ログ: ${archivePreview.hanchans.length}半荘\n・ペナルティ記録: ${validPenalties.length}件\n・新規登録される選手: ${archivePreview.newNames.length}名\n\n登録すると、対象選手の今季成績（ポイント・半荘数）に加算されます。`)) return;

    setIsImportingArchive(true);
    try {
      // 1. 選手名 → playerId の解決（無ければ新規作成）
      const nameToId = new Map<string, string>();
      let workingPlayers = [...dbPlayers];
      const resolveId = async (name: string): Promise<string> => {
        if (nameToId.has(name)) return nameToId.get(name)!;
        const found = workingPlayers.find(p => p.name === name);
        if (found) { nameToId.set(name, found.id); return found.id; }
        if (isPrevSeason) {
          // 前季のみの選手は、選手として新規登録しない（個人ページ・ログインコードは作らない）
          const legacyId = `legacy:${name}`;
          nameToId.set(name, legacyId);
          return legacyId;
        }
        const existingCodes = new Set<string>(workingPlayers.map(p => p.loginCode || '').filter(c => c !== ''));
        const newPlayer: Player = { id: crypto.randomUUID(), name, totalPoint: 0, totalGames: 0, championshipRight: false, loginCode: generateLoginCode(existingCodes) };
        await api.savePlayer(newPlayer);
        workingPlayers = [...workingPlayers, newPlayer];
        nameToId.set(name, newPlayer.id);
        return newPlayer.id;
      };

      for (const name of archivePreview.newNames) {
        await resolveId(name);
      }
      // リーダーボード・半荘ログ・ペナルティに出てくる全ての名前を解決
      for (const row of archivePreview.leaderboard) await resolveId(row.name);
      for (const h of archivePreview.hanchans) for (const r of h.rows) await resolveId(r.name);
      for (const p of validPenalties) await resolveId(p.name.trim());

      // 2. standings / hanchans / penalties を構築
      const standings: ArchiveStanding[] = archivePreview.leaderboard.map(row => ({
        playerId: nameToId.get(row.name)!,
        name: row.name,
        totalPoint: row.point,
        gameCount: row.gameCount,
        rank: row.rank,
      }));
      const hanchans: ArchiveHanchan[] = archivePreview.hanchans.map(h => ({
        no: h.no,
        deposit: h.deposit,
        results: h.rows.map(r => ({
          playerId: nameToId.get(r.name)!,
          name: r.name,
          rank: r.rank,
          score: r.score,
          point: r.point,
          excluded: r.excluded,
        })),
      }));
      const penalties: ArchivePenalty[] = validPenalties.map(p => ({
        playerId: nameToId.get(p.name.trim())!,
        name: p.name.trim(),
        point: Number(p.point),
        reason: p.reason.trim() || '（理由未入力）',
      }));

      // 3. アーカイブとして保存
      await api.saveArchive({
        name: archiveDisplayName,
        ruleName: ruleNameToSave,
        notes: archiveNotes.trim() || undefined,
        standings,
        hanchans,
        penalties,
      });

      // 4. 通算成績へ反映（standingsの値をそのまま加算。ペナルティは既に最終成績に織り込み済みのため二重加算しない）
      // 前季の大会は今季のポイントに加算しない（生涯成績は、保存した大会の記録から別途計算する）
      const updates = standings.map(s => ({ id: s.playerId, pointDelta: s.totalPoint }));
      if (!isPrevSeason && updates.length > 0) await api.updatePlayersScores(updates);

      setDbPlayers(await api.getPlayers());
      setArchives(await api.getArchives());
      // 登録した回が「いま入力している大会の回」だった場合は、次に入力する回を、まだ登録されていない一番小さい回にする
      // （例: 第1〜5回と第7回が登録済みなら、次は第6回）。必要なら画面から手動で変更できる。
      if (roundNum === tournamentNo && !archiveNameSuffix.trim()) {
        const done = new Set<number>();
        (await api.getArchives()).forEach((a: TournamentArchive) => {
          const m = a.name.match(/第(\d+)回/);
          if (m) done.add(parseInt(m[1], 10));
        });
        let next = 1;
        while (done.has(next)) next++;
        setTournamentNo(String(next));
        archiveRoundTouched.current = false;
        setArchiveRoundNumber(String(next));
      } else {
        archiveRoundTouched.current = false;
        setArchiveRoundNumber(tournamentNo);
      }
      setArchiveNotes(''); setArchiveRawText(''); setArchivePreview(null); setPenaltyRows([]); setArchiveNameSuffix(''); archiveRuleTouched.current = false; setArchiveRuleName(RULE_NAME);
      setShowArchiveImport(false);
      alert('過去大会を登録しました。');
    } catch (err) {
      console.error(err);
      alert('登録中にエラーが発生しました。コンソールを確認してください。');
    } finally {
      setIsImportingArchive(false);
    }
  };

  const handleDeleteArchive = async (archive: TournamentArchive) => {
    if (!isAdmin) return;
    if (!window.confirm(`「${archive.name}」を削除しますか？\n\n通算成績に加算されていたポイント・半荘数も取り消されます。`)) return;
    try {
      // 先に削除を確定させ、成功したことを確認してから通算成績を取り消す。
      // （削除に失敗した状態でポイントだけ取り消されると、再度削除ボタンを押した際に二重に減算されてしまうため）
      await api.deleteArchive(archive.id);
      // 前季の大会は今季のポイントに加算していないため、取り消しもしない
      const reverses = archive.standings.map(s => ({ id: s.playerId, pointDelta: -s.totalPoint }));
      if (!isPreviousSeasonArchive(archive) && reverses.length > 0) await api.updatePlayersScores(reverses);
      setDbPlayers(await api.getPlayers());
      setArchives(await api.getArchives());
      alert('削除しました。');
    } catch (err) {
      console.error(err);
      alert('削除中にエラーが発生しました。通算成績への反映は行っていません。コンソールを確認してください。\n（tournament_archivesテーブルのDELETEポリシーが正しく設定されているか確認してください）');
    }
  };

  // ----------------------------------------
  // H. データ集計
  // ----------------------------------------
  // 通算成績: 黒子は常に非表示
  const displayDbPlayers = [...dbPlayers]
    .filter(p => !isKuroko(p.name))
    .sort((a, b) => b.totalPoint - a.totalPoint);

  // 出場権が実際にあるのは「手動で付与されている」場合のみ。
  // 麻雀プロ(末尾がP)は半荘数や付与フラグに関わらず出場権を持たない。
  const hasChampionshipRight = (p: Player) => !isPro(p.name) && !!p.championshipRight;
  // 今季の大会（第4回以降）。今季成績は、前季（第1〜3回）を含めずに集計する
  const seasonArchives = archives.filter(a => !isPreviousSeasonArchive(a));
  // 今季対局数 = 今季の過去大会（アーカイブ）の半荘数の合計 ＋ 今大会（進行中・送信済み）の半荘数
  // 手動で編集・加減算する値ではなく、常にここから計算する。
  const getTotalGames = (playerId: string): number => {
    let count = 0;
    seasonArchives.forEach(a => {
      const standing = a.standings.find(s => s.playerId === playerId);
      if (standing) count += standing.gameCount;
    });
    count += getCurrentTournamentGameCount(playerId);
    return count;
  };

  // 今大会（進行中）で、指定選手が送信済みの卓に入った半荘数
  const getCurrentTournamentGameCount = (playerId: string) => {
    let count = 0;
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      if (t.players.some(p => p.playerId === playerId)) count++;
    }));
    return count;
  };

  // 各回戦の開始時刻の表示用。2回戦以降でタイマーが動いた回戦は実際の開始時刻、それ以外は従来の目安
  const startTimeOf = (roundNo: number): string | null =>
    timerState.startAts[roundNo] ? formatClock(timerState.startAts[roundNo]) : (scheduleTimes[roundNo - 1] || null);

  // 今季ポイントの「正しい値」= 今季の過去大会の最終成績 ＋ 今大会で送信済みの卓の合計。
  // 選手データの通算ポイント（加減算で更新される値）がこれとズレていないかの検算に使う。
  const getExpectedSeasonPoint = (playerId: string): number => {
    let pt = 0;
    seasonArchives.forEach(a => {
      const st = a.standings.find(s => s.playerId === playerId);
      if (st) pt += st.totalPoint;
    });
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      const me = t.players.find(p => p.playerId === playerId);
      if (me) pt += me.point;
    }));
    return Math.round(pt * 10) / 10;
  };
  const totalMismatches = dbPlayers
    .filter(p => !isKuroko(p.name))
    .map(p => ({ player: p, expected: getExpectedSeasonPoint(p.id), actual: Math.round(p.totalPoint * 10) / 10 }))
    .filter(x => Math.abs(x.expected - x.actual) >= 0.05 && (getTotalGames(x.player.id) > 0 || x.actual !== 0));

  const handleFixTotals = async () => {
    if (!isAdmin) return;
    if (totalMismatches.length === 0) { alert('ズレは見つかりませんでした。今季ポイントは大会成績の合計と一致しています。'); return; }
    const lines = totalMismatches.map(x => `${x.player.name}: ${fmtPt(x.actual)} → ${fmtPt(x.expected)}`).join('\n');
    if (!window.confirm(`今季ポイントを、過去大会（今季分）＋今大会の送信済み成績の合計に合わせて修正します。\n\n${lines}\n\n※手動で編集した調整値は上書きされます。実行しますか？`)) return;
    try {
      await api.setPlayerTotalPoints(totalMismatches.map(x => ({ id: x.player.id, totalPoint: x.expected })));
      setDbPlayers(await api.getPlayers());
      alert('今季ポイントを修正しました。');
    } catch (err) {
      console.error(err);
      alert('修正中にエラーが発生しました。コンソールを確認してください。');
    }
  };

  // 通算成績ランキングに表示する選手（通算0半荘の選手は表示しない）
  const totalRankingPlayers = displayDbPlayers.filter(p => getTotalGames(p.id) > 0);

  // 年間チャンピオン大会の出場権は、各大会優勝を除き今年度に2回以上の参加が必要。
  // ここでの「対象」表示は目安であり、自動的に出場権が得られるわけではない。
  const isChampionshipCandidate = (p: Player) => {
    if (isPro(p.name)) return false;
    let qualifyingTournaments = 0;
    seasonArchives.forEach(a => {
      const standing = a.standings.find(s => s.playerId === p.id);
      if (standing && standing.gameCount >= CHAMPIONSHIP_MIN_HANCHAN_PER_TOURNAMENT) qualifyingTournaments++;
    });
    // 今大会は、大会進行でエントリーされている選手も参加1回として数える（半荘数は未確定のため）
    if (entryPlayerIds.includes(p.id) || getCurrentTournamentGameCount(p.id) >= CHAMPIONSHIP_MIN_HANCHAN_PER_TOURNAMENT) qualifyingTournaments++;
    return qualifyingTournaments >= CHAMPIONSHIP_MIN_TOURNAMENTS;
  };

  // 年間CSの出場権保持者＋対象選手（今季ポイント順）
  const CS_BORDER_COUNT = 8; // 年間CSの出場枠
  const csEligibleIds = totalRankingPlayers
    .filter(p => hasChampionshipRight(p) || isChampionshipCandidate(p))
    .map(p => p.id);
  // ボーダー線: すでに出場権を獲得した選手の人数を x としたとき、出場権を獲得した選手を除いた「対象」の上位 (8 − x) 人の下に引く
  const csGrantedCount = totalRankingPlayers.filter(p => hasChampionshipRight(p)).length;
  const csOpenSlots = Math.max(0, CS_BORDER_COUNT - csGrantedCount);
  const csCandidateIds = totalRankingPlayers.filter(p => !hasChampionshipRight(p) && isChampionshipCandidate(p)).map(p => p.id);
  const csBorderPlayerId: string | null = csOpenSlots > 0 && csCandidateIds.length >= csOpenSlots ? csCandidateIds[csOpenSlots - 1] : null;

  // 今大会成績: 黒子の表示/非表示を選択可能 (デフォルト非表示)
  const currentRankingAll = entryPlayerIds
    .map(id => {
      const player = dbPlayers.find(p => p.id === id);
      let pt = 0; let games = 0; let chonbo = 0; let rankSum = 0;
      seating.forEach(r => r.tables.forEach(t => {
        if (t.isSubmitted) { 
          const matchPlayer = t.players.find(mp => mp.playerId === id);
          if (matchPlayer) {
            pt += matchPlayer.point;
            games += 1;
            chonbo += (matchPlayer.chonbo || 0);
            const sorted = [...t.players].sort((a, b) => b.score - a.score);
            rankSum += sorted.findIndex(mp => mp.playerId === id) + 1;
          }
        }
      }));
      return {
        id,
        name: player?.name || '不明',
        point: Math.round(pt * 10) / 10,
        games,
        chonbo,
        avgRank: games > 0 ? rankSum / games : 0,
      };
    })
    .sort((a, b) => b.point - a.point);

  // 出場試合数を限定された選手は、今大会成績のランキングには表示しない
  // （通算成績には通常通り加算・表示される）
  const displayCurrentRanking = (showKuroko
    ? currentRankingAll
    : currentRankingAll.filter(p => !isKuroko(p.name))
  ).filter(p => !isLimitedPlayer(p.id));

  // ----------------------------------------
  // G-2. 過去大会（アーカイブ）まわりの集計
  // ----------------------------------------
  // 選手名を後から変更しても、過去大会に保存されたスナップショット名ではなく
  // 常に「現在登録されている名前」で表示するためのヘルパー。
  // (選手が削除されていた場合のみ、インポート時点の名前にフォールバックする)
  const dbNameById = new Map<string, string>(dbPlayers.map(p => [p.id, p.name]));
  const nameOf = (playerId: string, fallback: string) => dbNameById.get(playerId) || fallback;

  // 「第N回」から回数を取り出すためのヘルパー（若い回数ほど小さい値になる。今大会は常に最後）
  const tournamentSortKey = (name: string) => {
    const m = name.match(/第(\d+)回/);
    return m ? parseInt(m[1], 10) + (name.includes(SEPARATE_EVENT_KEYWORD) ? 0.5 : 0) : Number.POSITIVE_INFINITY;
  };

  // 指定選手の、過去大会ごとの成績（ポイント・順位・半荘数）。回数の若い順に並べる。
  const getPlayerArchiveHistory = (playerId: string) => {
    return seasonArchives
      .map(a => {
        const standing = a.standings.find(s => s.playerId === playerId);
        if (!standing) return null;
        return {
          archiveId: a.id,
          name: a.name,
          point: standing.totalPoint,
          gameCount: standing.gameCount,
          rank: standing.rank,
          playerCount: a.standings.length,
          sortKey: tournamentSortKey(a.name),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.sortKey - b.sortKey);
  };

  // 指定選手が過去大会で受けたペナルティの一覧（記録用。ポイント計算には使わない）
  const getPlayerPenalties = (playerId: string) => {
    const list: { archiveId: string; archiveName: string; point: number; reason: string }[] = [];
    seasonArchives.forEach(a => {
      a.penalties.forEach(p => {
        if (p.playerId === playerId) list.push({ archiveId: a.id, archiveName: a.name, point: p.point, reason: p.reason });
      });
    });
    return list;
  };

  // 過去大会(アーカイブ) ＋ 今大会(送信済みの卓) を統合した「全半荘ログ」
  // 着順分布・対戦相性(相性度)の計算に使う。選手名は常に現在の登録名を使う。
  type NormalizedResult = { playerId: string; name: string; rank: number; point: number };
  type NormalizedHanchan = { source: string; results: NormalizedResult[] };
  const getAllHanchans = (): NormalizedHanchan[] => {
    const list: NormalizedHanchan[] = [];
    seasonArchives.forEach(a => {
      a.hanchans.forEach(h => {
        list.push({
          source: a.name,
          results: h.results
            .filter(r => !r.excluded && !isKuroko(nameOf(r.playerId, r.name)))
            .map(r => ({ playerId: r.playerId, name: nameOf(r.playerId, r.name), rank: r.rank, point: r.point })),
        });
      });
    });
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      const sorted = [...t.players].sort((a, b) => b.score - a.score);
      list.push({
        source: `${r.round}回戦`,
        results: t.players
          .filter(p => !isKuroko(p.name))
          .map(p => ({
            playerId: p.playerId,
            name: p.name,
            rank: sorted.findIndex(sp => sp.playerId === p.playerId) + 1,
            point: p.point,
          })),
      });
    }));
    return list;
  };

  // 着順分布（1着〜4着の回数）
  const getRankDistribution = (playerId: string) => {
    const dist = [0, 0, 0, 0];
    let total = 0;
    getAllHanchans().forEach(h => {
      const me = h.results.find(r => r.playerId === playerId);
      if (me && me.rank >= 1 && me.rank <= 4) { dist[me.rank - 1]++; total++; }
    });
    return { dist, total };
  };

  // 対戦相性（相手ごとの合計ポイント差・平均ポイント差・対戦数）
  const getHeadToHead = (playerId: string) => {
    const map: Record<string, { name: string; games: number; diffSum: number }> = {};
    getAllHanchans().forEach(h => {
      const me = h.results.find(r => r.playerId === playerId);
      if (!me) return;
      h.results.forEach(o => {
        if (o.playerId === playerId) return;
        if (!map[o.playerId]) map[o.playerId] = { name: o.name, games: 0, diffSum: 0 };
        map[o.playerId].games += 1;
        map[o.playerId].diffSum += me.point - o.point;
      });
    });
    return Object.entries(map)
      .map(([id, v]) => ({ id, name: v.name, games: v.games, diffSum: Math.round(v.diffSum * 10) / 10, avgDiff: Math.round((v.diffSum / v.games) * 10) / 10 }))
      .sort((a, b) => b.diffSum - a.diffSum);
  };

  // ----------------------------------------
  // 生涯成績（全シーズン通し）
  //  ・着順分布・平均着順・半荘数は、全ての大会（ルールを問わず）＋今大会の記録から集計する
  //  ・生涯ポイント = 今季ポイント（選手データの通算ポイント）＋ 前季の大会のポイント
  //      最高位戦ルールの大会はそのままの最終成績ポイント、
  //      それ以外のルールの大会は「最高位戦ルールに換算した参考値」を合算する（年間チャンピオン戦などの別大会は含めない）
  //  ・前季のみ参加の選手（選手登録されていない選手）は、名前で集計し、個人ページは作らない
  // ----------------------------------------
  const dbIdByName = new Map<string, string>();
  dbPlayers.forEach(p => { if (!dbIdByName.has(p.name)) dbIdByName.set(p.name, p.id); });
  const lifetimeKeyOf = (playerId: string, name: string) => (dbNameById.has(playerId) ? playerId : (dbIdByName.get(name) ?? playerId));
  // 今季の各大会（年間チャンピオン大会などの別枠は除く）で、3位までに入った大会。
  // 過去大会の選手IDが現在の選手IDと違っていても数え落とさないよう、生涯成績と同じく「ID → なければ名前」で選手に紐づける。
  // 同じ大会で同じ選手を二重に数えない。
  const seasonPodiums = new Map<string, PodiumCount>();
  seasonArchives.filter(a => !isSeparateEventArchive(a)).forEach(a => {
    const counted = new Set<string>();
    a.standings.forEach(st => {
      if (st.rank < 1 || st.rank > 3) return;
      if (isKuroko(nameOf(st.playerId, st.name))) return;
      const key = lifetimeKeyOf(st.playerId, st.name);
      if (counted.has(key)) return;
      counted.add(key);
      const cur = seasonPodiums.get(key) || { first: [], second: [], third: [] };
      const no = archiveTournamentNo(a.name);
      const label = no !== null ? String(no) : a.name;
      if (st.rank === 1) cur.first.push(label); else if (st.rank === 2) cur.second.push(label); else cur.third.push(label);
      seasonPodiums.set(key, cur);
    });
  });
  // 大会を最高位戦ルールに換算したときの、選手ごとの合計ポイント（ペナルティ込み）。参考値
  const convertedArchivePoints = (a: TournamentArchive): Map<string, number> => {
    const start = RULE_START_SCORE[effectiveArchiveRuleName(a)] ?? DEFAULT_START_SCORE;
    const m = new Map<string, number>();
    a.hanchans.forEach(h => {
      const pts = calcConvertedPoints(h.results.map(r => r.score), start);
      h.results.forEach((r, i) => {
        if (r.excluded || isKuroko(nameOf(r.playerId, r.name))) return;
        const k = lifetimeKeyOf(r.playerId, r.name);
        m.set(k, (m.get(k) || 0) + pts[i]);
      });
    });
    a.penalties.forEach(pn => {
      const k = lifetimeKeyOf(pn.playerId, pn.name);
      m.set(k, (m.get(k) || 0) + pn.point);
    });
    return m;
  };
  const buildLifetimeRows = (scope: LifetimeScope): LifetimeSummary[] => {
    const map = new Map<string, LifetimeSummary>();
    const touch = (playerId: string, rawName: string): LifetimeSummary => {
      const key = lifetimeKeyOf(playerId, rawName);
      let row = map.get(key);
      if (!row) {
        const db = dbPlayers.find(p => p.id === key);
        row = { key, name: db?.name || rawName, registered: !!db, games: 0, dist: [0, 0, 0, 0], rankSum: 0, point: 0, convertedPart: 0, tournaments: 0, rank: 0, rankTotal: 0 };
        map.set(key, row);
      }
      return row;
    };
    archives.filter(a => scope === 'all' || effectiveArchiveRuleName(a) === RULE_NAME).forEach(a => {
      const seen = new Set<string>();
      a.hanchans.forEach(h => h.results.forEach(r => {
        if (r.excluded || isKuroko(nameOf(r.playerId, r.name))) return;
        const row = touch(r.playerId, r.name);
        if (r.rank >= 1 && r.rank <= 4) {
          row.games += 1;
          row.dist[r.rank - 1] += 1;
          row.rankSum += r.rank;
        }
        seen.add(row.key);
      }));
      seen.forEach(k => { map.get(k)!.tournaments += 1; });
      // 前季の大会を生涯ポイントに反映する（今季分は選手データの通算ポイントに入っている）
      if (isPreviousSeasonArchive(a) && (SEPARATE_EVENT_COUNTS_FOR_LIFETIME_POINT || !isSeparateEventArchive(a))) {
        if (effectiveArchiveRuleName(a) === RULE_NAME) {
          // 最高位戦ルールの大会: 最終成績のポイントをそのまま
          a.standings.forEach(st => {
            if (isKuroko(nameOf(st.playerId, st.name))) return;
            touch(st.playerId, st.name).point += st.totalPoint;
          });
        } else if (scope === 'all') {
          // それ以外のルールの大会: 最高位戦ルールに換算した参考値（「最高位戦ルールのみ」の表示では含めない）
          convertedArchivePoints(a).forEach((v, k) => {
            const row = map.get(k);
            if (!row) return;
            row.point += v;
            row.convertedPart += v;
          });
        }
      }
    });
    // 今大会（送信済みの卓）
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      const sorted = [...t.players].sort((a, b) => b.score - a.score);
      t.players.forEach(pl => {
        if (isKuroko(pl.name)) return;
        const row = touch(pl.playerId, pl.name);
        const rank = sorted.findIndex(sp => sp.playerId === pl.playerId) + 1;
        if (rank >= 1 && rank <= 4) { row.games += 1; row.dist[rank - 1] += 1; row.rankSum += rank; }
      });
    }));
    // 今季ポイント（選手データの通算ポイント）
    dbPlayers.forEach(p => {
      if (isKuroko(p.name)) return;
      const row = map.get(p.id);
      if (row) row.point += p.totalPoint;
    });
    const rows = Array.from(map.values())
      .filter(r => r.games > 0)
      .map(r => ({ ...r, point: Math.round(r.point * 10) / 10, convertedPart: Math.round(r.convertedPart * 10) / 10 }))
      .sort((a, b) => b.point - a.point || b.games - a.games);
    // 生涯順位（同ポイントは同順位）
    rows.forEach((r, i) => {
      r.rank = i > 0 && rows[i - 1].point === r.point ? rows[i - 1].rank : i + 1;
      r.rankTotal = rows.length;
    });
    return rows;
  };
  // 生涯成績の集計は、生涯成績タブか個人成績を開いているときだけ行う（入力のたびに走らせない）
  // 見出しをクリックするたびに「昇順 → 降順 → 元の順」と切り替える
  const cycleLifetimeSort = (key: string) =>
    setLifetimeSort(prev => (!prev || prev.key !== key ? { key, dir: 'asc' } : prev.dir === 'asc' ? { key, dir: 'desc' } : null));
  const sortLifetimeRows = (rows: LifetimeSummary[]): LifetimeSummary[] => {
    if (!lifetimeSort) return rows;
    const { key, dir } = lifetimeSort;
    const sign = dir === 'asc' ? 1 : -1;
    const dIdx = key.startsWith('d') ? Number(key.slice(1)) : -1; // 着順の列（d0=1着 … d3=4着）は、回数で並べる
    const valueOf = (r: LifetimeSummary): number => {
      switch (key) {
        case 'rank': return r.rank;
        case 'point': return r.point;
        case 'games': return r.games;
        case 'avg': return r.games > 0 ? r.rankSum / r.games : 0;
        default: return dIdx >= 0 ? r.dist[dIdx] : 0;
      }
    };
    return [...rows].sort((a, b) => {
      const c = key === 'name' ? a.name.localeCompare(b.name, 'ja') : valueOf(a) - valueOf(b);
      return c * sign || a.rank - b.rank;
    });
  };
  const needLifetime = activeTab === 'lifetime' || !!detailModalPlayerId;
  const lifetimeRows = needLifetime ? buildLifetimeRows('all') : [];
  const lifetimeRowsSaikoi = needLifetime ? buildLifetimeRows('saikoi') : [];

  // 「学校の割り当て」の対象: 登録済みの全選手 ＋ 選手登録のない過去大会（前季など）だけの参加者。
  // 登録のない参加者は、集計と同じキー（legacy:名前など）で学校を保存する
  type SchoolRow = { id: string; name: string; legacy: boolean };
  const schoolRows: SchoolRow[] = (() => {
    if (!(isAdmin && activeTab === 'players')) return [];
    const dbIds = new Set(dbPlayers.map(pl => pl.id));
    const rows = new Map<string, SchoolRow>();
    dbPlayers.forEach(pl => { if (!isKuroko(pl.name)) rows.set(pl.id, { id: pl.id, name: pl.name, legacy: false }); });
    archives.forEach(a => a.hanchans.forEach(h => h.results.forEach(r => {
      const nm = nameOf(r.playerId, r.name);
      if (r.excluded || isKuroko(nm)) return;
      const key = lifetimeKeyOf(r.playerId, nm);
      if (dbIds.has(key) || rows.has(key)) return;
      rows.set(key, { id: key, name: nm, legacy: true });
    })));
    return Array.from(rows.values()).sort((x, y) => x.name.localeCompare(y.name, 'ja'));
  })();

  // 学校別成績の元データ: 1卓の1半荘を1件の「対局」として、過去の全大会＋今大会（送信済み）から作る（データタブを開いている管理者のみ）
  const schoolDataOn = isAdmin && activeTab === 'admin';
  const buildTableGames = (withCurrent: boolean): SGame[] => {
    const out: SGame[] = [];
    archives.forEach(a => {
      const season = !isPreviousSeasonArchive(a);
      const tOrder = tournamentSortKey(a.name);
      // 保存順は新しい半荘が先頭なので、反転して古い順にする
      [...a.hanchans].reverse().forEach((h, i) => {
        const players: SGPlayer[] = [];
        h.results.forEach(r => {
          const nm = nameOf(r.playerId, r.name);
          if (r.excluded || isKuroko(nm)) return;
          const key = lifetimeKeyOf(r.playerId, nm);
          players.push({ key, name: dbNameById.get(key) || nm, school: playerSchools[key] || '', rank: r.rank, score: r.score * 100, point: r.point });
        });
        if (players.length === 0) return;
        out.push({ id: `${a.id}#${i}`, tKey: a.id, tName: a.name, tOrder, season, round: h.round ?? null, label: `${a.name} ${h.round ?? i + 1}半荘目${h.table ? ` ${h.table}卓` : ''}`, players });
      });
    });
    if (withCurrent) countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      const sorted = [...t.players].sort((x, y) => y.score - x.score);
      const players: SGPlayer[] = [];
      t.players.forEach(pl => {
        const nm = nameOf(pl.playerId, pl.name);
        if (isKuroko(nm)) return;
        players.push({ key: pl.playerId, name: nm, school: playerSchools[pl.playerId] || '', rank: sorted.findIndex(sp => sp.playerId === pl.playerId) + 1, score: pl.score * 100, point: pl.point });
      });
      if (players.length === 0) return;
      out.push({ id: `cur#${r.round}-${t.tableNumber}`, tKey: 'current', tName: '今大会', tOrder: Number.POSITIVE_INFINITY, season: true, round: r.round, label: `今大会 ${r.round}回戦 ${t.tableNumber}卓`, players });
    }));
    return out;
  };
  const schoolGames: SGame[] = schoolDataOn ? buildTableGames(true) : [];

  // 選手の選択肢（個人対決・同卓数の絞り込み用）: 記録のある全選手（選手登録のない前季のみの選手も含む）
  const playerOptions: PlayerOption[] = schoolDataOn
    ? (() => {
        const m = new Map<string, string>();
        schoolGames.forEach(g => g.players.forEach(p => { if (!m.has(p.key)) m.set(p.key, p.name); }));
        return Array.from(m, ([key, name]) => ({ key, name })).sort((x, y) => x.name.localeCompare(y.name, 'ja'));
      })()
    : [];

  // 大会ごとの最終成績（過去大会の最終順位表）。一大会の最終スコアランキングと、個人対決の大会別比較に使う
  const tourneyStandings: TourneyStanding[] = schoolDataOn
    ? archives.flatMap(a => {
        const season = !isPreviousSeasonArchive(a);
        const separate = isSeparateEventArchive(a);
        const tOrder = tournamentSortKey(a.name);
        const list = a.standings.filter(st => !isKuroko(nameOf(st.playerId, st.name)));
        return list.map(st => {
          const nm = nameOf(st.playerId, st.name);
          const key = lifetimeKeyOf(st.playerId, nm);
          return { key, name: dbNameById.get(key) || nm, tKey: a.id, tName: a.name, tOrder, season, separate, point: st.totalPoint, rank: st.rank, total: list.length, gameCount: st.gameCount };
        });
      })
    : [];
  const getLifetimeSummary = (playerId: string, scope: LifetimeScope = 'all'): LifetimeSummary | null => (scope === 'all' ? lifetimeRows : lifetimeRowsSaikoi).find(r => r.key === playerId) || null;
  // 指定選手の、全シーズン分の大会別成績（ルール名・ポイント・順位）。回数の若い順
  const getLifetimeHistory = (playerId: string, scope: LifetimeScope = 'all'): LifetimeHistoryItem[] => {
    const list: (LifetimeHistoryItem & { sortKey: number })[] = [];
    archives.filter(a => scope === 'all' || effectiveArchiveRuleName(a) === RULE_NAME).forEach(a => {
      const st = a.standings.find(s => lifetimeKeyOf(s.playerId, s.name) === playerId);
      if (!st) return;
      const separate = isSeparateEventArchive(a) && !SEPARATE_EVENT_COUNTS_FOR_LIFETIME_POINT;
      const isSaikoi = effectiveArchiveRuleName(a) === RULE_NAME;
      const kind: 'actual' | 'converted' | 'excluded' = separate ? 'excluded' : (isSaikoi || !isPreviousSeasonArchive(a)) ? 'actual' : 'converted';
      list.push({
        archiveId: a.id,
        name: a.name,
        ruleName: effectiveArchiveRuleName(a),
        point: st.totalPoint,
        gameCount: st.gameCount,
        rank: st.rank,
        playerCount: a.standings.filter(x => !isKuroko(nameOf(x.playerId, x.name))).length,
        kind,
        convertedPoint: kind === 'converted' ? Math.round((convertedArchivePoints(a).get(playerId) || 0) * 10) / 10 : undefined,
        previousSeason: isPreviousSeasonArchive(a),
        sortKey: tournamentSortKey(a.name),
      });
    });
    return list.sort((a, b) => a.sortKey - b.sortKey).map(({ sortKey, ...rest }) => rest);
  };

  // 指定選手の半荘ごとの成績を、大会ごとにまとめ、時系列順（第N回の若い順→進行中の今大会が最後）に並べる。
  // 各半荘には同卓者全員のスコア・ポイントも含める（今大会成績タブと同様のクリック展開に使うため）。
  // 将来、大会が終わるたびに「今大会」がそのままここに1グループとして積み上がっていく想定。
  const getPlayerHanchanGroups = (playerId: string, allSeasons = false, saikoiOnly = false) => {
    type TableRow = { playerId: string; name: string; rank: number; score: number; point: number; isMe?: boolean };
    type Row = { rank: number; score: number; point: number; table: TableRow[] };
    const groups: { key: string; label: string; sortKey: number; rows: Row[] }[] = [];

    (allSeasons ? archives : seasonArchives).filter(a => !saikoiOnly || effectiveArchiveRuleName(a) === RULE_NAME).forEach(a => {
      const rows: Row[] = [];
      // MMCの元データは新しい半荘から並んでいる（例: 51戦目→1戦目）ため、
      // 古い順（時系列順）に表示するために反転してから処理する
      [...a.hanchans].reverse().forEach(h => {
        // 全シーズン版は、選手登録前の前季データ（legacy:名前）も名前でひも付けて同じ選手として扱う
        const isSame = (r: { playerId: string; name: string }) => (allSeasons ? lifetimeKeyOf(r.playerId, r.name) === playerId : r.playerId === playerId);
        const me = h.results.find(isSame);
        if (!me || me.excluded) return;
        const table: TableRow[] = h.results
          .map(r => ({ playerId: r.playerId, name: nameOf(r.playerId, r.name), rank: r.rank, score: r.score, point: r.point, isMe: isSame(r) }))
          .sort((x, y) => x.rank - y.rank);
        rows.push({ rank: me.rank, score: me.score, point: me.point, table });
      });
      if (rows.length > 0) groups.push({ key: a.id, label: a.name, sortKey: tournamentSortKey(a.name), rows });
    });

    // 進行中の今大会（送信済みの卓のみ）
    const currentRows: Row[] = [];
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      const me = t.players.find(p => p.playerId === playerId);
      if (!me || isKuroko(me.name)) return;
      const sorted = [...t.players].sort((a, b) => b.score - a.score);
      const table: TableRow[] = t.players
        .map(p => ({
          playerId: p.playerId,
          name: p.name,
          rank: sorted.findIndex(sp => sp.playerId === p.playerId) + 1,
          score: p.score,
          point: p.point,
          isMe: p.playerId === playerId,
        }))
        .sort((x, y) => x.rank - y.rank);
      const rank = sorted.findIndex(sp => sp.playerId === playerId) + 1;
      currentRows.push({ rank, score: me.score, point: me.point, table });
    }));
    if (currentRows.length > 0) {
      const curNo = parseInt(tournamentNo, 10);
      groups.push({
        key: 'current',
        label: Number.isFinite(curNo) ? `今大会（第${curNo}回）` : '今大会',
        // 第N回の若い順に並べる。同じ回が登録済みでも重ならないよう、わずかに後ろへ
        sortKey: Number.isFinite(curNo) ? curNo + 0.5 : Number.POSITIVE_INFINITY,
        rows: currentRows,
      });
    }

    return groups.sort((a, b) => a.sortKey - b.sortKey);
  };

  // 過去大会＋今大会を通じての最高スコア（ポイントではなく素点）
  const getMaxScore = (playerId: string): { score: number; label: string } | null => {
    let best: { score: number; label: string } | null = null;
    getPlayerHanchanGroups(playerId).forEach(g => {
      g.rows.forEach(r => {
        if (!best || r.score > best.score) best = { score: r.score, label: g.label };
      });
    });
    return best;
  };

  // 過去大会一覧で、特定の大会・特定の選手の半荘ごとの成績（同卓者つき）を取り出す
  const getPlayerRowsInArchive = (archive: TournamentArchive, playerId: string) => {
    const rows: PlayerDetailHanchanRow[] = [];
    [...archive.hanchans].reverse().forEach(h => {
      const me = h.results.find(r => r.playerId === playerId);
      if (!me || me.excluded) return;
      const table: PlayerDetailTableRow[] = h.results
        .map(r => ({ playerId: r.playerId, name: nameOf(r.playerId, r.name), rank: r.rank, score: r.score, point: r.point }))
        .sort((x, y) => x.rank - y.rank);
      rows.push({ rank: me.rank, score: me.score, point: me.point, table });
    });
    return rows;
  };

  // 個人の今大会スケジュール（済・予定・未定・抜け番）
  type ScheduleItem = {
    key: string; roundNo: number;
    status: 'done' | 'ready' | 'pending' | 'sitout';
    tableNo?: number; wind?: string; point?: number; rank?: number; chonbo?: number; table?: Table;
  };
  const getPlayerSchedule = (playerId: string): ScheduleItem[] => {
    const items: ScheduleItem[] = [];
    seating.forEach(r => {
      // 出場限定の範囲外の回戦は、そもそも予定に含めない
      if (!isAvailableInRound(playerId, r.round)) return;
      if (r.isPending || r.tables.length === 0) {
        items.push({ key: `r${r.round}`, roundNo: r.round, status: 'pending' });
        return;
      }
      let found = false;
      r.tables.forEach(t => {
        const me = t.players.find(p => p.playerId === playerId);
        if (!me) return;
        found = true;
        if (t.isSubmitted) {
          const sorted = [...t.players].sort((a, b) => b.score - a.score);
          items.push({
            key: `r${r.round}t${t.tableNumber}`, roundNo: r.round, status: 'done',
            tableNo: t.tableNumber, wind: me.wind, point: me.point,
            rank: sorted.findIndex(p => p.playerId === playerId) + 1,
            chonbo: me.chonbo || 0, table: t,
          });
        } else {
          items.push({
            key: `r${r.round}t${t.tableNumber}`, roundNo: r.round, status: 'ready',
            tableNo: t.tableNumber, wind: me.wind, table: t,
          });
        }
      });
      if (!found) items.push({ key: `r${r.round}`, roundNo: r.round, status: 'sitout' });
    });
    return items;
  };

  // ログイン中の選手向け：これから行われる対局（卓・対戦相手・時間）
  const getUpcomingMatches = (playerId: string): UpcomingMatch[] => {
    if (hideSeating) return [];
    const items = getPlayerSchedule(playerId);
    const firstIdx = items.findIndex(it => it.status === 'ready' || it.status === 'pending');
    if (firstIdx < 0) return [];
    return items.slice(firstIdx)
      .filter((it): it is ScheduleItem & { status: 'ready' | 'pending' | 'sitout' } => it.status !== 'done')
      .map(it => ({
        key: it.key,
        roundNo: it.roundNo,
        time: startTimeOf(it.roundNo),
        status: it.status,
        tableNo: it.tableNo,
        tableLabel: tableTextWithIcon(it.tableNo),
        wind: it.wind,
        isFinal: it.status === 'ready' && it.roundNo === roundsCount && it.tableNo === 1,
        opponents: it.table
          ? it.table.players.filter(pl => pl.playerId !== playerId).map(pl => ({ name: pl.name, wind: pl.wind }))
          : undefined,
      }));
  };

  const getTableRankList = (t: Table) => [...t.players].sort((a, b) => b.score - a.score);
  const getTableDeposit = (t: Table) => 1200 - t.players.reduce((s, p) => s + (p.score || 0), 0);
  const isFinalTable = (r: Round, t: Table) => r.round === roundsCount && t.tableNumber === 1 && !r.isPending;

  // 折りたたみ判定
  const roundIsOpen = (r: Round) => roundOpen[r.round] ?? !isRoundFinished(r);
  const tableIsOpen = (r: Round, t: Table) => tableOpen[`${r.round}-${t.tableNumber}`] ?? !t.isSubmitted;
  const toggleRound = (r: Round) => setRoundOpen(prev => ({ ...prev, [r.round]: !roundIsOpen(r) }));
  const toggleTable = (r: Round, t: Table) => setTableOpen(prev => ({ ...prev, [`${r.round}-${t.tableNumber}`]: !tableIsOpen(r, t) }));
  const setAllTablesOfRound = (r: Round, open: boolean) => {
    setTableOpen(prev => {
      const next = { ...prev };
      r.tables.forEach(t => { next[`${r.round}-${t.tableNumber}`] = open; });
      return next;
    });
  };

  // ----------------------------------------
  // H. PDF出力 / 画像保存
  // ----------------------------------------
  const escapeHtml = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const nameForDoc = (n: string) => escapeHtml(proMarkedName(n));

  const buildReportHtml = () => {
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;

    const rankRows = displayCurrentRanking.map((p, i) => `
      <tr>
        <td class="c">${i + 1}</td>
        <td>${nameForDoc(p.name)}</td>
        <td class="r">${p.games}</td>
        <td class="r">${p.games > 0 ? p.avgRank.toFixed(2) : '-'}</td>
        <td class="r">${p.chonbo > 0 ? p.chonbo : '-'}</td>
        <td class="r ${p.point > 0 ? 'plus' : p.point < 0 ? 'minus' : ''}">${fmtPt(p.point)}</td>
      </tr>`).join('');

    const totalRows = totalRankingPlayers.map((p, i) => {
      const granted = hasChampionshipRight(p);
      const candidate = isChampionshipCandidate(p);
      const pro = isPro(p.name);
      const rowClass = granted ? 'granted' : candidate ? 'candidate' : '';
      const csLabel = pro ? '対象外(プロ)' : granted ? '🏆 出場権' : candidate ? '○ 対象' : '-';
      return `
      <tr class="${rowClass}">
        <td class="c">${i + 1}</td>
        <td>${nameForDoc(p.name)}</td>
        <td class="r">${getTotalGames(p.id)}</td>
        <td class="r ${p.totalPoint > 0 ? 'plus' : p.totalPoint < 0 ? 'minus' : ''}">${fmtPt(p.totalPoint)}</td>
        <td class="c">${csLabel}</td>
      </tr>`;
    }).join('');

    const resultBlocks = (hideSeating ? [] : seating).map(r => {
      const timeNote = startTimeOf(r.round) ? `<span class="time">${timerState.startAts[r.round] ? '開始時間' : '開始目安'} ${startTimeOf(r.round)}</span>` : '';
      if (r.isPending || r.tables.length === 0) {
        return `<div class="round"><h3>${r.round}回戦 ${timeNote}</h3><p class="note">卓組未定（前の回戦が全て終了した時点で順位順に決定）</p></div>`;
      }
      const tables = r.tables.map(t => {
        const ranked = getTableRankList(t);
        const rows = t.players.map(p => {
          const rank = ranked.findIndex(x => x.playerId === p.playerId) + 1;
          return `<tr>
            <td class="c">${p.wind}</td>
            <td>${nameForDoc(p.name)}</td>
            <td class="r">${t.isSubmitted || t.isCalculated ? p.score * 100 : '-'}</td>
            <td class="c">${t.isSubmitted || t.isCalculated ? rank + '位' : '-'}</td>
            <td class="r">${(p.chonbo || 0) > 0 ? `×${p.chonbo}` : '-'}</td>
            <td class="r ${p.point > 0 ? 'plus' : p.point < 0 ? 'minus' : ''}">${t.isSubmitted || t.isCalculated ? fmtPt(p.point) : '-'}</td>
          </tr>`;
        }).join('');
        const deposit = getTableDeposit(t);
        return `
          <div class="tbl ${isFinalTable(r, t) ? 'final' : ''}">
            <div class="tblhead">${tableTextWithIcon(t.tableNumber)}${isFinalTable(r, t) ? ' 👑 決勝卓' : ''} <span class="badge">${t.isSubmitted ? '確定' : '未確定'}</span></div>
            <table>
              <thead><tr><th>席</th><th>選手</th><th class="r">素点</th><th>着順</th><th class="r">チョンボ</th><th class="r">ポイント</th></tr></thead>
              <tbody>${rows}</tbody>
            </table>
            <div class="note">${escapeHtml(RULE_NAME)} / 供託・不足分: ${deposit * 100}点</div>
          </div>`;
      }).join('');
      const sitOutNames = (r.sitOutIds || []).map(id => dbPlayers.find(p => p.id === id)?.name).filter(Boolean).map(n => nameForDoc(n as string)).join('、');
      return `<div class="round">
        <h3>${r.round}回戦${r.mode === 'rankTopFirst' ? '（順位戦・卓内上位から東南西北）' : r.mode === 'rankBottomFirst' ? '（最終戦・卓内下位から東南西北）' : ''} ${timeNote}</h3>
        ${sitOutNames ? `<p class="note">抜け番: ${sitOutNames}</p>` : ''}
        <div class="tables">${tables}</div>
      </div>`;
    }).join('');

    const timeTable = scheduleTimes.slice(0, Math.max(roundsCount, 0))
      .map((t, i) => `${i + 1}回戦 ${startTimeOf(i + 1) || t}`).join(' / ');

    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8" />
<title>今大会成績レポート</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; color:#0f172a; margin:0; padding:24px; }
  h1 { font-size: 22px; margin:0 0 4px; }
  h2 { font-size: 17px; margin:28px 0 10px; border-left:6px solid #0d9488; padding-left:10px; }
  h3 { font-size: 15px; margin:16px 0 8px; background:#0f172a; color:#fff; padding:6px 10px; border-radius:4px; }
  .time { font-size:11px; font-weight:normal; color:#cbd5e1; margin-left:8px; }
  .sub { color:#64748b; font-size:12px; margin-bottom:14px; line-height:1.6; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { border:1px solid #cbd5e1; padding:5px 8px; }
  th { background:#f1f5f9; font-size:11px; }
  .r { text-align:right; } .c { text-align:center; }
  .plus { color:#1d4ed8; font-weight:bold; } .minus { color:#dc2626; font-weight:bold; }
  .granted { background:#fffbeb; }
  .candidate { background:#ecfdf5; }
  .tables { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
  .tbl { border:1px solid #cbd5e1; border-radius:6px; padding:8px; page-break-inside: avoid; }
  .tbl.final { border:2px solid #f59e0b; background:#fffbeb; }
  .tblhead { font-weight:bold; font-size:13px; margin-bottom:6px; }
  .badge { font-size:10px; background:#e2e8f0; padding:2px 6px; border-radius:99px; margin-left:6px; font-weight:normal; }
  .note { font-size:10px; color:#64748b; margin-top:6px; }
  .round { page-break-inside: avoid; margin-bottom:14px; }
  .credit { margin-top:18px; padding-top:10px; border-top:1px solid #e2e8f0; font-size:10px; color:#64748b; line-height:1.7; }
  @media print { body { padding:10mm; } @page { size: A4; margin: 10mm; } }
</style></head>
<body>
  <h1>${escapeHtml(APP_TITLE)} ／ 今大会成績レポート</h1>
  <div class="sub">
    出力日時: ${dateStr} ／ ${escapeHtml(RULE_NAME)} ／ 参加 ${entryPlayerIds.length}名 ／ 全${roundsCount}回戦 ／ チョンボ 1回 -${CHONBO_PENALTY.toFixed(1)}pt<br>
    開始時間（1回戦は目安）: ${timeTable}
  </div>

  <h2>今大会ランキング${showKuroko ? '（黒子を含む）' : ''}</h2>
  <table>
    <thead><tr><th>順位</th><th>選手名</th><th class="r">半荘数</th><th class="r">平均着順</th><th class="r">チョンボ</th><th class="r">今大会pt</th></tr></thead>
    <tbody>${rankRows || '<tr><td colspan="6" class="c">データなし</td></tr>'}</tbody>
  </table>

  <h2>全試合結果</h2>
  ${resultBlocks || '<p class="note">試合結果はありません。</p>'}

  <h2>今季成績ランキング</h2>
  <table>
    <thead><tr><th>順位</th><th>選手名</th><th class="r">今季半荘数</th><th class="r">今季pt</th><th>年間CS出場権</th></tr></thead>
    <tbody>${totalRows || '<tr><td colspan="5" class="c">データなし</td></tr>'}</tbody>
  </table>
  <p class="note">※ 年間チャンピオン大会の出場権は各大会優勝を除き今年度に2回以上の参加が必要です。麻雀プロ（名前後ろの⒫）は半荘数に関わらず出場権の対象外です。</p>
  <p class="note">※ 大会規定: ${escapeHtml(RULES_DOC_URL)}</p>

  <div class="credit">
    本システムは、${escapeHtml(CREDIT_AUTHOR)}が制作・公開されている麻雀大会運営ツール ${escapeHtml(CREDIT_TOOL_NAME)}（${escapeHtml(CREDIT_TOOL_URL)}）を参考にさせていただき、作成しました。素晴らしいツールを公開してくださっていることに心より感謝申し上げます。
  </div>
</body></html>`;
  };

  const handlePrintLoginCodes = () => {
    const rows = [...printTargets].sort((a, b) => a.name.localeCompare(b.name, 'ja'));
    if (rows.length === 0) { alert('印刷する選手が選択されていません。'); return; }
    const cards = rows.map(p => `
      <div class="card">
        <div class="name">${escapeHtml(proMarkedName(p.name))}</div>
        <div class="label">ログインコード</div>
        <div class="code">${p.loginCode || '（未発行）'}</div>
      </div>`).join('');
    const html = `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8" />
<title>選手ログインコード一覧</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; margin:0; padding:16px; color:#0f172a; }
  h1 { font-size:16px; margin:0 0 12px; }
  .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:6px; }
  .card { border:1px solid #cbd5e1; border-radius:6px; padding:7px 4px; text-align:center; page-break-inside: avoid; }
  .name { font-weight:bold; font-size:11px; margin-bottom:3px; word-break:break-all; }
  .label { font-size:8px; color:#64748b; }
  .code { font-family: monospace; font-size:16px; font-weight:bold; letter-spacing:0.1em; margin-top:1px; }
  @media print { @page { size: A4; margin: 10mm; } }
</style></head>
<body>
  <h1>${escapeHtml(APP_TITLE)} ／ 選手ログインコード一覧（切り離して配布してください）</h1>
  <div class="grid">${cards}</div>
</body></html>`;
    const w = window.open('', '_blank');
    if (!w) { alert('ポップアップがブロックされました。ブラウザの設定を確認してください。'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 600);
  };

  // 過去大会1つ分の成績レポート（最終成績・半荘ごとの成績・ペナルティ）
  const buildArchiveReportHtml = (a: TournamentArchive) => {
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    const cls = (n: number) => (n > 0 ? 'plus' : n < 0 ? 'minus' : '');
    const nm = (id: string, fallback: string) => nameForDoc(nameOf(id, fallback));
    const standings = [...a.standings].sort((x, y) => x.rank - y.rank);
    const standingRows = standings.map(s => `
      <tr class="${s.rank <= 3 ? 'top' + s.rank : ''}">
        <td class="c">${s.rank <= 3 ? ['🥇', '🥈', '🥉'][s.rank - 1] + ' ' : ''}${s.rank}</td>
        <td>${nm(s.playerId, s.name)}</td>
        <td class="r">${s.gameCount}</td>
        <td class="r ${cls(s.totalPoint)}">${fmtPt(s.totalPoint)}</td>
      </tr>`).join('');

    // 卓ごとに「1半荘目-1卓」の見出しを付け、同じ回戦の卓は横に並べる（古い半荘が先）
    const hanchanBlocks = groupArchiveHanchans(a.hanchans).map(g => {
      const cards = g.items.map(h => {
        const rows = [...h.results].sort((x, y) => x.rank - y.rank).map(r => `
          <tr class="${r.excluded ? 'ex' : ''}">
            <td class="c">${r.rank}位</td>
            <td>${nm(r.playerId, r.name)}${r.excluded ? '<span class="tag">順位外</span>' : ''}</td>
            <td class="r">${(r.score * 100).toLocaleString()}</td>
            <td class="r ${cls(r.point)}">${fmtPt(r.point)}</td>
          </tr>`).join('');
        const label = typeof h.table === 'number' ? `${g.no}半荘目-${h.table}卓` : `${g.no}半荘目`;
        return `<div class="tbl"><div class="tblhead">${label}${h.deposit > 0 ? `<span class="badge">供託 ${h.deposit.toFixed(1)}</span>` : ''}</div><table><thead><tr><th>着順</th><th>選手</th><th class="r">素点</th><th class="r">ポイント</th></tr></thead><tbody>${rows}</tbody></table></div>`;
      }).join('');
      return `<div class="round"><div class="tables">${cards}</div></div>`;
    }).join('');

    const penaltyRows = a.penalties.map(p => `
      <tr><td>${nm(p.playerId, p.name)}</td><td>${escapeHtml(p.reason || '')}</td><td class="r ${cls(p.point)}">${fmtPt(p.point)}</td></tr>`).join('');

    return `<!DOCTYPE html>
<html lang="ja"><head><meta charset="utf-8" />
<title>${escapeHtml(a.name)} 成績</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif; color:#0f172a; margin:0; padding:24px; }
  h1 { font-size: 22px; margin:0 0 4px; }
  h2 { font-size: 17px; margin:26px 0 10px; border-left:6px solid #0d9488; padding-left:10px; }
  .sub { color:#64748b; font-size:12px; margin-bottom:14px; line-height:1.6; }
  table { width:100%; border-collapse:collapse; font-size:12px; }
  th, td { border:1px solid #cbd5e1; padding:5px 8px; }
  th { background:#f1f5f9; font-size:11px; }
  .r { text-align:right; } .c { text-align:center; }
  .plus { color:#1d4ed8; font-weight:bold; } .minus { color:#dc2626; font-weight:bold; }
  .top1 { background:#fffbeb; font-weight:bold; } .top2 { background:#f8fafc; } .top3 { background:#fff7ed; }
  .ex { color:#94a3b8; }
  .tag { font-size:9px; background:#e2e8f0; color:#64748b; padding:1px 5px; border-radius:99px; margin-left:6px; }
  .round { page-break-inside: avoid; margin-bottom:10px; }
  .tables { display:grid; grid-template-columns:repeat(3, minmax(0, 1fr)); gap:6px; }
  .tbl { border:1px solid #cbd5e1; border-radius:6px; padding:0 0 6px; overflow:hidden; page-break-inside: avoid; min-width:0; }
  .tblhead { background:#0f172a; color:#fff; font-weight:bold; font-size:11px; padding:4px 6px; margin-bottom:6px; }
  .tbl table { width:calc(100% - 8px); margin:0 4px; font-size:10px; }
  .tbl th, .tbl td { padding:3px 2px; white-space:nowrap; }
  .tbl th { font-size:9px; }
  .tbl th:first-child, .tbl td:first-child { width:1%; }
  .tbl th:nth-child(3), .tbl td:nth-child(3), .tbl th:nth-child(4), .tbl td:nth-child(4) { width:1%; }
  .tbl th:nth-child(2), .tbl td:nth-child(2) { min-width:6em; white-space:normal; overflow-wrap:anywhere; }
  .tbl tr.ex td:nth-child(2) { white-space:nowrap; }
  .tbl .tag { display:inline-block; margin:0 0 0 2px; padding:0 3px; font-size:7px; line-height:1.2; vertical-align:middle; white-space:nowrap; }
  .tblhead .badge { background:#334155; color:#e2e8f0; font-size:9px; padding:1px 4px; margin-left:4px; }
  .badge { font-size:10px; background:#e2e8f0; padding:2px 6px; border-radius:99px; margin-left:6px; font-weight:normal; }
  .note { font-size:10px; color:#64748b; margin-top:6px; line-height:1.6; }
  @media print { body { padding:10mm; } @page { size: A4; margin: 10mm; } }
</style></head>
<body>
  <h1>${escapeHtml(APP_TITLE)} ／ ${escapeHtml(a.name)} 成績</h1>
  <div class="sub">
    ${escapeHtml(effectiveArchiveRuleName(a))} ／ 参加 ${a.standings.length}名 ／ 全${a.hanchans.length}半荘 ／ 出力日: ${dateStr}
    ${a.notes ? `<br>📝 ${escapeHtml(a.notes)}` : ''}
  </div>

  <h2>最終成績</h2>
  <table>
    <thead><tr><th>順位</th><th>選手名</th><th class="r">半荘数</th><th class="r">ポイント</th></tr></thead>
    <tbody>${standingRows || '<tr><td colspan="4" class="c">データなし</td></tr>'}</tbody>
  </table>
  ${penaltyRows ? `<h2>ペナルティ</h2>
  <table><thead><tr><th>選手名</th><th>内容</th><th class="r">ポイント</th></tr></thead><tbody>${penaltyRows}</tbody></table>
  <p class="note">※ ペナルティは最終成績に反映済みです。</p>` : ''}

  <h2>半荘ごとの成績</h2>
  ${hanchanBlocks || '<p class="note">半荘ごとの記録はありません。</p>'}

</body></html>`;
  };

  // ---- 過去大会に、後からペナルティを付ける・外す ----
  // 最終成績を並べ直して順位を付ける（同点は同順位）
  const rerankStandings = (list: ArchiveStanding[]): ArchiveStanding[] => {
    const sorted = [...list].sort((x, y) => y.totalPoint - x.totalPoint || x.rank - y.rank);
    let prevRank = 0;
    return sorted.map((st, i) => {
      const rank = i > 0 && Math.round(sorted[i - 1].totalPoint * 10) === Math.round(st.totalPoint * 10) ? prevRank : i + 1;
      prevRank = rank;
      return { ...st, rank };
    });
  };

  // delta: 付ける（マイナス）／外す（プラス）ポイント。最終成績・順位を更新し、今季の大会なら通算ポイントにも反映する。
  const applyArchivePenaltyChange = async (a: TournamentArchive, playerId: string, delta: number, nextPenalties: ArchivePenalty[]) => {
    const standings = rerankStandings(a.standings.map(st => st.playerId === playerId ? { ...st, totalPoint: Math.round((st.totalPoint + delta) * 10) / 10 } : st));
    await api.updateArchive(a.id, { standings, penalties: nextPenalties });
    // 前季の大会は今季のポイントに加算していないため、反映もしない
    if (!isPreviousSeasonArchive(a)) {
      try {
        await api.updatePlayersScores([{ id: playerId, pointDelta: delta }]);
      } catch (err) {
        // 通算に反映できなかったら、過去大会の変更も元に戻して、ずれを作らない
        try { await api.updateArchive(a.id, { standings: a.standings, penalties: a.penalties }); } catch (e2) { console.error(e2); }
        throw err;
      }
    }
    setArchives(await api.getArchives());
    setDbPlayers(await api.getPlayers());
  };

  const handleAddArchivePenalty = async (a: TournamentArchive) => {
    if (!isAdmin) return;
    const d = penaltyDrafts[a.id];
    const st = d ? a.standings.find(x => x.playerId === d.playerId) : undefined;
    const amount = d ? Math.round(parseFloat(d.point) * 10) / 10 : NaN;
    if (!d || !st) { alert('ペナルティを付ける選手を選んでください。'); return; }
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000) { alert('減点ポイントは、0より大きい数で入力してください（例: 20）。'); return; }
    const delta = -amount;
    const reason = d.reason.trim() || 'ペナルティ';
    const name = nameOf(st.playerId, st.name);
    const after = Math.round((st.totalPoint + delta) * 10) / 10;
    const note = isPreviousSeasonArchive(a) ? '前季の大会なので、今季ポイントには反映しません。' : '今季の通算ポイントにも反映されます。';
    if (!window.confirm(`${a.name}：${name} に ${fmtPt(delta)}pt のペナルティ（${reason}）を付けます。\n\n最終成績 ${fmtPt(st.totalPoint)} → ${fmtPt(after)}（順位も並べ直します）\n${note}\n\nよろしいですか？`)) return;
    try {
      await applyArchivePenaltyChange(a, st.playerId, delta, [...a.penalties, { playerId: st.playerId, name: st.name, point: delta, reason, applied: true }]);
      setPenaltyDrafts(prev => { const n = { ...prev }; delete n[a.id]; return n; });
    } catch (err) {
      console.error(err);
      alert('ペナルティを付けられませんでした。管理者としてログインしているか、コンソールを確認してください。（成績は変更されていません）');
    }
  };

  // 「後から追加」したペナルティだけ外せる（取り込み時に成績へ織り込み済みのものは、元の成績が分からないため外せない）
  const handleRemoveArchivePenalty = async (a: TournamentArchive, idx: number) => {
    if (!isAdmin) return;
    const p = a.penalties[idx];
    if (!p || !p.applied) return;
    if (!window.confirm(`${a.name}：${nameOf(p.playerId, p.name)} のペナルティ（${p.reason} ${fmtPt(p.point)}pt）を外し、ポイントを元に戻します。よろしいですか？`)) return;
    try {
      await applyArchivePenaltyChange(a, p.playerId, -p.point, a.penalties.filter((_, i) => i !== idx));
    } catch (err) {
      console.error(err);
      alert('外せませんでした。コンソールを確認してください。（成績は変更されていません）');
    }
  };

  // 「今大会をアーカイブ」で、半荘を古い順のまま保存してしまった大会を直す。
  //   ・保存順を、取り込み済みの大会と同じ「新しい半荘が先」にそろえる
  //   ・同じ回戦（同じ選手が重ならない連続した卓）を「N半荘目」としてまとめ、卓番号を付ける
  // 古い順のまま保存された半荘を、「新しい半荘が先」の保存順にそろえ、同じ回戦の卓（同じ選手が重ならない連続した卓）をまとめて、回戦・卓番号を付ける
  const buildRepairedHanchans = (a: TournamentArchive): ArchiveHanchan[] => {
    const asc = [...a.hanchans]; // いまの保存順 = 古い順（誤り）
    const rounds: { ids: Set<string>; items: ArchiveHanchan[] }[] = [];
    asc.forEach(h => {
      const ids = h.results.map(r => r.playerId);
      const cur = rounds[rounds.length - 1];
      if (cur && ids.every(id => !cur.ids.has(id))) { cur.items.push(h); ids.forEach(id => cur.ids.add(id)); }
      else rounds.push({ ids: new Set(ids), items: [h] });
    });
    const fixedAsc: ArchiveHanchan[] = [];
    rounds.forEach((r, ri) => r.items.forEach((h, ti) => fixedAsc.push({ ...h, round: ri + 1, table: ti + 1 })));
    return [...fixedAsc].reverse().map((h, i) => ({ ...h, no: i + 1 }));
  };
  // 卓の情報が無い（＝まだ直していない／取り込み済みの）大会か
  const lacksTableInfo = (a: TournamentArchive) => a.hanchans.length > 0 && a.hanchans.every(h => h.round === undefined);

  const handleRepairArchiveOrder = async (a: TournamentArchive) => {
    if (!isAdmin) return;
    if (!window.confirm(`「${a.name}」の半荘の並びと卓を直します。\n\n・「今大会をアーカイブ」で保存した大会（半荘が逆順に見える大会）にだけ実行してください。\n・取り込み済みの大会に実行すると、逆になってしまいます。\n\n実行しますか？`)) return;
    const stored = buildRepairedHanchans(a);
    try {
      await api.updateArchiveHanchans(a.id, stored);
      setArchives(await api.getArchives());
      alert(`直しました（${new Set(stored.map(h => h.round)).size}半荘目、全${stored.length}卓）。`);
    } catch (err) {
      console.error(err);
      alert('直せませんでした。管理者としてログインしているか、コンソールを確認してください。');
    }
  };

  const handleExportArchivePdf = async (a: TournamentArchive) => {
    // ポップアップがブロックされないよう、クリックの直後に先にウィンドウを開く
    const w = window.open('', '_blank');
    if (!w) { alert('ポップアップがブロックされました。ブラウザの設定を確認してください。'); return; }
    w.document.open();
    w.document.write('<p style="font-family:sans-serif;padding:24px">PDFを作成しています...</p>');
    w.document.close();

    let target = a;
    // 卓の情報が無い大会は、PDFに「1半荘目-1卓」と書けない。管理者なら、その場で直してから出力できる。
    if (isAdmin && lacksTableInfo(a) && window.confirm(
      `「${a.name}」には、卓の情報がありません。\n\n【OK】半荘の並びと卓を直してから、PDFを作ります\n　（「今大会をアーカイブ」で保存した大会だけ。取り込み済みの大会では、キャンセルしてください）\n【キャンセル】そのままPDFを作ります`
    )) {
      try {
        const stored = buildRepairedHanchans(a);
        await api.updateArchiveHanchans(a.id, stored);
        target = { ...a, hanchans: stored };
        setArchives(await api.getArchives());
      } catch (err) {
        console.error(err);
        alert('直せませんでした。このままPDFを作ります。');
      }
    }
    w.document.open();
    w.document.write(buildArchiveReportHtml(target));
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 600);
  };

  const handleExportPdf = () => {
    const html = buildReportHtml();
    const w = window.open('', '_blank');
    if (!w) { alert('ポップアップがブロックされました。ブラウザの設定を確認してください。'); return; }
    w.document.open();
    w.document.write(html);
    w.document.close();
    setTimeout(() => { w.focus(); w.print(); }, 600);
  };

  const handleExportRankingImage = () => {
    const rows = displayCurrentRanking;
    if (rows.length === 0) { alert('表示できるランキングがありません。'); return; }

    const scale = 2;
    const width = 900;
    const headerH = 150;
    const rowH = 60;
    const footerH = 64;
    const height = headerH + rows.length * rowH + footerH;

    const canvas = document.createElement('canvas');
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(scale, scale);

    const jp = '"Hiragino Kaku Gothic ProN", "Yu Gothic", "Noto Sans JP", sans-serif';

    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);

    ctx.fillStyle = '#0f172a';
    ctx.fillRect(0, 0, width, 100);
    ctx.fillStyle = '#ffffff';
    ctx.font = `bold 28px ${jp}`;
    ctx.fillText(APP_TITLE, 32, 48);
    const now = new Date();
    const dateStr = `${now.getFullYear()}/${String(now.getMonth() + 1).padStart(2, '0')}/${String(now.getDate()).padStart(2, '0')}`;
    ctx.fillStyle = '#94a3b8';
    ctx.font = `15px ${jp}`;
    ctx.fillText(`今大会成績ランキング  ／  ${dateStr}  ／  ${RULE_NAME}`, 32, 78);

    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(0, 100, width, 40);
    ctx.fillStyle = '#475569';
    ctx.font = `bold 15px ${jp}`;
    ctx.fillText('順位', 36, 126);
    ctx.fillText('選手名', 110, 126);
    ctx.textAlign = 'right';
    ctx.fillText('半荘数', 640, 126);
    ctx.fillText('今大会ポイント', 864, 126);
    ctx.textAlign = 'left';

    rows.forEach((p, i) => {
      const y = headerH + i * rowH;
      if (i % 2 === 1) {
        ctx.fillStyle = '#f8fafc';
        ctx.fillRect(0, y, width, rowH);
      }
      ctx.strokeStyle = '#e2e8f0';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, y + rowH);
      ctx.lineTo(width, y + rowH);
      ctx.stroke();

      const medal = i === 0 ? '#eab308' : i === 1 ? '#94a3b8' : i === 2 ? '#b45309' : '#cbd5e1';
      ctx.fillStyle = medal;
      ctx.beginPath();
      ctx.arc(52, y + rowH / 2, 17, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = i < 3 ? '#ffffff' : '#475569';
      ctx.font = `bold 16px ${jp}`;
      ctx.textAlign = 'center';
      ctx.fillText(String(i + 1), 52, y + rowH / 2 + 6);
      ctx.textAlign = 'left';

      const shown = baseName(p.name);
      ctx.fillStyle = '#0f172a';
      ctx.font = `bold 22px ${jp}`;
      ctx.fillText(shown, 110, y + rowH / 2 + 8);

      if (isPro(p.name)) {
        const w = ctx.measureText(shown).width;
        const cx = 110 + w + 16;
        const cy = y + rowH / 2;
        ctx.fillStyle = '#d97706';
        ctx.beginPath();
        ctx.arc(cx, cy, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#ffffff';
        ctx.font = `bold 13px ${jp}`;
        ctx.textAlign = 'center';
        ctx.fillText('P', cx, cy + 5);
        ctx.textAlign = 'left';
      }

      ctx.textAlign = 'right';
      ctx.fillStyle = '#64748b';
      ctx.font = `16px ${jp}`;
      ctx.fillText(`${p.games} 半荘${p.chonbo > 0 ? ` / 🚫${p.chonbo}` : ''}`, 640, y + rowH / 2 + 6);

      ctx.fillStyle = p.point > 0 ? '#1d4ed8' : p.point < 0 ? '#dc2626' : '#94a3b8';
      ctx.font = `bold 24px ${jp}`;
      ctx.fillText(fmtPt(p.point), 864, y + rowH / 2 + 8);
      ctx.textAlign = 'left';
    });

    ctx.fillStyle = '#94a3b8';
    ctx.font = `13px ${jp}`;
    ctx.fillText(`全${roundsCount}回戦 ／ 参加${entryPlayerIds.length}名 ／ チョンボ 1回 -${CHONBO_PENALTY.toFixed(1)}pt${showKuroko ? ' ／ 黒子を含む' : ''}`, 32, height - 26);

    canvas.toBlob((blob) => {
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ranking_${dateStr.replace(/\//g, '')}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, 'image/png');
  };

  // ==========================================
  // Render
  // ==========================================
  // バックアップの作成（ファイルをダウンロード）
  const handleExportBackup = async () => {
    try {
      const data = await api.exportBackup();
      alert(`バックアップを保存しました。\n\n・選手 ${data.players.length}名\n・過去大会 ${data.archives?.length ?? 0}件\n・今大会の進行状態: ${data.currentTournament ? 'あり' : 'なし'}\n・次の大会の事前登録: ${data.nextEntry ? 'あり' : 'なし'}\n\n※ログインコードは含まれません。`);
    } catch (err) {
      console.error(err);
      alert('バックアップを作成できませんでした。通信状況を確認して、もう一度お試しください。');
    }
  };

  // バックアップからの復元。実行前に、いまの状態を自動でバックアップ（ダウンロード）してから書き戻す。
  const handleDataImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) return;
    const input = e.target;
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async (ev) => {
      try {
        const backup = parseBackup(JSON.parse(String(ev.target?.result)));
        const existingPlayerIds = new Set(dbPlayers.map(p => p.id));
        const updP = backup.players.filter(p => existingPlayerIds.has(p.id)).length;
        const keepP = dbPlayers.filter(p => !backup.players.some(b => b.id === p.id)).length;
        const lines: string[] = [
          `バックアップ（${backup.exportedAt ? new Date(backup.exportedAt).toLocaleString('ja-JP') : '日時不明'}）から復元します。`,
          '',
          `・選手: ${backup.players.length}名（上書き ${updP}名／新規 ${backup.players.length - updP}名）。通算ポイントもバックアップ時点に戻ります`,
        ];
        if (keepP > 0) lines.push(`　バックアップに無い選手 ${keepP}名は、そのまま残ります`);
        if (backup.archives) {
          const existingArchiveIds = new Set(archives.map(a => a.id));
          const updA = backup.archives.filter(a => existingArchiveIds.has(a.id)).length;
          const keepA = archives.filter(a => !backup.archives!.some(b => b.id === a.id)).length;
          lines.push(`・過去大会: ${backup.archives.length}件（上書き ${updA}件／新規 ${backup.archives.length - updA}件）`);
          if (keepA > 0) lines.push(`　バックアップに無い過去大会 ${keepA}件は、そのまま残ります`);
        } else {
          lines.push('・過去大会: このバックアップには含まれていないため、変更しません');
        }
        if (backup.currentTournament !== undefined) lines.push(`・今大会の進行状態: ${backup.currentTournament ? 'バックアップの内容に置き換えます' : '「大会なし」の状態にします（いまの進行状態は消えます）'}`);
        if (backup.nextEntry !== undefined) lines.push(`・次の大会の事前登録: ${backup.nextEntry ? 'バックアップの内容に置き換えます' : '削除します'}`);
        lines.push('', '実行前に、いまの状態を自動でバックアップ（ダウンロード）します。', '※ログインコードは変わりません。', '', 'よろしいですか？');
        if (!window.confirm(lines.join('\n'))) return;

        await api.exportBackup(); // 復元前の状態を保存（万一のやり直し用）
        await api.restoreBackup(backup);
        alert('復元しました。画面を再読み込みします。\n（復元前の状態も、別のファイルとしてダウンロードされています）');
        window.location.reload();
      } catch (err) {
        console.error(err);
        alert(`復元できませんでした。\n${err instanceof Error ? err.message : 'ファイルの読み込みに失敗しました。'}`);
      } finally {
        input.value = ''; // 同じファイルをもう一度選べるようにする
      }
    };
    reader.readAsText(file);
  };

  if (!isLoaded || status === 'loading') return <div className="min-h-screen bg-[#f3eee4] flex items-center justify-center font-bold text-lg animate-pulse">データを読み込んでいます...</div>;

  // ==========================================
  // データタブ用の集計（過去大会＋今大会（送信済みの卓）の全結果が対象。黒子・順位対象外の記録は除く）
  // ==========================================
  const RANK_LIMIT = 20; // データタブの最高スコアは20位まで（2列に分けて表示）
  const MIN_GAMES_FOR_RATE = 8; // 連対率・ラス回避率の対象となる最低半荘数

  // 同じ値は同順位にする（1,2,2,4…）
  const assignRanks = <T,>(sorted: T[], valueOf: (x: T) => number): (T & { rankNo: number })[] => {
    const out: (T & { rankNo: number })[] = [];
    sorted.forEach((x, i) => {
      const rankNo = i > 0 && valueOf(sorted[i - 1]) === valueOf(x) ? out[i - 1].rankNo : i + 1;
      out.push({ ...x, rankNo });
    });
    return out;
  };

  // 集計の対象範囲: 通算=過去の全大会、今季=今季の大会のみ（今大会は常に含む）
  const dataArchives = dataScope === 'season' ? seasonArchives : archives;
  const dataScopeLabel = dataScope === 'season' ? '今季' : '通算';

  // 全半荘の記録（1人1半荘につき1件）。score は実点（100点単位ではなく点）。
  // source は大会名（過去大会名 / 今大会）、seq はその大会の中での対局の順番（連勝の判定に使う）
  type GameRec = { playerId: string; name: string; source: string; seq: number; rank: number; score: number; point: number };
  const gameRecs: GameRec[] = [];
  // データ／管理用データのタブを開いているときだけ集計する
  const dataLike = activeTab === 'data' || activeTab === 'admin';
  (dataLike ? dataArchives : []).forEach(a => a.hanchans.forEach(h => {
    h.results.forEach(r => {
      const nm = nameOf(r.playerId, r.name);
      if (r.excluded || isKuroko(nm)) return;
      // 選手登録前の前季データ（legacy:名前）も、登録済みの同名の選手と同じ選手として集計する
      const key = lifetimeKeyOf(r.playerId, nm);
      gameRecs.push({ playerId: key, name: dbPlayers.find(p => p.id === key)?.name || nm, source: a.name, seq: -h.no, rank: r.rank, score: r.score * 100, point: r.point });
    });
  }));
  // 今大会（送信済みの卓のみ）。着順は卓内のスコア順
  (dataLike ? seating : []).forEach(r => r.tables.forEach(t => {
    if (!t.isSubmitted) return;
    const sorted = [...t.players].sort((a, b) => b.score - a.score);
    t.players.forEach(pl => {
      const nm = nameOf(pl.playerId, pl.name);
      if (isKuroko(nm)) return;
      gameRecs.push({
        playerId: pl.playerId, name: nm, source: '今大会', seq: r.round,
        rank: sorted.findIndex(sp => sp.playerId === pl.playerId) + 1,
        score: pl.score * 100,
        point: pl.point,
      });
    });
  }));

  // 最高スコア（1半荘ごと）
  const topScoreRanking = assignRanks([...gameRecs].sort((x, y) => y.score - x.score).slice(0, RANK_LIMIT), x => x.score);

  // ===== 管理用データ（管理者のみ・上位10名まで） =====
  const ADMIN_TOP_N = 10;
  const adminOn = isAdmin && activeTab === 'admin';
  const r1 = (v: number) => Math.round(v * 10) / 10;
  const toAdminRows = <T,>(sorted: T[], valueOf: (x: T) => number, make: (x: T) => { name: string; value: string; sub?: string }): AdminRow[] =>
    assignRanks(sorted.slice(0, ADMIN_TOP_N), valueOf).map(x => ({ rank: x.rankNo, ...make(x) }));
  // 選手ごとの集計: 素点 =（スコア − 30000点）÷ 1000、順位点 = ポイント − 素点（順位点・オカ・供託など）、着順の回数
  const adminAgg = new Map<string, { name: string; raw: number; uma: number; games: number; counts: number[] }>();
  if (adminOn) {
    gameRecs.forEach(g => {
      const cur = adminAgg.get(g.playerId) || { name: g.name, raw: 0, uma: 0, games: 0, counts: [0, 0, 0, 0] };
      const raw = (g.score - 30000) / 1000;
      cur.raw += raw;
      cur.uma += g.point - raw;
      cur.games += 1;
      if (g.rank >= 1 && g.rank <= 4) cur.counts[g.rank - 1] += 1;
      adminAgg.set(g.playerId, cur);
    });
  }
  const adminList = Array.from(adminAgg.values()).map(x => ({ ...x, raw: r1(x.raw), uma: r1(x.uma) }));
  const adminLow: AdminRow[] = adminOn
    ? toAdminRows([...gameRecs].sort((x, y) => x.score - y.score), x => x.score, x => ({ name: x.name, value: `${x.score.toLocaleString()}点`, sub: x.source }))
    : [];
  const adminRaw: AdminRow[] = adminOn
    ? toAdminRows([...adminList].sort((x, y) => y.raw - x.raw || y.games - x.games), x => x.raw, x => ({ name: x.name, value: fmtPt(x.raw), sub: `${x.games}半荘` }))
    : [];
  const adminUma: AdminRow[] = adminOn
    ? toAdminRows([...adminList].sort((x, y) => y.uma - x.uma || y.games - x.games), x => x.uma, x => ({ name: x.name, value: fmtPt(x.uma), sub: `${x.games}半荘` }))
    : [];
  // 順位別率（1位率〜4位率）: 8半荘以上の選手が対象。率の高い順
  const adminRates: AdminRow[][] = [0, 1, 2, 3].map(k => adminOn
    ? toAdminRows(
        adminList.filter(x => x.games >= MIN_GAMES_FOR_RATE).sort((x, y) => y.counts[k] / y.games - x.counts[k] / x.games || y.games - x.games),
        x => x.counts[k] / x.games,
        x => ({ name: x.name, value: `${Math.round((x.counts[k] / x.games) * 100)}%`, sub: `${x.counts[k]}回 / ${x.games}半荘` }))
    : []);
  // ---- 通算の1戦目／5戦目以降／最終戦ランキング ----
  // 大会ごと・選手ごとの半荘（古い順）。年間チャンピオン戦などの別大会は、大会の構成（1戦目・5戦目以降・最終戦）を見る集計からは除く
  type AdminTourneyGames = { playerId: string; name: string; games: GameRec[] };
  const adminTourneyGames = new Map<string, AdminTourneyGames>();
  if (adminOn) {
    gameRecs.forEach(g => {
      if (isSeparateEventArchive({ name: g.source })) return;
      const k = `${g.source}\u0001${g.playerId}`;
      const cur = adminTourneyGames.get(k) || { playerId: g.playerId, name: g.name, games: [] };
      cur.games.push(g);
      adminTourneyGames.set(k, cur);
    });
    adminTourneyGames.forEach(v => v.games.sort((x, y) => x.seq - y.seq));
  }
  // pick: 大会ごとに、数える半荘を選ぶ。選手ごとに、全大会の合計ポイントを出す
  const sumByPlayer = (pick: (games: GameRec[]) => GameRec[]) => {
    const m = new Map<string, { name: string; total: number; n: number; tournaments: number }>();
    adminTourneyGames.forEach(v => {
      const picked = pick(v.games);
      if (picked.length === 0) return;
      const cur = m.get(v.playerId) || { name: v.name, total: 0, n: 0, tournaments: 0 };
      cur.total += picked.reduce((sum, g) => sum + g.point, 0);
      cur.n += picked.length;
      cur.tournaments += 1;
      m.set(v.playerId, cur);
    });
    return Array.from(m.values()).map(x => ({ ...x, total: r1(x.total) })).sort((x, y) => y.total - x.total || y.n - x.n);
  };
  const adminFifth: AdminRow[] = adminOn
    ? toAdminRows(sumByPlayer(g => (g.length >= 5 ? g.slice(4) : [])), x => x.total, x => ({ name: x.name, value: fmtPt(x.total), sub: `${x.tournaments}大会・${x.n}戦分` }))
    : [];
  const adminFirst: AdminRow[] = adminOn
    ? toAdminRows(sumByPlayer(g => g.slice(0, 1)), x => x.total, x => ({ name: x.name, value: fmtPt(x.total), sub: `${x.tournaments}大会の1戦目` }))
    : [];
  const adminLast: AdminRow[] = adminOn
    ? toAdminRows(sumByPlayer(g => g.slice(-1)), x => x.total, x => ({ name: x.name, value: fmtPt(x.total), sub: `${x.tournaments}大会の最終戦` }))
    : [];
  // 一大会の最終スコアランキング（1つの大会での最終ポイント。年間チャンピオン戦は除く）。今季と通算を並べて出す
  const finalScoreRows = (scope: SchoolScope): AdminRow[] => adminOn
    ? toAdminRows(
        tourneyStandings.filter(x => !x.separate && (scope === 'all' || x.season)).sort((x, y) => y.point - x.point || x.rank - y.rank),
        x => r1(x.point),
        x => ({ name: x.name, value: fmtPt(r1(x.point)), sub: `${x.tName}・${x.rank}位・${x.gameCount}半荘` }))
    : [];
  const finalScoreSeason = finalScoreRows('season');
  const finalScoreAll = finalScoreRows('all');

  // ---- 連続記録（連勝・連敗・連続連対・連続ラス回避）。選手ごとに最長の記録を1件。2回以上続いたもののみ ----
  const adminStreaks = (pred: (g: GameRec) => boolean): AdminRow[] => {
    if (!adminOn) return [];
    const seqs = new Map<string, { name: string; games: GameRec[] }>();
    gameRecs.forEach(g => {
      const k = adminStreakAcross ? g.playerId : `${g.source}\u0001${g.playerId}`;
      const cur = seqs.get(k) || { name: g.name, games: [] };
      cur.games.push(g);
      seqs.set(k, cur);
    });
    const best = new Map<string, { name: string; len: number; from: string; to: string }>();
    seqs.forEach(v => {
      // 大会をまたぐときは、大会の番号順→大会内の順（第6回と第7回は開催順が逆でも、番号順で並べる）
      v.games.sort((x, y) => (adminStreakAcross ? tournamentSortKey(x.source) - tournamentSortKey(y.source) : 0) || x.seq - y.seq);
      let run = 0;
      let from = '';
      v.games.forEach(g => {
        if (!pred(g)) { run = 0; return; }
        if (run === 0) from = g.source;
        run += 1;
        const cur = best.get(g.playerId);
        if (run >= 2 && (!cur || run > cur.len)) best.set(g.playerId, { name: v.name, len: run, from, to: g.source });
      });
    });
    return toAdminRows(Array.from(best.values()).sort((x, y) => y.len - x.len), x => x.len, x => ({ name: x.name, value: `${x.len}連続`, sub: x.from === x.to ? x.from : `${x.from}〜${x.to}` }));
  };
  const adminWinStreak = adminStreaks(g => g.rank === 1);          // 連勝（1着が続く）
  const adminLoseStreak = adminStreaks(g => g.rank === 4);         // 連敗（ラス＝4着が続く）
  const adminRentaiStreak = adminStreaks(g => g.rank <= 2);        // 連続連対（1着か2着が続く）
  const adminAvoidStreak = adminStreaks(g => g.rank !== 4);        // 連続ラス回避（4着以外が続く）

  // ---- 過去の同点（同じ半荘で、点数がまったく同じだった組）。すべての着順をすべて表示 ----
  type AdminTie = { where: string; rankNo: number; names: string[]; score: number };
  const adminTies: AdminTie[] = (() => {
    if (!adminOn) return [];
    const out: (AdminTie & { sk: number; ord: number })[] = [];
    const scan = (where: string, sk: number, ord: number, items: { name: string; score: number; real: boolean }[]) => {
      const byScore = new Map<number, { name: string; score: number; real: boolean }[]>();
      items.forEach(it => { const arr = byScore.get(it.score); if (arr) arr.push(it); else byScore.set(it.score, [it]); });
      byScore.forEach((grp, score) => {
        if (grp.length < 2 || !grp.some(x => x.real)) return;
        out.push({ where, rankNo: 1 + items.filter(x => x.score > score).length, names: grp.map(x => x.name), score, sk, ord });
      });
    };
    dataArchives.forEach(a => {
      // 保存順は新しい半荘が先頭なので、反転して古い順にし「◯半荘目」を付ける
      [...a.hanchans].reverse().forEach((h, i) => {
        scan(`${a.name} ${i + 1}半荘目`, tournamentSortKey(a.name), i,
          h.results.map(r => { const nm = nameOf(r.playerId, r.name); return { name: nm, score: r.score * 100, real: !r.excluded && !isKuroko(nm) }; }));
      });
    });
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      scan(`今大会 ${r.round}回戦 ${t.tableNumber}卓`, Number.POSITIVE_INFINITY, r.round * 100 + t.tableNumber,
        t.players.map(pl => { const nm = nameOf(pl.playerId, pl.name); return { name: nm, score: pl.score * 100, real: !isKuroko(nm) }; }));
    }));
    return out
      .sort((x, y) => (x.sk === y.sk ? 0 : x.sk - y.sk) || x.ord - y.ord)
      .map(({ sk: _sk, ord: _ord, ...rest }) => rest);
  })();

  // ---- 通算の相性ランキング: 特定の選手と同卓したときの、自分のポイントの合計 ----
  const adminPairs: { an: string; bn: string; sum: number; n: number }[] = (() => {
    if (!adminOn) return [];
    const map = new Map<string, { an: string; bn: string; sum: number; n: number }>();
    const addTable = (members: { key: string; name: string; point: number; real: boolean }[]) => {
      const real = members.filter(m => m.real);
      real.forEach(a => real.forEach(b => {
        if (a.key === b.key) return;
        const k = `${a.key}\u0001${b.key}`;
        const cur = map.get(k) || { an: a.name, bn: b.name, sum: 0, n: 0 };
        cur.sum += a.point;
        cur.n += 1;
        map.set(k, cur);
      }));
    };
    dataArchives.forEach(a => a.hanchans.forEach(h => addTable(h.results.map(r => {
      const nm = nameOf(r.playerId, r.name);
      const key = lifetimeKeyOf(r.playerId, nm);
      return { key, name: dbNameById.get(key) || nm, point: r.point, real: !r.excluded && !isKuroko(nm) };
    }))));
    countedSeating.forEach(r => r.tables.forEach(t => {
      if (!t.isSubmitted) return;
      addTable(t.players.map(pl => ({ key: pl.playerId, name: nameOf(pl.playerId, pl.name), point: pl.point, real: !isKuroko(pl.name) })));
    }));
    return Array.from(map.values()).filter(x => x.n >= adminSynergyMin).map(x => ({ ...x, sum: r1(x.sum) }));
  })();
  // ---- 学校別成績（管理者のみ・非公開）。選択中の範囲（今季/通算）の、学校ごとの集計 ----
  const schoolStats: SchoolSummary[] = schoolDataOn
    ? Array.from(buildSchoolSummaries(schoolGames, dataScope).values()).sort((x, y) => y.point - x.point || y.games - x.games)
    : [];
  const schoolUnsetCount = adminOn ? new Set(gameRecs.filter(g => !playerSchools[g.playerId]).map(g => g.playerId)).size : 0;
  const synergyRow = (x: { an: string; bn: string; sum: number; n: number }) => ({ name: `${x.an}（${x.bn}と同卓）`, value: fmtPt(x.sum), sub: `${x.n}半荘・平均${fmtPt(r1(x.sum / x.n))}` });
  const adminGoodMatch: AdminRow[] = adminOn ? toAdminRows([...adminPairs].sort((x, y) => y.sum - x.sum || y.n - x.n), x => x.sum, synergyRow) : [];
  const adminBadMatch: AdminRow[] = adminOn ? toAdminRows([...adminPairs].sort((x, y) => x.sum - y.sum || y.n - x.n), x => x.sum, synergyRow) : [];

  // データタブのランキングカード（全カード共通の見た目。高さも揃える）
  type DataRow = { key: string; rankNo: number; name: string; sub: string; value: string; unit?: string; valueClass?: string; bar?: number };
  const DATA_THEMES = {
    amber:   { head: 'from-amber-50 to-yellow-50 border-amber-100', title: 'text-amber-900', chip: 'text-amber-600', sub: 'text-amber-700/80', hi: 'bg-amber-50/50', val: 'text-amber-600', bar: 'from-amber-400 to-yellow-500' },
    rose:    { head: 'from-rose-50 to-pink-50 border-rose-100', title: 'text-rose-900', chip: 'text-rose-600', sub: 'text-rose-700/80', hi: 'bg-rose-50/50', val: 'text-rose-600', bar: 'from-rose-400 to-pink-500' },
    emerald: { head: 'from-emerald-50 to-teal-50 border-emerald-100', title: 'text-emerald-900', chip: 'text-emerald-600', sub: 'text-emerald-700/80', hi: 'bg-emerald-50/50', val: 'text-emerald-600', bar: 'from-emerald-400 to-teal-500' },
    sky:     { head: 'from-sky-50 to-cyan-50 border-sky-100', title: 'text-sky-900', chip: 'text-sky-600', sub: 'text-sky-700/80', hi: 'bg-sky-50/50', val: 'text-sky-600', bar: 'from-sky-400 to-cyan-500' },
    indigo:  { head: 'from-[#fdf1ed] to-[#eff3f9] border-[#fbddd3]', title: 'text-[#5e190e]', chip: 'text-[#c8361e]', sub: 'text-[#a62b17]/80', hi: 'bg-[#fdf1ed]/50', val: 'text-[#c8361e]', bar: 'from-[#e5664c] to-[#42649a]' },
    slate:   { head: 'from-[#f3eee4] to-zinc-50 border-[#e7dfd1]', title: 'text-[#2d2721]', chip: 'text-[#625a4f]', sub: 'text-[#82786b]', hi: 'bg-[#faf7f1]', val: 'text-[#473f36]', bar: 'from-[#a99d8c] to-zinc-500' },
  } as const;
  const medalClass = (n: number) =>
    n === 1 ? 'bg-gradient-to-br from-yellow-300 to-amber-500 text-white'
    : n === 2 ? 'bg-gradient-to-br from-[#d4c9b7] to-[#a99d8c] text-white'
    : n === 3 ? 'bg-gradient-to-br from-orange-300 to-orange-500 text-white'
    : 'bg-[#f3eee4] text-[#82786b]';

  const renderDataCard = (opts: { icon: string; title: string; desc: string; theme: keyof typeof DATA_THEMES; rows: DataRow[]; emptyText?: string; limit: number; twoColumns?: boolean }) => {
    const th = DATA_THEMES[opts.theme];
    const limit = opts.limit;
    const rowH = 'min-h-[64px]';
    const fillers = Math.max(0, limit - opts.rows.length);
    const rowEls = opts.rows.map(x => (
      <li key={x.key} className={`px-4 flex-1 ${rowH} flex flex-col justify-center ${x.rankNo === 1 ? th.hi : ''}`}>
        <div className="flex items-center gap-3">
          <span className={`flex-shrink-0 w-9 h-9 rounded-full flex items-center justify-center font-black text-sm shadow-sm ${medalClass(x.rankNo)}`}>{x.rankNo}</span>
          <div className="flex-1 min-w-0">
            <div className="font-bold text-[#2d2721] truncate"><PlayerLabel name={x.name} /></div>
            <div className="text-[11px] text-[#a99d8c] truncate">{x.sub}</div>
          </div>
          <div className="text-right flex-shrink-0">
            <span className={`text-xl font-black tabular-nums ${x.valueClass || th.val}`}>{x.value}</span>
            {x.unit && <span className="text-xs font-bold text-[#a99d8c] ml-0.5">{x.unit}</span>}
          </div>
        </div>
        {x.bar !== undefined && (
          <div className="mt-2 ml-12 h-1.5 rounded-full bg-[#f3eee4] overflow-hidden">
            <div className={`h-full rounded-full bg-gradient-to-r ${th.bar}`} style={{ width: `${Math.max(0, Math.min(1, x.bar)) * 100}%` }} />
          </div>
        )}
      </li>
    ));
    const fillEls = Array.from({ length: fillers }).map((_, i) => (
      <li key={`ph-${i}`} className={`flex items-center justify-center flex-1 ${rowH} text-sm text-[#d4c9b7]`}>{i === 0 && opts.rows.length === 0 && opts.emptyText ? opts.emptyText : '—'}</li>
    ));
    const all = [...rowEls, ...fillEls];
    const per = Math.ceil(limit / 2);
    return (
      <section className="bg-white rounded-2xl shadow-sm border border-[#e7dfd1] overflow-hidden flex flex-col h-full">
        <div className={`px-5 py-3.5 bg-gradient-to-r ${th.head} border-b min-h-[64px]`}>
          <h3 className={`text-lg font-black ${th.title} flex items-center gap-2`}>{opts.icon} {opts.title} <span className={`text-xs font-bold ${th.chip} bg-white/70 px-2 py-0.5 rounded-full`}>TOP{limit}</span></h3>
          <p className={`text-[11px] ${th.sub} mt-0.5`}>{opts.desc}</p>
        </div>
        {opts.twoColumns ? (
          <div className="grid grid-cols-1 md:grid-cols-2 md:divide-x divide-[#f3eee4] flex-1">
            <ol className="divide-y divide-[#f3eee4] flex flex-col">{all.slice(0, per)}</ol>
            <ol className="divide-y divide-[#f3eee4] flex flex-col border-t border-[#f3eee4] md:border-t-0">{all.slice(per)}</ol>
          </div>
        ) : (
          <ol className="divide-y divide-[#f3eee4] flex-1 flex flex-col">{all}</ol>
        )}
      </section>
    );
  };

  // 過去大会の上位3名（表彰台用）
  const archiveTop3 = (a: TournamentArchive): PodiumEntry[] =>
    [...a.standings]
      .filter(st => !isKuroko(nameOf(st.playerId, st.name)))
      .sort((x, y) => x.rank - y.rank || y.totalPoint - x.totalPoint)
      .slice(0, 3)
      .map(st => ({ rank: st.rank, name: nameOf(st.playerId, st.name), point: st.totalPoint, gameCount: st.gameCount }));
  const podiumArchives = [...archives]
    .filter(a => podiumScope === 'all' || !isPreviousSeasonArchive(a))
    .sort((x, y) => tournamentSortKey(y.name) - tournamentSortKey(x.name));

  // 管理用データの各セクションの見出しに置く「今季／通算」の切り替え（上のバナーのボタンと同じ設定を切り替える）
  const scopeToggle = (
    <div className="flex gap-1 flex-shrink-0">
      {([['season', '今季'], ['all', '通算']] as const).map(([v, label]) => (
        <button
          key={v}
          onClick={() => setDataScope(v)}
          className={`px-3 py-1 rounded-md text-xs font-bold transition ${dataScope === v ? 'bg-[#c8361e] text-white' : 'bg-white border border-[#e7dfd1] text-[#82786b] hover:bg-[#f3eee4]'}`}
        >{label}</button>
      ))}
    </div>
  );

  // データタブの最高スコアランキング（20位まで。10位ずつ2列に分けて表示）
  const renderTopCards = () => renderDataCard({
    limit: RANK_LIMIT, twoColumns: true,
    icon: '🎯', title: '最高スコア', theme: 'amber',
    desc: '1半荘あたりの最高スコア（左が1〜10位、右が11〜20位）',
    rows: topScoreRanking.slice(0, RANK_LIMIT).map((x, i) => ({ key: `top-${x.playerId}-${x.source}-${i}`, rankNo: x.rankNo, name: x.name, sub: x.source, value: x.score.toLocaleString(), unit: '点' })),
  });

  // タブボタン（ヘッダー用）。選択中は白いカード調＋タブごとの色のドット、それ以外は控えめな文字
  const TAB_DOTS: Record<string, string> = {
    'bg-[#c8361e]': 'bg-gradient-to-br from-[#e5664c] to-[#c8361e]',
    'bg-teal-600': 'bg-gradient-to-br from-teal-400 to-emerald-500',
    'bg-amber-600': 'bg-gradient-to-br from-amber-300 to-orange-500',
    'bg-[#9a7022]': 'bg-gradient-to-br from-[#d3a23f] to-[#31507f]',
    'bg-rose-600': 'bg-gradient-to-br from-rose-400 to-red-500',
    'bg-yellow-600': 'bg-gradient-to-br from-amber-300 to-yellow-500',
  };
  const tabBtn = (key: typeof activeTab, label: string, color: string) => {
    const on = activeTab === key;
    return (
      <button
        onClick={() => setActiveTab(key)}
        className={`flex items-center gap-1.5 px-3 lg:px-4 h-11 font-bold text-[13px] whitespace-nowrap transition border-b-[3px] ${on ? 'text-white border-amber-400 bg-white/[0.08]' : 'text-[#a99d8c] hover:text-white border-transparent hover:bg-white/[0.05]'}`}
      >
        {label}
      </button>
    );
  };

  // スマホ用の下部ナビの項目
  const mobileNavItems: { key: typeof activeTab; icon: string; label: string; color: string }[] = [
    { key: 'tournament', icon: '🀄', label: '大会進行', color: 'bg-[#e5664c]' },
    { key: 'currentRanking', icon: '🏆', label: '今大会', color: 'bg-teal-400' },
    { key: 'totalRanking', icon: '📈', label: '今季', color: 'bg-[#e5664c]' },
    { key: 'archives', icon: '🗂️', label: '過去大会', color: 'bg-amber-400' },
    ...(isAdmin ? [{ key: 'players' as const, icon: '👥', label: '登録', color: 'bg-[#e5664c]' }] : []),
    { key: 'data', icon: '📊', label: 'データ', color: 'bg-[#d3a23f]' },
    ...(isAdmin ? [{ key: 'admin' as const, icon: '🛠️', label: '管理', color: 'bg-rose-400' }] : []),
    { key: 'lifetime', icon: '🏅', label: '生涯', color: 'bg-amber-300' },
  ];

  // 表示するタイマー: 開始時刻が設定済みで、まだ終わっていない回戦のうち一番新しいもの
  // （開始時刻を過ぎて一定時間が経つと、タイマー部品の側で自動的に消える）
  const activeTimer = (() => {
    if (tournamentPhase !== 'playing') return null;
    const cands = Object.entries(timerState.startAts)
      .map(([k, v]) => ({ round: Number(k), startAt: Number(v) }))
      .filter(c => {
        const rd = seating.find(r => r.round === c.round);
        return !!rd && !isRoundFinished(rd);
      })
      .sort((a, b) => b.round - a.round);
    return cands[0] || null;
  })();
  // 一番下の「〇卓〇家」は、選手ログイン中のみ表示する
  const timerSeatText = (() => {
    if (!activeTimer || !loggedInPlayerId || hideSeating) return undefined;
    const item = getPlayerSchedule(loggedInPlayerId).find(it => it.roundNo === activeTimer.round);
    if (!item) return undefined;
    if (item.status === 'ready' && item.tableNo) return `${tableTextWithIcon(item.tableNo)}${item.wind}家`;
    if (item.status === 'sitout') return '抜け番';
    return undefined;
  })();

  return (
    <main
      className="min-h-screen text-[#2d2721] font-sans relative pb-28 md:pb-20"
      style={{
        backgroundColor: '#f6f1e8',
        backgroundImage: 'linear-gradient(180deg, #fbf8f2 0px, #f6f1e8 480px)',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {/* スマホ向けの共通調整: 入力欄の自動ズーム防止（16px）、タップ時の青いハイライト抑止、横スクロールの慣性など */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Shippori+Mincho+B1:wght@600;800&family=Barlow+Condensed:wght@600;700;800&family=Inter:wght@400;600;800&family=Noto+Sans+JP:wght@400;500;700;900&display=swap');
        html { -webkit-text-size-adjust: 100%; }
        body { -webkit-tap-highlight-color: transparent; overflow-x: hidden; }
        @media (max-width: 767px) {
          input:not([type="checkbox"]):not([type="radio"]):not([type="file"]), select, textarea { font-size: 16px !important; }
          .overflow-x-auto { -webkit-overflow-scrolling: touch; }
        }
        /* ===== 和モダン「墨 × 朱」デザイン（ライトテーマ・軽量）=====
           生成りの紙に、墨色・朱・藍・金。見出しは明朝、数字は細身のコンデンス体。
           ぼかし(backdrop-filter)・多重の影・属性セレクタ・文字の発光は、重くなるので使わない */
        main { font-family: 'Inter', 'Noto Sans JP', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'Yu Gothic UI', system-ui, sans-serif; color: #1c1814; -webkit-font-smoothing: antialiased; }
        main h1, main h2, main h3 { font-family: 'Shippori Mincho B1', 'Hiragino Mincho ProN', 'Yu Mincho', 'Noto Serif JP', serif; font-weight: 800; letter-spacing: .03em; }
        main .tabular-nums { font-family: 'Barlow Condensed', 'Inter', 'Noto Sans JP', sans-serif; font-variant-numeric: tabular-nums lining-nums; font-weight: 700; font-size: 1.1em; letter-spacing: .01em; }

        /* ヘッダー: 墨色＋下端に朱の太線 */
        main > header { background-image: none !important; background-color: #17120e !important; box-shadow: none !important; }
        main > header h1 { background-image: none !important; color: #fff; -webkit-text-fill-color: #fff; letter-spacing: .12em; font-size: 1.15rem; }
        main > header::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 4px; pointer-events: none; background: linear-gradient(90deg, #c8361e 0 72%, #b8892b 72% 100%); }

        /* カード: 生成りの白に細い罫線。影は付けず、角は小さく */
        main .bg-white { background-color: #fffdf9; }
        main .shadow-sm { box-shadow: none; }
        main .bg-white.rounded-2xl, main .bg-white.rounded-3xl, main .bg-white.rounded-xl { border-radius: 10px; box-shadow: none; }
        main .bg-white.rounded-2xl.border:not(.overflow-hidden) { border-top: 3px solid #1c1814; }
        /* カード見出しの朱印 */
        main .bg-white.rounded-2xl > h2:first-child::before { content: ''; display: inline-block; flex-shrink: 0; width: .55em; height: .55em; margin: 0 .65rem 0 .1rem; border-radius: 1px; background: #c8361e; vertical-align: .05em; }

        /* ページ上部のバナー: 青海波（せいがいは）の模様＋下端に朱の線 */
        main .relative.overflow-hidden.rounded-2xl.text-white { isolation: isolate; border-radius: 10px; border: 0; box-shadow: none; border-bottom: 4px solid #c8361e; }
        main .relative.overflow-hidden.rounded-2xl.text-white::before {
          content: ''; position: absolute; inset: 0; z-index: 0; pointer-events: none;
          background-image:
            radial-gradient(circle at 50% 100%, transparent 0 34%, rgba(255,255,255,.14) 35% 37%, transparent 38% 52%, rgba(255,255,255,.14) 53% 55%, transparent 56% 70%, rgba(255,255,255,.14) 71% 73%, transparent 74%),
            radial-gradient(circle at 50% 100%, transparent 0 34%, rgba(255,255,255,.14) 35% 37%, transparent 38% 52%, rgba(255,255,255,.14) 53% 55%, transparent 56% 70%, rgba(255,255,255,.14) 71% 73%, transparent 74%);
          background-size: 46px 23px, 46px 23px; background-position: 0 0, 23px 11.5px;
          -webkit-mask-image: linear-gradient(100deg, transparent 25%, #000 100%); mask-image: linear-gradient(100deg, transparent 25%, #000 100%);
        }
        main .relative.overflow-hidden.rounded-2xl.text-white > *:not(.absolute) { position: relative; z-index: 1; }
        main .relative.overflow-hidden.rounded-2xl.text-white h2 { font-size: clamp(1.6rem, 1.2rem + 1.4vw, 2.3rem); letter-spacing: .12em; }

        /* 表: 墨色の見出し＋朱の下線、行のホバー */
        main thead.bg-\\[\\#1c1814\\] th { box-shadow: inset 0 -2px 0 #c8361e; letter-spacing: .06em; }
        main thead th { letter-spacing: .04em; }
        main tbody tr { transition: background-color .12s ease; }
        main tbody tr:hover { background-color: rgba(200,54,30,.05); }

        /* 入力欄 */
        main input:not([type="checkbox"]):not([type="radio"]):not([type="file"]):not([type="range"]), main select, main textarea { border-radius: 8px; border: 1px solid #d4c9b7; background-color: #fffdf9; transition: border-color .14s ease, box-shadow .14s ease; }
        main input:not([type="checkbox"]):not([type="radio"]):focus, main select:focus, main textarea:focus { outline: none; border-color: #c8361e; box-shadow: 0 0 0 3px rgba(200,54,30,.18); }

        /* ボタン */
        main button { transition: transform .12s ease, filter .12s ease, background-color .12s ease, border-color .12s ease; }
        main button:not(:disabled):hover { filter: brightness(1.07); }
        main button:not(:disabled):active { transform: scale(.97); }

        /* 1〜3位のメダル */
        main .rounded-full.bg-gradient-to-br.from-yellow-300 { box-shadow: 0 0 0 3px rgba(184,137,43,.28); }
        main .rounded-full.bg-gradient-to-br.from-\\[\\#d4c9b7\\] { box-shadow: 0 0 0 3px rgba(130,120,107,.25); }
        main .rounded-full.bg-gradient-to-br.from-orange-300 { box-shadow: 0 0 0 3px rgba(200,54,30,.22); }

        /* モーダル */
        main .fixed.inset-0 > .bg-white.rounded-2xl, main .fixed.inset-0 > .bg-white.rounded-t-3xl { border: 0; border-radius: 12px; box-shadow: 0 30px 70px -22px rgba(28,24,20,.6); }

        ::selection { background: #f7bcab; color: #1c1814; }
        html { scrollbar-width: thin; scrollbar-color: #c9bda9 transparent; }
        .no-scrollbar { scrollbar-width: none; -ms-overflow-style: none; }
        .no-scrollbar::-webkit-scrollbar { display: none; }
        ::-webkit-scrollbar { width: 10px; height: 10px; }
        ::-webkit-scrollbar-track { background: transparent; }
        ::-webkit-scrollbar-thumb { background: #c9bda9; border-radius: 999px; border: 2px solid transparent; background-clip: content-box; }
      `}</style>
      
      {isResetting && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center text-white">
          <div className="animate-pulse flex flex-col items-center">
            <span className="text-red-500 text-6xl mb-4 block text-center">⚠️</span>
            <h2 className="text-2xl font-bold mb-2">{resetMessage}</h2>
            <p className="text-lg">誤操作防止のため、30秒間待機しています。</p>
            <p className="text-6xl font-mono text-center mt-8 font-black text-red-400">{resetCountdown}</p>
          </div>
        </div>
      )}

      {showPlayerLogin && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowPlayerLogin(false)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 max-h-[92vh] overflow-y-auto" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black text-[#2d2721] mb-1">🀄 選手ログイン</h2>
            <p className="text-xs text-[#82786b] mb-4">配布されたログインコードを入力してください。</p>
            <input
              type="text"
              value={loginCodeInput}
              onChange={(e) => { setLoginCodeInput(e.target.value); setLoginError(''); }}
              onKeyDown={(e) => { if (e.key === 'Enter') handlePlayerLogin(); }}
              placeholder="例: A3K7QZ"
              autoFocus
              className="w-full p-3 border-2 border-[#e7dfd1] focus:border-teal-500 rounded-lg text-center text-2xl font-mono font-bold tracking-widest uppercase outline-none"
            />
            {loginError && <p className="text-xs font-bold text-red-600 mt-2">{loginError}</p>}
            <div className="flex gap-2 mt-4">
              <button onClick={() => setShowPlayerLogin(false)} className="flex-1 py-2.5 rounded-lg font-bold text-sm bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f] transition">キャンセル</button>
              <button onClick={handlePlayerLogin} disabled={!loginCodeInput.trim()} className="flex-1 py-2.5 rounded-lg font-bold text-sm bg-teal-600 hover:bg-teal-700 disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] text-white transition">ログイン</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== ヘッダー ==========
          スマホ: 1段目=タイトル+ログイン、2段目=横スクロールの操作ボタン。画面切替は下部ナビで行う
          PC    : 従来どおり1行（画面上部に固定） */}
      <header className="bg-gradient-to-r from-[#100d0a] via-[#3b0f08] to-[#100d0a] text-white shadow-lg shadow-[#3b0f08]/25 relative md:sticky md:top-0 z-40">
        <div className="max-w-7xl mx-auto px-3 md:px-4 py-2 md:py-0 flex flex-wrap items-center gap-x-3 gap-y-2 md:gap-x-4 md:gap-y-0">
          {/* タイトル */}
          <div className="order-1 min-w-0 flex-1 mr-1 md:h-12 flex items-center gap-2.5">
            <span className="flex-shrink-0 w-9 h-10 rounded-md bg-gradient-to-b from-amber-50 to-amber-200 border-b-[5px] border-emerald-700 flex items-center justify-center text-lg shadow ring-1 ring-black/20" aria-hidden="true">🀄</span>
            <div className="min-w-0 leading-tight">
            <h1 className="text-[15px] sm:text-lg lg:text-xl font-bold tracking-wide truncate md:whitespace-nowrap bg-gradient-to-r from-white via-[#fbddd3] to-[#ef937c] bg-clip-text text-transparent">{APP_TITLE}</h1>
            <p className="text-[10px] text-[#ef937c]/70 whitespace-nowrap">{RULE_NAME}</p>
            </div>
          </div>

          {/* 段区切り（PCのみ） */}
          <div className="hidden md:block basis-full h-px bg-white/10 order-3" aria-hidden="true" />

          {/* タブ（PCのみ。スマホは下部ナビ） */}
          <div className="hidden md:flex order-4 h-11 items-center flex-shrink-0">
          <nav className="flex flex-shrink-0 items-stretch h-11 gap-0.5">
            {tabBtn('tournament', '大会進行', 'bg-[#c8361e]')}
            {tabBtn('currentRanking', '今大会成績', 'bg-teal-600')}
            {tabBtn('totalRanking', '今季成績', 'bg-[#c8361e]')}
            {tabBtn('archives', '過去大会', 'bg-amber-600')}
            {isAdmin && tabBtn('players', '新規登録', 'bg-[#c8361e]')}
            {tabBtn('data', 'データ', 'bg-[#9a7022]')}
            {isAdmin && tabBtn('admin', '管理用データ', 'bg-rose-600')}
            {tabBtn('lifetime', '生涯成績', 'bg-yellow-600')}
          </nav>
          </div>

          {/* 操作ボタン（スマホでは2段目で横スクロール／PCでは1行に並ぶ） */}
          <div className="order-3 md:order-none w-full md:w-auto md:contents flex items-center gap-2 overflow-x-auto md:overflow-visible no-scrollbar pb-0.5 md:pb-0">
            {/* 大会規定 */}
            <a
              href={RULES_DOC_URL}
              target="_blank"
              rel="noopener noreferrer"
              className="md:order-5 flex-shrink-0 text-xs md:text-xs font-bold bg-white/[0.08] hover:bg-white/[0.18] hover:shadow-[0_0_16px_rgba(214,54,31,0.45)] ring-1 ring-white/15 text-[#f3eee4] px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap"
              title="大会規定（Google ドキュメント）を別タブで開きます"
            >
              📖 大会規定
            </a>

            <div className="hidden md:block md:flex-1 md:order-5" />

            {/* 管理ツール */}
            {isAdmin && (
              <div className="md:hidden flex-shrink-0 flex gap-2 items-center">
                <button onClick={() => { setBreakInput(String(timerState.breakMinutes)); setShowTimerSettings(true); }} className="text-xs md:text-xs bg-white/[0.08] hover:bg-white/[0.18] hover:shadow-[0_0_16px_rgba(214,54,31,0.45)] ring-1 ring-white/15 text-[#f3eee4] px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap" title="次の回戦までの休憩時間を設定します">⏱ 休憩設定</button>
                <button onClick={handleExportBackup} className="text-xs md:text-xs bg-white/[0.08] hover:bg-white/[0.18] hover:shadow-[0_0_16px_rgba(214,54,31,0.45)] ring-1 ring-white/15 text-[#f3eee4] px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap" title="データをファイルとして保存します">💾 バックアップ</button>
                <label className="text-xs md:text-xs bg-white/[0.08] hover:bg-white/[0.18] hover:shadow-[0_0_16px_rgba(214,54,31,0.45)] ring-1 ring-white/15 text-[#f3eee4] px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition cursor-pointer whitespace-nowrap" title="保存したファイルから復元します">
                  📂 復元
                  <input type="file" accept=".json" className="hidden" onChange={handleDataImport} />
                </label>
              </div>
            )}

            {/* PC用: 管理ツールは「管理」メニューにまとめる（横幅を節約） */}
            {isAdmin && (
              <div className="hidden md:block md:order-5 relative flex-shrink-0">
                <button
                  onClick={() => setShowAdminMenu(v => !v)}
                  className="text-[11px] font-bold bg-white/[0.08] hover:bg-white/[0.18] hover:shadow-[0_0_16px_rgba(214,54,31,0.45)] ring-1 ring-white/15 text-[#f3eee4] px-3 py-1.5 rounded-full transition whitespace-nowrap"
                  aria-expanded={showAdminMenu}
                >⚙ 管理 {showAdminMenu ? '▴' : '▾'}</button>
                {showAdminMenu && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setShowAdminMenu(false)} aria-hidden="true" />
                    <div className="absolute right-0 top-full mt-2 w-52 z-50 rounded-xl bg-[#1c1814] ring-1 ring-white/15 shadow-2xl shadow-black/40 p-1.5 space-y-0.5">
                      <button
                        onClick={() => { setShowAdminMenu(false); setBreakInput(String(timerState.breakMinutes)); setShowTimerSettings(true); }}
                        className="w-full text-left text-xs font-bold text-[#e7dfd1] hover:bg-white/10 px-3 py-2 rounded-lg transition"
                      >⏱ 休憩設定</button>
                      <button
                        onClick={() => { setShowAdminMenu(false); handleExportBackup(); }}
                        className="w-full text-left text-xs font-bold text-[#e7dfd1] hover:bg-white/10 px-3 py-2 rounded-lg transition"
                      >💾 バックアップ</button>
                      <label className="block w-full text-left text-xs font-bold text-[#e7dfd1] hover:bg-white/10 px-3 py-2 rounded-lg transition cursor-pointer">
                        📂 復元
                        <input type="file" accept=".json" className="hidden" onChange={(e) => { setShowAdminMenu(false); handleDataImport(e); }} />
                      </label>
                    </div>
                  </>
                )}
              </div>
            )}

            {/* 選手ログイン（管理者以外向け） */}
            {!isAdmin && (
              <div className="md:order-5 flex-shrink-0 flex gap-2 items-center">
                {loggedInPlayer ? (
                  <>
                    <button
                      onClick={() => setDetailModalPlayerId(loggedInPlayer.id)}
                      className="text-xs md:text-xs font-bold bg-gradient-to-r from-teal-500 to-emerald-600 hover:brightness-110 shadow-[0_0_20px_rgba(45,212,191,0.55)] ring-1 ring-white/20 text-white px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap"
                      title="自分の個人成績と、この後の対局を見る"
                    >
                      👤 {loggedInPlayer.name}（個人成績）
                    </button>
                    <button onClick={handlePlayerLogout} className="text-xs md:text-xs bg-white/[0.08] hover:bg-rose-500 ring-1 ring-white/15 text-[#f3eee4] hover:text-white px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap">ログアウト</button>
                  </>
                ) : (
                  <button onClick={() => { setShowPlayerLogin(true); setLoginError(''); setLoginCodeInput(''); }} className="text-xs md:text-xs bg-gradient-to-r from-teal-400 to-emerald-500 hover:brightness-110 shadow-[0_0_20px_rgba(45,212,191,0.55)] ring-1 ring-white/25 text-white px-4 md:px-3 py-2 md:py-1.5 rounded-full font-bold transition whitespace-nowrap">
                    🀄 選手ログイン
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Auth Area */}
          <div className="order-2 flex-shrink-0 flex gap-2 items-center md:h-12">
            {session ? (
              <>
                <span className="text-[11px] font-bold text-[#d4c9b7] whitespace-nowrap hidden sm:inline">
                  {session.user?.name}{isAdmin && ' (管理者)'}
                </span>
                {isAdmin && <span className="sm:hidden text-[10px] font-bold bg-[#c8361e] px-1.5 py-0.5 rounded">管理者</span>}
                <button onClick={() => signOut()} className="text-xs md:text-xs bg-white/[0.08] hover:bg-rose-500 ring-1 ring-white/15 text-[#f3eee4] hover:text-white px-3 md:px-3.5 py-2 md:py-1.5 rounded-full transition whitespace-nowrap">ログアウト</button>
              </>
            ) : (
              <button onClick={() => signIn('google')} className="text-xs md:text-xs bg-gradient-to-r from-[#d9452b] via-[#42649a] to-[#b8892b] hover:brightness-110 shadow-[0_0_20px_rgba(217,70,239,0.55)] ring-1 ring-white/25 text-white px-3 py-2 md:py-1.5 rounded-full font-bold transition whitespace-nowrap">Googleログイン</button>
            )}
          </div>
        </div>
        {/* アクセントライン */}
        <div className="h-[3px] bg-gradient-to-r from-[#d9452b] via-[#b8892b] to-amber-400 shadow-[0_0_18px_rgba(217,70,239,0.85)]" />
      </header>

      {/* ========== スマホ用 下部ナビ（親指で届く位置に画面切替を置く） ========== */}
      <nav
        className="md:hidden fixed inset-x-3 z-40 rounded-[1.4rem] bg-[#100d0a]/95 ring-1 ring-white/[0.12] shadow-[0_14px_36px_rgba(2,6,23,0.5)]"
        style={{ bottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.75rem)' }}
        aria-label="画面の切り替え"
      >
        <div className="grid p-1" style={{ gridTemplateColumns: `repeat(${mobileNavItems.length}, minmax(0, 1fr))` }}>
          {mobileNavItems.map(it => {
            const on = activeTab === it.key;
            return (
              <button
                key={it.key}
                onClick={() => { setActiveTab(it.key); if (typeof window !== 'undefined') window.scrollTo({ top: 0 }); }}
                className={`relative flex flex-col items-center justify-center gap-0.5 py-2 min-h-[54px] rounded-2xl transition ${on ? 'text-white bg-white/[0.12] ring-1 ring-white/15 shadow-[0_0_18px_rgba(129,140,248,0.5)]' : 'text-[#a99d8c] active:text-white'}`}
                aria-current={on ? 'page' : undefined}
              >
                <span className="text-xl leading-none">{it.icon}</span>
                <span className={`text-[10px] leading-none ${on ? 'font-black' : 'font-bold'}`}>{it.label}</span>
                {on && <span className={`absolute bottom-0.5 w-4 h-[3px] rounded-full ${it.color}`} />}
              </button>
            );
          })}
        </div>
      </nav>

      {/* ========== 次の回戦までのタイマー（全ページ共通・ヘッダーの下） ========== */}
      {activeTimer && (
        <NextRoundTimerBar
          round={activeTimer.round}
          startAt={activeTimer.startAt}
          seatText={timerSeatText}
          isAdmin={isAdmin}
          onOpenSettings={() => { setBreakInput(String(timerState.breakMinutes)); setShowTimerSettings(true); }}
        />
      )}

      {/* ========== タイマー設定（管理者） ========== */}
      {showTimerSettings && isAdmin && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={() => setShowTimerSettings(false)}>
          <div className="bg-white w-full sm:max-w-sm rounded-t-3xl sm:rounded-2xl shadow-2xl p-5 sm:p-6 max-h-[92vh] overflow-y-auto" style={{ paddingBottom: 'max(1.25rem, env(safe-area-inset-bottom))' }} onClick={(e) => e.stopPropagation()}>
            <h2 className="text-lg font-black text-[#2d2721] mb-1">⏱ 休憩時間・タイマー設定</h2>
            <p className="text-xs text-[#82786b] mb-4 leading-relaxed">2回戦以降は「前の回戦の全卓が送信された瞬間」からこの時間後が開始時刻になります。</p>

            <label className="block text-xs font-bold text-[#625a4f] mb-1">休憩時間（分）</label>
            <div className="flex gap-2 mb-1">
              <input
                type="number" min="0" max="60" step="1"
                value={breakInput}
                onChange={(e) => setBreakInput(e.target.value)}
                className="flex-1 p-2.5 border-2 border-[#e7dfd1] focus:border-[#d9452b] rounded-lg text-center text-xl font-black outline-none"
              />
              <button
                onClick={() => {
                  const v = Math.floor(Number(breakInput));
                  if (!Number.isFinite(v) || v < 0 || v > 60) { alert('休憩時間は0〜60分の整数で指定してください。'); return; }
                  const delta = (v - timerState.breakMinutes) * 60 * 1000;
                  const target = activeTimer?.round;
                  updateTimer(prev => ({
                    ...prev,
                    breakMinutes: v,
                    // 動いているタイマーにも、変更分をそのまま反映する
                    startAts: target !== undefined && prev.startAts[target] !== undefined
                      ? { ...prev.startAts, [target]: prev.startAts[target] + delta }
                      : prev.startAts,
                  }));
                }}
                className="px-4 rounded-lg font-bold text-sm bg-[#c8361e] hover:bg-[#a62b17] text-white transition"
              >設定</button>
            </div>
            <p className="text-[11px] text-[#a99d8c] mb-5">現在: {timerState.breakMinutes}分{activeTimer ? '（動いているタイマーにも反映されます）' : ''}</p>

            {activeTimer ? (
              <div className="border-t pt-4">
                <p className="text-xs font-bold text-[#625a4f] mb-1">いまのタイマー（{activeTimer.round}回戦 ／ 開始 {formatClock(activeTimer.startAt)}）</p>
                <p className="text-[11px] text-[#a99d8c] mb-2">早く進んでいる・遅れているときの微調整</p>
                <div className="grid grid-cols-4 gap-2 mb-2">
                  {[-5, -1, 1, 5].map(m => (
                    <button
                      key={m}
                      onClick={() => updateTimer(prev => ({ ...prev, startAts: { ...prev.startAts, [activeTimer.round]: activeTimer.startAt + m * 60 * 1000 } }))}
                      className="py-2 rounded-lg font-black text-sm bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#473f36] transition"
                    >{m > 0 ? `+${m}` : m}分</button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    onClick={() => updateTimer(prev => ({ ...prev, startAts: { ...prev.startAts, [activeTimer.round]: Date.now() } }))}
                    className="py-2 rounded-lg font-bold text-sm bg-emerald-100 hover:bg-emerald-200 text-emerald-800 transition"
                  >今すぐ開始</button>
                  <button
                    onClick={() => {
                      if (!window.confirm('このタイマーを消しますか？（次に回戦の全卓が送信されると、また自動で始まります）')) return;
                      updateTimer(prev => { const startAts = { ...prev.startAts }; delete startAts[activeTimer.round]; return { ...prev, startAts }; });
                    }}
                    className="py-2 rounded-lg font-bold text-sm bg-red-100 hover:bg-red-200 text-red-700 transition"
                  >タイマーを消す</button>
                </div>
              </div>
            ) : (
              <p className="border-t pt-4 text-[11px] text-[#a99d8c]">いま動いているタイマーはありません。</p>
            )}

            <button onClick={() => setShowTimerSettings(false)} className="w-full mt-5 py-2.5 rounded-lg font-bold text-sm bg-[#2d2721] hover:bg-[#473f36] text-white transition">閉じる</button>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto p-3 sm:p-4 md:p-6">
        
        {/* ========== 新規登録 ========== */}
        {activeTab === 'players' && isAdmin && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e7dfd1]">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">新規選手の登録</h2>
              <form onSubmit={handleRegisterPlayer} className="grid grid-cols-1 md:grid-cols-4 gap-x-4 gap-y-5 items-start">
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-[#625a4f] mb-1">選手名</label>
                  <input type="text" required value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)} className="w-full p-2.5 border rounded-lg bg-[#faf7f1]"/>
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-[#625a4f] mb-1">学校 <span className="text-[11px] font-normal text-[#a99d8c]">（任意・管理者のみ閲覧／一般には非公開）</span></label>
                  <input type="text" value={newPlayerSchool} onChange={e => setNewPlayerSchool(e.target.value)} placeholder="新しい学校は直接入力" className="w-full p-2.5 border rounded-lg bg-[#faf7f1]"/>
                  <SchoolChips options={schoolOptions} value={newPlayerSchool} onPick={setNewPlayerSchool} />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-[#625a4f] mb-1">今季の通算ポイント</label>
                  <input type="number" step="0.1" value={newPlayerPoint} onChange={e => setNewPlayerPoint(Number(e.target.value))} className="w-full p-2.5 border rounded-lg bg-[#faf7f1]"/>
                  <p className="text-[11px] text-[#a99d8c] mt-1">通算対局数は過去大会・今大会の記録から自動計算されるため、入力欄はありません。</p>
                </div>

                <div className="md:col-span-4">
                  <label className={`flex items-center gap-3 p-3 rounded-xl border-2 transition ${isPro(newPlayerName) ? 'bg-[#f3eee4] border-[#e7dfd1] cursor-not-allowed opacity-60' : newPlayerRight ? 'bg-amber-50 border-amber-300 cursor-pointer' : 'bg-[#faf7f1] border-[#e7dfd1] hover:border-[#d4c9b7] cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={isPro(newPlayerName) ? false : newPlayerRight}
                      disabled={isPro(newPlayerName)}
                      onChange={e => setNewPlayerRight(e.target.checked)}
                      className="w-5 h-5 accent-amber-500"
                    />
                    <span className="font-bold text-sm text-[#473f36]">🏆 年間チャンピオン大会 出場権あり</span>
                    {isPro(newPlayerName) && (
                      <span className="text-[11px] font-bold text-[#a99d8c] ml-auto">麻雀プロは出場権の対象外です</span>
                    )}
                  </label>
                </div>

                <button type="submit" className="md:col-span-4 mt-2 bg-[#2d2721] hover:bg-[#473f36] text-white font-bold py-3 rounded-lg transition">登録して保存</button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e7dfd1]">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-2">
                <h2 className="text-xl font-bold">🏫 選手の名前・学校の管理 <span className="ml-1 text-[10px] font-bold text-rose-500 border border-rose-200 rounded px-1.5 py-0.5 align-middle">非公開</span></h2>
                <button
                  onClick={() => setSchoolUnsetOnly(!schoolUnsetOnly)}
                  className={`text-xs font-bold px-3 py-1.5 rounded-lg border-2 transition ${schoolUnsetOnly ? 'bg-[#c8361e] text-white border-[#c8361e]' : 'bg-white text-[#82786b] border-[#d4c9b7] hover:border-[#82786b]'}`}
                >{schoolUnsetOnly ? '未設定のみ表示中' : '未設定のみ表示'}</button>
              </div>
              <p className="text-[11px] text-[#82786b] mb-3 leading-relaxed">
                今季ランキングに載っていない選手も含めて、登録済みの全選手の名前と学校を変更できます（行の「✏️ 編集」または学校名を押します）。過去の大会にだけ参加した選手（「選手登録なし」）は学校のみ設定できます。学校は管理者のみ閲覧でき、一般には表示されません。
                （設定済み {schoolRows.filter(p => playerSchools[p.id]).length}名 ／ 未設定 {schoolRows.filter(p => !playerSchools[p.id]).length}名）
              </p>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse text-sm">
                  <thead>
                    <tr className="bg-[#f3eee4] border-b border-[#e7dfd1] text-[#625a4f]">
                      <th className="p-2 font-bold whitespace-nowrap">選手名</th>
                      <th className="p-2 font-bold">学校</th>
                    </tr>
                  </thead>
                  <tbody>
                    {schoolRows
                      .filter(p => !schoolUnsetOnly || !playerSchools[p.id])
                      .map(p => {
                        const editing = schoolEditId === p.id;
                        return (
                          <tr key={p.id} className="border-b border-[#f3eee4] align-top">
                            <td className="p-2 font-bold align-top">
                              {editing && !p.legacy ? (
                                <input
                                  type="text"
                                  value={nameDraft}
                                  onChange={e => setNameDraft(e.target.value)}
                                  onKeyDown={e => { if (e.key === 'Enter') savePlayerProfile(p, nameDraft, schoolDraft); if (e.key === 'Escape') setSchoolEditId(null); }}
                                  placeholder="選手名"
                                  className="w-40 border p-1.5 rounded text-sm font-bold"
                                />
                              ) : (
                                <span className="whitespace-nowrap">
                                  <PlayerLabel name={p.name} />
                                  {p.legacy
                                    ? <span className="ml-1.5 text-[10px] font-bold text-[#a99d8c] border border-[#e7dfd1] rounded px-1 py-0.5 align-middle">選手登録なし</span>
                                    : <button onClick={() => { setSchoolEditId(p.id); setSchoolDraft(playerSchools[p.id] || ''); setNameDraft(p.name); }} className="ml-1.5 text-[10px] font-bold text-[#a99d8c] hover:text-[#c8361e] border border-[#e7dfd1] hover:border-[#ef937c] rounded px-1.5 py-0.5 align-middle">✏️ 編集</button>}
                                </span>
                              )}
                            </td>
                            <td className="p-2">
                              {editing ? (
                                <div className="max-w-md">
                                  <div className="flex gap-1.5">
                                    <input
                                      type="text"
                                      autoFocus
                                      value={schoolDraft}
                                      onChange={e => setSchoolDraft(e.target.value)}
                                      onKeyDown={e => { if (e.key === 'Enter') savePlayerProfile(p, nameDraft, schoolDraft); if (e.key === 'Escape') setSchoolEditId(null); }}
                                      placeholder="新しい学校は直接入力"
                                      className="min-w-0 flex-1 border p-1.5 rounded text-sm"
                                    />
                                    <button onClick={() => savePlayerProfile(p, nameDraft, schoolDraft)} className="bg-[#c8361e] text-white px-3 py-1 rounded text-xs font-bold whitespace-nowrap">保存</button>
                                    <button onClick={() => setSchoolEditId(null)} className="text-[#a99d8c] text-xs font-bold whitespace-nowrap">取消</button>
                                  </div>
                                  <SchoolChips options={schoolOptions} value={schoolDraft} onPick={setSchoolDraft} />
                                </div>
                              ) : (
                                <button
                                  onClick={() => { setSchoolEditId(p.id); setSchoolDraft(playerSchools[p.id] || ''); setNameDraft(p.name); }}
                                  className={`text-left rounded-md px-2 py-1 text-sm font-bold transition ${playerSchools[p.id] ? 'text-[#473f36] hover:bg-[#f3eee4]' : 'text-[#d4c9b7] hover:bg-[#f3eee4] hover:text-[#82786b]'}`}
                                >{playerSchools[p.id] || '未設定（押して設定）'}</button>
                              )}
                            </td>
                          </tr>
                        );
                      })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-[#e7dfd1]">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-xl font-bold">🔑 選手ログインコード一覧</h2>
                <div className="flex flex-wrap gap-2">
                  <button onClick={handleIssueMissingCodes} disabled={isIssuingCodes} className="text-xs font-bold bg-[#2d2721] hover:bg-[#473f36] disabled:bg-[#d4c9b7] text-white px-3 py-2 rounded-lg transition">
                    {isIssuingCodes ? '処理中...' : '未発行分をまとめて発行'}
                  </button>
                  <button onClick={handleRevokeAllCodes} disabled={isIssuingCodes} className="text-xs font-bold bg-red-100 hover:bg-red-200 disabled:bg-[#e7dfd1] text-red-700 px-3 py-2 rounded-lg transition">
                    全員分を取り消す
                  </button>
                  <button onClick={handlePrintLoginCodes} disabled={printTargets.length === 0} className="text-xs font-bold bg-[#c8361e] hover:bg-[#a62b17] disabled:bg-[#d4c9b7] text-white px-3 py-2 rounded-lg transition">
                    🖨️ 選択した{printTargets.length}名を印刷
                  </button>
                </div>
              </div>
              <p className="text-[11px] text-[#82786b] mb-3 leading-relaxed">
                選手はこのコードだけでログインでき、自分が座っている卓の成績のみ入力できます（選手名の入力は不要です）。印刷する選手はチェックで選べます（コード発行済みの選手のみ対象）。
              </p>
              <div className="flex flex-wrap gap-2 mb-3">
                <button onClick={() => setPrintExcludedIds([])} className="text-[11px] font-bold bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f] px-2.5 py-1 rounded-md transition">全員を選択</button>
                <button onClick={() => setPrintExcludedIds(dbPlayers.map(p => p.id))} className="text-[11px] font-bold bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f] px-2.5 py-1 rounded-md transition">全て解除</button>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse whitespace-nowrap text-sm">
                  <thead>
                    <tr className="bg-[#f3eee4] border-b border-[#e7dfd1] text-[#625a4f]">
                      <th className="p-2 font-bold w-10">印刷</th>
                      <th className="p-2 font-bold">選手名</th>
                      <th className="p-2 font-bold">ログインコード</th>
                      <th className="p-2 font-bold text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...dbPlayers].sort((a, b) => a.name.localeCompare(b.name, 'ja')).map(p => (
                      <tr key={p.id} className="border-b border-[#f3eee4]">
                        <td className="p-2">
                          <input
                            type="checkbox"
                            className="w-4 h-4 accent-[#c8361e]"
                            checked={!!p.loginCode && !printExcludedIds.includes(p.id)}
                            disabled={!p.loginCode}
                            onChange={() => togglePrintTarget(p.id)}
                          />
                        </td>
                        <td className="p-2 font-bold"><PlayerLabel name={p.name} /></td>
                        <td className="p-2 font-mono font-bold tracking-widest">{p.loginCode || <span className="text-[#d4c9b7] font-sans font-normal">未発行</span>}</td>
                        <td className="p-2 text-center">
                          <div className="inline-flex gap-1.5">
                            <button onClick={() => handleReissueCode(p)} className="text-[11px] font-bold bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f] px-2 py-1 rounded-md transition">
                              {p.loginCode ? '再発行' : '発行'}
                            </button>
                            {p.loginCode && (
                              <button onClick={() => handleRevokeCode(p)} className="text-[11px] font-bold bg-red-50 hover:bg-red-100 text-red-600 px-2 py-1 rounded-md transition">取り消し</button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ========== データ ========== */}
        {activeTab === 'data' && (
          <div className="space-y-6 animate-in fade-in duration-300">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#7a591b] via-[#274066] to-[#822213] text-white p-5 md:p-7 shadow-lg">
              <div className="absolute -right-6 -top-8 text-[120px] opacity-10 select-none leading-none" aria-hidden="true">📊</div>
              <h2 className="text-xl md:text-2xl font-black tracking-wide">データ</h2>
              <p className="text-xs md:text-sm text-[#f6ead0] mt-1">{dataScope === 'season' ? `今季の大会（${dataArchives.length}大会）` : `過去の全ての大会（${dataArchives.length}大会）`} ＋ 今大会（送信済みの卓）の記録から集計（黒子は除く）</p>
              <div className="flex gap-1 mt-3">
                {([['season', '今季'], ['all', '通算']] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setDataScope(v)}
                    className={`px-4 py-1.5 rounded-full text-xs font-bold transition ${dataScope === v ? 'bg-white text-[#7a591b] shadow' : 'bg-white/15 text-white hover:bg-white/25 ring-1 ring-white/20'}`}
                  >{label}</button>
                ))}
              </div>
            </div>

            {gameRecs.length === 0 ? (
              <div className="bg-white p-8 rounded-2xl border border-[#e7dfd1] text-center text-[#82786b]">集計できるデータがまだありません。</div>
            ) : (
              <div>
                {renderTopCards()}
              </div>
            )}

          </div>
        )}
        {/* ========== 管理用データ（管理者のみ） ========== */}
        {activeTab === 'admin' && isAdmin && (
          <div className="space-y-10 animate-in fade-in duration-300">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#100d0a] via-[#3b0f08] to-[#1f3253] text-white p-5 md:p-7 shadow-lg">
              <div className="absolute -right-6 -top-8 text-[120px] opacity-10 select-none leading-none" aria-hidden="true">🛠️</div>
              <p className="text-[11px] font-black tracking-[0.25em] text-[#ef937c]">ADMIN ONLY</p>
              <h2 className="text-xl md:text-2xl font-black tracking-wide">管理用データ</h2>
              <p className="text-xs md:text-sm text-[#f7bcab] mt-1">管理者のみに表示されます。{dataScope === 'season' ? `今季の大会（${dataArchives.length}大会）` : `過去の全ての大会（${dataArchives.length}大会）`} ＋ 今大会（送信済みの卓）の記録から集計（黒子は除く）</p>
              <div className="flex gap-1 mt-3">
                {([['season', '今季'], ['all', '通算']] as const).map(([v, label]) => (
                  <button
                    key={v}
                    onClick={() => setDataScope(v)}
                    className={`px-4 py-1.5 rounded-full text-xs font-bold transition ${dataScope === v ? 'bg-white text-[#822213] shadow' : 'bg-white/15 text-white hover:bg-white/25 ring-1 ring-white/20'}`}
                  >{label}</button>
                ))}
              </div>
              <div className="flex gap-1.5 mt-4 overflow-x-auto no-scrollbar pb-0.5">
                {([['adm-final','最終スコア','🏆'],['adm-rank','各種ランキング','📉'],['adm-streak','連続記録','🔥'],['adm-synergy','相性','💞'],['adm-coseat','同卓数','🎲'],['adm-school','学校','🏫'],['adm-player','個人対決','🥊'],['adm-ties','同点','🤝']] as const).map(([id, label, icon]) => (
                  <button
                    key={id}
                    onClick={() => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
                    className="flex-shrink-0 px-3 py-1 rounded-full text-[11px] font-bold bg-white/10 hover:bg-white/20 ring-1 ring-white/15 transition whitespace-nowrap"
                  >{icon} {label}</button>
                ))}
              </div>
            </div>

            {gameRecs.length === 0 ? (
              <div className="bg-white p-8 rounded-2xl border border-[#e7dfd1] text-center text-[#82786b]">集計できるデータがまだありません。</div>
            ) : (
              <>
                <AdminSection id="adm-final" icon="🏆" title="一大会の最終スコアランキング" desc="1つの大会が終わった時点での最終ポイント（ペナルティ反映後）の高い順。年間チャンピオン戦は除きます。今季と通算を並べて表示">
                  <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                    <AdminRankList title="🌸 今季の最終スコア TOP10" desc="今季の大会での、1大会あたりの最終ポイント" rows={finalScoreSeason} />
                    <AdminRankList title="👑 通算の最終スコア TOP10" desc="過去の全大会での、1大会あたりの最終ポイント（ルールが違う大会もそのままの値）" rows={finalScoreAll} />
                  </div>
                </AdminSection>

                <AdminSection id="adm-rank" icon="📉" title={`各種ランキング（${dataScopeLabel}）`} desc="スコア・素点・順位点・順位別率・大会内の位置ごとの合計" right={scopeToggle}>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <AdminRankList title="📉 最低スコア" desc="1半荘あたりの最低スコア" rows={adminLow} />
                  <AdminRankList title="💎 素点ランキング" desc={`素点ポイント（スコア − 30,000点 を1,000点＝1ptとしたもの）の${dataScopeLabel}合計。順位点は含みません`} rows={adminRaw} />
                  <AdminRankList title="🏅 順位点ランキング" desc={`ポイントから素点を引いた分（順位点・オカ・供託など）の${dataScopeLabel}合計。素点は含みません`} rows={adminUma} />
                  <AdminRankList
                    title="📊 順位別率ランキング"
                    desc={`各順位になった割合の高い順（${MIN_GAMES_FOR_RATE}半荘以上の選手が対象）`}
                    rows={adminRates[adminRateRank]}
                    emptyText={`${MIN_GAMES_FOR_RATE}半荘以上の選手がまだいません`}
                    extra={
                      <div className="flex gap-1">
                        {['1位率', '2位率', '3位率', '4位率'].map((label, k) => (
                          <button
                            key={label}
                            onClick={() => setAdminRateRank(k)}
                            className={`flex-1 py-1 rounded-md text-xs font-bold transition ${adminRateRank === k ? 'bg-[#c8361e] text-white' : 'bg-white border border-[#e7dfd1] text-[#82786b] hover:bg-[#f3eee4]'}`}
                          >{label}</button>
                        ))}
                      </div>
                    }
                  />
                  <AdminRankList title={`⏩ ${dataScopeLabel}の5戦目以降ランキング`} desc="各大会の5戦目以降に積み上げたポイントの、全大会の合計（5半荘以上出場した大会が対象。年間チャンピオン戦は除く）" rows={adminFifth} emptyText="5半荘以上出場した大会がありません。" />
                  <AdminRankList title={`1️⃣ ${dataScopeLabel}の1戦目ランキング`} desc="各大会の1戦目のポイントの、全大会の合計（年間チャンピオン戦は除く）" rows={adminFirst} />
                  <AdminRankList title={`🏁 ${dataScopeLabel}の最終戦ランキング`} desc="各大会での、その選手の最後の半荘のポイントの、全大会の合計（年間チャンピオン戦は除く）" rows={adminLast} />
                </div>


                </AdminSection>

                <AdminSection id="adm-streak" icon="🔥" title="連続記録" desc="連勝・連敗・連続連対・連続ラス回避" right={scopeToggle}>
                {/* 連続記録 */}
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <h4 className="text-sm font-black text-[#473f36]">連続記録</h4>
                  <div className="flex gap-1">
                    {([[false, '同じ大会のみ'], [true, '大会をまたぐ']] as const).map(([v, label]) => (
                      <button key={label} onClick={() => setAdminStreakAcross(v)} className={`px-3 py-1 rounded-md text-xs font-bold transition ${adminStreakAcross === v ? 'bg-[#c8361e] text-white' : 'bg-white border border-[#e7dfd1] text-[#82786b] hover:bg-[#f3eee4]'}`}>{label}</button>
                    ))}
                  </div>
                  <span className="text-[11px] text-[#a99d8c]">選手ごとに最長の記録を1件。2回以上続いたもののみ。抜け番で出なかった回戦は飛ばして数えます{adminStreakAcross ? '（第6回・第7回は番号順に並べます）' : ''}。</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <AdminRankList title="🔥 連勝ランキング" desc="1着が連続した回数" rows={adminWinStreak} emptyText="2連勝以上の記録がありません。" />
                  <AdminRankList title="🧊 連敗ランキング" desc="ラス（4着）が連続した回数" rows={adminLoseStreak} emptyText="2連続ラスの記録がありません。" />
                  <AdminRankList title="🥈 連続連対記録" desc="1着か2着が連続した回数" rows={adminRentaiStreak} />
                  <AdminRankList title="🛡️ 連続ラス回避記録" desc="ラス（4着）以外が連続した回数" rows={adminAvoidStreak} />
                </div>


                </AdminSection>

                <AdminSection id="adm-synergy" icon="💞" title={`相性（${dataScopeLabel}）`} desc="同卓したときのポイントの合計から見た相性" right={scopeToggle}>
                {/* 相性 */}
                <div className="flex flex-wrap items-center gap-2 pt-2">
                  <h4 className="text-sm font-black text-[#473f36]">{dataScopeLabel}の相性</h4>
                  <label className="inline-flex items-center gap-1.5 text-xs font-bold text-[#82786b]">
                    同卓
                    <select value={adminSynergyMin} onChange={e => setAdminSynergyMin(Number(e.target.value))} className="p-1 border rounded-md bg-white text-xs font-bold">
                      {[3, 5, 8, 10].map(n => <option key={n} value={n}>{n}半荘以上</option>)}
                    </select>
                    の組が対象
                  </label>
                  <span className="text-[11px] text-[#a99d8c]">「Aさん（Bさんと同卓）」= Bさんと同じ卓だった半荘での、Aさんのポイントの合計。黒子は除きます。</span>
                </div>
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <AdminRankList title="💞 相性いいランキング" desc="同卓したときの自分のポイントの合計が大きい順" rows={adminGoodMatch} emptyText={`同卓${adminSynergyMin}半荘以上の組がありません。`} />
                  <AdminRankList title="💢 相性悪いランキング" desc="同卓したときの自分のポイントの合計が小さい順" rows={adminBadMatch} emptyText={`同卓${adminSynergyMin}半荘以上の組がありません。`} />
                </div>


                </AdminSection>

                <AdminSection id="adm-coseat" icon="🎲" title={`同卓数の分布（${dataScopeLabel}）`} desc="ともに参加した大会での同卓回数が、期待値をどれだけ上回っているか／下回っているか" right={scopeToggle}>
                  <CoSeatPanel games={schoolGames} scope={dataScope} players={playerOptions} />
                </AdminSection>

                <AdminSection id="adm-school" icon="🏫" title="学校別成績・学校対決" desc="学校は管理者でログインしているときだけ読み込まれます" right={scopeToggle}>
                {/* 学校別成績（管理者のみ・非公開） */}
                <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-[#faf7f1]">
                    <div className="flex flex-wrap items-center gap-2">
                      <h4 className="text-sm font-black text-[#2d2721]">🏫 学校別成績（{dataScopeLabel}）<span className="ml-2 text-[10px] font-bold text-rose-500 border border-rose-200 rounded px-1.5 py-0.5 align-middle">非公開</span></h4>
                      <div className="flex gap-1 ml-auto">
                        {([['season', '今季'], ['all', '通算']] as const).map(([v, label]) => (
                          <button key={v} onClick={() => setDataScope(v)} className={`px-3 py-1 rounded-md text-xs font-bold transition ${dataScope === v ? 'bg-[#c8361e] text-white' : 'bg-white border border-[#e7dfd1] text-[#82786b] hover:bg-[#f3eee4]'}`}>{label}</button>
                        ))}
                      </div>
                    </div>
                    <p className="text-[11px] text-[#a99d8c] leading-snug">
                      選手に設定した学校ごとの、全半荘の合計です（黒子は除く）。学校名を押すと、個人成績と同じ形式の詳細（大会別成績・着順分布・半荘ごとの成績・他校との対戦）が開きます。学校は管理者でログインしているときだけ読み込まれ、一般の画面には表示されません。
                      {schoolUnsetCount > 0 ? `学校が未設定の選手 ${schoolUnsetCount}名 は集計に含まれていません。` : ''}
                    </p>
                  </div>
                  {schoolStats.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-[#a99d8c]">学校が設定された選手の記録がありません。選手の編集（今季タブ）か、新規登録で学校を入力してください。</p>
                  ) : (
                    <div className="overflow-x-auto">
                      <table className="w-full text-left text-sm whitespace-nowrap">
                        <thead>
                          <tr className="bg-[#f3eee4] text-[#625a4f] text-xs">
                            <th className="p-2 font-bold">順位</th>
                            <th className="p-2 font-bold">学校</th>
                            <th className="p-2 font-bold text-right">人数</th>
                            <th className="p-2 font-bold text-right">半荘数</th>
                            <th className="p-2 font-bold text-right">合計pt</th>
                            <th className="p-2 font-bold text-right">1半荘平均</th>
                            <th className="p-2 font-bold text-right">平均着順</th>
                            <th className="p-2 font-bold text-right">1着率</th>
                            <th className="p-2 font-bold text-right">連対率</th>
                            <th className="p-2 font-bold text-right">ラス率</th>
                          </tr>
                        </thead>
                        <tbody>
                          {schoolStats.map((sc, i) => (
                            <React.Fragment key={sc.school}>
                              <tr className="border-b border-[#f3eee4] align-top">
                                <td className="p-2 text-xs font-bold text-[#a99d8c] tabular-nums">{i + 1}</td>
                                <td className="p-2 font-bold">
                                  <button onClick={() => setSchoolModal(sc.school)} className="text-left text-[#a62b17] hover:underline">{sc.school}</button>
                                  <span className="ml-1 text-[10px] font-normal text-[#a99d8c]">詳細 ▸</span>
                                </td>
                                <td className="p-2 text-right tabular-nums">{sc.members.size}名</td>
                                <td className="p-2 text-right tabular-nums">{sc.games}</td>
                                <td className={`p-2 text-right font-black tabular-nums ${sc.point > 0 ? 'text-blue-600' : sc.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(r1(sc.point))}</td>
                                <td className="p-2 text-right tabular-nums">{fmtPt(r1(sc.point / sc.games))}</td>
                                <td className="p-2 text-right tabular-nums">{(sc.rankSum / sc.games).toFixed(2)}</td>
                                <td className="p-2 text-right tabular-nums">{((sc.dist[0] / sc.games) * 100).toFixed(1)}%</td>
                                <td className="p-2 text-right tabular-nums">{(((sc.dist[0] + sc.dist[1]) / sc.games) * 100).toFixed(1)}%</td>
                                <td className="p-2 text-right tabular-nums">{((sc.dist[3] / sc.games) * 100).toFixed(1)}%</td>
                              </tr>
                            </React.Fragment>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </section>

                {/* 学校対決（2校の直対成績・成績比較） */}
                <SchoolH2HPanel schools={schoolOptions} games={schoolGames} scope={dataScope} a={h2hA} b={h2hB} setA={setH2hA} setB={setH2hB} />


                </AdminSection>

                <AdminSection id="adm-player" icon="🥊" title="個人対決" desc="2人の選手の直接対決と成績比較" right={scopeToggle}>
                  <PlayerH2HPanel players={playerOptions} games={schoolGames} standings={tourneyStandings} scope={dataScope} a={phA} b={phB} setA={setPhA} setB={setPhB} />
                </AdminSection>

                <AdminSection id="adm-ties" icon="🤝" title="過去の同点" desc="同じ半荘で点数が同じになった組">
                {/* 同点一覧（すべての着順・すべて表示） */}
                <section className="bg-white rounded-xl border border-[#e7dfd1] overflow-hidden">
                  <div className="px-3 py-2.5 border-b border-[#f3eee4] bg-[#faf7f1]">
                    <h4 className="text-sm font-black text-[#2d2721]">🤝 過去の同点（すべての着順）</h4>
                    <p className="text-[11px] text-[#a99d8c] leading-snug">
                      同じ半荘で点数が同じになった組を、すべて表示します（全{adminTies.length}件
                      {adminTies.length > 0 ? `：1着タイ ${adminTies.filter(t => t.rankNo === 1).length} ／ 2着タイ ${adminTies.filter(t => t.rankNo === 2).length} ／ 3着タイ ${adminTies.filter(t => t.rankNo === 3).length} ／ 4着タイ ${adminTies.filter(t => t.rankNo === 4).length}` : ''}）。
                    </p>
                  </div>
                  {adminTies.length === 0 ? (
                    <p className="px-3 py-4 text-center text-xs text-[#a99d8c]">同点の記録はありません。</p>
                  ) : (
                    <ul className="divide-y divide-[#f3eee4] max-h-[28rem] overflow-y-auto">
                      {adminTies.map((t, i) => (
                        <li key={i} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 text-sm">
                          <span className="w-36 text-xs text-[#a99d8c] whitespace-nowrap">{t.where}</span>
                          <span className="w-16 text-xs font-black text-[#c8361e] whitespace-nowrap">{t.rankNo}着タイ</span>
                          <span className="flex-1 min-w-0 font-bold text-[#473f36]">{t.names.join('・')}</span>
                          <span className="font-black tabular-nums text-[#2d2721] whitespace-nowrap">{t.score.toLocaleString()}点</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>

                </AdminSection>
              </>
            )}
          </div>
        )}
        {/* ========== 生涯成績 ========== */}
        {activeTab === 'lifetime' && (
          <div className="space-y-4 animate-in fade-in duration-300">
            <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-[#1c1814] via-[#5e190e] to-amber-600 text-white p-5 md:p-7 shadow-lg">
              <div className="absolute -right-6 -top-8 text-[120px] opacity-10 select-none leading-none" aria-hidden="true">🏅</div>
              <h2 className="text-xl md:text-2xl font-black tracking-wide">生涯成績</h2>
              <p className="text-xs md:text-sm text-amber-100 mt-1 leading-relaxed">
                {lifetimeScope === 'all'
                  ? '今季より前の大会も含めた全記録です。生涯ポイントは、最高位戦ルール以外の大会を最高位戦ルールに換算して合算した「あくまで参考の値」です。着順などの成績は全ての大会が対象です。'
                  : '最高位戦ルールで開催した大会だけを集計しています。ポイントは実際の値です（換算なし）。年間チャンピオン戦のポイントは含みません。'}
              </p>
            </div>
            <div className="flex gap-1 p-1 bg-white rounded-xl border border-[#e7dfd1] shadow-sm">
              {([['all', '全ルール（換算込み）'], ['saikoi', '最高位戦ルールのみ']] as const).map(([k, label]) => (
                <button
                  key={k}
                  onClick={() => setLifetimeScope(k)}
                  className={`flex-1 py-2.5 rounded-lg text-sm font-black transition ${lifetimeScope === k ? 'bg-gradient-to-b from-amber-500 to-amber-600 text-white shadow-md shadow-amber-900/20' : 'text-[#82786b] hover:bg-amber-50'}`}
                >{label}</button>
              ))}
            </div>
            <div className="bg-white rounded-2xl shadow-sm border border-[#e7dfd1] overflow-hidden">
              {(lifetimeScope === 'all' ? lifetimeRows : lifetimeRowsSaikoi).length === 0 ? (
                <p className="p-8 text-center text-sm text-[#a99d8c]">記録がまだありません。</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-sm min-w-[560px]">
                    <thead className="bg-[#1c1814] text-white text-xs">
                      <tr>
                        {([
                          { key: 'rank', label: '順位', align: 'center', extra: 'w-12' },
                          { key: 'name', label: '選手名', align: 'left', extra: '' },
                          { key: 'point', label: '生涯pt', align: 'right', extra: 'whitespace-nowrap' },
                          { key: 'games', label: '半荘', align: 'right', extra: '' },
                          { key: 'avg', label: '平均着順', align: 'right', extra: 'whitespace-nowrap' },
                          { key: 'd0', label: '1着', align: 'right', extra: '' },
                          { key: 'd1', label: '2着', align: 'right', extra: '' },
                          { key: 'd2', label: '3着', align: 'right', extra: '' },
                          { key: 'd3', label: '4着', align: 'right', extra: '' },
                        ] as const).map(col => {
                          const active = lifetimeSort?.key === col.key;
                          return (
                            <th
                              key={col.key}
                              className={`p-0 font-bold ${col.extra}`}
                              aria-sort={active ? (lifetimeSort!.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
                            >
                              <button
                                onClick={() => cycleLifetimeSort(col.key)}
                                className={`w-full p-2.5 whitespace-nowrap font-bold transition hover:bg-white/10 ${col.align === 'center' ? 'text-center' : col.align === 'left' ? 'text-left' : 'text-right'} ${active ? 'bg-white/10' : ''}`}
                                title="クリックで 昇順 → 降順 → 元の順 と切り替わります"
                              >
                                {col.label}
                                {col.key === 'point' && lifetimeScope === 'all' && <span className="text-amber-300">※</span>}
                                <span className={`ml-1 text-[10px] ${active ? 'text-amber-300' : 'text-[#82786b]'}`}>{active ? (lifetimeSort!.dir === 'asc' ? '▲' : '▼') : '⇅'}</span>
                              </button>
                            </th>
                          );
                        })}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-[#f3eee4]">
                      {sortLifetimeRows(lifetimeScope === 'all' ? lifetimeRows : lifetimeRowsSaikoi).map(r => {
                        const pctOf = (n: number) => (r.games > 0 ? `${Math.round((n / r.games) * 100)}%` : '-');
                        return (
                          <tr
                            key={r.key}
                            onClick={() => setDetailModalPlayerId(r.key)}
                            className="cursor-pointer hover:bg-amber-50/60"
                          >
                            <td className="p-2.5 text-center font-black text-[#a99d8c]">{r.rank}</td>
                            <td className="p-2.5 font-bold text-[#2d2721] whitespace-nowrap"><PlayerLabel name={r.name} /></td>
                            <td className={`p-2.5 text-right font-black tabular-nums whitespace-nowrap ${r.point > 0 ? 'text-blue-600' : r.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(r.point)}</td>
                            <td className="p-2.5 text-right tabular-nums text-[#82786b]">{r.games}</td>
                            <td className="p-2.5 text-right tabular-nums text-[#625a4f]">{(r.rankSum / r.games).toFixed(2)}</td>
                            {r.dist.map((n, idx) => (
                              <td key={idx} className="p-2.5 text-right tabular-nums text-[#82786b] whitespace-nowrap">
                                <span className="inline-block w-6 text-right">{n}</span>
                                <span className="inline-block w-12 text-right text-[10px] text-[#a99d8c]">({pctOf(n)})</span>
                              </td>
                            ))}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
            {lifetimeScope === 'all' ? (
              <p className="text-[11px] font-bold text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 leading-relaxed">※ 生涯ptは、最高位戦ルール以外の大会（第1回・第2回など）を最高位戦ルールに換算して合算した、あくまで参考の値です。実際のポイントではありません。年間チャンピオン戦は含みません。</p>
            ) : (
              <p className="text-[11px] font-bold text-[#625a4f] bg-white border border-[#e7dfd1] rounded-lg px-3 py-2 leading-relaxed">最高位戦ルールの大会のみの集計です（換算なし）。半荘数・着順分布には年間チャンピオン戦も含みますが、ポイントには含みません。</p>
            )}
            <p className="text-[11px] text-[#a99d8c] leading-relaxed px-1">選手名をタップすると、その選手の生涯成績（個人ページ）が開きます。選手登録のない前季のみ参加の選手も見られます。</p>
          </div>
        )}

        {/* ========== 今季成績 ========== */}
        {activeTab === 'totalRanking' && (
          <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-[#e7dfd1] animate-in fade-in duration-300">
            <div className="flex items-start justify-between gap-3 mb-1">
              <h2 className="text-xl font-bold">今季成績ランキング</h2>
              {isAdmin && (
                <button onClick={handleFixTotals} className="bg-amber-100 hover:bg-amber-200 text-amber-800 px-3 py-1.5 rounded-lg font-bold text-xs transition whitespace-nowrap mr-2">
                  🔧 通算を検算して修正
                </button>
              )}
              {isAdmin && (
                <button onClick={handleResetAllTotals} className="bg-red-100 hover:bg-red-200 text-red-700 px-3 py-1.5 rounded-lg font-bold text-xs transition whitespace-nowrap">
                  🗑️ 全員の今季成績をリセット
                </button>
              )}
            </div>
            {isAdmin && totalMismatches.length > 0 && (
              <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
                <div className="font-bold mb-1">⚠️ 今季ポイントが大会成績の合計とズレている選手がいます（{totalMismatches.length}名）</div>
                <ul className="mb-2 space-y-0.5">
                  {totalMismatches.map(x => (
                    <li key={x.player.id} className="tabular-nums">{x.player.name}: 表示 {fmtPt(x.actual)} ／ 正しい値 {fmtPt(x.expected)}</li>
                  ))}
                </ul>
                <button onClick={handleFixTotals} className="bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg font-bold text-xs transition">大会成績の合計に合わせて修正する</button>
              </div>
            )}
            <p className="text-[11px] text-[#82786b] mb-4 leading-relaxed">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300 align-middle mr-1"></span>
              年間チャンピオン大会の出場権は各大会優勝を除き今年度に2回以上の参加が必要です
              <br />
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-300 align-middle mr-1"></span>
              🏆 は出場権が個別に付与されている選手 ／ 麻雀プロ（Ⓟ）は半荘数に関わらず出場権の対象外です
            </p>
            <div className="flex flex-wrap items-center gap-2 mb-3">
              <button
                onClick={() => setCsOnly(!csOnly)}
                className={`px-3 py-1.5 rounded-lg text-xs font-bold border-2 transition ${csOnly ? 'bg-emerald-600 text-white border-emerald-600' : 'bg-white text-emerald-700 border-emerald-300 hover:border-emerald-500'}`}
              >
                {csOnly ? '🏆 年間CS対象のみ: 表示中' : '🏆 年間CS対象のみ表示'}
              </button>
              <span className="text-[11px] text-[#82786b]">出場権・対象 {csEligibleIds.length}名</span>
            </div>
            <p className="text-[11px] text-[#a99d8c] mb-3">選手名をクリックすると大会別成績が表示され、「個人成績」から着順分布・対戦相性・半荘ごとの成績なども確認できます。</p>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead>
                  <tr className="bg-[#f3eee4] border-b border-[#e7dfd1] text-[#625a4f] text-sm">
                    <th className="p-2 md:p-3 text-xs md:text-sm font-bold">順位</th>
                    <th className="p-2 md:p-3 text-xs md:text-sm font-bold">選手名</th>
                    <th className="p-2 md:p-3 text-xs md:text-sm font-bold text-right">今季対局数</th>
                    <th className="p-2 md:p-3 text-xs md:text-sm font-bold text-right">今季ポイント</th>
                    <th className="p-2 md:p-3 text-xs md:text-sm font-bold text-center">年間CS</th>
                    {isAdmin && <th className="p-2 md:p-3 text-xs md:text-sm font-bold text-center">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {totalRankingPlayers.map((p, i) => {
                    const pro = isPro(p.name);
                    const granted = hasChampionshipRight(p);
                    const candidate = isChampionshipCandidate(p);
                    const isOpen = openTotalPlayerId === p.id;
                    const colSpan = isAdmin ? 6 : 5;
                    const csPos = csEligibleIds.indexOf(p.id) + 1; // 0 = 対象外
                    if (csOnly && csPos === 0) return null;
                    return (
                      <React.Fragment key={p.id}>
                        <tr className={`border-b border-[#f3eee4] transition ${isOpen ? 'bg-[#fdf1ed]/60' : granted ? 'bg-amber-50/70 hover:bg-amber-100/70' : candidate ? 'bg-emerald-50/60 hover:bg-emerald-100/60' : 'hover:bg-[#faf7f1]'}`}>
                          <td className="p-2 md:p-3 text-xs md:text-sm font-bold text-[#a99d8c]">{i + 1}</td>
                          {editingPlayerId === p.id && isAdmin ? (
                            <>
                              <td className="p-2 align-top">
                                <div className="w-36 md:w-44">
                                  <input type="text" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} className="block box-border w-full min-w-0 border p-1 rounded" />
                                  <input type="text" value={editForm.school} onChange={e => setEditForm({...editForm, school: e.target.value})} placeholder="学校（非公開）" className="block box-border w-full min-w-0 border p-1 rounded mt-1 text-xs" />
                                  <SchoolChips compact options={schoolOptions} value={editForm.school} onPick={sc => setEditForm({...editForm, school: sc})} />
                                </div>
                              </td>
                              <td className="p-2 text-right text-[#a99d8c]">{getTotalGames(p.id)} 半荘<div className="text-[10px] font-normal">（自動計算・編集不可）</div></td>
                              <td className="p-2 text-right"><input type="number" step="0.1" value={editForm.totalPoint} onChange={e => setEditForm({...editForm, totalPoint: Number(e.target.value)})} className="border p-1 w-24 text-right rounded" /></td>
                              <td className="p-2 text-center">
                                <label className={`inline-flex items-center gap-1 text-xs font-bold ${isPro(editForm.name) ? 'text-[#d4c9b7] cursor-not-allowed' : 'text-[#625a4f]'}`}>
                                  <input
                                    type="checkbox"
                                    checked={isPro(editForm.name) ? false : editForm.championshipRight}
                                    disabled={isPro(editForm.name)}
                                    onChange={e => setEditForm({...editForm, championshipRight: e.target.checked})}
                                    className="w-4 h-4 accent-amber-500"
                                  />
                                  出場権
                                </label>
                                {isPro(editForm.name) && <div className="text-[10px] text-[#a99d8c] mt-0.5">プロは対象外</div>}
                              </td>
                              <td className="p-2 text-center">
                                <button onClick={saveEditPlayer} className="bg-[#c8361e] text-white px-3 py-1 rounded text-sm font-bold">保存</button>
                                <button onClick={() => setEditingPlayerId(null)} className="ml-2 text-[#a99d8c] text-sm">取消</button>
                              </td>
                            </>
                          ) : (
                            <>
                              <td className="p-2 md:p-3 text-xs md:text-sm font-bold text-lg cursor-pointer" onClick={() => setOpenTotalPlayerId(isOpen ? null : p.id)}>
                                <span className="inline-flex items-center gap-1.5">
                                  <span className={`text-[10px] text-[#a99d8c] transition ${isOpen ? 'rotate-90' : ''}`}>▶</span>
                                  <PlayerLabel name={p.name} />
                                  <PodiumBadges podium={seasonPodiums.get(p.id)} />
                                </span>
                              </td>
                              <td className="p-2 md:p-3 text-right text-[#82786b] tabular-nums">{getTotalGames(p.id)} 半荘</td>
                              <td className={`p-3 text-right font-black text-lg tabular-nums ${p.totalPoint > 0 ? 'text-blue-600' : p.totalPoint < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>
                                {fmtPt(p.totalPoint)}
                              </td>
                              <td className="p-2 md:p-3 text-center">
                                {pro ? (
                                  <span className="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full bg-[#f3eee4] text-[#a99d8c] border border-[#e7dfd1]">対象外（プロ）</span>
                                ) : granted ? (
                                  <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 text-white shadow-sm">🏆 出場権</span>
                                ) : candidate ? (
                                  <span className="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">○ 対象</span>
                                ) : (
                                  <span className="text-[11px] text-[#a99d8c]">出場権なし</span>
                                )}
                              </td>
                              {isAdmin && (
                                <td className="p-2 md:p-3 text-center">
                                  <button onClick={() => startEditPlayer(p)} className="bg-[#e7dfd1] hover:bg-[#d4c9b7] text-[#473f36] px-3 py-1 rounded text-sm font-bold transition">編集</button>
                                </td>
                              )}
                            </>
                          )}
                        </tr>

                        {isOpen && (
                          <tr>
                            <td colSpan={colSpan} className="p-0 bg-[#faf7f1]/60 border-b border-[#e7dfd1]">
                              <ArchiveHistoryMini
                                history={getPlayerArchiveHistory(p.id)}
                                onOpenDetail={() => setDetailModalPlayerId(p.id)}
                              />
                            </td>
                          </tr>
                        )}

                        {csBorderPlayerId === p.id && (
                          <tr aria-hidden="true">
                            <td colSpan={colSpan} className="p-0">
                              <div className="h-0 border-t-[3px] border-dashed border-[#c8361e]" />
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {detailModalPlayerId && (() => {
          const dbp = dbPlayers.find(pl => pl.id === detailModalPlayerId);
          // 選手登録のない選手（前季のみ参加など）も、生涯成績だけの個人ページを開ける（個人コードは作らない）
          const legacyRow = dbp ? null : (lifetimeRows.find(r => r.key === detailModalPlayerId) || lifetimeRowsSaikoi.find(r => r.key === detailModalPlayerId) || null);
          const dp: Player | undefined = dbp || (legacyRow ? { id: legacyRow.key, name: legacyRow.name, totalPoint: 0, totalGames: 0 } : undefined);
          if (!dp) return null;
          return (
            <PlayerDetailModal
              player={dp}
              totalGames={getTotalGames(dp.id)}
              history={getPlayerArchiveHistory(dp.id)}
              rankDist={getRankDistribution(dp.id)}
              headToHead={getHeadToHead(dp.id)}
              penalties={getPlayerPenalties(dp.id)}
              maxScore={getMaxScore(dp.id)}
              hanchanGroups={getPlayerHanchanGroups(dp.id)}
              lifetimeOnly={!dbp}
              seasonRank={(() => { const ix = totalRankingPlayers.findIndex(x => x.id === dp.id); return ix >= 0 ? ix + 1 : null; })()}
              seasonRankTotal={totalRankingPlayers.length}
              lifetimeData={{
                all: { summary: getLifetimeSummary(dp.id, 'all'), history: getLifetimeHistory(dp.id, 'all'), groups: getPlayerHanchanGroups(dp.id, true, false) },
                saikoi: { summary: getLifetimeSummary(dp.id, 'saikoi'), history: getLifetimeHistory(dp.id, 'saikoi'), groups: getPlayerHanchanGroups(dp.id, true, true) },
              }}
              upcoming={!isAdmin && dp.id === loggedInPlayerId ? getUpcomingMatches(dp.id) : undefined}
              onClose={() => setDetailModalPlayerId(null)}
            />
          );
        })()}

        {isAdmin && schoolDataOn && schoolModal && (() => {
          const sums: Record<SchoolScope, Map<string, SchoolSummary>> = { season: buildSchoolSummaries(schoolGames, 'season'), all: buildSchoolSummaries(schoolGames, 'all') };
          const rankOf = (scope: SchoolScope) => {
            const mine = sums[scope].get(schoolModal);
            if (!mine) return null;
            const me = schoolR1(mine.point);
            const pts = Array.from(sums[scope].values()).map(x => schoolR1(x.point));
            return { rank: pts.filter(v => v > me).length + 1, total: pts.length };
          };
          return (
            <SchoolDetailModal
              key={schoolModal}
              school={schoolModal}
              summaries={{ season: sums.season.get(schoolModal) || null, all: sums.all.get(schoolModal) || null }}
              ranks={{ season: rankOf('season'), all: rankOf('all') }}
              vs={{ season: buildSchoolVs(schoolGames, 'season', schoolModal), all: buildSchoolVs(schoolGames, 'all', schoolModal) }}
              initialScope={dataScope}
              onCompare={other => { setH2hA(schoolModal); setH2hB(other); setSchoolModal(null); }}
              onClose={() => setSchoolModal(null)}
            />
          );
        })()}

        {/* ========== 過去大会 ========== */}
        {activeTab === 'archives' && (
          <div className="space-y-6 animate-in fade-in duration-300">
            {isAdmin && (
              <div className="bg-white rounded-2xl shadow-sm border border-[#e7dfd1] overflow-hidden">
                <button
                  onClick={() => setShowArchiveImport(!showArchiveImport)}
                  className="w-full flex items-center justify-between gap-3 p-4 md:p-5 text-left"
                >
                  <span className="font-black text-[#2d2721]">📥 過去大会をインポート（MMCのテキストを貼り付け）</span>
                  <span className="text-[#a99d8c] text-xs font-bold">{showArchiveImport ? '閉じる ▲' : '開く ▼'}</span>
                </button>

                {showArchiveImport && (
                  <div className="px-4 md:px-5 pb-5 pt-1 border-t border-[#f3eee4] space-y-4">
                    <p className="text-xs text-[#82786b] leading-relaxed">
                      MMC（mahjong-manage.com）の大会ページで「トータル成績」の一覧から「半荘ごと」のログまでをまとめて選択・コピーし、下のテキスト欄にそのまま貼り付けてください。
                      最終成績（ポイント・半荘数・順位）と、各半荘の結果を自動で読み取ります。対局時間・対局番号（◯戦目）・ルール名は読み取らないため、下の「ルール名」欄で指定してください。
                    </p>
                    <div className="grid md:grid-cols-3 gap-3">
                      <div>
                        <label className="block text-xs font-bold text-[#625a4f] mb-1">第何回</label>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-[#82786b]">第</span>
                          <input
                            type="number"
                            value={archiveRoundNumber}
                            onChange={e => { archiveRoundTouched.current = true; setArchiveRoundNumber(e.target.value); }}
                            placeholder="4"
                            className="w-20 p-2.5 border rounded-lg bg-[#faf7f1] text-sm text-center"
                          />
                          <span className="text-sm font-bold text-[#82786b]">回</span>
                        </div>
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-[#625a4f] mb-1">大会名の追記（任意）</label>
                        <input value={archiveNameSuffix} onChange={e => setArchiveNameSuffix(e.target.value)} placeholder="例: 年間チャンピオン戦" className="w-full p-2.5 border rounded-lg bg-[#faf7f1] text-sm" />
                      </div>
                      <div>
                        <label className="block text-xs font-bold text-[#625a4f] mb-1">備考（任意）</label>
                        <input value={archiveNotes} onChange={e => setArchiveNotes(e.target.value)} placeholder="任意のメモ" className="w-full p-2.5 border rounded-lg bg-[#faf7f1] text-sm" />
                      </div>
                      <div className="md:col-span-3">
                        {archiveNameSuffix.includes(SEPARATE_EVENT_KEYWORD) && (
                          <p className="mb-2 text-[11px] font-bold text-amber-700">「{archiveNameSuffix.trim()}」は別大会として登録され、生涯ポイントには加算されません（着順分布・半荘数には含まれます）。</p>
                        )}
                        <label className="block text-xs font-bold text-[#625a4f] mb-1">ルール名（「{RULE_NAME}」以外は、生涯ポイントには最高位戦ルールに換算した参考値として反映されます）</label>
                        <input
                          list="archive-rule-names"
                          value={archiveRuleName}
                          onChange={e => { archiveRuleTouched.current = true; setArchiveRuleName(e.target.value); }}
                          placeholder={RULE_NAME}
                          className="w-full p-2.5 border rounded-lg bg-[#faf7f1] text-sm"
                        />
                        <datalist id="archive-rule-names">
                          <option value={RULE_NAME} />
                          <option value="日本プロ麻雀協会ルール" />
                          <option value="WRCルール" />
                        </datalist>
                        {isPreviousSeasonArchive({ name: `第${archiveRoundNumber.trim()}回` }) && (
                          <p className="mt-2 text-[11px] font-bold text-rose-600 leading-relaxed">
                            第{archiveRoundNumber.trim()}回は前季（第{CURRENT_SEASON_FIRST_TOURNAMENT_NO}回より前）の大会として登録されます。今季のポイント・半荘数には加算されず、選手の新規登録もされません。生涯成績にだけ反映されます。
                          </p>
                        )}
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs font-bold text-[#625a4f] mb-1">MMCのページテキスト（トータル成績〜半荘ごとのログ）</label>
                      <textarea
                        value={archiveRawText}
                        onChange={e => { setArchiveRawText(e.target.value); setArchivePreview(null); }}
                        rows={10}
                        placeholder={"1 あおい +200.1 10戦 1.90\n2 尾崎太郎 +171.9 10戦 2.10\n...\n5戦目 07/12 14:28\n最高位戦ルール\n供託 0.0\n1\n立直\n+33.0(33,000)\n2\n鯨井商事\n+11.0(31,000)\n..."}
                        className="w-full p-3 border rounded-lg bg-[#faf7f1] text-xs font-mono"
                      />
                    </div>

                    <div className="flex flex-wrap gap-2">
                      <button onClick={handlePreviewArchiveText} disabled={!archiveRawText.trim()} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-[#2d2721] hover:bg-[#473f36] text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">
                        🔍 解析してプレビュー
                      </button>
                      {archivePreview && (
                        <button onClick={handleCommitArchiveImport} disabled={isImportingArchive} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">
                          {isImportingArchive ? '登録中...' : '✅ この内容で登録する'}
                        </button>
                      )}
                    </div>

                    {archivePreview && (
                      <div className="bg-[#faf7f1] border border-[#e7dfd1] rounded-xl p-4 space-y-3">
                        <p className="text-xs font-bold text-[#625a4f]">
                          解析結果: 最終成績 {archivePreview.leaderboard.length}名 ／ 半荘ログ {archivePreview.hanchans.length}半荘
                          {archivePreview.newNames.length > 0 && <span className="text-amber-600"> ／ 新規登録される選手 {archivePreview.newNames.length}名</span>}
                        </p>
                        {archivePreview.newNames.length > 0 && (
                          <p className="text-[11px] text-[#82786b]">新規: {archivePreview.newNames.join('、')}</p>
                        )}
                        <div className="overflow-x-auto">
                          <table className="w-full text-xs">
                            <thead>
                              <tr className="text-[#a99d8c] border-b border-[#e7dfd1]">
                                <th className="text-left py-1 pr-2">順位</th>
                                <th className="text-left py-1 pr-2">名前</th>
                                <th className="text-right py-1 pr-2">半荘数</th>
                                <th className="text-right py-1">ポイント</th>
                              </tr>
                            </thead>
                            <tbody>
                              {archivePreview.leaderboard.map(row => (
                                <tr key={row.rank} className="border-b border-[#f3eee4]">
                                  <td className="py-1 pr-2 text-[#a99d8c]">{row.rank}</td>
                                  <td className="py-1 pr-2 font-bold text-[#473f36]">{row.name}</td>
                                  <td className="py-1 pr-2 text-right text-[#82786b]">{row.gameCount}</td>
                                  <td className={`py-1 text-right font-bold tabular-nums ${row.point > 0 ? 'text-blue-600' : row.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(row.point)}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}

                    {archivePreview && (
                      <div className="bg-red-50 border border-red-200 rounded-xl p-4 space-y-3">
                        <div className="flex items-center justify-between">
                          <p className="text-xs font-bold text-red-700">🚫 ペナルティ（任意・記録用）</p>
                          <button onClick={addPenaltyRow} className="text-xs font-bold bg-red-600 hover:bg-red-700 text-white px-3 py-1.5 rounded-lg transition">＋ 追加</button>
                        </div>
                        <p className="text-[11px] text-red-500 leading-relaxed">
                          最終成績（トータル成績）の数値には既にペナルティが反映されているため、ここでの入力はポイント計算に影響しません。「誰が・いくつ・なぜ」を記録として残すための入力です。
                        </p>
                        {penaltyRows.length === 0 ? (
                          <p className="text-xs text-red-400">ペナルティはありません。</p>
                        ) : (
                          <div className="space-y-2">
                            {penaltyRows.map((row, idx) => (
                              <div key={idx} className="grid grid-cols-[1fr_auto_1fr_auto] gap-2 items-center">
                                <select
                                  value={row.name}
                                  onChange={e => updatePenaltyRow(idx, { name: e.target.value })}
                                  className="p-2 border rounded-lg bg-white text-sm"
                                >
                                  <option value="">選手を選択...</option>
                                  {archivePreview.leaderboard.map(r => (
                                    <option key={r.name} value={r.name}>{r.name}</option>
                                  ))}
                                </select>
                                <input
                                  type="number"
                                  step="0.1"
                                  value={row.point}
                                  onChange={e => updatePenaltyRow(idx, { point: e.target.value })}
                                  className="w-20 p-2 border rounded-lg bg-white text-sm text-right"
                                />
                                <input
                                  value={row.reason}
                                  onChange={e => updatePenaltyRow(idx, { reason: e.target.value })}
                                  placeholder="理由（例: チョンボ、遅刻）"
                                  className="p-2 border rounded-lg bg-white text-sm"
                                />
                                <button onClick={() => removePenaltyRow(idx)} className="text-red-500 hover:text-red-700 font-bold text-sm px-2">削除</button>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-[#e7dfd1]">
              <h2 className="text-xl font-bold mb-4">過去大会一覧</h2>
              {archives.length === 0 ? (
                <p className="text-sm text-[#a99d8c]">登録されている過去大会はまだありません。</p>
              ) : (
                <div className="space-y-3">
                  {[...archives].sort((x, y) => tournamentSortKey(x.name) - tournamentSortKey(y.name)).map(a => {
                    const isOpen = openArchiveId === a.id;
                    return (
                      <div key={a.id} id={`archive-${a.id}`} className="border border-[#e7dfd1] rounded-xl overflow-hidden scroll-mt-4">
                        <button
                          onClick={() => {
                            const next = isOpen ? null : a.id;
                            setOpenArchiveId(next);
                            setOpenArchivePlayerId(null);
                            setOpenArchiveHanchanIdx(null);
                          }}
                          className="w-full flex items-center justify-between gap-3 px-4 py-3 bg-[#faf7f1] hover:bg-[#f3eee4] transition text-left"
                        >
                          <span className="font-black text-[#2d2721]">{a.name}</span>
                          <span className="text-xs text-[#a99d8c] flex items-center gap-3">
                            {a.standings.length}名 ／ {a.hanchans.length}半荘
                            <span
                              role="button"
                              onClick={(e) => { e.stopPropagation(); handleExportArchivePdf(a); }}
                              className="text-[#c8361e] hover:text-[#822213] font-bold cursor-pointer"
                            >📄 PDF</span>
                            {isAdmin && (
                              <button
                                onClick={(e) => { e.stopPropagation(); handleDeleteArchive(a); }}
                                className="text-red-500 hover:text-red-700 font-bold"
                              >削除</button>
                            )}
                          </span>
                        </button>
                        {isOpen && (
                          <div className="p-4">
                            <div className="mb-5 max-w-xl mx-auto"><Podium entries={archiveTop3(a)} /></div>
                            {a.notes && <p className="text-xs text-[#82786b] mb-3">📝 {a.notes}</p>}
                            <p className="text-[11px] text-[#a99d8c] mb-2">選手名をクリックすると半荘ごとの成績、さらにその半荘をクリックすると同卓者が見られます。</p>
                            <div className="overflow-x-auto">
                              <table className="w-full text-xs">
                                <thead>
                                  <tr className="text-[#a99d8c] border-b border-[#e7dfd1]">
                                    <th className="text-left py-1 pr-2">順位</th>
                                    <th className="text-left py-1 pr-2">名前</th>
                                    <th className="text-right py-1 pr-2">半荘数</th>
                                    <th className="text-right py-1">ポイント</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {[...a.standings].sort((x, y) => x.rank - y.rank).map(s => {
                                    const isPlayerOpen = openArchivePlayerId === s.playerId;
                                    const rows = isPlayerOpen ? getPlayerRowsInArchive(a, s.playerId) : [];
                                    return (
                                      <React.Fragment key={s.playerId}>
                                        <tr
                                          className={`border-b border-[#f3eee4] cursor-pointer transition ${isPlayerOpen ? 'bg-[#fdf1ed]/60' : 'hover:bg-[#faf7f1]'}`}
                                          onClick={() => {
                                            const next = isPlayerOpen ? null : s.playerId;
                                            setOpenArchivePlayerId(next);
                                            setOpenArchiveHanchanIdx(null);
                                          }}
                                        >
                                          <td className="py-1 pr-2 text-[#a99d8c]">{s.rank}</td>
                                          <td className="py-1 pr-2 font-bold text-[#473f36]"><PlayerLabel name={nameOf(s.playerId, s.name)} /></td>
                                          <td className="py-1 pr-2 text-right text-[#82786b]">{s.gameCount}</td>
                                          <td className={`py-1 text-right font-bold tabular-nums ${s.totalPoint > 0 ? 'text-blue-600' : s.totalPoint < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(s.totalPoint)}</td>
                                        </tr>
                                        {isPlayerOpen && (
                                          <tr>
                                            <td colSpan={4} className="p-0 bg-[#faf7f1]/60 border-b border-[#e7dfd1]">
                                              <div className="px-3 py-2 space-y-1">
                                                {rows.length === 0 ? (
                                                  <p className="text-[#a99d8c] py-1">半荘ごとの記録がありません。</p>
                                                ) : rows.map((r, i) => {
                                                  const hKey = i;
                                                  const isHOpen = openArchiveHanchanIdx === hKey;
                                                  return (
                                                    <div key={i} className="bg-white border border-[#e7dfd1] rounded-lg overflow-hidden">
                                                      <div
                                                        className={`flex items-center justify-between gap-2 px-3 py-1.5 cursor-pointer transition ${isHOpen ? 'bg-[#fdf1ed]/60' : 'hover:bg-[#faf7f1]'}`}
                                                        onClick={() => setOpenArchiveHanchanIdx(isHOpen ? null : hKey)}
                                                      >
                                                        <span className="text-[#a99d8c] w-8">#{i + 1}</span>
                                                        <span className="text-[#625a4f] font-bold w-10">{r.rank}位</span>
                                                        <span className="text-[#82786b] tabular-nums flex-1 text-right">{(r.score * 100).toLocaleString()}点</span>
                                                        <span className={`font-black tabular-nums w-16 text-right ${r.point > 0 ? 'text-blue-600' : r.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(r.point)}</span>
                                                      </div>
                                                      {isHOpen && (
                                                        <div className="px-3 pb-2 pt-1 bg-white border-t border-[#f3eee4]">
                                                          {r.table.map(tp => (
                                                            <div key={tp.playerId} className={`flex items-center justify-between px-2 py-1 text-[11px] rounded ${tp.playerId === s.playerId ? 'bg-[#fdf1ed]' : ''}`}>
                                                              <span className="text-[#625a4f] font-bold truncate flex-1">
                                                                <span className="text-[#a99d8c] font-mono mr-1">{tp.rank}位</span>
                                                                <PlayerLabel name={tp.name} />
                                                              </span>
                                                              <span className="text-[#a99d8c] mr-3 tabular-nums">{(tp.score * 100).toLocaleString()}点</span>
                                                              <span className={`font-bold tabular-nums ${tp.point > 0 ? 'text-blue-600' : tp.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(tp.point)}</span>
                                                            </div>
                                                          ))}
                                                        </div>
                                                      )}
                                                    </div>
                                                  );
                                                })}
                                              </div>
                                            </td>
                                          </tr>
                                        )}
                                      </React.Fragment>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            {/* 半荘ごとの成績（大会の全半荘を、古い順に一覧） */}
                            {a.hanchans.length > 0 && (
                              <div className="mt-4">
                                <button
                                  onClick={() => setOpenHanchanListIds(prev => ({ ...prev, [a.id]: !prev[a.id] }))}
                                  className="w-full flex items-center justify-between gap-2 px-3 py-2.5 bg-[#fdf1ed] hover:bg-[#fbddd3] border border-[#fbddd3] rounded-lg transition text-left"
                                >
                                  <span className="text-sm font-black text-[#5e190e]">🀄 半荘ごとの成績（{a.hanchans.length}半荘）</span>
                                  <span className="text-xs font-bold text-[#d9452b]">{openHanchanListIds[a.id] ? '閉じる ▲' : '開く ▼'}</span>
                                </button>
                                {openHanchanListIds[a.id] && (
                                  <div className="mt-2 space-y-3">
                                    {isAdmin && a.hanchans.every(h => h.round === undefined) && (
                                      <div className="flex flex-wrap items-center gap-2 text-[11px] bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                                        <span className="text-amber-800 flex-1 min-w-[12rem]">「今大会をアーカイブ」で保存した大会の半荘が逆順に表示される場合は、ここで並びと卓を直せます。（取り込み済みの大会では実行しないでください）</span>
                                        <button onClick={() => handleRepairArchiveOrder(a)} className="bg-amber-500 hover:bg-amber-600 text-white font-bold px-3 py-1.5 rounded-lg">🔧 半荘の並びと卓を直す</button>
                                      </div>
                                    )}
                                    {groupArchiveHanchans(a.hanchans).map(g => (
                                      <div key={g.no} className="border border-[#fbddd3] rounded-xl overflow-hidden bg-white">
                                        {!g.items.some(h => typeof h.table === 'number') && (
                                          <div className="flex items-center gap-2 px-3 py-1.5 bg-[#fdf1ed] border-b border-[#fbddd3]">
                                            <span className="text-sm font-black text-[#5e190e]">{g.no}半荘目</span>
                                          </div>
                                        )}
                                        <div className="p-2 grid gap-2 md:grid-cols-2">
                                          {g.items.map((h, k) => (
                                            <div key={k} className="border border-[#e7dfd1] rounded-lg overflow-hidden bg-white">
                                              {(typeof h.table === 'number' || h.deposit > 0) && (
                                                <div className="flex items-center justify-between px-3 py-1 bg-[#faf7f1] border-b border-[#f3eee4]">
                                                  <span className="text-xs font-black text-[#5e190e]">{typeof h.table === 'number' ? `${g.no}半荘目-${h.table}卓` : ''}</span>
                                                  {h.deposit > 0 && <span className="text-[10px] text-[#a99d8c]">供託 {h.deposit.toFixed(1)}</span>}
                                                </div>
                                              )}
                                              <div className="px-2 py-1">
                                                {[...h.results].sort((x, y) => x.rank - y.rank).map((r, m) => (
                                                  <div key={m} className={`flex items-center justify-between gap-2 px-1 py-1 text-[11px] ${r.excluded ? 'opacity-60' : ''}`}>
                                                    <span className="text-[#a99d8c] font-mono w-5">{r.rank}位</span>
                                                    <span className="flex-1 min-w-0 truncate font-bold text-[#473f36]">
                                                      <PlayerLabel name={nameOf(r.playerId, r.name)} />
                                                      {r.excluded && <span className="ml-1 text-[9px] font-bold bg-[#e7dfd1] text-[#82786b] px-1 rounded">順位外</span>}
                                                    </span>
                                                    <span className="text-[#a99d8c] tabular-nums">{(r.score * 100).toLocaleString()}点</span>
                                                    <span className={`font-black tabular-nums w-14 text-right ${r.point > 0 ? 'text-blue-600' : r.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{fmtPt(r.point)}</span>
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          ))}
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            )}
                            {(a.penalties.length > 0 || isAdmin) && (
                              <div className="mt-4">
                                <p className="text-xs font-bold text-red-600 mb-2">🚫 ペナルティ</p>
                                {a.penalties.length === 0 && <p className="text-[11px] text-[#a99d8c] mb-1">ペナルティの記録はありません。</p>}
                                <div className="space-y-1">
                                  {a.penalties.map((p, i) => (
                                    <div key={i} className="flex items-center justify-between gap-2 bg-red-50 border border-red-200 rounded-lg px-3 py-1.5 text-xs">
                                      <PlayerLabel name={nameOf(p.playerId, p.name)} className="font-bold text-red-700" />
                                      <span className="text-red-500 flex-1 truncate">{p.reason}</span>
                                      <span className="font-black text-red-600 tabular-nums">{fmtPt(p.point)}</span>
                                      {isAdmin && p.applied && (
                                        <button onClick={() => handleRemoveArchivePenalty(a, i)} className="text-[10px] font-bold text-red-500 hover:text-red-700 underline">外す</button>
                                      )}
                                    </div>
                                  ))}
                                </div>
                                {isAdmin && (() => {
                                  const d = penaltyDrafts[a.id] || { playerId: '', point: '', reason: '' };
                                  const setD = (patch: Partial<typeof d>) => setPenaltyDrafts(prev => ({ ...prev, [a.id]: { ...d, ...patch } }));
                                  return (
                                    <div className="mt-2 flex flex-wrap items-center gap-2 bg-[#faf7f1] border border-[#e7dfd1] rounded-lg p-2">
                                      <select value={d.playerId} onChange={e => setD({ playerId: e.target.value })} className="border border-[#d4c9b7] rounded-md px-2 py-1 text-xs bg-white">
                                        <option value="">選手を選ぶ</option>
                                        {[...a.standings].sort((x, y) => x.rank - y.rank).map(st => (
                                          <option key={st.playerId} value={st.playerId}>{st.rank}位 {nameOf(st.playerId, st.name)}</option>
                                        ))}
                                      </select>
                                      <input type="number" step="0.1" min="0" value={d.point} onChange={e => setD({ point: e.target.value })} placeholder="減点 例:20" className="w-24 border border-[#d4c9b7] rounded-md px-2 py-1 text-xs bg-white" />
                                      <input type="text" value={d.reason} onChange={e => setD({ reason: e.target.value })} placeholder="理由 例:チョンボ・遅刻" className="flex-1 min-w-[8rem] border border-[#d4c9b7] rounded-md px-2 py-1 text-xs bg-white" />
                                      <button onClick={() => handleAddArchivePenalty(a)} className="bg-red-600 hover:bg-red-700 text-white font-bold px-3 py-1.5 rounded-md text-xs">＋ ペナルティを付ける</button>
                                    </div>
                                  );
                                })()}
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-[#e7dfd1]">
              <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
                <h2 className="text-xl font-bold">🏆 大会別 表彰台</h2>
                <div className="flex gap-1">
                  {([['season', '今季'], ['all', 'すべて']] as const).map(([v, label]) => (
                    <button
                      key={v}
                      onClick={() => setPodiumScope(v)}
                      className={`px-3 py-1 rounded-md text-xs font-bold transition ${podiumScope === v ? 'bg-[#c8361e] text-white' : 'bg-white border border-[#e7dfd1] text-[#82786b] hover:bg-[#f3eee4]'}`}
                    >{label}</button>
                  ))}
                </div>
              </div>
              {podiumArchives.length === 0 ? (
                <p className="text-sm text-[#a99d8c]">表示できる大会がありません。</p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {podiumArchives.map(a => (
                    <div key={a.id} className="rounded-xl border border-[#e7dfd1] bg-[#faf7f1]/70 p-3 sm:p-4">
                      <div className="flex items-center justify-between gap-2 mb-3">
                        <span className="font-black text-[#2d2721]" style={{ fontFamily: "'Shippori Mincho B1', serif" }}>{a.name}</span>
                        <button
                          onClick={() => {
                            setOpenArchiveId(a.id);
                            setOpenArchivePlayerId(null);
                            setOpenArchiveHanchanIdx(null);
                            setTimeout(() => document.getElementById(`archive-${a.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
                          }}
                          className="text-[11px] font-bold text-[#c8361e] hover:text-[#822213] whitespace-nowrap"
                        >成績を見る ▸</button>
                      </div>
                      <Podium entries={archiveTop3(a)} />
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ========== 今大会成績 ========== */}
        {activeTab === 'currentRanking' && (
          <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-[#e7dfd1] animate-in fade-in duration-300">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b pb-3 mb-5">
              <h2 className="text-2xl font-black text-teal-800">🏆 今大会の成績</h2>
              <div className="flex flex-wrap gap-2 items-center">
                <button
                  onClick={() => setShowKuroko(!showKuroko)}
                  className={`px-3 py-2 rounded-lg text-xs font-bold border-2 transition ${showKuroko ? 'bg-[#2d2721] text-white border-[#2d2721]' : 'bg-white text-[#82786b] border-[#d4c9b7] hover:border-[#82786b]'}`}
                  title="今大会成績での黒子の表示を切り替えます">
                  {showKuroko ? '🕶️ 黒子: 表示中' : '🕶️ 黒子: 非表示'}
                </button>
                <button onClick={handleExportPdf} className="px-3 py-2 rounded-lg text-xs font-bold bg-rose-600 hover:bg-rose-700 text-white transition shadow-sm" title="全試合結果・ランキング・通算ランキングをPDFにします">
                  📄 PDFで出力
                </button>
                <button onClick={handleExportRankingImage} className="px-3 py-2 rounded-lg text-xs font-bold bg-teal-600 hover:bg-teal-700 text-white transition shadow-sm" title="ランキングのみを画像(PNG)で保存します">
                  🖼️ ランキング画像を保存
                </button>
              </div>
            </div>

            {tournamentPhase === 'entry' || hideSeating ? (
              <p className="text-[#82786b]">{generalDrawingScreen ? '卓組抽選中です。大会が始まるまでお待ちください。' : '大会が始まっていません。'}</p>
            ) : (
              <>
                <p className="text-xs text-[#82786b] mb-3">選手名をクリックすると、今大会の全成績（これからの対局予定を含む）が表示されます。</p>
                <div className="space-y-2">
                  {displayCurrentRanking.map((p, i) => {
                    const isOpen = openPlayerId === p.id;
                    const schedule = isOpen ? getPlayerSchedule(p.id) : [];
                    return (
                      <div key={p.id} className={`rounded-xl overflow-hidden border ${isOpen ? 'border-teal-300 shadow-sm' : 'border-transparent'}`}>
                        <button
                          onClick={() => { setOpenPlayerId(isOpen ? null : p.id); setOpenGameKey(null); }}
                          className={`w-full flex items-center gap-2.5 sm:gap-3 px-3 sm:px-4 py-3.5 sm:py-4 text-left transition ${isOpen ? 'bg-emerald-50' : 'bg-gradient-to-r from-emerald-50/70 to-white hover:from-emerald-100/70'}`}
                        >
                          <span className={`w-9 h-9 flex-shrink-0 rounded-full flex items-center justify-center font-black text-sm ${i === 0 ? 'bg-yellow-400 text-white' : i === 1 ? 'bg-[#a99d8c] text-white' : i === 2 ? 'bg-amber-700 text-white' : 'bg-[#e7dfd1] text-[#625a4f]'}`}>
                            {i + 1}
                          </span>
                          <span className="flex-1 min-w-0">
                            <span className="block font-black text-base sm:text-lg text-[#2d2721] truncate">
                              <PlayerLabel name={p.name} />
                              {isKuroko(p.name) && <span className="ml-2 text-[10px] font-bold bg-[#2d2721] text-white px-2 py-0.5 rounded-full align-middle">黒子</span>}
                              {p.chonbo > 0 && <span className="ml-2 text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full align-middle">🚫 {p.chonbo}</span>}
                            </span>
                            <span className="block sm:hidden text-[11px] text-[#a99d8c] mt-0.5">{p.games}戦 ／ 平均着順 {p.games > 0 ? p.avgRank.toFixed(2) : '-'}</span>
                          </span>
                          <span className={`font-black text-xl sm:text-2xl tabular-nums ${p.point > 0 ? 'text-emerald-700' : p.point < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>
                            {fmtPt(p.point)}
                          </span>
                          <span className="hidden sm:block w-16 text-right text-sm text-[#a99d8c] font-medium">{p.games}戦</span>
                          <span className="hidden sm:block w-14 text-right text-sm text-[#82786b] tabular-nums">
                            {p.games > 0 ? p.avgRank.toFixed(2) : '-'}
                          </span>
                        </button>

                        {isOpen && (
                          <div className="bg-white border-t border-teal-100">
                            {schedule.length === 0 && (
                              <p className="px-6 py-4 text-sm text-[#a99d8c]">対局の予定がありません。</p>
                            )}
                            {schedule.map(g => {
                              const gKey = `${p.id}-${g.key}`;
                              const isGOpen = openGameKey === gKey;
                              const time = startTimeOf(g.roundNo);

                              // --- 未定 (最後の2回戦) ---
                              if (g.status === 'pending') {
                                return (
                                  <div key={gKey} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-3 border-b border-[#f3eee4] last:border-b-0 bg-[#faf7f1]/60">
                                    <span className="font-mono text-xs sm:text-sm text-[#a99d8c] w-28 sm:w-40 flex-shrink-0">
                                      {g.roundNo}回戦{time && <span className="ml-2 text-[10px]">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm font-bold text-[#a99d8c]">卓組未定</span>
                                    <span className="text-[10px] text-[#a99d8c] text-right">
                                      {g.roundNo === roundsCount ? '最終戦は直前の回戦終了後に決定' : '前の回戦が全て終了した時点で決定'}
                                    </span>
                                  </div>
                                );
                              }

                              // --- 抜け番 ---
                              if (g.status === 'sitout') {
                                return (
                                  <div key={gKey} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-3 border-b border-[#f3eee4] last:border-b-0">
                                    <span className="font-mono text-xs sm:text-sm text-[#a99d8c] w-28 sm:w-40 flex-shrink-0">
                                      {g.roundNo}回戦{time && <span className="ml-2 text-[10px]">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm text-[#a99d8c]">抜け番</span>
                                    <span className="w-12 text-right text-[#d4c9b7] font-bold">(-)</span>
                                  </div>
                                );
                              }

                              // --- 対局予定 ---
                              if (g.status === 'ready') {
                                return (
                                  <div key={gKey} className="flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-3 border-b border-[#f3eee4] last:border-b-0 bg-[#fdf1ed]/40">
                                    <span className="font-mono text-xs sm:text-sm text-[#82786b] w-28 sm:w-40 flex-shrink-0">
                                      {g.roundNo}回戦 / {tableTag(g.tableNo)}{time && <span className="ml-2 text-[10px] text-[#a99d8c]">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm font-bold text-[#d9452b]">
                                      対局予定（{g.wind}家）
                                      {g.roundNo === roundsCount && g.tableNo === 1 && <span className="ml-2 text-[10px] font-black text-amber-600">👑 決勝卓</span>}
                                    </span>
                                    <span className="w-12 text-right text-[#d4c9b7] font-bold">(-)</span>
                                  </div>
                                );
                              }

                              // --- 結果あり ---
                              const ranked = getTableRankList(g.table as Table);
                              const deposit = getTableDeposit(g.table as Table);
                              return (
                                <div key={gKey} className="border-b border-[#f3eee4] last:border-b-0">
                                  <button
                                    onClick={() => setOpenGameKey(isGOpen ? null : gKey)}
                                    className={`w-full flex items-center gap-2 sm:gap-3 px-3 sm:px-6 py-3.5 sm:py-3 text-left transition ${isGOpen ? 'bg-emerald-50/60' : 'hover:bg-[#faf7f1]'}`}
                                  >
                                    <span className="font-mono text-xs sm:text-sm text-[#625a4f] w-28 sm:w-40 flex-shrink-0">
                                      {g.roundNo}回戦 / {tableTag(g.tableNo)}{time && <span className="ml-2 text-[10px] text-[#a99d8c]">{time}〜</span>}
                                    </span>
                                    <span className={`flex-1 text-center font-black text-lg tabular-nums ${(g.point || 0) > 0 ? 'text-emerald-700' : (g.point || 0) < 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>
                                      {fmtPt(g.point || 0)}
                                    </span>
                                    {(g.chonbo || 0) > 0 && <span className="text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">🚫 {g.chonbo}</span>}
                                    <span className="w-12 text-right text-[#a99d8c] font-bold">({g.rank})</span>
                                  </button>

                                  {isGOpen && (
                                    <div className="px-3 sm:px-6 pb-4 pt-1 bg-white">
                                      <div className="border border-[#e7dfd1] rounded-lg overflow-hidden">
                                        {ranked.map((rp, rIdx2) => (
                                          <div key={rp.playerId} className={`flex items-center justify-between gap-2 px-3 sm:px-4 py-2.5 text-sm ${rp.playerId === p.id ? 'bg-emerald-50' : 'bg-white'} ${rIdx2 < 3 ? 'border-b border-[#f3eee4]' : ''}`}>
                                            <span className="text-[#473f36] font-bold truncate">
                                              <span className="text-[#a99d8c] font-mono mr-2">{rIdx2 + 1}</span>
                                              <PlayerLabel name={rp.name} />
                                              <span className="text-[#a99d8c] font-normal text-xs ml-2">| {rp.wind}家 / {rp.score * 100}点</span>
                                              {(rp.chonbo || 0) > 0 && <span className="ml-2 text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">🚫{rp.chonbo}</span>}
                                            </span>
                                            <span className={`font-mono font-bold tabular-nums ${rp.point > 0 ? 'text-[#2d2721]' : rp.point < 0 ? 'text-red-600' : 'text-[#82786b]'}`}>
                                              {rp.point > 0 ? rp.point.toFixed(1) : `−${Math.abs(rp.point).toFixed(1)}`}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex justify-between items-start mt-2 text-[11px] text-[#a99d8c]">
                                        <span>{RULE_NAME}</span>
                                        <div className="text-right">
                                          <div>供託・不足分：{(deposit * 100).toLocaleString()}点</div>
                                          <div>{g.roundNo}回戦 {tableTag(g.tableNo)}</div>
                                        </div>
                                      </div>
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                  {displayCurrentRanking.length === 0 && (
                    <p className="text-[#a99d8c] text-sm py-6 text-center">表示できるデータがありません。</p>
                  )}
                </div>

                <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-[11px] text-[#a99d8c] mt-4 pr-2">
                  <span>右端の数値は平均着順</span>
                  <span>Ⓟ = 麻雀プロ</span>
                  <span>チョンボ: 1回 −{CHONBO_PENALTY.toFixed(1)}pt</span>
                </div>
              </>
            )}
          </div>
        )}

        {/* ========== 大会進行 ========== */}
        {activeTab === 'tournament' && (
          <div className="space-y-6 animate-in fade-in duration-300">

            {/* 次の大会の参加選手の事前登録（管理者のみ。今の大会が進行中・終了後でも登録できる） */}
            {isAdmin && (
              <div className="bg-white rounded-2xl shadow-sm border border-[#e7dfd1] overflow-hidden">
                <button onClick={() => setNextEntryOpen(v => !v)} className="w-full flex items-center justify-between gap-3 px-4 md:px-5 py-3.5 text-left hover:bg-[#faf7f1] transition">
                  <span className="min-w-0">
                    <span className="block text-sm md:text-base font-black text-[#2d2721]">📝 次の大会の参加選手を事前登録</span>
                    <span className="block text-[11px] text-[#82786b] mt-0.5">
                      {nextEntry && nextEntry.playerIds.length > 0
                        ? `第${nextEntry.no || '?'}回: ${nextEntry.playerIds.length}名を登録済み${Object.keys(nextEntry.limits || {}).length > 0 ? `（出場限定 ${Object.keys(nextEntry.limits || {}).length}名）` : ''}`
                        : '今の大会の進行中・終了後でも、先に参加選手を登録しておけます'}
                    </span>
                  </span>
                  <span className="text-xs font-bold text-[#a99d8c] whitespace-nowrap">{nextEntryOpen ? '閉じる ▲' : '開く ▼'}</span>
                </button>
                {nextEntryOpen && (
                  <div className="px-4 md:px-5 pb-5 pt-1 space-y-3 border-t border-[#f3eee4]">
                    <div className="flex flex-wrap items-center gap-3 pt-3">
                      <label className="inline-flex items-center gap-1.5 text-sm font-bold text-[#625a4f]">
                        第
                        <input
                          type="number" min="1" inputMode="numeric"
                          value={nextEntry?.no ?? suggestNextTournamentNo()}
                          onChange={e => setNextEntryNo(e.target.value)}
                          className="w-20 p-2 border rounded-lg text-center font-black text-lg"
                        />
                        回の参加選手
                      </label>
                      <label className="inline-flex items-center gap-1.5 text-sm font-bold text-[#625a4f]">
                        全
                        <input
                          type="number" min="1" max="20" inputMode="numeric"
                          value={nextRoundsN()}
                          onChange={e => setNextRoundsCount(Number(e.target.value))}
                          className="w-16 p-2 border rounded-lg text-center font-black text-lg"
                        />
                        回戦
                      </label>
                      <span className="text-sm font-black text-[#a62b17]">{nextEntry ? nextEntry.playerIds.length : 0}名</span>
                      <span className={`text-[11px] font-bold ${nextSaveState === 'error' ? 'text-red-600' : 'text-[#a99d8c]'}`}>
                        {nextSaveState === 'saving' ? '保存中…' : nextSaveState === 'saved' ? '✓ 保存しました' : nextSaveState === 'error' ? '保存に失敗しました（もう一度操作してください）' : ''}
                      </span>
                    </div>
                    <div className="flex flex-wrap items-center gap-2">
                      <input
                        value={nextEntryFilter}
                        onChange={e => setNextEntryFilter(e.target.value)}
                        placeholder="名前で絞り込み"
                        className="flex-1 min-w-[10rem] p-2 border rounded-lg text-sm"
                      />
                      <button onClick={() => setNextEntryAll(true)} className="text-xs font-bold px-3 py-2 rounded-lg bg-white border border-[#e7dfd1] hover:bg-[#faf7f1] text-[#625a4f]">全員を選択</button>
                      <button onClick={() => setNextEntryAll(false)} className="text-xs font-bold px-3 py-2 rounded-lg bg-white border border-[#e7dfd1] hover:bg-[#faf7f1] text-[#625a4f]">すべて解除</button>
                      <button
                        onClick={copyCurrentEntryToNext}
                        disabled={entryPlayerIds.length === 0}
                        className="text-xs font-bold px-3 py-2 rounded-lg bg-white border border-[#e7dfd1] hover:bg-[#faf7f1] text-[#625a4f] disabled:opacity-40"
                        title="いまの大会のエントリーを、次の大会の候補としてコピーします"
                      >今の大会の参加者をコピー</button>
                    </div>
                    <div className="flex flex-wrap gap-2 max-h-72 overflow-y-auto p-1">
                      {dbPlayers
                        .filter(pl => !isKuroko(pl.name) && (nextEntryFilter.trim() === '' || pl.name.toLowerCase().includes(nextEntryFilter.trim().toLowerCase())))
                        .map(pl => {
                          const on = !!nextEntry && nextEntry.playerIds.includes(pl.id);
                          return (
                            <button
                              key={pl.id}
                              onClick={() => toggleNextEntry(pl.id)}
                              className={`px-3.5 py-2 rounded-full font-bold text-sm transition border-2 ${on ? 'bg-[#c8361e] text-white border-[#c8361e]' : 'bg-white text-[#625a4f] border-[#e7dfd1] hover:border-[#ef937c]'}`}
                            ><PlayerLabel name={pl.name} /> {on && '✓'}</button>
                          );
                        })}
                    </div>
                    {/* 出場試合数の限定（任意）: 事前登録した選手の中から、出る回戦を選ぶ */}
                    <div className="p-3 bg-amber-50/60 rounded-xl border border-amber-200">
                      <h4 className="text-sm font-black text-[#473f36] mb-1">出場試合数を限定する選手（任意）</h4>
                      <p className="text-[11px] text-[#82786b] mb-2 leading-relaxed">基本は全試合に出場します。出る回戦を連続していなくても自由に選べます（例: 1〜3回戦と7〜9回戦、2・5・8回戦）。</p>
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={nextLimitPlayerId}
                          onChange={e => { setNextLimitPlayerId(e.target.value); setNextLimitRounds(nextEntry?.limits?.[e.target.value]?.rounds || []); }}
                          className="p-2 border rounded-lg bg-white text-sm min-w-[12rem]"
                        >
                          <option value="">登録済みの選手から選ぶ...</option>
                          {dbPlayers.filter(pl => nextEntry?.playerIds.includes(pl.id)).map(pl => (
                            <option key={pl.id} value={pl.id}>{proMarkedName(pl.name)}{nextEntry?.limits?.[pl.id] ? '（設定済み）' : ''}</option>
                          ))}
                        </select>
                        <button
                          onClick={addNextLimit}
                          disabled={!nextLimitPlayerId || nextLimitRounds.length === 0}
                          className="px-4 py-2 rounded-lg font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition"
                        >{nextLimitPlayerId && nextEntry?.limits?.[nextLimitPlayerId] ? '更新' : '追加'}</button>
                      </div>
                      <div className="mt-2">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-bold text-[#625a4f]">出場する回戦（タップで選択）</span>
                          <button onClick={() => setNextLimitRounds(Array.from({ length: nextRoundsN() }, (_, i) => i + 1))} className="text-[11px] font-bold text-amber-700 underline">全選択</button>
                          <button onClick={() => setNextLimitRounds([])} className="text-[11px] font-bold text-[#82786b] underline">クリア</button>
                          {nextLimitRounds.length > 0 && <span className="text-[11px] font-bold text-amber-700">→ {formatLimitRounds(nextLimitRounds.filter(n => n <= nextRoundsN()))}</span>}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {Array.from({ length: nextRoundsN() }, (_, i) => i + 1).map(n => {
                            const on = nextLimitRounds.includes(n);
                            return (
                              <button
                                key={n}
                                onClick={() => toggleNextLimitRound(n)}
                                className={`min-w-[2.75rem] px-2 py-2 rounded-lg text-sm font-black border-2 transition ${on ? 'bg-amber-500 border-amber-500 text-white shadow' : 'bg-white border-[#e7dfd1] text-[#82786b] hover:border-amber-300'}`}
                              >{n}</button>
                            );
                          })}
                        </div>
                      </div>
                      {Object.keys(nextEntry?.limits || {}).length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {(Object.entries(nextEntry?.limits ?? {}) as [string, PlayerLimit][]).map(([id, l]) => (
                            <span key={id} className="inline-flex items-center gap-2 bg-white border border-amber-300 rounded-full pl-3 pr-1.5 py-1 text-sm font-bold text-[#473f36]">
                              <PlayerLabel name={dbPlayers.find(pl => pl.id === id)?.name || '不明'} />
                              <button
                                onClick={() => { setNextLimitPlayerId(id); setNextLimitRounds(l.rounds); }}
                                className="text-xs text-amber-700 underline decoration-dotted hover:text-amber-900"
                                title="出場回戦を編集"
                              >{formatLimitRounds(l.rounds)}</button>
                              <button onClick={() => removeNextLimit(id)} className="w-5 h-5 rounded-full bg-[#e7dfd1] hover:bg-red-200 text-[#82786b] hover:text-red-700 text-xs leading-none transition" title="限定を解除">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="flex flex-wrap items-center gap-3">
                      {nextEntry && nextEntry.playerIds.length > 0 && (
                        <button onClick={clearNextEntryAll} className="text-xs font-bold px-3 py-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-700 border border-red-200">事前登録を消す</button>
                      )}
                      <p className="text-[11px] text-[#a99d8c] leading-relaxed">
                        登録した選手は、新しい大会のエントリー画面で「事前登録を読み込む」を押すと、そのまま参加者になります。この大会を開始すると、事前登録は自動で消えます。
                      </p>
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* 卓組抽選中（管理者のみ）: 画面の一番上に「大会開始」ボタン */}
            {isAdmin && tournamentPhase === 'drawing' && (
              <div className="bg-gradient-to-r from-amber-50 to-orange-50 border-2 border-amber-300 rounded-2xl p-4 md:p-5 flex flex-col md:flex-row md:items-center gap-3 md:gap-5 shadow-sm">
                <div className="flex-1">
                  <h2 className="text-lg font-black text-amber-900">🎲 卓組抽選中（運営確認中）</h2>
                  <p className="text-xs text-amber-800 leading-relaxed mt-1">
                    卓組は生成済みです。内容を確認・編集（🛠️ 選手の追加・差し替え）してから「大会開始」を押してください。<br />
                    開始するまで得点入力はできません。{drawingAnnounced ? '一般の画面には「卓組抽選中」と表示されています。' : '一般の画面は、「抽選」ボタンを押すまで、これまでどおりの表示です。'}
                  </p>
                  {drawReport && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] font-bold">
                      <span className={`px-2 py-1 rounded-full border ${drawReport.windPenalty === 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-orange-50 text-orange-700 border-orange-200'}`}>
                        {drawReport.windPenalty === 0 ? '✅ 席順: 全員の東南西北の回数が均等' : `⚠️ 席順: 偏りあり（${drawReport.windPenalty}）。人数の都合で均等にできませんでした`}
                      </span>
                      <span className={`px-2 py-1 rounded-full border ${drawReport.repeatPairs === 0 ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-sky-50 text-sky-700 border-sky-200'}`}>
                        {drawReport.repeatPairs === 0 ? '✅ 同卓: 通常回戦で同じ相手との同卓はありません' : `同卓: 2回以上同卓する組が${drawReport.repeatPairs}組（最大${drawReport.maxPair}回）`}
                      </span>
                      <span className="px-2 py-1 rounded-full border bg-white text-[#82786b] border-[#e7dfd1]">{drawReport.rounds}回戦・{drawReport.attempts}パターンから最良を採用</span>
                    </div>
                  )}
                </div>
                <div className="flex flex-col gap-2 w-full md:w-auto">
                  {!drawingAnnounced ? (
                    <button
                      onClick={() => handleToggleDrawingAnnounce(true)}
                      className="w-full md:w-auto bg-[#c8361e] hover:bg-[#a62b17] text-white font-black py-3 px-8 rounded-xl text-base transition"
                    >🎰 抽選（一般画面に「抽選中」を表示）</button>
                  ) : (
                    <button
                      onClick={() => handleToggleDrawingAnnounce(false)}
                      className="w-full md:w-auto bg-white hover:bg-[#faf7f1] text-[#625a4f] font-bold py-2 px-6 rounded-xl text-xs border border-[#e7dfd1] transition"
                    >「抽選中」の表示を取り消す</button>
                  )}
                  <button
                    onClick={handleStartTournament}
                    className="w-full md:w-auto bg-amber-500 hover:bg-amber-600 text-white font-black py-4 px-10 rounded-xl shadow-lg text-lg transition"
                  >
                    🚀 大会開始
                  </button>
                </div>
              </div>
            )}

            {/* 大会規定（大会開催中は、全ての回戦の下に表示する） */}
            {!(tournamentPhase === 'playing' || (tournamentPhase === 'drawing' && isAdmin)) && <RulesDocCard />}

            {/* 卓組抽選中（管理者以外）: 抽選中アニメーション */}
            {generalDrawingScreen && (
              <div className="bg-white p-8 md:p-12 rounded-2xl shadow-sm border border-[#e7dfd1] text-center">
                <div className="flex justify-center gap-3 mb-6" aria-hidden="true">
                  {['🀄', '🀅', '🀀', '🀁'].map((tile, i) => (
                    <span
                      key={i}
                      className="text-5xl animate-bounce"
                      style={{ animationDelay: `${i * 150}ms` }}
                    >{tile}</span>
                  ))}
                </div>
                <h2 className="text-2xl md:text-3xl font-black text-[#5e190e] animate-pulse">卓組抽選中...</h2>
                <p className="text-sm text-[#82786b] mt-3 leading-relaxed">
                  ただいま対局者及び席順がなるべく公平になるようランダムで生成しています。<br />しばらくお待ちください。
                </p>
              </div>
            )}

            {((tournamentPhase === 'entry' && !generalDrawingScreen) || generalEntryView) && (
              <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-[#e7dfd1]">
                <h2 className="text-2xl font-black text-[#5e190e] mb-6">今大会のエントリー</h2>
                
                {!isAdmin ? (
                   <p className="text-[#625a4f] font-bold">管理者が大会を開始するのをお待ちください...</p>
                ) : (
                  <>
                    {nextEntry && nextEntry.playerIds.length > 0 && tournamentPhase === 'entry' && (
                      <div className="mb-4 p-3 rounded-xl border border-[#f7bcab] bg-[#fdf1ed]/60 flex flex-wrap items-center gap-3">
                        <span className="text-sm font-bold text-[#5e190e]">📝 事前登録した第{nextEntry.no || '?'}回の参加選手（{nextEntry.playerIds.length}名{Object.keys(nextEntry.limits || {}).length > 0 ? `・出場限定 ${Object.keys(nextEntry.limits || {}).length}名` : ''}）があります</span>
                        <button onClick={loadNextEntryIntoCurrent} className="text-xs font-black px-4 py-2 rounded-lg bg-[#c8361e] hover:bg-[#a62b17] text-white">📥 事前登録を読み込む</button>
                      </div>
                    )}
                    <div className="mb-8 p-4 bg-[#faf7f1] rounded-xl border border-[#e7dfd1]">
                      <h3 className="font-bold text-[#473f36] mb-3">参加者を選択 (クリックで追加)</h3>
                      <div className="flex flex-wrap gap-2">
                        {dbPlayers.map(p => {
                          const isEntry = entryPlayerIds.includes(p.id);
                          return (
                            <button key={p.id} onClick={() => toggleEntry(p.id)}
                              className={`px-4 py-2.5 rounded-full font-bold text-sm transition border-2 ${isEntry ? 'bg-[#c8361e] text-white border-[#c8361e]' : 'bg-white text-[#625a4f] hover:border-[#e5664c]'}`}>
                              <PlayerLabel name={p.name} /> {isEntry && '✓'}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    {/* 出場試合数の限定 */}
                    <div className="mb-8 p-4 bg-amber-50/60 rounded-xl border border-amber-200">
                      <h3 className="font-bold text-[#473f36] mb-1">出場試合数を限定する選手（任意）</h3>
                      <p className="text-[11px] text-[#82786b] mb-3 leading-relaxed">
                        基本は全選手が全試合に出場します。一部の選手のみ、出場する回戦を自由に選んで限定できます（例: 1〜3回戦のみ、7〜9回戦のみ、1〜3回戦＋7〜9回戦、2・5・8回戦のみ）。<br />
                        限定された選手は、順位順で決まる回戦では黒子と同様に上位8位（2卓）に入らず、弾かれた場合は9位の位置に入ります。今大会成績のランキングには表示されず、通算成績には通常通り加算されます。
                      </p>
                      <div className="flex flex-wrap gap-2 items-center">
                        <select value={limitPlayerId} onChange={e => { setLimitPlayerId(e.target.value); setLimitRounds(playerLimits[e.target.value]?.rounds || []); }} className="p-2.5 border rounded-lg bg-white text-sm min-w-[12rem]">
                          <option value="">エントリー済みの選手から選ぶ...</option>
                          {dbPlayers.filter(p => entryPlayerIds.includes(p.id)).map(p => (
                            <option key={p.id} value={p.id}>{proMarkedName(p.name)}{playerLimits[p.id] ? '（設定済み）' : ''}</option>
                          ))}
                        </select>
                        <button onClick={handleAddLimit} disabled={!limitPlayerId || limitRounds.length === 0} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">{limitPlayerId && playerLimits[limitPlayerId] ? '更新' : '追加'}</button>
                      </div>
                      <div className="mt-3">
                        <div className="flex items-center gap-2 mb-1.5">
                          <span className="text-xs font-bold text-[#625a4f]">出場する回戦（タップで選択）</span>
                          <button onClick={() => setLimitRounds(Array.from({ length: roundsCount }, (_, i) => i + 1))} className="text-[11px] font-bold text-amber-700 underline">全選択</button>
                          <button onClick={() => setLimitRounds([])} className="text-[11px] font-bold text-[#82786b] underline">クリア</button>
                          {limitRounds.length > 0 && <span className="text-[11px] font-bold text-amber-700">→ {formatLimitRounds(limitRounds.filter(n => n <= roundsCount))}</span>}
                        </div>
                        <div className="flex flex-wrap gap-1.5">
                          {Array.from({ length: roundsCount }, (_, i) => i + 1).map(n => {
                            const on = limitRounds.includes(n);
                            return (
                              <button
                                key={n}
                                onClick={() => toggleLimitRound(n)}
                                className={`min-w-[2.75rem] px-2 py-2 rounded-lg text-sm font-black border-2 transition ${on ? 'bg-amber-500 border-amber-500 text-white shadow' : 'bg-white border-[#e7dfd1] text-[#82786b] hover:border-amber-300'}`}
                              >{n}</button>
                            );
                          })}
                        </div>
                        <p className="text-[10px] text-[#a99d8c] mt-1.5">※ {roundsCount - 1}・{roundsCount}回戦は順位順で決まる回戦です。</p>
                      </div>
                      {limitEntries.length > 0 && (
                        <div className="flex flex-wrap gap-2 mt-3">
                          {limitEntries.map(([id, l]) => (
                            <span key={id} className="inline-flex items-center gap-2 bg-white border border-amber-300 rounded-full pl-3 pr-1.5 py-1 text-sm font-bold text-[#473f36]">
                              <PlayerLabel name={dbPlayers.find(p => p.id === id)?.name || '不明'} />
                              <button onClick={() => handleEditLimit(id)} className="text-xs text-amber-700 underline decoration-dotted hover:text-amber-900" title="出場回戦を編集">{limitLabel(l)}</button>
                              <button onClick={() => handleRemoveLimit(id)} className="w-5 h-5 rounded-full bg-[#e7dfd1] hover:bg-red-200 text-[#82786b] hover:text-red-700 text-xs leading-none transition" title="限定を解除">×</button>
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    <div className="flex flex-col md:flex-row gap-6 items-end border-t pt-6">
                      <div className="w-full md:w-auto">
                        <label className="block text-sm font-bold text-[#625a4f] mb-2">参加予定</label>
                        <div className="text-2xl font-black text-[#c8361e]">{entryPlayerIds.length} <span className="text-base text-[#82786b] font-normal">名</span></div>
                      </div>
                      <div className="w-full md:w-auto">
                        <label className="block text-sm font-bold text-[#625a4f] mb-2">大会の回</label>
                        {isAdmin ? (
                          <div className="flex items-center gap-1.5">
                            <span className="text-sm font-bold text-[#82786b]">第</span>
                            <input type="number" min="1" inputMode="numeric" value={tournamentNo} onChange={e => handleChangeTournamentNo(e.target.value)} className="w-20 p-3 border rounded-lg text-lg font-bold text-center"/>
                            <span className="text-sm font-bold text-[#82786b]">回</span>
                          </div>
                        ) : (
                          <div className="text-2xl font-black text-[#c8361e]">第{tournamentNo || '?'}回</div>
                        )}
                      </div>
                      <div className="w-full md:w-auto">
                        <label className="block text-sm font-bold text-[#625a4f] mb-2">回戦数</label>
                        <input type="number" min="1" value={roundsCount} onChange={e => setRoundsCount(Number(e.target.value))} className="w-24 p-3 border rounded-lg text-lg font-bold text-center"/>
                      </div>
                      <div className="flex-1"></div>
                      <button
                        onClick={() => handleToggleDrawingAnnounce(!drawingAnnounced)}
                        className={`w-full md:w-auto font-bold py-4 px-6 rounded-xl border-2 transition ${drawingAnnounced ? 'bg-amber-50 border-amber-300 text-amber-800' : 'bg-white border-[#f7bcab] text-[#a62b17] hover:bg-[#fdf1ed]'}`}
                      >{drawingAnnounced ? '🎰 「抽選中」を表示中（押すと取り消し）' : '🎰 抽選（一般画面に「抽選中」を表示）'}</button>
                      <button onClick={handleGenerateTables} className="w-full md:w-auto bg-[#c8361e] hover:bg-[#a62b17] text-white font-bold py-4 px-8 rounded-xl shadow-lg transition">
                        自動卓組を生成
                      </button>
                    </div>
                    <p className="text-xs text-[#82786b] mt-4 leading-relaxed">
                      ※ 「抽選」ボタンは、一般の画面に「卓組抽選中」を表示するためのボタンです（押すまで、一般の画面はこれまでどおりの表示）。卓組の生成そのものは「自動卓組を生成」で行われます。<br />
                      ※ 生成後は、管理者が卓組を確認して「大会開始」を押すまで得点入力はできません。<br />
                      ※ {roundsCount - 1}回戦・{roundsCount}回戦は、それ以前の全ての対局が終了した瞬間に順位順（1234／5678…）で自動決定されます。<br />
                      ※ この大会は「第{tournamentNo || '?'}回」として扱われ、過去大会として登録するときもこの回が入力されます。{ROUND_START_TIMES_BY_TOURNAMENT[Number(tournamentNo)] ? '（この回の開始目安時刻が設定済みです）' : ''}<br />
                      　 最後から2つ目は卓内上位から東南西北、最終戦は卓内下位から東南西北に着席。上位2卓（8位まで）に「黒子」は入らず、その下を繰り上げます。
                    </p>
                  </>
                )}
              </div>
            )}

            {(tournamentPhase === 'playing' || (tournamentPhase === 'drawing' && isAdmin)) && (
              <div className="space-y-6">
                {(isAdmin || !loggedInPlayerId) && (
                <div className="bg-[#fdf1ed] border border-[#fbddd3] p-4 rounded-xl">
                  <div className="flex justify-between items-center gap-4">
                    <div>
                      <h2 className="text-lg font-black text-[#5e190e]">第{tournamentNo || '?'}回 {tournamentPhase === 'drawing' ? '卓組の確認（大会開始前）' : '大会進行中'}</h2>
                      <p className="text-sm text-[#a62b17] font-medium">参加者: {entryPlayerIds.length}名 / 全{roundsCount}回戦</p>
                      {limitEntries.length > 0 && (
                        <p className="text-xs text-amber-700 font-bold mt-1">
                          出場限定: {limitEntries.map(([id, l]) => `${proMarkedName(dbPlayers.find(p => p.id === id)?.name || '不明')}（${limitLabel(l)}）`).join('、')}
                        </p>
                      )}
                    </div>
                    {isAdmin && (
                      <div className="flex gap-2">
                        <button onClick={() => setShowAdminTools(!showAdminTools)} className={`px-4 py-2 rounded-lg font-bold text-sm transition ${showAdminTools ? 'bg-[#2d2721] text-white' : 'bg-white text-[#625a4f] border border-[#d4c9b7] hover:bg-[#f3eee4]'}`}>
                          🛠️ 選手の追加・差し替え
                        </button>
                        {currentTournamentArchived && (
                          <button onClick={handleClearArchivedCurrent} className="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg font-bold text-sm transition">
                            🧹 登録済みの今大会データをクリア
                          </button>
                        )}
                        {tournamentPhase === 'playing' && !currentTournamentArchived && (
                          <button onClick={handleArchiveCurrentTournament} disabled={isArchivingCurrent} className="bg-emerald-600 hover:bg-emerald-700 disabled:bg-[#d4c9b7] text-white px-4 py-2 rounded-lg font-bold text-sm transition">
                            {isArchivingCurrent ? '保存中...' : '📦 過去大会にアーカイブ'}
                          </button>
                        )}
                        <button onClick={handleResetTournament} className="bg-red-100 hover:bg-red-200 text-red-700 px-4 py-2 rounded-lg font-bold text-sm transition">
                          大会をリセット
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 開始時間（1回戦は目安） */}
                  <p className="mt-3 text-[10px] text-[#e5664c] leading-relaxed">
                    開始時間（1回戦は目安、2回戦以降は前の回戦の全卓送信＋休憩{timerState.breakMinutes}分）:&nbsp;
                    {scheduleTimes.slice(0, roundsCount).map((t, i) => (
                      <span key={i} className={`mr-2 whitespace-nowrap ${timerState.startAts[i + 1] ? 'text-[#a62b17] font-bold' : ''}`}>{i + 1}回戦 {startTimeOf(i + 1) || t}</span>
                    ))}
                  </p>
                </div>
                )}

                {/* ---- 成績表（リーグ戦と同じ形式）。Xへは、この表を画面に出してスクリーンショットで手動投稿する（管理者用） ---- */}
                {isAdmin && (
                  <div className="bg-white p-4 md:p-5 rounded-2xl shadow-sm border border-[#e7dfd1] space-y-4">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <h3 className="text-base font-black text-[#2d2721]">📋 成績表（Xポスト用）</h3>
                      <div className="flex flex-wrap items-center gap-2">
                        <button
                          onClick={() => copyText(xPostText(effectiveSheetRound() || 1), '投稿文')}
                          className="text-xs font-bold px-3 py-1.5 rounded-lg bg-sky-600 hover:bg-sky-700 text-white"
                        >📝 {effectiveSheetRound() > 0 ? `${effectiveSheetRound()}回戦の` : ''}投稿文をコピー</button>
                        <button onClick={handleSaveSheetImages} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-white border border-[#e7dfd1] hover:bg-[#faf7f1] text-[#625a4f]">🖼️ 画像を保存</button>
                        <button onClick={() => setShowSheet(v => !v)} className="text-xs font-bold px-3 py-1.5 rounded-lg bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f]">{showSheet ? '閉じる ▲' : '開く ▼'}</button>
                      </div>
                    </div>
                    <p className="text-[11px] text-[#82786b] leading-relaxed">
                      各回戦が終わったら、下の成績表を画面に出してスクリーンショットを撮り、「投稿文をコピー」の文面と一緒にXへ投稿してください（2回戦以降は、前の投稿への返信でつなぐと見やすくなります）。
                      成績表は選んだ回戦までの最新4半荘分で、18人以内なら1枚、それより多いと上位・下位の2枚です。
                    </p>
                    {copyMsg && <p className="text-xs font-bold text-emerald-700">{copyMsg}</p>}

                    {/* 何回戦終了時点の成績表にするか（投稿し忘れた回戦に巻き戻せる） */}
                    {latestStartedRound() > 0 && (
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[11px] font-bold text-[#82786b] mr-1">表示する回戦:</span>
                        {Array.from({ length: latestStartedRound() }, (_, i) => i + 1).map(n => (
                          <button
                            key={n}
                            onClick={() => setSheetRound(n === latestStartedRound() ? null : n)}
                            className={`text-xs font-bold px-2.5 py-1 rounded-lg border transition ${effectiveSheetRound() === n ? 'bg-[#2d2721] text-white border-[#2d2721]' : 'bg-white text-[#625a4f] border-[#e7dfd1] hover:bg-[#faf7f1]'}`}
                          >{n}回戦終了時</button>
                        ))}
                        {effectiveSheetRound() < latestStartedRound() && (
                          <span className="text-[11px] font-bold text-amber-700">⏪ 巻き戻し表示中（最新は{latestStartedRound()}回戦）</span>
                        )}
                      </div>
                    )}

                    {showSheet && (() => {
                      const roundNos = sheetRoundNos();
                      const rows = buildSheetRows(roundNos);
                      if (rows.length === 0) return <p className="text-sm text-[#a99d8c]">成績表に載せる選手がいません。</p>;
                      return (
                        <div className="space-y-5">
                          {splitSheetPages(rows).map(pg => (
                            <React.Fragment key={pg.label || 'all'}>
                              <StandingsSheetTable rows={pg.rows} roundNos={roundNos} title={pageTitle(pg.label)} />
                            </React.Fragment>
                          ))}
                          <p className="text-[11px] text-[#a99d8c]">順位・ポイント・対局数は今大会の成績です（今大会に出場していない選手は載せていません）。今季通算は、今季ここまでの通算ポイント（今大会の分を含む）です。黒子・プロは載せていません。順位の数字: 4位まで緑、8位まで青、それ以下は黒（ポイントがマイナスの選手は赤）。</p>
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* ---- 管理者用ツール ---- */}
                {isAdmin && showAdminTools && (
                  <div className="bg-white border-2 border-[#2d2721] rounded-2xl p-5 space-y-5">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-black text-[#2d2721]">🛠️ 選手の追加・差し替え（管理者用）</h3>
                      <p className="text-[11px] text-[#a99d8c] text-right leading-relaxed">
                        誤操作防止のため、確認ダイアログを経てから反映されます。<br />送信済みの卓は変更できません。
                      </p>
                    </div>

                    {/* 追加 */}
                    <div className="p-4 bg-[#faf7f1] rounded-xl border border-[#e7dfd1]">
                      <h4 className="font-bold text-sm text-[#473f36] mb-3">① 大会に選手を追加（途中参加）</h4>
                      <div className="grid md:grid-cols-2 gap-4">
                        <div className="flex gap-2">
                          <select value={addExistingId} onChange={e => setAddExistingId(e.target.value)} className="flex-1 p-2.5 border rounded-lg bg-white text-sm">
                            <option value="">登録済みの選手から選ぶ...</option>
                            {dbPlayers.filter(p => !entryPlayerIds.includes(p.id)).map(p => (
                              <option key={p.id} value={p.id}>{proMarkedName(p.name)}</option>
                            ))}
                          </select>
                          <button onClick={handleAddExistingToTournament} disabled={!addExistingId} className="px-4 py-2 rounded-lg font-bold text-sm bg-[#c8361e] text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">追加</button>
                        </div>
                        <div className="flex gap-2">
                          <input value={quickName} onChange={e => setQuickName(e.target.value)} placeholder="新規選手名（例: 黒子A）" className="flex-1 p-2.5 border rounded-lg bg-white text-sm" />
                          <button onClick={handleQuickRegister} disabled={!quickName.trim()} className="px-4 py-2 rounded-lg font-bold text-sm bg-[#2d2721] text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition whitespace-nowrap">登録して追加</button>
                        </div>
                      </div>
                      <p className="text-[11px] text-[#a99d8c] mt-2">追加した選手は下の「差し替え」で席に入れてください。</p>
                    </div>

                    {/* 差し替え */}
                    <div className="p-4 bg-[#faf7f1] rounded-xl border border-[#e7dfd1]">
                      <h4 className="font-bold text-sm text-[#473f36] mb-3">② 席の差し替え（1人を別の選手に交代）</h4>
                      <div className="grid md:grid-cols-3 gap-3 items-center">
                        <select value={replaceSeatKey} onChange={e => setReplaceSeatKey(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">対象の席を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <select value={replaceWithId} onChange={e => setReplaceWithId(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">交代する選手を選ぶ...</option>
                          {dbPlayers.map(p => <option key={p.id} value={p.id}>{proMarkedName(p.name)}{entryPlayerIds.includes(p.id) ? '' : '（未エントリー）'}</option>)}
                        </select>
                        <button onClick={handleReplaceSeat} disabled={!replaceSeatKey || !replaceWithId} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">
                          差し替える
                        </button>
                      </div>
                    </div>

                    {/* 入れ替え */}
                    <div className="p-4 bg-[#faf7f1] rounded-xl border border-[#e7dfd1]">
                      <h4 className="font-bold text-sm text-[#473f36] mb-3">③ 席の入れ替え（同じ回戦の2人を交換）</h4>
                      <div className="grid md:grid-cols-3 gap-3 items-center">
                        <select value={swapSeatA} onChange={e => setSwapSeatA(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">席A を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <select value={swapSeatB} onChange={e => setSwapSeatB(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">席B を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <button onClick={handleSwapSeats} disabled={!swapSeatA || !swapSeatB} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-teal-600 hover:bg-teal-700 text-white disabled:bg-[#e7dfd1] disabled:text-[#a99d8c] transition">
                          入れ替える
                        </button>
                      </div>
                    </div>
                  </div>
                )}

                {/* ---- 各回戦 ---- */}
                {seating.map((r, rIdx) => {
                  const finished = isRoundFinished(r);
                  const open = roundIsOpen(r);
                  const time = startTimeOf(r.round);
                  return (
                    <div key={r.round} className={`bg-white rounded-2xl shadow-sm border transition ${finished ? 'border-[#e7dfd1]' : 'border-[#fbddd3]'}`}>
                      {/* 回戦ヘッダー */}
                      <div className="flex flex-wrap items-center gap-3 p-4 md:p-5">
                        <button onClick={() => toggleRound(r)} className="flex items-center gap-3 text-left group">
                          <span className={`w-7 h-7 rounded-lg flex items-center justify-center font-black text-sm transition ${open ? 'bg-[#2d2721] text-white' : 'bg-[#e7dfd1] text-[#82786b] group-hover:bg-[#d4c9b7]'}`}>
                            {open ? '−' : '+'}
                          </span>
                          <span className="text-xl md:text-2xl font-black text-[#2d2721]">{r.round}回戦</span>
                        </button>

                        {time && <span className={`text-[11px] font-bold ${timerState.startAts[r.round] ? 'text-[#d9452b]' : 'text-[#a99d8c]'}`}>{timerState.startAts[r.round] ? '開始時間' : '開始目安'} {time}〜</span>}

                        {r.mode === 'rankTopFirst' && <span className="text-[11px] font-bold bg-amber-100 text-amber-800 px-2 py-1 rounded">順位戦 / 上位から東南西北</span>}
                        {r.mode === 'rankBottomFirst' && <span className="text-[11px] font-bold bg-rose-100 text-rose-800 px-2 py-1 rounded">最終戦 / 下位から東南西北</span>}
                        {finished && <span className="text-[11px] font-bold bg-[#e7dfd1] text-[#625a4f] px-2 py-1 rounded-full">✓ 全{r.tables.length}卓 終了</span>}

                        <div className="flex-1" />

                        {!r.isPending && r.tables.length > 0 && open && (
                          <div className="flex gap-1">
                            <button onClick={() => setAllTablesOfRound(r, false)} className="text-xs sm:text-[11px] bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#82786b] px-3 sm:px-2.5 py-2 sm:py-1.5 rounded-lg font-bold transition">全て畳む</button>
                            <button onClick={() => setAllTablesOfRound(r, true)} className="text-xs sm:text-[11px] bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#82786b] px-3 sm:px-2.5 py-2 sm:py-1.5 rounded-lg font-bold transition">全て開く</button>
                          </div>
                        )}
                        {!r.isPending && isAdmin && r.mode !== 'normal' && !r.tables.some(t => t.isSubmitted) && (
                          <button onClick={() => handleReshufflePendingRound(rIdx)} className="text-[11px] bg-[#f3eee4] hover:bg-[#e7dfd1] text-[#625a4f] px-2.5 py-1.5 rounded-lg font-bold transition">
                            🔄 現在の順位で再決定
                          </button>
                        )}
                      </div>

                      {open && (
                        <div className="px-4 md:px-5 pb-5 border-t border-[#f3eee4] pt-5">
                          {r.isPending ? (
                            <div className="p-8 rounded-xl border-2 border-dashed border-[#d4c9b7] bg-[#faf7f1] text-center">
                              <p className="text-3xl mb-2">🔒</p>
                              <p className="font-black text-[#625a4f] mb-1">卓組はまだ決定していません</p>
                              <p className="text-sm text-[#82786b]">
                                {r.round - 1}回戦までの全ての対局が終了した瞬間に、順位順（1234／5678…）で自動決定されます。
                              </p>
                              <p className="text-xs text-[#a99d8c] mt-2">
                                席順: {r.mode === 'rankBottomFirst' ? '卓内下位から 東→南→西→北' : '卓内上位から 東→南→西→北'} ／ 上位2卓（8位まで）に「黒子」「プロ」は入りません。それ以外の卓も、プロ・黒子は1卓に1人までです
                              </p>
                            </div>
                          ) : (
                            <>
                              {(r.sitOutIds && r.sitOutIds.length > 0) && (
                                <p className="text-xs text-[#82786b] mb-4">
                                  抜け番: {r.sitOutIds.map(id => proMarkedName(dbPlayers.find(p => p.id === id)?.name || '不明')).join('、')}
                                </p>
                              )}
                              <div className="grid lg:grid-cols-2 gap-5">
                                
                                {r.tables.map((table, tIdx) => {
                                  const currentSum = table.players.reduce((sum, p) => sum + (p.score || 0), 0);
                                  const diff = 1200 - currentSum;
                                  const isValidSum = diff >= 0 && diff % 10 === 0;
                                  const tableChonbo = table.players.reduce((s, p) => s + (p.chonbo || 0), 0);
                                  const isOpen = tableIsOpen(r, table);
                                  const isFinal = isFinalTable(r, table);
                                  const ranked = getTableRankList(table);

                                  return (
                                    <div
                                      key={table.tableNumber}
                                      className={`border-2 rounded-xl transition relative ${
                                        isFinal
                                          ? 'border-amber-400 bg-gradient-to-br from-amber-50 via-white to-amber-50 shadow-[0_0_28px_-6px_rgba(245,158,11,0.75)] ring-1 ring-amber-200'
                                          : table.isSubmitted ? 'bg-[#faf7f1] border-[#e7dfd1]'
                                          : table.isCalculated ? 'bg-[#faf7f1] border-[#f7bcab]'
                                          : 'bg-white border-[#fbddd3]'
                                      }`}
                                    >
                                      {isFinal && (
                                        <div className="absolute -top-3 left-4 px-3 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 text-white text-[11px] font-black shadow-md tracking-wider">
                                          👑 決勝卓
                                        </div>
                                      )}

                                      {/* 卓ヘッダー（クリックで開閉） */}
                                      <button onClick={() => toggleTable(r, table)} className="w-full flex justify-between items-center gap-2 p-3 sm:p-4 md:p-5 pb-3 text-left">
                                        <div className="flex items-center gap-2">
                                          <h4 className={`font-black text-lg px-3 py-1 rounded ${tableColor(table.tableNumber) ? `${tableColor(table.tableNumber)!.badge} ${table.isSubmitted ? 'opacity-60' : ''}` : isFinal ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white' : table.isSubmitted ? 'bg-[#a99d8c] text-white' : 'bg-[#2d2721] text-white'}`}>
                                            {tableName(table.tableNumber)}
                                          </h4>
                                          <span className={`text-[#a99d8c] text-xs font-bold`}>{isOpen ? '▼' : '▶'}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {tableChonbo > 0 && (
                                            <span className="text-[11px] px-2 py-1 rounded-full font-bold bg-red-100 text-red-700">🚫 {tableChonbo}</span>
                                          )}
                                          {table.isSubmitted ? (
                                            <span className="text-xs px-3 py-1 rounded-full font-bold bg-[#d4c9b7] text-[#473f36]">✓ 送信済み</span>
                                          ) : (
                                            <span className={`text-[11px] px-2 py-1 rounded-full font-bold ${isValidSum ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                                              {isValidSum ? (diff === 0 ? '合計 120000点 ✓' : `合計 ${currentSum}00 (供託等 ${diff}00) ✓`) : `異常 ${currentSum}00点 ✗`}
                                            </span>
                                          )}
                                        </div>
                                      </button>

                                      {/* 畳んでいるときのサマリー */}
                                      {!isOpen && (
                                        <div className="px-4 md:px-5 pb-4 space-y-1">
                                          {ranked.map((p, i2) => (
                                            <div key={p.playerId} className="flex items-center justify-between text-sm">
                                              <span className="truncate text-[#625a4f]">
                                                <span className="text-[#a99d8c] font-mono mr-1.5">{table.isSubmitted ? i2 + 1 : '-'}</span>
                                                <PlayerLabel name={p.name} />
                                                <span className="text-[#a99d8c] text-xs ml-1.5">({p.wind})</span>
                                              </span>
                                              <span className={`font-bold tabular-nums ${!table.isSubmitted && !table.isCalculated ? 'text-[#d4c9b7]' : p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-[#82786b]'}`}>
                                                {table.isSubmitted || table.isCalculated ? fmtPt(p.point) : '-'}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {/* 展開時 */}
                                      {isOpen && (
                                        <div className="px-3 sm:px-4 md:px-5 pb-5">
                                          <div className="space-y-3">
                                            {table.players.map((p, pIdx) => {
                                              const chonbo = p.chonbo || 0;
                                              return (
                                                <div key={pIdx} className={`p-2 rounded-lg ${table.isSubmitted ? 'opacity-80' : 'bg-[#faf7f1]'} ${chonbo > 0 ? 'ring-1 ring-red-200 bg-red-50/60' : ''}`}>
                                                  <div className="flex justify-between items-center gap-2 sm:gap-3">
                                                    <span className="flex-1 min-w-0 font-bold text-[#473f36] leading-snug break-words">
                                                      <span className="text-[#a99d8c] mr-1">{p.wind}</span><PlayerLabel name={p.name} className="text-[#5e190e]" />
                                                    </span>
                                                    
                                                    <div className={`flex items-center border-2 rounded-lg px-2 py-2 sm:py-1.5 transition ${table.isSubmitted || !canEditTable(table) ? 'bg-[#e7dfd1] border-[#d4c9b7]' : 'bg-white focus-within:border-[#d9452b]'}`}>
                                                      <input
                                                        type="number" value={p.score} disabled={table.isSubmitted || !canEditTable(table)}
                                                        onChange={(e) => handleScoreChange(rIdx, tIdx, pIdx, Number(e.target.value))}
                                                        className={`w-14 sm:w-20 text-right font-mono font-bold text-xl sm:text-lg outline-none ${table.isSubmitted || !canEditTable(table) ? 'bg-transparent text-[#625a4f]' : 'text-[#2d2721]'}`}
                                                      />
                                                      <span className="text-[#a99d8c] font-bold text-sm ml-1 select-none">00</span>
                                                    </div>

                                                    <span className={`w-14 sm:w-20 flex-shrink-0 text-right font-black text-lg sm:text-xl tabular-nums ${!table.isCalculated && !table.isSubmitted ? 'text-[#d4c9b7]' : p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-[#82786b]'}`}>
                                                      {table.isCalculated || table.isSubmitted ? fmtPt(p.point) : '-'}
                                                    </span>
                                                  </div>

                                                  {/* チョンボ */}
                                                  {(canEditTable(table) && !table.isSubmitted) ? (
                                                    <div className="flex items-center justify-end gap-2 mt-2 pr-1">
                                                      <span className="text-xs font-bold text-[#a99d8c] mr-auto pl-1">チョンボ</span>
                                                      <button onClick={() => handleChonboChange(rIdx, tIdx, pIdx, -1)}
                                                        className="w-11 h-11 sm:w-8 sm:h-8 rounded-lg bg-white border border-[#d4c9b7] text-[#625a4f] text-lg font-black hover:bg-[#f3eee4] transition disabled:opacity-40"
                                                        disabled={chonbo === 0}>−</button>
                                                      <span className={`w-8 text-center font-black tabular-nums ${chonbo > 0 ? 'text-red-600' : 'text-[#a99d8c]'}`}>{chonbo}</span>
                                                      <button onClick={() => handleChonboChange(rIdx, tIdx, pIdx, 1)}
                                                        className="w-11 h-11 sm:w-8 sm:h-8 rounded-lg bg-red-500 text-white text-lg font-black hover:bg-red-600 transition">＋</button>
                                                      <span className={`w-16 text-right text-xs font-bold ${chonbo > 0 ? 'text-red-600' : 'text-[#d4c9b7]'}`}>
                                                        {chonbo > 0 ? `−${(CHONBO_PENALTY * chonbo).toFixed(1)}` : '−0.0'}
                                                      </span>
                                                    </div>
                                                  ) : chonbo > 0 ? (
                                                    <div className="flex items-center justify-end gap-2 mt-1 pr-1">
                                                      <span className="text-[11px] font-bold text-red-600">🚫 チョンボ {chonbo}回 (−{(CHONBO_PENALTY * chonbo).toFixed(1)}pt)</span>
                                                    </div>
                                                  ) : null}
                                                </div>
                                              );
                                            })}
                                          </div>

                                          {!table.isSubmitted && canEditTable(table) && !isAdmin && (
                                            <div className="mt-5 p-3 rounded-lg bg-amber-50 border border-amber-200 text-[11px] text-amber-800 leading-relaxed">
                                              ⚠️ 卓内の1人が入力後、<span className="font-bold">全員の確認を取ってから</span>送信ボタンを押してください。送信すると自分では修正できなくなります。送信後に間違いが見つかった場合は、運営にお知らせください。
                                            </div>
                                          )}

                                          {canEditTable(table) && (
                                            <div className="mt-3 flex gap-2">
                                              {!table.isSubmitted ? (
                                                <>
                                                  <button onClick={() => calculateTablePoints(rIdx, tIdx)} className={`flex-1 py-4 sm:py-3 rounded-xl sm:rounded-lg font-bold text-base sm:text-sm transition ${table.isCalculated ? 'bg-[#e7dfd1] text-[#625a4f]' : 'bg-[#c8361e] text-white'}`}>
                                                    {table.isCalculated ? '再計算' : '計算・確定'}
                                                  </button>
                                                  <button onClick={() => handleSubmitTable(rIdx, tIdx)} disabled={!table.isCalculated} className={`flex-1 py-4 sm:py-3 rounded-xl sm:rounded-lg font-bold text-base sm:text-sm transition ${table.isCalculated ? 'bg-green-500 text-white' : 'bg-[#f3eee4] text-[#a99d8c] cursor-not-allowed'}`}>
                                                    送信する
                                                  </button>
                                                </>
                                              ) : isAdmin ? (
                                                <button onClick={() => handleRevokeTable(rIdx, tIdx)} className="flex-1 py-4 sm:py-3 rounded-xl sm:rounded-lg font-bold text-base sm:text-sm transition bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300">
                                                  送信を取り消して編集する
                                                </button>
                                              ) : null}
                                            </div>
                                          )}
                                        </div>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                            </>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}

                {/* 大会規定（全ての回戦の下） */}
                <RulesDocCard />

              </div>
            )}
          </div>
        )}
      </div>

      {/* ========== フッター（謝辞） ========== */}
      <SiteFooter />

    </main>
  );
}