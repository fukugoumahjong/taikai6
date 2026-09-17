'use client';

import React, { useState, useEffect, useRef } from 'react';

// ==========================================
// 1. 型定義
// ==========================================
type Player = {
  id: string;
  name: string;
  totalPoint: number;
  totalGames: number;
};

type PlayerScore = {
  playerId: string;
  wind: string;
  name: string;
  score: number; // 100点単位
  point: number;
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
};

// ==========================================
// 2. クラウド通信・データ管理 (モックAPI)
// ==========================================
const api = {
  getPlayers: async (): Promise<Player[]> => {
    const data = localStorage.getItem('mahjong_players');
    return data ? JSON.parse(data) : [];
  },
  savePlayer: async (player: Player) => {
    const players = await api.getPlayers();
    players.push(player);
    localStorage.setItem('mahjong_players', JSON.stringify(players));
  },
  updatePlayer: async (updatedPlayer: Player) => {
    const players = await api.getPlayers();
    const newPlayers = players.map(p => p.id === updatedPlayer.id ? updatedPlayer : p);
    localStorage.setItem('mahjong_players', JSON.stringify(newPlayers));
  },
  updatePlayersScores: async (updates: { id: string; pointDelta: number; gamesDelta: number }[]) => {
    const players = await api.getPlayers();
    const updated = players.map(p => {
      const update = updates.find(u => u.id === p.id);
      if (update) {
        return { 
          ...p, 
          totalPoint: Math.round((p.totalPoint + update.pointDelta) * 10) / 10, 
          totalGames: p.totalGames + update.gamesDelta 
        };
      }
      return p;
    });
    localStorage.setItem('mahjong_players', JSON.stringify(updated));
  },
  getCurrentTournament: async (): Promise<any> => {
    const data = localStorage.getItem('mahjong_current_tournament');
    return data ? JSON.parse(data) : null;
  },
  saveCurrentTournament: async (data: any) => {
    localStorage.setItem('mahjong_current_tournament', JSON.stringify(data));
  },
  clearCurrentTournament: async () => {
    localStorage.removeItem('mahjong_current_tournament');
  },
  // --- データ消失対策：ローカルへのエクスポート/インポート ---
  exportBackup: () => {
    const data = {
      players: localStorage.getItem('mahjong_players'),
      tournament: localStorage.getItem('mahjong_current_tournament')
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `mahjong_backup_${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
};

// ==========================================
// 3. メインコンポーネント
// ==========================================
export default function Home() {
  const [isLoaded, setIsLoaded] = useState(false);

  const [activeTab, setActiveTab] = useState<'tournament' | 'currentRanking' | 'players'>('tournament');
  const [tournamentPhase, setTournamentPhase] = useState<'entry' | 'playing'>('entry');
  
  const [dbPlayers, setDbPlayers] = useState<Player[]>([]);
  const [entryPlayerIds, setEntryPlayerIds] = useState<string[]>([]);
  
  const [roundsCount, setRoundsCount] = useState(4);
  const [seating, setSeating] = useState<Round[]>([]);
  
  const [isResetting, setIsResetting] = useState(false);
  const [resetCountdown, setResetCountdown] = useState(0);

  // OCRスキャン中のステート
  const [isScanning, setIsScanning] = useState<{rIdx: number, tIdx: number} | null>(null);

  const rule = { originPoint: 300, returnPoint: 300, uma: [30, 10, -10, -30] };

  // ----------------------------------------
  // 初期ロード＆自動バックアップ
  // ----------------------------------------
  useEffect(() => {
    const loadData = async () => {
      setDbPlayers(await api.getPlayers());
      const current = await api.getCurrentTournament();
      if (current) {
        if (current.tournamentPhase) setTournamentPhase(current.tournamentPhase);
        if (current.entryPlayerIds) setEntryPlayerIds(current.entryPlayerIds);
        if (current.roundsCount) setRoundsCount(current.roundsCount);
        if (current.seating) setSeating(current.seating);
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

  // プレイヤー編集用ステート
  const [editingPlayerId, setEditingPlayerId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ name: '', totalPoint: 0, totalGames: 0 });

  const handleRegisterPlayer = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newPlayerName.trim()) return;
    const newPlayer: Player = {
      id: crypto.randomUUID(),
      name: newPlayerName.trim(),
      totalPoint: newPlayerPoint,
      totalGames: newPlayerGames,
    };
    await api.savePlayer(newPlayer);
    setDbPlayers(await api.getPlayers());
    setNewPlayerName(''); setNewPlayerPoint(0); setNewPlayerGames(0);
    alert(`${newPlayer.name} を登録しました！`);
  };

  const startEditPlayer = (p: Player) => {
    setEditingPlayerId(p.id);
    setEditForm({ name: p.name, totalPoint: p.totalPoint, totalGames: p.totalGames });
  };

  const saveEditPlayer = async () => {
    if (!editingPlayerId) return;
    const player = dbPlayers.find(p => p.id === editingPlayerId);
    if (player) {
      const updated = { ...player, name: editForm.name, totalPoint: editForm.totalPoint, totalGames: editForm.totalGames };
      await api.updatePlayer(updated);
      setDbPlayers(await api.getPlayers());
    }
    setEditingPlayerId(null);
  };

  const toggleEntry = (id: string) => {
    if (entryPlayerIds.includes(id)) {
      setEntryPlayerIds(entryPlayerIds.filter(pid => pid !== id));
    } else {
      setEntryPlayerIds([...entryPlayerIds, id]);
    }
  };

  // ----------------------------------------
  // B. 卓組生成
  // ----------------------------------------
  const handleGenerateTables = () => {
    if (entryPlayerIds.length < 4) {
      alert('参加者は4名以上選択してください。');
      return;
    }
    const numTables = Math.floor(entryPlayerIds.length / 4);
    const activeIds = entryPlayerIds.slice(0, numTables * 4);
    const winds = ['東', '南', '西', '北'];
    const matchHistory: Record<string, Record<string, number>> = {};
    const windHistory: Record<string, Record<string, number>> = {};

    activeIds.forEach(id => {
      matchHistory[id] = {};
      windHistory[id] = { '東': 0, '南': 0, '西': 0, '北': 0 };
      activeIds.forEach(other => { matchHistory[id][other] = 0; });
    });

    const generatedRounds: Round[] = [];
    for (let r = 0; r < roundsCount; r++) {
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
            for (const seated of tablePlayerIds) {
              overlapCost += matchHistory[candidate][seated] || 0;
            }
            const windCost = windHistory[candidate][wind] || 0;
            const totalCost = (overlapCost * 100) + (windCost * 10);
            if (totalCost < minCost) { minCost = totalCost; bestCandidate = candidate; }
          }
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
            playerId: id, wind: winds[i], name: dbPlayers.find(p => p.id === id)?.name || '不明', score: 300, point: 0.0,
          })),
        });
      }
      generatedRounds.push({ round: r + 1, tables });
    }
    setSeating(generatedRounds);
    setTournamentPhase('playing');
  };

  // ----------------------------------------
  // C. スコア計算 (★同点折半ロジック追加)
  // ----------------------------------------
  const handleScoreChange = (rIdx: number, tIdx: number, pIdx: number, val: number) => {
    const updated = [...seating];
    if (updated[rIdx].tables[tIdx].isSubmitted) return;
    updated[rIdx].tables[tIdx].players[pIdx].score = val;
    updated[rIdx].tables[tIdx].isCalculated = false;
    setSeating(updated);
  };

  const calculateTablePoints = (rIdx: number, tIdx: number) => {
    const updated = [...seating];
    const table = updated[rIdx].tables[tIdx];
    const sum = table.players.reduce((acc, p) => acc + (p.score || 0), 0);
    const diff = 1200 - sum;
    
    if (diff < 0) { alert('得点の合計が120,000点を超えています。'); return; }
    if (diff % 10 !== 0) { alert('不足分が1,000点単位ではありません。'); return; }

    // まずスコア順に降順ソート
    const sorted = table.players.map((p, index) => ({ score: p.score, index })).sort((a, b) => b.score - a.score);
    
    let i = 0;
    while (i < sorted.length) {
      // 同じスコアのプレイヤーをグループ化
      let j = i;
      while (j < sorted.length && sorted[j].score === sorted[i].score) {
        j++;
      }
      
      const tieCount = j - i;
      // 該当する順位のウマを合算する
      let umaSum = 0;
      for (let k = i; k < j; k++) {
        umaSum += rule.uma[k];
      }
      // ウマを同点人数で等分
      const splitUma = umaSum / tieCount;

      // 素点に等分したウマを足して計算
      for (let k = i; k < j; k++) {
        const item = sorted[k];
        let pt = (item.score - rule.returnPoint) / 10;
        pt += splitUma;
        table.players[item.index].point = Math.round(pt * 10) / 10;
      }
      
      i = j; // 次の順位グループへ
    }

    table.isCalculated = true;
    setSeating(updated);
  };

  // OCRスキャンのモック処理
  const handleFileScan = (e: React.ChangeEvent<HTMLInputElement>, rIdx: number, tIdx: number) => {
    const file = e.target.files?.[0];
    if (!file) return;
    
    setIsScanning({rIdx, tIdx});
    // 画像解析にかかる時間を疑似体験 (2.5秒)
    setTimeout(() => {
      const updated = [...seating];
      const table = updated[rIdx].tables[tIdx];
      // 120,000点(1200)をランダムに分配するデモスコア
      const mockScores = [450, 310, 240, 200].sort(() => Math.random() - 0.5);
      
      table.players.forEach((p, i) => { p.score = mockScores[i]; });
      table.isCalculated = false;
      
      setSeating(updated);
      setIsScanning(null);
      alert('【スキャン完了】\n成績シートから点数を自動入力しました。\n※これはカメラOCR機能のデモです。');
      e.target.value = ''; // inputリセット
    }, 2500);
  };

  // ----------------------------------------
  // D. 送信と「送信の取り消し(編集)」
  // ----------------------------------------
  const handleSubmitTable = async (rIdx: number, tIdx: number) => {
    const table = seating[rIdx].tables[tIdx];
    if (!table.isCalculated) { alert('先にスコアを計算してください。'); return; }
    if (!window.confirm('クラウドに送信しますか？')) return;

    const updates = table.players.map(p => ({ id: p.playerId, pointDelta: p.point, gamesDelta: 1 }));
    await api.updatePlayersScores(updates);
    setDbPlayers(await api.getPlayers());

    const updated = [...seating];
    updated[rIdx].tables[tIdx].isSubmitted = true;
    setSeating(updated);
  };

  const handleRevokeTable = async (rIdx: number, tIdx: number) => {
    const table = seating[rIdx].tables[tIdx];
    if (!window.confirm('【警告】\nこの卓の送信を取り消し、成績を編集できるようにしますか？\n※通算成績に加算されたポイントは一旦マイナスされます。')) return;

    // ロールバック（マイナスして元に戻す）
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
  // E. 大会全体のリセット (30秒)
  // ----------------------------------------
  const handleResetTournament = async () => {
    if (!window.confirm('【警告】現在の大会の進行を全てリセットしますか？')) return;
    setIsResetting(true);
    let count = 30; // 誤操作防止の30秒
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
  // F. 「黒子」を除外したデータ集計
  // ----------------------------------------
  const displayDbPlayers = dbPlayers
    .filter(p => !p.name.includes('黒子'))
    .sort((a, b) => b.totalPoint - a.totalPoint);

  const displayCurrentRanking = entryPlayerIds
    .map(id => {
      const player = dbPlayers.find(p => p.id === id);
      let pt = 0; let games = 0;
      seating.forEach(r => r.tables.forEach(t => {
        if (t.isCalculated) {
          const matchPlayer = t.players.find(mp => mp.playerId === id);
          if (matchPlayer) { pt += matchPlayer.point; games += 1; }
        }
      }));
      return { id, name: player?.name || '不明', point: Math.round(pt * 10) / 10, games };
    })
    .filter(p => !p.name.includes('黒子'))
    .sort((a, b) => b.point - a.point);


  // ==========================================
  // Render (UI構築)
  // ==========================================
  
  // JSON復元用ハンドラ
  const handleDataImport = (e: React.ChangeEvent<HTMLInputElement>) => {
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

  if (!isLoaded) return <div className="min-h-screen bg-slate-100 flex items-center justify-center font-bold text-lg animate-pulse">データを読み込んでいます...</div>;

  return (
    <main className="min-h-screen bg-slate-100 text-slate-800 font-sans relative pb-20">
      
      {/* リセット中のオーバーレイ画面 (30秒) */}
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

      {/* スキャン中のオーバーレイ画面 */}
      {isScanning && (
        <div className="fixed inset-0 bg-black/70 z-50 flex flex-col items-center justify-center text-white">
          <div className="animate-pulse flex flex-col items-center">
            <div className="w-16 h-16 border-4 border-teal-500 border-t-transparent rounded-full animate-spin mb-4"></div>
            <h2 className="text-xl font-bold">成績シートを解析中...</h2>
            <p className="text-slate-300 mt-2">カメラで読み込んだ数値を認識しています</p>
          </div>
        </div>
      )}

      {/* ヘッダー */}
      <header className="bg-slate-900 text-white p-4 shadow-md sticky top-0 z-40">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row justify-between items-center gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-wider">高等学校複合麻雀競技大会</h1>
            <p className="text-xs text-slate-400">最高位戦ルール (30000/30000)</p>
          </div>
          
          <div className="flex flex-wrap gap-2 items-center">
            <div className="flex bg-slate-800 p-1 rounded-lg">
              <button onClick={() => setActiveTab('tournament')} className={`px-4 py-2 rounded-md font-bold text-sm transition ${activeTab === 'tournament' ? 'bg-indigo-600' : 'text-slate-300 hover:text-white'}`}>大会進行</button>
              <button onClick={() => setActiveTab('currentRanking')} className={`px-4 py-2 rounded-md font-bold text-sm transition ${activeTab === 'currentRanking' ? 'bg-teal-600' : 'text-slate-300 hover:text-white'}`}>今大会成績</button>
              <button onClick={() => setActiveTab('players')} className={`px-4 py-2 rounded-md font-bold text-sm transition ${activeTab === 'players' ? 'bg-indigo-600' : 'text-slate-300 hover:text-white'}`}>マスタ</button>
            </div>

            {/* データ消失対策: バックアップ/復元 */}
            <div className="flex gap-2 ml-4 border-l border-slate-700 pl-4">
              <button onClick={api.exportBackup} className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-md transition" title="データをファイルとして保存します">💾 バックアップ</button>
              <label className="text-xs bg-slate-700 hover:bg-slate-600 px-3 py-2 rounded-md transition cursor-pointer" title="保存したファイルから復元します">
                📂 復元
                <input type="file" accept=".json" className="hidden" onChange={handleDataImport} />
              </label>
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto p-6">
        
        {/* ==========================================
            タブ1: 通算成績 / プレイヤーマスタ
            ========================================== */}
        {activeTab === 'players' && (
          <div className="space-y-8 animate-in fade-in duration-300">
            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-xl font-bold mb-6 flex items-center gap-2">新規プレイヤーの登録</h2>
              <form onSubmit={handleRegisterPlayer} className="grid grid-cols-1 md:grid-cols-4 gap-4 items-end">
                <div className="md:col-span-2">
                  <label className="block text-sm font-bold text-slate-600 mb-1">プレイヤー名 (黒子はランキング除外)</label>
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
                <button type="submit" className="md:col-span-4 mt-2 bg-slate-800 hover:bg-slate-700 text-white font-bold py-3 rounded-lg transition">登録して保存</button>
              </form>
            </div>

            <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
              <h2 className="text-xl font-bold mb-4">クラウド全通算成績ランキング (黒子除外)</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="bg-slate-100 border-b border-slate-200 text-slate-600 text-sm">
                      <th className="p-4 font-bold">順位</th>
                      <th className="p-4 font-bold">プレイヤー名</th>
                      <th className="p-4 font-bold text-right">通算対局数</th>
                      <th className="p-4 font-bold text-right">通算ポイント</th>
                      <th className="p-4 font-bold text-center">操作</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayDbPlayers.map((p, i) => (
                      <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="p-4 font-bold text-slate-400">{i + 1}</td>
                        {editingPlayerId === p.id ? (
                          <>
                            <td className="p-2"><input type="text" value={editForm.name} onChange={e => setEditForm({...editForm, name: e.target.value})} className="border p-1 w-full rounded" /></td>
                            <td className="p-2 text-right"><input type="number" value={editForm.totalGames} onChange={e => setEditForm({...editForm, totalGames: Number(e.target.value)})} className="border p-1 w-20 text-right rounded" /></td>
                            <td className="p-2 text-right"><input type="number" step="0.1" value={editForm.totalPoint} onChange={e => setEditForm({...editForm, totalPoint: Number(e.target.value)})} className="border p-1 w-24 text-right rounded" /></td>
                            <td className="p-2 text-center">
                              <button onClick={saveEditPlayer} className="bg-indigo-600 text-white px-3 py-1 rounded text-sm font-bold">保存</button>
                              <button onClick={() => setEditingPlayerId(null)} className="ml-2 text-slate-400 text-sm">取消</button>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="p-4 font-bold text-lg">{p.name}</td>
                            <td className="p-4 text-right text-slate-500">{p.totalGames} 半荘</td>
                            <td className={`p-4 text-right font-black text-lg ${p.totalPoint > 0 ? 'text-blue-600' : p.totalPoint < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                              {p.totalPoint > 0 ? `+${p.totalPoint.toFixed(1)}` : p.totalPoint.toFixed(1)}
                            </td>
                            <td className="p-4 text-center">
                              <button onClick={() => startEditPlayer(p)} className="bg-slate-200 hover:bg-slate-300 text-slate-700 px-3 py-1 rounded text-sm font-bold transition">編集</button>
                            </td>
                          </>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </div>
        )}

        {/* ==========================================
            タブ2: 今大会の成績
            ========================================== */}
        {activeTab === 'currentRanking' && (
          <div className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200 animate-in fade-in duration-300">
            <h2 className="text-2xl font-black mb-6 text-teal-800 border-b pb-2">🏆 今大会のポイントランキング (黒子除外)</h2>
            {tournamentPhase === 'entry' ? (
              <p className="text-slate-500">大会が始まっていません。</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse whitespace-nowrap">
                  <thead>
                    <tr className="bg-teal-50 border-b border-teal-100 text-teal-700 text-sm">
                      <th className="p-4 font-bold">順位</th>
                      <th className="p-4 font-bold">プレイヤー名</th>
                      <th className="p-4 font-bold text-right">消化局数</th>
                      <th className="p-4 font-bold text-right">今大会ポイント</th>
                    </tr>
                  </thead>
                  <tbody>
                    {displayCurrentRanking.map((p, i) => (
                      <tr key={p.id} className="border-b border-slate-100 hover:bg-slate-50">
                        <td className="p-4 font-bold text-slate-400">{i + 1}</td>
                        <td className="p-4 font-bold text-lg">{p.name}</td>
                        <td className="p-4 text-right text-slate-500">{p.games} 半荘</td>
                        <td className={`p-4 text-right font-black text-lg ${p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-slate-400'}`}>
                          {p.point > 0 ? `+${p.point.toFixed(1)}` : p.point.toFixed(1)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ==========================================
            タブ3: 大会の進行 (エントリー / スコア入力)
            ========================================== */}
        {activeTab === 'tournament' && (
          <div className="space-y-6 animate-in fade-in duration-300">
            
            {tournamentPhase === 'entry' && (
              <div className="bg-white p-6 md:p-8 rounded-2xl shadow-sm border border-slate-200">
                <h2 className="text-2xl font-black text-indigo-900 mb-6">今大会のエントリー</h2>
                <div className="mb-8 p-4 bg-slate-50 rounded-xl border border-slate-200">
                  <h3 className="font-bold text-slate-700 mb-3">参加者を選択 (クリックで追加)</h3>
                  <div className="flex flex-wrap gap-2">
                    {dbPlayers.map(p => {
                      const isEntry = entryPlayerIds.includes(p.id);
                      return (
                        <button key={p.id} onClick={() => toggleEntry(p.id)}
                          className={`px-4 py-2 rounded-full font-bold text-sm transition border-2 ${isEntry ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-600 hover:border-indigo-400'}`}>
                          {p.name} {isEntry && '✓'}
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
              </div>
            )}

            {tournamentPhase === 'playing' && (
              <div className="space-y-8">
                <div className="flex justify-between items-center bg-indigo-50 border border-indigo-100 p-4 rounded-xl">
                  <div>
                    <h2 className="text-lg font-black text-indigo-900">大会進行中</h2>
                    <p className="text-sm text-indigo-700 font-medium">参加者: {entryPlayerIds.length}名 / 全{roundsCount}回戦</p>
                  </div>
                  <button onClick={handleResetTournament} className="bg-red-100 hover:bg-red-200 text-red-700 px-4 py-2 rounded-lg font-bold text-sm transition">
                    大会をリセット
                  </button>
                </div>

                {seating.map((r, rIdx) => (
                  <div key={r.round} className="bg-white p-6 rounded-2xl shadow-sm border border-slate-200">
                    <h3 className="text-2xl font-black mb-6 border-b pb-2 text-slate-800">第 {r.round} 回戦</h3>
                    <div className="grid lg:grid-cols-2 gap-6">
                      
                      {r.tables.map((table, tIdx) => {
                        const currentSum = table.players.reduce((sum, p) => sum + (p.score || 0), 0);
                        const diff = 1200 - currentSum;
                        const isValidSum = diff >= 0 && diff % 10 === 0;

                        return (
                          <div key={table.tableNumber} className={`border-2 p-5 rounded-xl transition relative ${table.isSubmitted ? 'bg-slate-100 border-slate-300' : table.isCalculated ? 'bg-slate-50 border-indigo-200' : 'bg-white border-indigo-100'}`}>
                            
                            {/* OCRカメラスキャンボタン */}
                            {!table.isSubmitted && (
                              <label className="absolute -top-3 -right-3 bg-teal-500 hover:bg-teal-600 text-white p-2 rounded-full shadow-lg cursor-pointer transition transform hover:scale-110 z-10" title="成績シートをカメラで読み込む">
                                📷
                                <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => handleFileScan(e, rIdx, tIdx)} />
                              </label>
                            )}

                            <div className="flex justify-between items-center mb-4">
                              <h4 className={`font-black text-lg px-3 py-1 rounded ${table.isSubmitted ? 'bg-slate-400 text-white' : 'bg-slate-800 text-white'}`}>
                                卓 {table.tableNumber}
                              </h4>
                              {table.isSubmitted ? (
                                <span className="text-sm px-3 py-1 rounded-full font-bold bg-slate-300 text-slate-700">✓ 送信済み</span>
                              ) : (
                                <span className={`text-xs px-2 py-1 rounded-full font-bold ${isValidSum ? 'bg-green-100 text-green-700' : 'bg-red-100 text-red-600'}`}>
                                  {isValidSum ? (diff === 0 ? '合計: 120000点 ✓' : `合計: ${currentSum}00 (供託等: ${diff}00) ✓`) : `異常: ${currentSum}00点 ✗`}
                                </span>
                              )}
                            </div>

                            <div className="space-y-3">
                              {table.players.map((p, pIdx) => (
                                <div key={pIdx} className={`flex justify-between items-center gap-3 p-2 rounded-lg ${table.isSubmitted ? 'opacity-70' : 'bg-slate-50'}`}>
                                  <span className="w-24 font-bold text-slate-700 truncate">{p.wind}: <span className="text-indigo-900">{p.name}</span></span>
                                  
                                  <div className={`flex items-center border-2 rounded-lg px-2 py-1.5 transition ${table.isSubmitted ? 'bg-slate-200 border-slate-300' : 'bg-white focus-within:border-indigo-500'}`}>
                                    <input
                                      type="number" value={p.score} disabled={table.isSubmitted}
                                      onChange={(e) => handleScoreChange(rIdx, tIdx, pIdx, Number(e.target.value))}
                                      className={`w-16 text-right font-mono font-bold text-lg outline-none ${table.isSubmitted ? 'bg-transparent text-slate-600' : 'text-slate-800'}`}
                                    />
                                    <span className="text-slate-400 font-bold text-sm ml-1 select-none">00</span>
                                  </div>

                                  <span className={`w-20 text-right font-black text-xl ${!table.isCalculated ? 'text-slate-300' : p.point > 0 ? 'text-blue-600' : p.point < 0 ? 'text-red-600' : 'text-slate-500'}`}>
                                    {table.isCalculated ? (p.point > 0 ? `+${p.point.toFixed(1)}` : p.point.toFixed(1)) : '-'}
                                  </span>
                                </div>
                              ))}
                            </div>

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

                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}

              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}