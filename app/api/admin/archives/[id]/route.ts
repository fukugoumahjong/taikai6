import { NextRequest } from 'next/server';
import { handler, json, readJson, requireAdmin, HttpError } from '@/lib/authz';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { asId, sanitizeStandings, sanitizeHanchans, sanitizePenalties } from '@/lib/validators';

// DELETE: 過去大会の削除（管理者のみ）
export const DELETE = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> | { id: string } }) => {
  await requireAdmin(req);
  const id = asId((await ctx.params).id);
  const { data, error } = await supabaseAdmin().from('tournament_archives').delete().eq('id', id).select();
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, '過去大会が見つかりません');
  return json({ archive: data[0] });
});

// PATCH { standings?, hanchans?, penalties? }: 過去大会の最終成績・半荘・ペナルティを更新する（管理者のみ）。
// 渡された項目だけを更新する。（半荘の並び直し、後からのペナルティ追加・取り消しで使う）
export const PATCH = handler(async (req: NextRequest, ctx: { params: Promise<{ id: string }> | { id: string } }) => {
  await requireAdmin(req);
  const id = asId((await ctx.params).id);
  const b = await readJson(req, 6_000_000);
  const patch: Record<string, unknown> = {};
  if (b.standings !== undefined) patch.standings = sanitizeStandings(b.standings);
  if (b.hanchans !== undefined) patch.hanchans = sanitizeHanchans(b.hanchans);
  if (b.penalties !== undefined) patch.penalties = sanitizePenalties(b.penalties);
  if (Object.keys(patch).length === 0) throw new HttpError(400, '更新する項目がありません');
  const { data, error } = await supabaseAdmin().from('tournament_archives').update(patch).eq('id', id).select('id');
  if (error) throw error;
  if (!data?.length) throw new HttpError(404, '過去大会が見つかりません');
  return json({ ok: true });
});
