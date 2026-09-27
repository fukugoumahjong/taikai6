-- ============================================================
-- 選手ログイン機能用のマイグレーション
-- Supabase の SQL Editor でそのまま実行してください。
-- ============================================================

-- players テーブルにログインコード用の列を追加
alter table public.players add column if not exists login_code text;

-- コードの重複を防ぐ（NULLは複数あってもOK。未発行の選手がいても問題ありません）
create unique index if not exists players_login_code_unique
  on public.players (login_code)
  where login_code is not null;

-- players テーブルは既に anon からの select/insert/update ポリシーがある想定です。
-- login_code 列もそれらの既存ポリシーでそのまま読み書きできます（列単位の追加設定は不要）。
-- もし players テーブル自体の書き込みで 401 エラーが出る場合は、
-- fix_archive_permissions.sql と同じ内容を players テーブル向けに実行してください。
