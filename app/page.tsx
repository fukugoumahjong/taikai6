'use client';

import React, { useState, useEffect } from 'react';
import { signIn, signOut, useSession } from "next-auth/react";
import { supabase } from '@/lib/supabase';

// ==========================================
// 0. 定数
// ==========================================
// 大会名はここだけ変えれば全画面・PDF・画像に反映されます
const APP_TITLE = '高等学校複合麻雀競技大会';
const RULE_NAME = '最高位戦ルール';
const CHONBO_PENALTY = 20.0;
// 年間チャンピオン大会 出場権の自動条件 (通算半荘数)
const CHAMPIONSHIP_GAMES = 11;
// 各回戦の開始時刻（あくまで目安）
const ROUND_START_TIMES = ['08:40', '10:00', '11:15', '12:30', '13:45', '15:00', '16:20', '17:35', '19:50'];
const roundStartTime = (roundNo: number) => ROUND_START_TIMES[roundNo - 1] || null;

// ==========================================
// 1. 型定義
// ==========================================
type Player = {
  id: string;
  name: string;
  totalPoint: number;
  totalGames: number;
  championshipRight?: boolean; // 年間チャンピオン大会 出場権（手動付与）
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

// ==========================================
// 2. 共通ヘルパー
// ==========================================
const isKuroko = (name: string) => name.includes('黒子');
const fmtPt = (n: number) => (n > 0 ? `+${n.toFixed(1)}` : n.toFixed(1));

// 名前の末尾が P の選手は麻雀プロ（"プロ"という文字を含むだけでは判定しない）
const PRO_SUFFIX = /[PＰⓅⓟ]$/;
const isPro = (name: string) => PRO_SUFFIX.test((name || '').trim());
const baseName = (name: string) => (name || '').trim().replace(PRO_SUFFIX, '');
const proMarkedName = (name: string) => (isPro(name) ? `${baseName(name)}Ⓟ` : name);

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

// ==========================================
// 3. クラウド通信・データ管理 (モックAPI)
// ==========================================
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
      }]);
    if (error) console.error('プレイヤー保存エラー:', error);
  },

  updatePlayer: async (updatedPlayer: Player) => {
    const { error } = await supabase
      .from('players')
      .update({
        name: updatedPlayer.name,
        total_point: updatedPlayer.totalPoint,
        total_games: updatedPlayer.totalGames,
        championship_right: updatedPlayer.championshipRight ?? false,
      })
      .eq('id', updatedPlayer.id);
    if (error) console.error('プレイヤー更新エラー:', error);
  },

  updatePlayersScores: async (updates: { id: string; pointDelta: number; gamesDelta: number }[]) => {
    for (const u of updates) {
      const { data: current } = await supabase
        .from('players')
        .select('total_point, total_games')
        .eq('id', u.id)
        .single();
      
      if (current) {
        const newPoint = Math.round((Number(current.total_point) + u.pointDelta) * 10) / 10;
        const newGames = current.total_games + u.gamesDelta;
        
        await supabase
          .from('players')
          .update({
            total_point: newPoint,
            total_games: newGames,
          })
          .eq('id', u.id);
      }
    }
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

  exportBackup: async () => {
    const players = await api.getPlayers();
    const tournament = await api.getCurrentTournament();
    const data = { players, tournament };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mahjong_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
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
  const [activeTab, setActiveTab] = useState<'tournament' | 'currentRanking' | 'totalRanking' | 'players'>('tournament');
  const [tournamentPhase, setTournamentPhase] = useState<'entry' | 'playing'>('entry');
  
  const [dbPlayers, setDbPlayers] = useState<Player[]>([]);
  const [entryPlayerIds, setEntryPlayerIds] = useState<string[]>([]);
  
  const [roundsCount, setRoundsCount] = useState(4);
  const [seating, setSeating] = useState<Round[]>([]);
  
  const [isResetting, setIsResetting] = useState(false);
  const [resetCountdown, setResetCountdown] = useState(0);

  // 今大会成績まわりの表示状態
  const [showKuroko, setShowKuroko] = useState(false); // デフォルトは非表示
  const [openPlayerId, setOpenPlayerId] = useState<string | null>(null);
  const [openGameKey, setOpenGameKey] = useState<string | null>(null);

  // 折りたたみ状態（未設定なら「終了していれば畳む」）
  const [roundOpen, setRoundOpen] = useState<Record<number, boolean>>({});
  const [tableOpen, setTableOpen] = useState<Record<string, boolean>>({});

  const rule = { originPoint: 300, returnPoint: 300, uma: [30, 10, -10, -30], name: RULE_NAME };

  useEffect(() => {
    if (isLoaded && !isAdmin && activeTab === 'players') {
      setActiveTab('tournament');
    }
  }, [isAdmin, activeTab, isLoaded]);

  useEffect(() => {
    const loadData = async () => {
      setDbPlayers(await api.getPlayers());
      const current = await api.getCurrentTournament();
      if (current) {
        if (current.tournamentPhase) setTournamentPhase(current.tournamentPhase);
        if (current.entryPlayerIds) setEntryPlayerIds(current.entryPlayerIds);
        if (current.roundsCount) setRoundsCount(current.roundsCount);
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
      }
      setIsLoaded(true);
    };
    loadData();
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    api.saveCurrentTournament({ tournamentPhase, entryPlayerIds, roundsCount, seating });
  }, [tournamentPhase, entryPlayerIds, roundsCount, seating, isLoaded]);

  // ----------------------------------------
  // A. プレイヤー管理 & 編集機能
  // ----------------------------------------
  const [newPlayerName, setNewPlayerName] = useState('');
  const [newPlayerPoint, setNewPlayerPoint] = useState(0);
  const [newPlayerGames, setNewPlayerGames] = useState(0);
  const [newPlayerRight, setNewPlayerRight] = useState(false); // 出場権（デフォルトなし）
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', totalPoint: 0, totalGames: 0, championshipRight: false });

  const handleRegisterPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    if (!newPlayerName.trim()) return;
    const newPlayer: Player = {
      id: crypto.randomUUID(),
      name: newPlayerName.trim(),
      totalPoint: newPlayerPoint,
      totalGames: newPlayerGames,
      championshipRight: isPro(newPlayerName) ? false : newPlayerRight,
    };
    await api.savePlayer(newPlayer);
    setDbPlayers(await api.getPlayers());
    setNewPlayerName(''); setNewPlayerPoint(0); setNewPlayerGames(0); setNewPlayerRight(false);
    alert(`${newPlayer.name} を登録しました！`);
  };

  const startEditPlayer = (p: Player) => {
    if (!isAdmin) return;
    setEditingPlayerId(p.id);
    setEditForm({ name: p.name, totalPoint: p.totalPoint, totalGames: p.totalGames, championshipRight: !!p.championshipRight });
  };

  const saveEditPlayer = async () => {
    if (!editingPlayerId || !isAdmin) return;
    const player = dbPlayers.find(p => p.id === editingPlayerId);
    if (player) {
      const updated = {
        ...player,
        name: editForm.name,
        totalPoint: editForm.totalPoint,
        totalGames: editForm.totalGames,
        championshipRight: isPro(editForm.name) ? false : editForm.championshipRight,
      };
      await api.updatePlayer(updated);
      setDbPlayers(await api.getPlayers());
    }
    setEditingPlayerId(null);
  };

  const toggleEntry = (id: string) => {
    if (!isAdmin) return;
    if (entryPlayerIds.includes(id)) {
      setEntryPlayerIds(entryPlayerIds.filter(pid => pid !== id));
    } else {
      setEntryPlayerIds([...entryPlayerIds, id]);
    }
  };

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
    const numTables = Math.floor(entryPlayerIds.length / 4);
    const winds = ['東', '南', '西', '北'];

    // 通常生成する回戦数 (最後の2半荘は順位順で後決め。ただし最低1回戦は通常生成)
    const normalCount = Math.max(1, roundsCount - 2);
    const pendingCount = Math.max(0, roundsCount - normalCount);
    
    const matchHistory: Record<string, Record<string, number>> = {};
    const windHistory: Record<string, Record<string, number>> = {};
    const sitOuts: Record<string, number> = {};

    entryPlayerIds.forEach(id => {
      matchHistory[id] = {};
      windHistory[id] = { '東': 0, '南': 0, '西': 0, '北': 0 };
      sitOuts[id] = 0;
      entryPlayerIds.forEach(other => { matchHistory[id][other] = 0; });
    });

    const rainfId = dbPlayers.find(p => p.name === 'れいんえふ')?.id;
    const tokuId = dbPlayers.find(p => p.name === 'toku')?.id;

    const generatedRounds: Round[] = [];
    for (let r = 0; r < normalCount; r++) {
      // 抜け番を均等にするため、抜け番回数が少ない人を優先してアクティブに
      const sortedForActive = [...entryPlayerIds].sort((a, b) => {
        if (sitOuts[a] !== sitOuts[b]) return sitOuts[a] - sitOuts[b];
        return Math.random() - 0.5;
      });
      
      const activeIds = sortedForActive.slice(0, numTables * 4);
      const sittingOutIds = sortedForActive.slice(numTables * 4);
      sittingOutIds.forEach(id => sitOuts[id]++);

      const available = [...activeIds];
      const tables: Table[] = [];
      for (let t = 0; t < numTables; t++) {
        const tablePlayerIds: string[] = [];
        for (let wIdx = 0; wIdx < 4; wIdx++) {
          const wind = winds[wIdx];
          let bestCandidate = available[0];
          let minCost = Infinity;
          const candidates = [...available].sort(() => Math.random() - 0.5);

          for (const candidate of candidates) {
            let overlapCost = 0;
            let isBannedPair = false;

            for (const seated of tablePlayerIds) {
              overlapCost += matchHistory[candidate][seated] || 0;
              
              // 特例ルール: れいんえふ と toku は2回以上同卓しない
              if (
                ((candidate === rainfId && seated === tokuId) || (candidate === tokuId && seated === rainfId)) &&
                matchHistory[rainfId || ''][tokuId || ''] >= 1
              ) {
                isBannedPair = true;
              }
            }

            if (isBannedPair) continue;

            const windCost = windHistory[candidate][wind] || 0;
            const totalCost = (overlapCost * 100) + (windCost * 10);
            
            if (totalCost < minCost) { 
              minCost = totalCost; 
              bestCandidate = candidate; 
            }
          }

          if (minCost === Infinity) bestCandidate = candidates[0];

          tablePlayerIds.push(bestCandidate);
          available.splice(available.indexOf(bestCandidate), 1);
        }
        
        for (let i = 0; i < 4; i++) {
          const p1 = tablePlayerIds[i];
          windHistory[p1][winds[i]]++;
          for (let j = 0; j < 4; j++) {
            if (i !== j) matchHistory[p1][tablePlayerIds[j]]++;
          }
        }
        tables.push({
          tableNumber: t + 1, isCalculated: false, isSubmitted: false,
          players: tablePlayerIds.map((id, i) => ({
            playerId: id, wind: winds[i], name: dbPlayers.find(p => p.id === id)?.name || '不明', score: 300, point: 0.0, chonbo: 0,
          })),
        });
      }
      generatedRounds.push({ round: r + 1, tables, mode: 'normal', isPending: false, sitOutIds: sittingOutIds });
    }

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

    setSeating(generatedRounds);
    setRoundOpen({});
    setTableOpen({});
    setTournamentPhase('playing');
  };

  // ----------------------------------------
  // B-2. 順位順の卓組
  // ----------------------------------------
  // 「黒子」が上位8位(上位2卓)に入らないよう、その下を繰り上げる。
  // 弾かれた黒子は順位順に9位のところへ差し込む。
  const applyKurokoRule = <T extends { id: string; name: string }>(ranked: T[]): T[] => {
    const nonKuroko = ranked.filter(p => !isKuroko(p.name));
    const top8 = nonKuroko.slice(0, 8);
    if (top8.length === 0) return ranked;
    const cutoffIndex = ranked.indexOf(top8[top8.length - 1]);
    const displacedKuroko = ranked.filter((p, i) => isKuroko(p.name) && i < cutoffIndex);
    const usedIds = new Set([...top8.map(p => p.id), ...displacedKuroko.map(p => p.id)]);
    const rest = ranked.filter(p => !usedIds.has(p.id));
    return [...top8, ...displacedKuroko, ...rest];
  };

  const buildRankedOrder = (data: Round[], beforeIdx: number) => {
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
    const list = entryPlayerIds.map(id => {
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
    const ordered = buildRankedOrder(data, idx);
    const numTables = Math.floor(entryPlayerIds.length / 4);
    const active = ordered.slice(0, numTables * 4);
    const sitOut = ordered.slice(numTables * 4);
    const winds = ['東', '南', '西', '北'];

    const tables: Table[] = [];
    for (let t = 0; t < numTables; t++) {
      const group = active.slice(t * 4, t * 4 + 4); // 卓内の上位→下位
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
  }, [seating, isLoaded, tournamentPhase, dbPlayers, entryPlayerIds]);

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
  const handleScoreChange = (rIdx: number, tIdx: number, pIdx: number, val: number) => {
    if (!isAdmin) return;
    const updated = [...seating];
    if (updated[rIdx].tables[tIdx].isSubmitted) return;
    updated[rIdx].tables[tIdx].players[pIdx].score = val;
    updated[rIdx].tables[tIdx].isCalculated = false;
    setSeating(updated);
  };

  const handleChonboChange = (rIdx: number, tIdx: number, pIdx: number, delta: number) => {
    if (!isAdmin) return;
    const updated = [...seating];
    const table = updated[rIdx].tables[tIdx];
    if (table.isSubmitted) return;
    const cur = table.players[pIdx].chonbo || 0;
    table.players[pIdx].chonbo = Math.max(0, Math.min(9, cur + delta));
    table.isCalculated = false;
    setSeating(updated);
  };

  const calculateTablePoints = (rIdx: number, tIdx: number) => {
    if (!isAdmin) return;
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
  const handleSubmitTable = async (rIdx: number, tIdx: number) => {
    if (!isAdmin) return;
    const table = seating[rIdx].tables[tIdx];
    if (!table.isCalculated) { alert('先にスコアを計算してください。'); return; }
    if (!window.confirm('クラウドに送信しますか？')) return;

    const updates = table.players.map(p => ({ id: p.playerId, pointDelta: p.point, gamesDelta: 1 }));
    await api.updatePlayersScores(updates);
    setDbPlayers(await api.getPlayers());

    const updated = [...seating];
    updated[rIdx].tables[tIdx].isSubmitted = true;
    setSeating(updated);
    // 送信した卓は自動的に畳む
    setTableOpen(prev => ({ ...prev, [`${seating[rIdx].round}-${table.tableNumber}`]: false }));
  };

  const handleRevokeTable = async (rIdx: number, tIdx: number) => {
    if (!isAdmin) return;
    const table = seating[rIdx].tables[tIdx];
    if (!window.confirm('【警告】\nこの卓の送信を取り消し、成績を編集できるようにしますか？\n※通算成績に加算されたポイントは一旦マイナスされます。')) return;

    const reverses = table.players.map(p => ({ id: p.playerId, pointDelta: -p.point, gamesDelta: -1 }));
    await api.updatePlayersScores(reverses);
    setDbPlayers(await api.getPlayers());

    const updated = [...seating];
    updated[rIdx].tables[tIdx].isSubmitted = false;
    updated[rIdx].tables[tIdx].isCalculated = false;
    setSeating(updated);
    alert('送信を取り消しました。スコアを修正してください。');
  };

  // ----------------------------------------
  // E. 大会全体のリセット
  // ----------------------------------------
  const handleResetTournament = async () => {
    if (!isAdmin) return;
    if (!window.confirm('【警告】現在の大会の進行を全てリセットしますか？')) return;
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
    setTimeout(async () => {
      if (window.confirm('【最終確認】待機時間が終了しました。\n本当に全てリセットしますか？')) {
        setSeating([]); setEntryPlayerIds([]); setTournamentPhase('entry'); setActiveTab('tournament');
        await api.clearCurrentTournament();
        alert('大会状況をリセットしました。');
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
        label: `${r.round}回戦 ${t.tableNumber}卓 ${p.wind}家 : ${proMarkedName(p.name)}`,
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
    const newPlayer: Player = { id: crypto.randomUUID(), name, totalPoint: 0, totalGames: 0, championshipRight: false };
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
    if (!window.confirm(`${round.round}回戦 ${table.tableNumber}卓 ${old.wind}家\n\n${proMarkedName(old.name)} → ${proMarkedName(newPlayer.name)}\n\nこの内容で差し替えますか？`)) return;

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
    if (!window.confirm(`${round.round}回戦\n\n${round.tables[a.tIdx].tableNumber}卓 ${pa.wind}家 : ${proMarkedName(pa.name)}\n　　　　⇅\n${round.tables[b.tIdx].tableNumber}卓 ${pb.wind}家 : ${proMarkedName(pb.name)}\n\nこの2人を入れ替えますか？`)) return;

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
  // G. データ集計
  // ----------------------------------------
  // 通算成績: 黒子は常に非表示
  const displayDbPlayers = [...dbPlayers]
    .filter(p => !isKuroko(p.name))
    .sort((a, b) => b.totalPoint - a.totalPoint);

  // 出場権が実際にあるのは「手動で付与されている」場合のみ。
  // 麻雀プロ(末尾がP)は半荘数や付与フラグに関わらず出場権を持たない。
  const hasChampionshipRight = (p: Player) => !isPro(p.name) && !!p.championshipRight;
  // 通算11半荘以上は「出場権の対象」になるだけで、自動的に出場権が得られるわけではない。
  const isChampionshipCandidate = (p: Player) => !isPro(p.name) && p.totalGames >= CHAMPIONSHIP_GAMES;

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

  const displayCurrentRanking = showKuroko
    ? currentRankingAll
    : currentRankingAll.filter(p => !isKuroko(p.name));

  // 個人の今大会スケジュール（済・予定・未定・抜け番）
  type ScheduleItem = {
    key: string; roundNo: number;
    status: 'done' | 'ready' | 'pending' | 'sitout';
    tableNo?: number; wind?: string; point?: number; rank?: number; chonbo?: number; table?: Table;
  };
  const getPlayerSchedule = (playerId: string): ScheduleItem[] => {
    const items: ScheduleItem[] = [];
    seating.forEach(r => {
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

    const totalRows = displayDbPlayers.map((p, i) => {
      const granted = hasChampionshipRight(p);
      const candidate = isChampionshipCandidate(p);
      const pro = isPro(p.name);
      const rowClass = granted ? 'granted' : candidate ? 'candidate' : '';
      const csLabel = pro ? '対象外(プロ)' : granted ? '🏆 出場権' : candidate ? '○ 対象' : '-';
      return `
      <tr class="${rowClass}">
        <td class="c">${i + 1}</td>
        <td>${nameForDoc(p.name)}</td>
        <td class="r">${p.totalGames}</td>
        <td class="r ${p.totalPoint > 0 ? 'plus' : p.totalPoint < 0 ? 'minus' : ''}">${fmtPt(p.totalPoint)}</td>
        <td class="c">${csLabel}</td>
      </tr>`;
    }).join('');

    const resultBlocks = seating.map(r => {
      const timeNote = roundStartTime(r.round) ? `<span class="time">開始目安 ${roundStartTime(r.round)}</span>` : '';
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
            <div class="tblhead">${t.tableNumber}卓${isFinalTable(r, t) ? ' 👑 決勝卓' : ''} <span class="badge">${t.isSubmitted ? '確定' : '未確定'}</span></div>
            <table>
              <thead><tr><th>席</th><th>プレイヤー</th><th class="r">素点</th><th>着順</th><th class="r">チョンボ</th><th class="r">ポイント</th></tr></thead>
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

    const timeTable = ROUND_START_TIMES.slice(0, Math.max(roundsCount, 0))
      .map((t, i) => `${i + 1}回戦 ${t}`).join(' / ');

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
  @media print { body { padding:10mm; } @page { size: A4; margin: 10mm; } }
</style></head>
<body>
  <h1>${escapeHtml(APP_TITLE)} ／ 今大会成績レポート</h1>
  <div class="sub">
    出力日時: ${dateStr} ／ ${escapeHtml(RULE_NAME)} ／ 参加 ${entryPlayerIds.length}名 ／ 全${roundsCount}回戦 ／ チョンボ 1回 -${CHONBO_PENALTY.toFixed(1)}pt<br>
    開始時刻（目安）: ${timeTable}
  </div>

  <h2>今大会ランキング${showKuroko ? '（黒子を含む）' : ''}</h2>
  <table>
    <thead><tr><th>順位</th><th>プレイヤー名</th><th class="r">半荘数</th><th class="r">平均着順</th><th class="r">チョンボ</th><th class="r">今大会pt</th></tr></thead>
    <tbody>${rankRows || '<tr><td colspan="6" class="c">データなし</td></tr>'}</tbody>
  </table>

  <h2>全試合結果</h2>
  ${resultBlocks || '<p class="note">試合結果はありません。</p>'}

  <h2>今年度通算ランキング</h2>
  <table>
    <thead><tr><th>順位</th><th>プレイヤー名</th><th class="r">通算半荘数</th><th class="r">通算pt</th><th>年間CS出場権</th></tr></thead>
    <tbody>${totalRows || '<tr><td colspan="5" class="c">データなし</td></tr>'}</tbody>
  </table>
  <p class="note">※ 年間チャンピオン大会の出場権は各大会優勝を除き今年度に2回以上の参加が必要です。麻雀プロ（名前後ろの⒫）は半荘数に関わらず出場権の対象外です。</p>
</body></html>`;
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
    ctx.fillText('プレイヤー名', 110, 126);
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
  const handleDataImport = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!isAdmin) return;
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      try {
        const data = JSON.parse(ev.target?.result as string);
        if (data.players) localStorage.setItem('mahjong_players', data.players);
        if (data.tournament) localStorage.setItem('mahjong_current_tournament', data.tournament);
        alert('データを復元しました。画面を再読み込みします。');
        window.location.reload();
      } catch(err) { alert('ファイルの読み込みに失敗しました。'); }
    };
    reader.readAsText(file);
  };

  if (!isLoaded || status === 'loading') return <div className="min-h-screen bg-slate-100 flex items-center justify-center font-bold text-lg animate-pulse">データを読み込んでいます...</div>;

  const tabBtn = (key: typeof activeTab, label: string, color: string) => (
    <button
      onClick={() => setActiveTab(key)}
      className={`px-3 lg:px-4 py-1.5 rounded-md font-bold text-[13px] whitespace-nowrap transition ${activeTab === key ? `${color} text-white shadow` : 'text-slate-300 hover:text-white hover:bg-slate-700/60'}`}
    >{label}</button>
  );

  return (
    <main className="min-h-screen bg-slate-100 text-slate-800 font-sans relative pb-20">
      
      {isResetting && (
        <div className="fixed inset-0 bg-black/90 z-50 flex flex-col items-center justify-center text-white">
          <div className="animate-pulse flex flex-col items-center">
            <span className="text-red-500 text-6xl mb-4 block text-center">⚠️</span>
            <h2 className="text-2xl font-bold mb-2">リセット待機中...</h2>
            <p className="text-lg">誤操作防止のため、30秒間待機しています。</p>
            <p className="text-6xl font-mono text-center mt-8 font-black text-red-400">{resetCountdown}</p>
          </div>
        </div>
      )}

      {/* ========== ヘッダー (1行固定・折り返しなし) ========== */}
      <header className="bg-slate-900 text-white shadow-md sticky top-0 z-40">
        <div className="max-w-7xl mx-auto px-4 h-16 flex items-center gap-4 overflow-x-auto" style={{ scrollbarWidth: 'none', msOverflowStyle: 'none' }}>
          {/* タイトル */}
          <div className="flex-shrink-0 leading-tight mr-1">
            <h1 className="text-base sm:text-lg lg:text-xl font-bold tracking-wide whitespace-nowrap">{APP_TITLE}</h1>
            <p className="text-[10px] text-slate-400 whitespace-nowrap">{RULE_NAME}</p>
          </div>

          {/* タブ */}
          <nav className="flex-shrink-0 flex bg-slate-800 p-1 rounded-lg gap-0.5">
            {tabBtn('tournament', '大会進行', 'bg-indigo-600')}
            {tabBtn('currentRanking', '今大会成績', 'bg-teal-600')}
            {tabBtn('totalRanking', '通算成績', 'bg-indigo-600')}
            {isAdmin && tabBtn('players', '新規登録', 'bg-indigo-600')}
          </nav>

          <div className="flex-1" />

          {/* 管理ツール */}
          {isAdmin && (
            <div className="flex-shrink-0 flex gap-2 items-center">
              <button onClick={api.exportBackup} className="text-[11px] bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-md transition whitespace-nowrap" title="データをファイルとして保存します">💾 バックアップ</button>
              <label className="text-[11px] bg-slate-800 hover:bg-slate-700 px-2.5 py-1.5 rounded-md transition cursor-pointer whitespace-nowrap" title="保存したファイルから復元します">
                📂 復元
                <input type="file" accept=".json" className="hidden" onChange={handleDataImport} />
              </label>
            </div>
          )}

          {/* Auth Area */}
          <div className="flex-shrink-0 flex gap-2 items-center pl-3 ml-1 border-l border-slate-700">
            {session ? (
              <>
                <span className="text-[11px] font-bold text-slate-300 whitespace-nowrap hidden sm:inline">
                  {session.user?.name}{isAdmin && ' (管理者)'}
                </span>
                <button onClick={() => signOut()} className="text-[11px] bg-slate-800 hover:bg-red-600 px-2.5 py-1.5 rounded-md transition whitespace-nowrap">ログアウト</button>
              </>
            ) : (
              <button onClick={() => signIn('google')} className="text-[11px] bg-indigo-600 hover:bg-indigo-500 px-3 py-1.5 rounded-md font-bold transition whitespace-nowrap">Googleログイン</button>
            )}
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-4 md:p-6">
        
        {/* ========== 新規登録 ========== */}
        {activeTab === 'players' && isAdmin && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">新規プレイヤーの登録</h2>
              <form onSubmit={handleRegisterPlayer} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-600 mb-1">プレイヤー名</label>
                  <input type="text" required value={newPlayerName} onChange={e => setNewPlayerName(e.target.value)} className="w-full p-2.5 border rounded-lg bg-slate-50"/>
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-600 mb-1">過去の通算ポイント</label>
                  <input type="number" step="0.1" value={newPlayerPoint} onChange={e => setNewPlayerPoint(Number(e.target.value))} className="w-full p-2.5 border rounded-lg bg-slate-50"/>
                </div>
                <div>
                  <label className="block text-sm font-bold text-slate-600 mb-1">過去の対局数</label>
                  <input type="number" value={newPlayerGames} onChange={e => setNewPlayerGames(Number(e.target.value))} className="w-full p-2.5 border rounded-lg bg-slate-50"/>
                </div>

                <div className="md:col-span-4">
                  <label className={`flex items-center gap-3 p-3 rounded-xl border-2 transition ${isPro(newPlayerName) ? 'bg-slate-100 border-slate-200 cursor-not-allowed opacity-60' : newPlayerRight ? 'bg-amber-50 border-amber-300 cursor-pointer' : 'bg-slate-50 border-slate-200 hover:border-slate-300 cursor-pointer'}`}>
                    <input
                      type="checkbox"
                      checked={isPro(newPlayerName) ? false : newPlayerRight}
                      disabled={isPro(newPlayerName)}
                      onChange={e => setNewPlayerRight(e.target.checked)}
                      className="w-5 h-5 accent-amber-500"
                    />
                    <span className="font-bold text-sm text-slate-700">🏆 年間チャンピオン大会 出場権あり</span>
                    {isPro(newPlayerName) && (
                      <span className="text-[11px] font-bold text-slate-400 ml-auto">麻雀プロは出場権の対象外です</span>
                    )}
                  </label>
                </div>

                <button type="submit" className="md:col-span-4 mt-2 bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 rounded-lg transition">登録して保存</button>
              </form>
            </div>
          </div>
        )}

        {/* ========== 通算成績 ========== */}
        {activeTab === 'totalRanking' && (
          <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-slate-200 animate-in fade-in duration-300">
            <h2 className="text-xl font-bold mb-1">今年度通算成績ランキング</h2>
            <p className="text-[11px] text-slate-500 mb-4 leading-relaxed">
              <span className="inline-block w-3 h-3 rounded-sm bg-emerald-100 border border-emerald-300 align-middle mr-1"></span>
              通算{CHAMPIONSHIP_GAMES}半荘以上 = 年間チャンピオン大会 出場権の「対象」（自動付与ではありません）
              <br />
              <span className="inline-block w-3 h-3 rounded-sm bg-amber-100 border border-amber-300 align-middle mr-1"></span>
              🏆 は出場権が個別に付与されている選手 ／ 麻雀プロ（Ⓟ）は半荘数に関わらず出場権の対象外です
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse whitespace-nowrap">
                <thead>
                  <tr className="bg-slate-100 border-b border-slate-200 text-slate-600 text-sm">
                    <th className="p-3 font-bold">順位</th>
                    <th className="p-3 font-bold">プレイヤー名</th>
                    <th className="p-3 font-bold text-right">通算対局数</th>
                    <th className="p-3 font-bold text-right">通算ポイント</th>
                    <th className="p-3 font-bold text-center">年間CS</th>
                    {isAdmin && <th className="p-3 font-bold text-center">操作</th>}
                  </tr>
                </thead>
                <tbody>
                  {displayDbPlayers.map((p, i) => {
                    const pro = isPro(p.name);
                    const granted = hasChampionshipRight(p);
                    const candidate = isChampionshipCandidate(p);
                    return (
                      <tr key={p.id} className={`border-b border-slate-100 transition ${granted ? 'bg-amber-50/70 hover:bg-amber-100/70' : candidate ? 'bg-emerald-50/60 hover:bg-emerald-100/60' : 'hover:bg-slate-50'}`}>
                        <td className="p-3 font-bold text-slate-400">{i + 1}</td>
                        {editingPlayerId === p.id && isAdmin ? (
                          <>
                            <td className="p-2"><input type="text" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} className="border p-1 w-full rounded" /></td>
                            <td className="p-2 text-right"><input type="number" value={editForm.totalGames} onChange={e => setEditForm({...editForm, totalGames: Number(e.target.value)})} className="border p-1 w-20 text-right rounded" /></td>
                            <td className="p-2 text-right"><input type="number" step="0.1" value={editForm.totalPoint} onChange={e => setEditForm({...editForm, totalPoint: Number(e.target.value)})} className="border p-1 w-24 text-right rounded" /></td>
                            <td className="p-2 text-center">
                              <label className={`inline-flex items-center gap-1 text-xs font-bold ${isPro(editForm.name) ? 'text-slate-300 cursor-not-allowed' : 'text-slate-600'}`}>
                                <input
                                  type="checkbox"
                                  checked={isPro(editForm.name) ? false : editForm.championshipRight}
                                  disabled={isPro(editForm.name)}
                                  onChange={e => setEditForm({...editForm, championshipRight: e.target.checked})}
                                  className="w-4 h-4 accent-amber-500"
                                />
                                出場権
                              </label>
                              {isPro(editForm.name) && <div className="text-[10px] text-slate-400 mt-0.5">プロは対象外</div>}
                            </td>
                            <td className="p-2 text-center">
                              <button onClick={saveEditPlayer} className="bg-indigo-600 text-white px-3 py-1 rounded text-sm font-bold">保存</button>
                              <button onClick={() => setEditingPlayerId(null)} className="ml-2 text-slate-400 text-sm">取消</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="p-3 font-bold text-lg"><PlayerLabel name={p.name} /></td>
                            <td className="p-3 text-right text-slate-500">{p.totalGames} 半荘</td>
                            <td className={`p-3 text-right font-black text-lg ${p.totalPoint > 0 ? 'text-blue-600' : p.totalPoint < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                              {fmtPt(p.totalPoint)}
                            </td>
                            <td className="p-3 text-center">
                              {pro ? (
                                <span className="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full bg-slate-100 text-slate-400 border border-slate-200">対象外（プロ）</span>
                              ) : granted ? (
                                <span className="inline-block text-[11px] font-black px-2.5 py-1 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 text-white shadow-sm">🏆 出場権</span>
                              ) : candidate ? (
                                <span className="inline-block text-[11px] font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-700 border border-emerald-200">○ 対象</span>
                              ) : (
                                <span className="text-[11px] text-slate-400">出場権なし</span>
                              )}
                            </td>
                            {isAdmin && (
                              <td className="p-3 text-center">
                                <button onClick={() => startEditPlayer(p)} className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-1 rounded text-sm font-bold transition">編集</button>
                              </td>
                            )}
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {/* ========== 今大会成績 ========== */}
        {activeTab === 'currentRanking' && (
          <div className="bg-white p-4 md:p-6 rounded-2xl shadow-sm border border-slate-200 animate-in fade-in duration-300">
            <div className="flex flex-col md:flex-row md:items-center justify-between gap-3 border-b pb-3 mb-5">
              <h2 className="text-2xl font-black text-teal-800">🏆 今大会の成績</h2>
              <div className="flex flex-wrap gap-2 items-center">
                <button
                  onClick={() => setShowKuroko(!showKuroko)}
                  className={`px-3 py-2 rounded-lg text-xs font-bold border-2 transition ${showKuroko ? 'bg-slate-800 text-white border-slate-800' : 'bg-white text-slate-500 border-slate-300 hover:border-slate-500'}`}
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

            {tournamentPhase === 'entry' ? (
              <p className="text-slate-500">大会が始まっていません。</p>
            ) : (
              <>
                <p className="text-xs text-slate-500 mb-3">プレイヤー名をクリックすると、今大会の全成績（これからの対局予定を含む）が表示されます。</p>
                <div className="space-y-2">
                  {displayCurrentRanking.map((p, i) => {
                    const isOpen = openPlayerId === p.id;
                    const schedule = isOpen ? getPlayerSchedule(p.id) : [];
                    return (
                      <div key={p.id} className={`rounded-xl overflow-hidden border ${isOpen ? 'border-teal-300 shadow-sm' : 'border-transparent'}`}>
                        <button
                          onClick={() => { setOpenPlayerId(isOpen ? null : p.id); setOpenGameKey(null); }}
                          className={`w-full flex items-center gap-3 px-4 py-4 text-left transition ${isOpen ? 'bg-emerald-50' : 'bg-gradient-to-r from-emerald-50/70 to-white hover:from-emerald-100/70'}`}
                        >
                          <span className={`w-9 h-9 flex-shrink-0 rounded-full flex items-center justify-center font-black text-sm ${i === 0 ? 'bg-yellow-400 text-white' : i === 1 ? 'bg-slate-400 text-white' : i === 2 ? 'bg-amber-700 text-white' : 'bg-slate-200 text-slate-600'}`}>
                            {i + 1}
                          </span>
                          <span className="flex-1 font-black text-lg text-slate-800 truncate">
                            <PlayerLabel name={p.name} />
                            {isKuroko(p.name) && <span className="ml-2 text-[10px] font-bold bg-slate-800 text-white px-2 py-0.5 rounded-full align-middle">黒子</span>}
                            {p.chonbo > 0 && <span className="ml-2 text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full align-middle">🚫 {p.chonbo}</span>}
                          </span>
                          <span className={`font-black text-2xl tabular-nums ${p.point > 0 ? 'text-emerald-700' : p.point < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                            {fmtPt(p.point)}
                          </span>
                          <span className="w-16 text-right text-sm text-slate-400 font-medium">{p.games}戦</span>
                          <span className="w-14 text-right text-sm text-slate-500 tabular-nums">
                            {p.games > 0 ? p.avgRank.toFixed(2) : '-'}
                          </span>
                        </button>

                        {isOpen && (
                          <div className="bg-white border-t border-teal-100">
                            {schedule.length === 0 && (
                              <p className="px-6 py-4 text-sm text-slate-400">対局の予定がありません。</p>
                            )}
                            {schedule.map(g => {
                              const gKey = `${p.id}-${g.key}`;
                              const isGOpen = openGameKey === gKey;
                              const time = roundStartTime(g.roundNo);

                              // --- 未定 (最後の2回戦) ---
                              if (g.status === 'pending') {
                                return (
                                  <div key={gKey} className="flex items-center gap-3 px-6 py-3 border-b border-slate-100 last:border-b-0 bg-slate-50/60">
                                    <span className="font-mono text-sm text-slate-400 w-40">
                                      {g.roundNo}回戦{time && <span className="ml-2 text-[10px]">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm font-bold text-slate-400">卓組未定</span>
                                    <span className="text-[10px] text-slate-400 text-right">
                                      {g.roundNo === roundsCount ? '最終戦は直前の回戦終了後に決定' : '前の回戦が全て終了した時点で決定'}
                                    </span>
                                  </div>
                                );
                              }

                              // --- 抜け番 ---
                              if (g.status === 'sitout') {
                                return (
                                  <div key={gKey} className="flex items-center gap-3 px-6 py-3 border-b border-slate-100 last:border-b-0">
                                    <span className="font-mono text-sm text-slate-400 w-40">
                                      {g.roundNo}回戦{time && <span className="ml-2 text-[10px]">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm text-slate-400">抜け番</span>
                                    <span className="w-12 text-right text-slate-300 font-bold">(-)</span>
                                  </div>
                                );
                              }

                              // --- 対局予定 ---
                              if (g.status === 'ready') {
                                return (
                                  <div key={gKey} className="flex items-center gap-3 px-6 py-3 border-b border-slate-100 last:border-b-0 bg-indigo-50/40">
                                    <span className="font-mono text-sm text-slate-500 w-40">
                                      {g.roundNo}回戦 / {g.tableNo}卓{time && <span className="ml-2 text-[10px] text-slate-400">{time}〜</span>}
                                    </span>
                                    <span className="flex-1 text-center text-sm font-bold text-indigo-500">
                                      対局予定（{g.wind}家）
                                      {g.roundNo === roundsCount && g.tableNo === 1 && <span className="ml-2 text-[10px] font-black text-amber-600">👑 決勝卓</span>}
                                    </span>
                                    <span className="w-12 text-right text-slate-300 font-bold">(-)</span>
                                  </div>
                                );
                              }

                              // --- 結果あり ---
                              const ranked = getTableRankList(g.table as Table);
                              const deposit = getTableDeposit(g.table as Table);
                              return (
                                <div key={gKey} className="border-b border-slate-100 last:border-b-0">
                                  <button
                                    onClick={() => setOpenGameKey(isGOpen ? null : gKey)}
                                    className={`w-full flex items-center gap-3 px-6 py-3 text-left transition ${isGOpen ? 'bg-emerald-50/60' : 'hover:bg-slate-50'}`}
                                  >
                                    <span className="font-mono text-sm text-slate-600 w-40">
                                      {g.roundNo}回戦 / {g.tableNo}卓{time && <span className="ml-2 text-[10px] text-slate-400">{time}〜</span>}
                                    </span>
                                    <span className={`flex-1 text-center font-black text-lg tabular-nums ${(g.point || 0) > 0 ? 'text-emerald-700' : (g.point || 0) < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                                      {fmtPt(g.point || 0)}
                                    </span>
                                    {(g.chonbo || 0) > 0 && <span className="text-[10px] font-bold bg-red-100 text-red-700 px-2 py-0.5 rounded-full">🚫 {g.chonbo}</span>}
                                    <span className="w-12 text-right text-slate-400 font-bold">({g.rank})</span>
                                  </button>

                                  {isGOpen && (
                                    <div className="px-6 pb-4 pt-1 bg-white">
                                      <div className="border border-slate-200 rounded-lg overflow-hidden">
                                        {ranked.map((rp, rIdx2) => (
                                          <div key={rp.playerId} className={`flex items-center justify-between px-4 py-2.5 text-sm ${rp.playerId === p.id ? 'bg-emerald-50' : 'bg-white'} ${rIdx2 < 3 ? 'border-b border-slate-100' : ''}`}>
                                            <span className="text-slate-700 font-bold truncate">
                                              <span className="text-slate-400 font-mono mr-2">{rIdx2 + 1}</span>
                                              <PlayerLabel name={rp.name} />
                                              <span className="text-slate-400 font-normal text-xs ml-2">| {rp.wind}家 / {rp.score * 100}点</span>
                                              {(rp.chonbo || 0) > 0 && <span className="ml-2 text-[10px] font-bold bg-red-100 text-red-700 px-1.5 py-0.5 rounded">🚫{rp.chonbo}</span>}
                                            </span>
                                            <span className={`font-mono font-bold tabular-nums ${rp.point > 0 ? 'text-slate-800' : rp.point < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                              {rp.point > 0 ? rp.point.toFixed(1) : `−${Math.abs(rp.point).toFixed(1)}`}
                                            </span>
                                          </div>
                                        ))}
                                      </div>
                                      <div className="flex justify-between items-start mt-2 text-[11px] text-slate-400">
                                        <span>{RULE_NAME}</span>
                                        <div className="text-right">
                                          <div>供託・不足分：{(deposit * 100).toLocaleString()}点</div>
                                          <div>{g.roundNo}回戦 {g.tableNo}卓</div>
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
                    <p className="text-slate-400 text-sm py-6 text-center">表示できるデータがありません。</p>
                  )}
                </div>

                <div className="flex flex-wrap justify-end gap-x-6 gap-y-1 text-[11px] text-slate-400 mt-4 pr-2">
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
            
            {tournamentPhase === 'entry' && (
              <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-slate-200">
                <h2 className="text-2xl font-black text-indigo-900 mb-6">今大会のエントリー</h2>
                
                {!isAdmin ? (
                   <p className="text-slate-600 font-bold">管理者が大会を開始するのをお待ちください...</p>
                ) : (
                  <>
                    <div className="mb-8 p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <h3 className="font-bold text-slate-700 mb-3">参加者を選択 (クリックで追加)</h3>
                      <div className="flex flex-wrap gap-2">
                        {dbPlayers.map(p => {
                          const isEntry = entryPlayerIds.includes(p.id);
                          return (
                            <button key={p.id} onClick={() => toggleEntry(p.id)}
                              className={`px-4 py-2 rounded-full font-bold text-sm transition border-2 ${isEntry ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 hover:border-indigo-400'}`}>
                              <PlayerLabel name={p.name} /> {isEntry && '✓'}
                            </button>
                          );
                        })}
                      </div>
                    </div>

                    <div className="flex flex-col md:flex-row gap-6 items-end border-t pt-6">
                      <div className="w-full md:w-auto">
                        <label className="block text-sm font-bold text-slate-600 mb-2">参加予定</label>
                        <div className="text-2xl font-black text-indigo-600">{entryPlayerIds.length} <span className="text-base text-slate-500 font-normal">名</span></div>
                      </div>
                      <div className="w-full md:w-auto">
                        <label className="block text-sm font-bold text-slate-600 mb-2">回戦数</label>
                        <input type="number" min="1" value={roundsCount} onChange={e => setRoundsCount(Number(e.target.value))} className="w-24 p-3 border rounded-lg text-lg font-bold text-center"/>
                      </div>
                      <div className="flex-1"></div>
                      <button onClick={handleGenerateTables} className="w-full md:w-auto bg-indigo-600 hover:bg-indigo-700 text-white font-bold py-4 px-8 rounded-xl shadow-lg transition">
                        自動卓組を生成して大会開始 ➡️
                      </button>
                    </div>
                    <p className="text-xs text-slate-500 mt-4 leading-relaxed">
                      ※ 最後から2つ目・最後の回戦は、それ以前の全ての対局が終了した瞬間に順位順（1234／5678…）で自動決定されます。<br />
                      　 最後から2つ目は卓内上位から東南西北、最終戦は卓内下位から東南西北に着席。上位2卓（8位まで）に「黒子」は入らず、その下を繰り上げます。
                    </p>
                  </>
                )}
              </div>
            )}

            {tournamentPhase === 'playing' && (
              <div className="space-y-6">
                <div className="bg-indigo-50 border border-indigo-100 p-4 rounded-xl">
                  <div className="flex justify-between items-center gap-4">
                    <div>
                      <h2 className="text-lg font-black text-indigo-900">大会進行中</h2>
                      <p className="text-sm text-indigo-700 font-medium">参加者: {entryPlayerIds.length}名 / 全{roundsCount}回戦</p>
                    </div>
                    {isAdmin && (
                      <div className="flex gap-2">
                        <button onClick={() => setShowAdminTools(!showAdminTools)} className={`px-4 py-2 rounded-lg font-bold text-sm transition ${showAdminTools ? 'bg-slate-800 text-white' : 'bg-white text-slate-600 border border-slate-300 hover:bg-slate-100'}`}>
                          🛠️ 選手の追加・差し替え
                        </button>
                        <button onClick={handleResetTournament} className="bg-red-100 hover:bg-red-200 text-red-700 px-4 py-2 rounded-lg font-bold text-sm transition">
                          大会をリセット
                        </button>
                      </div>
                    )}
                  </div>
                  {/* 開始時刻の目安 */}
                  <p className="mt-3 text-[10px] text-indigo-400 leading-relaxed">
                    開始時刻（目安）:&nbsp;
                    {ROUND_START_TIMES.slice(0, roundsCount).map((t, i) => (
                      <span key={i} className="mr-2 whitespace-nowrap">{i + 1}回戦 {t}</span>
                    ))}
                  </p>
                </div>

                {/* ---- 管理者用ツール ---- */}
                {isAdmin && showAdminTools && (
                  <div className="bg-white border-2 border-slate-800 rounded-2xl p-5 space-y-5">
                    <div className="flex items-start justify-between gap-4">
                      <h3 className="font-black text-slate-800">🛠️ 選手の追加・差し替え（管理者用）</h3>
                      <p className="text-[11px] text-slate-400 text-right leading-relaxed">
                        誤操作防止のため、確認ダイアログを経てから反映されます。<br />送信済みの卓は変更できません。
                      </p>
                    </div>

                    {/* 追加 */}
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <h4 className="font-bold text-sm text-slate-700 mb-3">① 大会に選手を追加（途中参加）</h4>
                      <div className="grid md:grid-cols-2 gap-4">
                        <div className="flex gap-2">
                          <select value={addExistingId} onChange={e => setAddExistingId(e.target.value)} className="flex-1 p-2.5 border rounded-lg bg-white text-sm">
                            <option value="">登録済みの選手から選ぶ...</option>
                            {dbPlayers.filter(p => !entryPlayerIds.includes(p.id)).map(p => (
                              <option key={p.id} value={p.id}>{proMarkedName(p.name)}</option>
                            ))}
                          </select>
                          <button onClick={handleAddExistingToTournament} disabled={!addExistingId} className="px-4 py-2 rounded-lg font-bold text-sm bg-indigo-600 text-white disabled:bg-slate-200 disabled:text-slate-400 transition">追加</button>
                        </div>
                        <div className="flex gap-2">
                          <input value={quickName} onChange={e => setQuickName(e.target.value)} placeholder="新規選手名（例: 黒子A）" className="flex-1 p-2.5 border rounded-lg bg-white text-sm" />
                          <button onClick={handleQuickRegister} disabled={!quickName.trim()} className="px-4 py-2 rounded-lg font-bold text-sm bg-slate-800 text-white disabled:bg-slate-200 disabled:text-slate-400 transition whitespace-nowrap">登録して追加</button>
                        </div>
                      </div>
                      <p className="text-[11px] text-slate-400 mt-2">追加した選手は下の「差し替え」で席に入れてください。</p>
                    </div>

                    {/* 差し替え */}
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <h4 className="font-bold text-sm text-slate-700 mb-3">② 席の差し替え（1人を別の選手に交代）</h4>
                      <div className="grid md:grid-cols-3 gap-3 items-center">
                        <select value={replaceSeatKey} onChange={e => setReplaceSeatKey(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">対象の席を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <select value={replaceWithId} onChange={e => setReplaceWithId(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">交代する選手を選ぶ...</option>
                          {dbPlayers.map(p => <option key={p.id} value={p.id}>{proMarkedName(p.name)}{entryPlayerIds.includes(p.id) ? '' : '（未エントリー）'}</option>)}
                        </select>
                        <button onClick={handleReplaceSeat} disabled={!replaceSeatKey || !replaceWithId} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-amber-500 hover:bg-amber-600 text-white disabled:bg-slate-200 disabled:text-slate-400 transition">
                          差し替える
                        </button>
                      </div>
                    </div>

                    {/* 入れ替え */}
                    <div className="p-4 bg-slate-50 rounded-xl border border-slate-200">
                      <h4 className="font-bold text-sm text-slate-700 mb-3">③ 席の入れ替え（同じ回戦の2人を交換）</h4>
                      <div className="grid md:grid-cols-3 gap-3 items-center">
                        <select value={swapSeatA} onChange={e => setSwapSeatA(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">席A を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <select value={swapSeatB} onChange={e => setSwapSeatB(e.target.value)} className="p-2.5 border rounded-lg bg-white text-sm">
                          <option value="">席B を選ぶ...</option>
                          {editableSeats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
                        </select>
                        <button onClick={handleSwapSeats} disabled={!swapSeatA || !swapSeatB} className="px-4 py-2.5 rounded-lg font-bold text-sm bg-teal-600 hover:bg-teal-700 text-white disabled:bg-slate-200 disabled:text-slate-400 transition">
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
                  const time = roundStartTime(r.round);
                  return (
                    <div key={r.round} className={`bg-white rounded-2xl shadow-sm border transition ${finished ? 'border-slate-200' : 'border-indigo-100'}`}>
                      {/* 回戦ヘッダー */}
                      <div className="flex flex-wrap items-center gap-3 p-4 md:p-5">
                        <button onClick={() => toggleRound(r)} className="flex items-center gap-3 text-left group">
                          <span className={`w-7 h-7 rounded-lg flex items-center justify-center font-black text-sm transition ${open ? 'bg-slate-800 text-white' : 'bg-slate-200 text-slate-500 group-hover:bg-slate-300'}`}>
                            {open ? '−' : '+'}
                          </span>
                          <span className="text-xl md:text-2xl font-black text-slate-800">{r.round}回戦</span>
                        </button>

                        {time && <span className="text-[11px] text-slate-400 font-bold">開始目安 {time}〜</span>}

                        {r.mode === 'rankTopFirst' && <span className="text-[11px] font-bold bg-amber-100 text-amber-800 px-2 py-1 rounded">順位戦 / 上位から東南西北</span>}
                        {r.mode === 'rankBottomFirst' && <span className="text-[11px] font-bold bg-rose-100 text-rose-800 px-2 py-1 rounded">最終戦 / 下位から東南西北</span>}
                        {finished && <span className="text-[11px] font-bold bg-slate-200 text-slate-600 px-2 py-1 rounded-full">✓ 全{r.tables.length}卓 終了</span>}

                        <div className="flex-1" />

                        {!r.isPending && r.tables.length > 0 && open && (
                          <div className="flex gap-1">
                            <button onClick={() => setAllTablesOfRound(r, false)} className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-500 px-2.5 py-1.5 rounded-lg font-bold transition">全て畳む</button>
                            <button onClick={() => setAllTablesOfRound(r, true)} className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-500 px-2.5 py-1.5 rounded-lg font-bold transition">全て開く</button>
                          </div>
                        )}
                        {!r.isPending && isAdmin && r.mode !== 'normal' && !r.tables.some(t => t.isSubmitted) && (
                          <button onClick={() => handleReshufflePendingRound(rIdx)} className="text-[11px] bg-slate-100 hover:bg-slate-200 text-slate-600 px-2.5 py-1.5 rounded-lg font-bold transition">
                            🔄 現在の順位で再決定
                          </button>
                        )}
                      </div>

                      {open && (
                        <div className="px-4 md:px-5 pb-5 border-t border-slate-100 pt-5">
                          {r.isPending ? (
                            <div className="p-8 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 text-center">
                              <p className="text-3xl mb-2">🔒</p>
                              <p className="font-black text-slate-600 mb-1">卓組はまだ決定していません</p>
                              <p className="text-sm text-slate-500">
                                {r.round - 1}回戦までの全ての対局が終了した瞬間に、順位順（1234／5678…）で自動決定されます。
                              </p>
                              <p className="text-xs text-slate-400 mt-2">
                                席順: {r.mode === 'rankBottomFirst' ? '卓内下位から 東→南→西→北' : '卓内上位から 東→南→西→北'} ／ 上位2卓（8位まで）に「黒子」は入りません
                              </p>
                            </div>
                          ) : (
                            <>
                              {(r.sitOutIds && r.sitOutIds.length > 0) && (
                                <p className="text-xs text-slate-500 mb-4">
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
                                          : table.isSubmitted ? 'bg-slate-50 border-slate-200'
                                          : table.isCalculated ? 'bg-slate-50 border-indigo-200'
                                          : 'bg-white border-indigo-100'
                                      }`}
                                    >
                                      {isFinal && (
                                        <div className="absolute -top-3 left-4 px-3 py-0.5 rounded-full bg-gradient-to-r from-amber-400 to-amber-600 text-white text-[11px] font-black shadow-md tracking-wider">
                                          👑 決勝卓
                                        </div>
                                      )}

                                      {/* 卓ヘッダー（クリックで開閉） */}
                                      <button onClick={() => toggleTable(r, table)} className="w-full flex justify-between items-center gap-2 p-4 md:p-5 pb-3 text-left">
                                        <div className="flex items-center gap-2">
                                          <h4 className={`font-black text-lg px-3 py-1 rounded ${isFinal ? 'bg-gradient-to-r from-amber-500 to-amber-600 text-white' : table.isSubmitted ? 'bg-slate-400 text-white' : 'bg-slate-800 text-white'}`}>
                                            {table.tableNumber}卓
                                          </h4>
                                          <span className={`text-slate-400 text-xs font-bold`}>{isOpen ? '▼' : '▶'}</span>
                                        </div>
                                        <div className="flex items-center gap-2">
                                          {tableChonbo > 0 && (
                                            <span className="text-[11px] px-2 py-1 rounded-full font-bold bg-red-100 text-red-700">🚫 {tableChonbo}</span>
                                          )}
                                          {table.isSubmitted ? (
                                            <span className="text-xs px-3 py-1 rounded-full font-bold bg-slate-300 text-slate-700">✓ 送信済み</span>
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
                                              <span className="truncate text-slate-600">
                                                <span className="text-slate-400 font-mono mr-1.5">{table.isSubmitted ? i2 + 1 : '-'}</span>
                                                <PlayerLabel name={p.name} />
                                                <span className="text-slate-400 text-xs ml-1.5">({p.wind})</span>
                                              </span>
                                              <span className={`font-bold tabular-nums ${!table.isSubmitted && !table.isCalculated ? 'text-slate-300' : p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                                {table.isSubmitted || table.isCalculated ? fmtPt(p.point) : '-'}
                                              </span>
                                            </div>
                                          ))}
                                        </div>
                                      )}

                                      {/* 展開時 */}
                                      {isOpen && (
                                        <div className="px-4 md:px-5 pb-5">
                                          <div className="space-y-3">
                                            {table.players.map((p, pIdx) => {
                                              const chonbo = p.chonbo || 0;
                                              return (
                                                <div key={pIdx} className={`p-2 rounded-lg ${table.isSubmitted ? 'opacity-80' : 'bg-slate-50'} ${chonbo > 0 ? 'ring-1 ring-red-200 bg-red-50/60' : ''}`}>
                                                  <div className="flex justify-between items-center gap-3">
                                                    <span className="w-28 font-bold text-slate-700 truncate">
                                                      {p.wind}: <PlayerLabel name={p.name} className="text-indigo-900" />
                                                    </span>
                                                    
                                                    <div className={`flex items-center border-2 rounded-lg px-2 py-1.5 transition ${table.isSubmitted || !isAdmin ? 'bg-slate-200 border-slate-300' : 'bg-white focus-within:border-indigo-500'}`}>
                                                      <input
                                                        type="number" value={p.score} disabled={table.isSubmitted || !isAdmin}
                                                        onChange={(e) => handleScoreChange(rIdx, tIdx, pIdx, Number(e.target.value))}
                                                        className={`w-16 text-right font-mono font-bold text-lg outline-none ${table.isSubmitted || !isAdmin ? 'bg-transparent text-slate-600' : 'text-slate-800'}`}
                                                      />
                                                      <span className="text-slate-400 font-bold text-sm ml-1 select-none">00</span>
                                                    </div>

                                                    <span className={`w-20 text-right font-black text-xl ${!table.isCalculated && !table.isSubmitted ? 'text-slate-300' : p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                                      {table.isCalculated || table.isSubmitted ? fmtPt(p.point) : '-'}
                                                    </span>
                                                  </div>

                                                  {/* チョンボ */}
                                                  {(isAdmin && !table.isSubmitted) ? (
                                                    <div className="flex items-center justify-end gap-2 mt-2 pr-1">
                                                      <span className="text-[11px] font-bold text-slate-400 mr-auto pl-1">チョンボ</span>
                                                      <button onClick={() => handleChonboChange(rIdx, tIdx, pIdx, -1)}
                                                        className="w-7 h-7 rounded-md bg-white border border-slate-300 text-slate-600 font-black hover:bg-slate-100 transition disabled:opacity-40"
                                                        disabled={chonbo === 0}>−</button>
                                                      <span className={`w-8 text-center font-black tabular-nums ${chonbo > 0 ? 'text-red-600' : 'text-slate-400'}`}>{chonbo}</span>
                                                      <button onClick={() => handleChonboChange(rIdx, tIdx, pIdx, 1)}
                                                        className="w-7 h-7 rounded-md bg-red-500 text-white font-black hover:bg-red-600 transition">＋</button>
                                                      <span className={`w-16 text-right text-xs font-bold ${chonbo > 0 ? 'text-red-600' : 'text-slate-300'}`}>
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

                                          {isAdmin && (
                                            <div className="mt-6 flex gap-2">
                                              {!table.isSubmitted ? (
                                                <>
                                                  <button onClick={() => calculateTablePoints(rIdx, tIdx)} className={`flex-1 py-3 rounded-lg font-bold text-sm transition ${table.isCalculated ? 'bg-slate-200 text-slate-600' : 'bg-indigo-600 text-white'}`}>
                                                    {table.isCalculated ? '再計算' : '計算・確定'}
                                                  </button>
                                                  <button onClick={() => handleSubmitTable(rIdx, tIdx)} disabled={!table.isCalculated} className={`flex-1 py-3 rounded-lg font-bold text-sm transition ${table.isCalculated ? 'bg-green-500 text-white' : 'bg-slate-100 text-slate-400 cursor-not-allowed'}`}>
                                                    クラウドへ送信
                                                  </button>
                                                </>
                                              ) : (
                                                <button onClick={() => handleRevokeTable(rIdx, tIdx)} className="flex-1 py-3 rounded-lg font-bold text-sm transition bg-amber-100 hover:bg-amber-200 text-amber-800 border border-amber-300">
                                                  送信を取り消して編集する
                                                </button>
                                              )}
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

              </div>
            )}
          </div>
        )}
      </div>

    </main>
  );
}
