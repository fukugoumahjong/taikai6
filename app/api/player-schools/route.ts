// 配置先: app/api/player-schools/route.ts（src/app を使っている場合は src/app/api/player-schools/route.ts）
// 選手の所属学校（非公開）の読み書きAPI。
// ・管理者としてログイン（NextAuth）している人だけが使える
// ・Supabaseへは、サーバー側だけにある service_role キーでアクセスする（ブラウザには渡らない）
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import { createClient } from '@supabase/supabase-js';

export const dynamic = 'force-dynamic';

const adminEmails = () =>
  (process.env.NEXT_PUBLIC_ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);

const isAdminRequest = async (req: NextRequest) => {
  const token = await getToken({ req });
  const email = token?.email;
  return !!email && adminEmails().includes(email);
};

const supabaseAdmin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

// 全員分の学校を { 選手ID: 学校名 } で返す
export async function GET(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  const { data, error } = await supabaseAdmin().from('player_schools').select('player_id, school');
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const schools: Record<string, string> = {};
  (data || []).forEach((r: { player_id: string; school: string }) => {
    if (r.school) schools[r.player_id] = r.school;
  });
  return NextResponse.json({ schools });
}

// 1人分の学校を保存する（空文字なら削除）
export async function PUT(req: NextRequest) {
  if (!(await isAdminRequest(req))) return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  let body: { playerId?: unknown; school?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'bad request' }, { status: 400 });
  }
  const playerId = typeof body.playerId === 'string' ? body.playerId : '';
  const school = typeof body.school === 'string' ? body.school.trim().slice(0, 100) : '';
  if (!playerId) return NextResponse.json({ error: 'playerId is required' }, { status: 400 });

  const sb = supabaseAdmin();
  const { error } = school
    ? await sb.from('player_schools').upsert({ player_id: playerId, school, updated_at: new Date().toISOString() }, { onConflict: 'player_id' })
    : await sb.from('player_schools').delete().eq('player_id', playerId);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ ok: true });
}
