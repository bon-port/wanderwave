import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return await res.json();
}

// MyMemory(https://mymemory.translated.net)の無料翻訳API。APIキー不要で
// 1日あたり5000語まで無料(超過すると翻訳せず原文を返してくるだけなので、
// 失敗時のフォールバックと自然に両立する)。当初は非公式のGoogle翻訳
// エンドポイントを使っていたが、Supabase Edge Functionsの送信元IPからだと
// 429(レート制限)で弾かれ続けたため、こちらの正式な無料APIに切り替えた。
// 1リクエストあたり500文字程度が上限のため、長いレビューは複数チャンクに
// 分けて翻訳し、繋ぎ合わせる(以前は480文字で単純に切り詰めていたため、
// 翻訳結果が文の途中でぶつ切りになっていた)。
const MAX_REVIEW_SOURCE_LEN = 1200;
const TRANSLATE_CHUNK_LEN = 450;

// 1200文字を超えるレビューはさすがに長すぎるので、文の区切り(. ! ?)が
// 見つかればそこで、無ければ単純に切り詰める。
function trimToSentenceBoundary(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  const cut = text.slice(0, maxLen);
  const lastPunct = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return lastPunct > maxLen * 0.5 ? cut.slice(0, lastPunct + 1) : cut;
}

// 単語の途中で切らないよう、単語単位でmaxLen以下のチャンクにまとめる。
function splitIntoChunks(text: string, maxLen: number): string[] {
  const words = text.split(/\s+/);
  const chunks: string[] = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (candidate.length > maxLen && current) {
      chunks.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 1レビューを複数チャンクに分けたことで、6件同時翻訳時のMyMemoryへの
// 瞬間リクエスト数が増え、まれに素っ気ないレート制限で失敗する(原文の
// 英語がそのまま返ってしまう)ことが確認された。1回だけ間を置いて
// リトライすることで、この取りこぼしをほぼ無くす。
async function translateChunkOnce(chunk: string): Promise<string | null> {
  try {
    const url = new URL("https://api.mymemory.translated.net/get");
    url.searchParams.set("q", chunk);
    url.searchParams.set("langpair", "en|ja");
    const res = await fetch(url.toString());
    if (!res.ok) return null;
    const data = await res.json();
    const translated = String(data?.responseData?.translatedText || "").trim();
    return translated || null;
  } catch {
    return null;
  }
}

async function translateChunk(chunk: string): Promise<string> {
  const first = await translateChunkOnce(chunk);
  if (first) return first;
  await sleep(700);
  const retried = await translateChunkOnce(chunk);
  return retried || chunk;
}

async function translateToJa(text: string): Promise<string> {
  const bounded = trimToSentenceBoundary(text, MAX_REVIEW_SOURCE_LEN);
  const chunks = splitIntoChunks(bounded, TRANSLATE_CHUNK_LEN);
  const translated: string[] = [];
  for (const chunk of chunks) {
    translated.push(await translateChunk(chunk));
    await sleep(120);
  }
  return translated.join("");
}

// TMDBは外部の匿名レビューなので、作品とは関係のない政治的な主張や扇動的な
// 話題が混ざることがある(実例: 作品評とは無関係に特定の政治的立場について
// 書かれたレビュー)。完全な検閲ではなく「一定の歯止め」として、政治色の
// 強い語を含むレビューは表示前に除外する。作品のテーマとして正当に触れて
// いるだけのレビューまで誤って弾いてしまうことはありうるが、静かなトーンの
// プロダクトなので疑わしきは出さない側に倒す。
const POLITICAL_FLAG_WORDS = [
  "left-wing", "right-wing", "leftist", "rightist", "far-left", "far-right",
  "woke agenda", "sjw", "maga", "antifa", "culture war",
  "democrat party", "republican party", "trump", "biden",
  "communism", "communist", "marxist", "marxism", "fascist propaganda",
  "abortion", "gun control", "critical race theory", "immigration policy",
];

function containsPoliticalContent(text: string): boolean {
  const lower = text.toLowerCase();
  return POLITICAL_FLAG_WORDS.some((w) => lower.includes(w));
}

// tmdb-movie-metadataと同じ考え方の検索(年が分かればまず年で絞り込み、
// ダメなら候補の中から公開年が近いものを選ぶ)。include_adult:falseは固定。
async function searchTmdbId(title: string, year: number | null): Promise<number | null> {
  if (year) {
    const data = await tmdbFetch("/search/movie", {
      query: title, include_adult: "false", language: "ja-JP", year: String(year),
    });
    if (data?.results?.length) return data.results[0].id;
  }
  const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language: "ja-JP" });
  const candidates = data?.results || [];
  if (!candidates.length) return null;
  if (!year) return candidates[0].id;
  for (const c of candidates) {
    const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return c.id;
  }
  return candidates[0].id;
}

// この映画カタログはTMDbの映画IDを常設で持っていない(poster_pathの取得時に
// 都度検索しているだけ)ので、ここで初めて必要になった時に検索し、
// movies.tmdb_idへ書き戻しておく(次回以降は検索し直さずに済む)。
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { movie_id?: number };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "リクエストの形式が正しくありません" }, 400);
  }

  const movieId = Number(payload.movie_id);
  if (!Number.isFinite(movieId)) return json({ error: "movie_idが不正です" }, 400);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: movie, error: movieErr } = await supabase
    .from("movies")
    .select("id, title, release_year, tmdb_id")
    .eq("id", movieId)
    .single();
  if (movieErr || !movie) return json({ error: "作品が見つかりませんでした" }, 404);

  let tmdbId: number | null = movie.tmdb_id ?? null;
  if (!tmdbId) {
    tmdbId = await searchTmdbId(movie.title, movie.release_year);
    if (tmdbId) {
      await supabase.from("movies").update({ tmdb_id: tmdbId }).eq("id", movieId);
    }
  }

  if (!tmdbId) {
    return json({ movie_id: movieId, tmdb_matched: false, reviews: [] });
  }

  const reviewsData = await tmdbFetch(`/movie/${tmdbId}/reviews`, { language: "en-US", page: "1" });
  const rawReviews = (reviewsData?.results || [])
    .map((r: any) => ({
      author: r.author_details?.username || r.author || "anonymous",
      rating: r.author_details?.rating ?? null,
      content: String(r.content || "").trim(),
      url: r.url || null,
      created_at: r.created_at || null,
    }))
    .filter((r: any) => r.content.length > 0)
    .filter((r: any) => !containsPoliticalContent(r.content))
    // 翻訳リクエストが増えすぎないよう、表示する分だけ(最大6件)に絞る
    .slice(0, 6);

  // レビューごとに開始タイミングを少しずらし、MyMemoryへの瞬間リクエスト数が
  // 一気に跳ね上がらないようにする(バーストによるレート制限を避けるため)。
  const reviews = await Promise.all(
    rawReviews.map(async (r: any, i: number) => {
      await sleep(i * 180);
      return { ...r, content: await translateToJa(r.content) };
    }),
  );

  return json({ movie_id: movieId, tmdb_matched: true, tmdb_id: tmdbId, reviews });
});
