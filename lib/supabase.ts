import { createClient, SupabaseClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

// ブラウザ上での複数インスタンス生成（GoTrueClient警告）を防ぐ
declare global {
  var supabaseClient: SupabaseClient | undefined;
}

export const supabase =
  global.supabaseClient || createClient(supabaseUrl, supabaseAnonKey);

if (process.env.NODE_ENV !== 'production') {
  global.supabaseClient = supabase;
}