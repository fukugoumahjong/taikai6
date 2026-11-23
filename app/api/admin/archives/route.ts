import { NextRequest } from 'next/server';
import { handler, json, readJson, requireAdmin } from '@/lib/authz';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { asText, sanitizeStandings, sanitizeHanchans, sanitizePenalties } from '@/lib/validators';

const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

// POST: 過去大会の保存（管理者のみ）
export const POST = handler(async (req: NextRequest) => {
  await requireAdmin(req);
  const b = await readJson(req, 6_000_000);
  const standings = sanitizeStandings(b.standings);
  const hanchans = sanitizeHanchans(b.hanchans);
  const penalties = sanitizePenalties(b.penalties ?? []);
  const { data, error } = await supabaseAdmin().from('tournament_archives').insert({
    name: asText(b.name, '大会名', 1, 100),
    rule_name: b.ruleName ? str(b.ruleName, 60) : null,
    notes: b.notes ? str(b.notes, 2000) : null,
    standings, hanchans, penalties,
  }).select().single();
  if (error) throw error;
  return json({ archive: data }, 201);
});
