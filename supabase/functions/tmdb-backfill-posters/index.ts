import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbFetch(path: string, params: Record<string, string>) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

async function searchMovie(title: string, year: number | null): Promise<any | null> {
  if (year) {
    for (const language of ["ja-JP", "en-US"]) {
      const data = await tmdbFetch("/search/movie", { query: title, include_adult: "true", language, year: String(year) });
      if (data?.results?.length) return data.results[0];
    }
  }
  const candidates: any[] = [];
  for (const language of ["ja-JP", "en-US"]) {
    const data = await tmdbFetch("/search/movie", { query: title, include_adult: "true", language });
    if (data?.results?.length) candidates.push(...data.results);
  }
  if (candidates.length === 0) return null;
  if (!year) return candidates[0];
  for (const c of candidates) {
    const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return c;
  }
  return candidates[0];
}

// 既存作品(poster_pathが未設定のもの)にTMDbの画像パスを埋める。
// tmdb-movie-metadata/tmdb-expression-estimateと違い、この関数は結果をその場で
// moviesテーブルに直接UPDATEする(計算結果を返すだけで保存しない既存2関数の
// 流儀は、ポスターのような「そのまま使うだけの値」には手間が増えるだけなので
// 採用しない)。
Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 50, ids = null } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    let todo: any[];
    if (ids) {
      const { data, error } = await supabase.from("movies").select("id, title, release_year").in("id", ids);
      if (error) throw error;
      todo = data || [];
    } else {
      const { data, error } = await supabase
        .from("movies")
        .select("id, title, release_year")
        .is("poster_path", null)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      todo = data || [];
    }

    const results: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const match = await searchMovie(m.title, m.release_year);
          if (!match || !match.poster_path) {
            return { movie_id: m.id, title: m.title, matched: false };
          }
          const { error: updateErr } = await supabase
            .from("movies")
            .update({ poster_path: match.poster_path })
            .eq("id", m.id);
          if (updateErr) {
            return { movie_id: m.id, title: m.title, matched: false, error: updateErr.message };
          }
          return { movie_id: m.id, title: m.title, matched: true, poster_path: match.poster_path };
        }),
      );
      results.push(...chunkResults);
      await sleep(150);
    }

    const updated = results.filter((r) => r.matched).length;
    return new Response(
      JSON.stringify({ processed: todo.length, updated, results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err) }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
