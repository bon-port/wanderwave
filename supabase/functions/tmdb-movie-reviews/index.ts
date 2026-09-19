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
  const reviews = (reviewsData?.results || []).map((r: any) => ({
    author: r.author_details?.username || r.author || "anonymous",
    rating: r.author_details?.rating ?? null,
    content: String(r.content || "").trim(),
    url: r.url || null,
    created_at: r.created_at || null,
  })).filter((r: any) => r.content.length > 0);

  return json({ movie_id: movieId, tmdb_matched: true, tmdb_id: tmdbId, reviews });
});
