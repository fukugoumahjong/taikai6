-- ============================================================
-- 過去大会データ(アーカイブ)用テーブル
-- Supabaseダッシュボード → SQL Editor に貼り付けて実行してください。
-- 既存の players / tournaments テーブルはそのままで、これを追加するだけです。
-- ============================================================

create table if not exists public.tournament_archives (
  id uuid primary key default gen_random_uuid(),
  name text not null,                              -- 例: 第4回高等学校複合麻雀競技大会
  rule_name text,                                   -- 例: 最高位戦ルール
  notes text,                                       -- 任意の備考（ペナルティの説明など）
  standings jsonb not null default '[]'::jsonb,     -- [{playerId, name, totalPoint, gameCount, rank}]
  hanchans jsonb not null default '[]'::jsonb,      -- [{no, deposit, results:[{playerId,name,rank,score,point,excluded}]}]
  created_at timestamptz not null default now()
);

alter table public.tournament_archives enable row level security;

drop policy if exists tournament_archives_select_all on public.tournament_archives;
create policy tournament_archives_select_all on public.tournament_archives for select using (true);

-- 書き込み(insert/update/delete)ポリシーは、既存の players / tournaments テーブルに
-- 設定しているものと同じ考え方で追加してください。
-- (今の実装はブラウザから直接 supabase-js で書き込む方式なので、
--  players/tournaments に anon 向けの insert/update/delete ポリシーが
--  既にある場合は、同じものをこのテーブルにも追加する必要があります)
--
-- 例（誰でも書き込める、最も簡単な設定。学内アプリとして手軽に運用したい場合向け）:
-- create policy tournament_archives_insert_all on public.tournament_archives for insert with check (true);
-- create policy tournament_archives_update_all on public.tournament_archives for update using (true);
-- create policy tournament_archives_delete_all on public.tournament_archives for delete using (true);
