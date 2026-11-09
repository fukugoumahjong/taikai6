// 置き場所: app/api/x/post/route.ts
//
// 大会の成績表（画像）と文面を、X（旧Twitter）に投稿するためのサーバー側API。
// 管理者としてログインしている人だけが呼び出せます。X のキーはサーバーの環境変数にだけ置き、ブラウザには出ません。
//
// 必要な環境変数（Vercel の Environment Variables など）:
//   X_API_KEY / X_API_KEY_SECRET           … X Developer Portal の「API Key / Secret」(Consumer Keys)
//   X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET … 同じアプリの「Access Token / Secret」（投稿するアカウントのもの。Read and Write 権限）
//   NEXTAUTH_SECRET                        … すでに設定済みのはず（next-auth 用）
//   NEXT_PUBLIC_ADMIN_EMAIL                … すでに設定済みのはず（管理者のメール。カンマ区切り）
import { NextRequest, NextResponse } from 'next/server';
import { getToken } from 'next-auth/jwt';
import crypto from 'crypto';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ---------- OAuth 1.0a の署名 ----------
const enc = (s: string) =>
  encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

function authHeader(method: string, url: string, query: Record<string, string> = {}): string {
  const key = process.env.X_API_KEY;
  const secret = process.env.X_API_KEY_SECRET;
  const token = process.env.X_ACCESS_TOKEN;
  const tokenSecret = process.env.X_ACCESS_TOKEN_SECRET;
  if (!key || !secret || !token || !tokenSecret) {
    throw new Error('X のキーが設定されていません（X_API_KEY / X_API_KEY_SECRET / X_ACCESS_TOKEN / X_ACCESS_TOKEN_SECRET）');
  }
  const oauth: Record<string, string> = {
    oauth_consumer_key: key,
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_token: token,
    oauth_version: '1.0',
  };
  const all: Record<string, string> = { ...query, ...oauth };
  const paramString = Object.keys(all)
    .sort()
    .map((k) => `${enc(k)}=${enc(all[k])}`)
    .join('&');
  const base = [method.toUpperCase(), enc(url), enc(paramString)].join('&');
  oauth.oauth_signature = crypto.createHmac('sha1', `${enc(secret)}&${enc(tokenSecret)}`).update(base).digest('base64');
  return (
    'OAuth ' +
    Object.keys(oauth)
      .sort()
      .map((k) => `${enc(k)}="${enc(oauth[k])}"`)
      .join(', ')
  );
}

// ---------- 管理者チェック ----------
async function isAdminRequest(req: NextRequest): Promise<boolean> {
  const token = await getToken({ req, secret: process.env.NEXTAUTH_SECRET });
  const email = (token?.email as string | undefined) || '';
  const admins = (process.env.NEXT_PUBLIC_ADMIN_EMAIL || '')
    .split(',')
    .map((e) => e.trim())
    .filter(Boolean);
  return !!email && admins.includes(email);
}

// ---------- 画像のアップロード（media_id を返す） ----------
async function uploadImage(png: Buffer): Promise<string> {
  const errors: string[] = [];
  const blob = () => new Blob([new Uint8Array(png)], { type: 'image/png' });

  // 1) 従来のアップロード（OAuth 1.0a 署名。マルチパートの本文は署名に含めない）
  try {
    const url = 'https://upload.twitter.com/1.1/media/upload.json';
    const form = new FormData();
    form.append('media', blob(), 'standings.png');
    form.append('media_category', 'tweet_image');
    const res = await fetch(url, { method: 'POST', headers: { Authorization: authHeader('POST', url) }, body: form });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      if (j.media_id_string) return String(j.media_id_string);
    }
    errors.push(`v1.1 ${res.status}: ${text.slice(0, 160)}`);
  } catch (e: any) {
    errors.push(`v1.1: ${e?.message || e}`);
  }

  // 2) v2 のアップロード（1 が使えない場合の予備）
  try {
    const url = 'https://api.x.com/2/media/upload';
    const form = new FormData();
    form.append('media', blob(), 'standings.png');
    form.append('media_category', 'tweet_image');
    form.append('media_type', 'image/png');
    const res = await fetch(url, { method: 'POST', headers: { Authorization: authHeader('POST', url) }, body: form });
    const text = await res.text();
    if (res.ok) {
      const j = JSON.parse(text);
      const id = j?.data?.id || j?.media_id_string;
      if (id) return String(id);
    }
    errors.push(`v2 ${res.status}: ${text.slice(0, 160)}`);
  } catch (e: any) {
    errors.push(`v2: ${e?.message || e}`);
  }

  throw new Error('画像のアップロードに失敗しました。' + errors.join(' / '));
}

export async function POST(req: NextRequest) {
  try {
    if (!(await isAdminRequest(req))) {
      return NextResponse.json({ error: '管理者としてログインしていません。' }, { status: 401 });
    }
    const body = await req.json();
    const action = body?.action === 'verify' ? 'verify' : 'post';

    // 接続確認: キーが正しいか（どのアカウントに投稿されるか）だけを確認する。投稿はしない
    if (action === 'verify') {
      const url = 'https://api.x.com/2/users/me';
      const res = await fetch(url, { headers: { Authorization: authHeader('GET', url) } });
      const text = await res.text();
      if (!res.ok) return NextResponse.json({ error: `接続確認に失敗しました (${res.status}): ${text.slice(0, 200)}` }, { status: 502 });
      const j = JSON.parse(text);
      return NextResponse.json({ ok: true, username: j?.data?.username, name: j?.data?.name });
    }

    const text: string = String(body?.text || '');
    const images: string[] = Array.isArray(body?.images) ? body.images : [];
    // 返信先のツイートID（各回戦の投稿は、直前の投稿への返信でつなぐ。最終メッセージは指定しない＝独立した投稿）
    const replyToId: string = body?.replyToId ? String(body.replyToId) : '';
    if (replyToId && !/^\d{1,25}$/.test(replyToId)) return NextResponse.json({ error: '返信先のIDが正しくありません。' }, { status: 400 });
    if (!text.trim()) return NextResponse.json({ error: '本文が空です。' }, { status: 400 });
    if (text.length > 600) return NextResponse.json({ error: '本文が長すぎます。' }, { status: 400 });
    if (images.length > 4) return NextResponse.json({ error: '画像は4枚までです。' }, { status: 400 });

    const mediaIds: string[] = [];
    for (const dataUrl of images) {
      const m = /^data:image\/png;base64,(.+)$/.exec(dataUrl);
      if (!m) return NextResponse.json({ error: '画像の形式が正しくありません（PNGのみ）。' }, { status: 400 });
      const buf = Buffer.from(m[1], 'base64');
      if (buf.length > 5 * 1024 * 1024) return NextResponse.json({ error: '画像が5MBを超えています。' }, { status: 400 });
      mediaIds.push(await uploadImage(buf));
    }

    const url = 'https://api.x.com/2/tweets';
    const payload: Record<string, unknown> = { text };
    if (mediaIds.length > 0) payload.media = { media_ids: mediaIds };
    if (replyToId) payload.reply = { in_reply_to_tweet_id: replyToId };
    const res = await fetch(url, {
      method: 'POST',
      headers: { Authorization: authHeader('POST', url), 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const resText = await res.text();
    if (!res.ok) {
      return NextResponse.json({ error: `投稿に失敗しました (${res.status}): ${resText.slice(0, 300)}` }, { status: 502 });
    }
    const j = JSON.parse(resText);
    const id = j?.data?.id as string | undefined;
    return NextResponse.json({ ok: true, id, url: id ? `https://x.com/i/web/status/${id}` : undefined });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message || '不明なエラーが発生しました。' }, { status: 500 });
  }
}
