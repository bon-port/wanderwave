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

// include_adult:falseで固定(trueだとタイトルの一部一致だけでアダルト作品が
// 紛れ込み、無関係な映画に誤ったデータを紐付ける事故になるため)
async function searchMovie(title: string, year: number | null): Promise<{ result: any; yearCorroborated: boolean } | null> {
  if (year) {
    for (const language of ["ja-JP", "en-US"]) {
      const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language, year: String(year) });
      if (data?.results?.length) return { result: data.results[0], yearCorroborated: true };
    }
  }

  const candidates: any[] = [];
  for (const language of ["ja-JP", "en-US"]) {
    const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language });
    if (data?.results?.length) candidates.push(...data.results);
  }
  if (candidates.length === 0) return null;
  if (!year) return { result: candidates[0], yearCorroborated: false };

  for (const c of candidates) {
    const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return { result: c, yearCorroborated: true };
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const {
      offset = 0,
      limit = 20,
      ids = null,
      tmdb_id_overrides = null,
      debug_title = null,
    } = await req.json().catch(() => ({}));

    if (debug_title) {
      const ja = await tmdbFetch("/search/movie", { query: debug_title, include_adult: "false", language: "ja-JP" });
      return new Response(JSON.stringify(ja), { headers: { "Content-Type": "application/json" } });
    }

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
        .is("director", null)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      todo = data || [];
    }

    const results = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const forcedId = tmdb_id_overrides?.[String(m.id)];
          const searched = forcedId
            ? { result: { id: forcedId, title: null }, yearCorroborated: true }
            : await searchMovie(m.title, m.release_year);
          const match = searched?.result ?? null;
          if (!match) {
            return { movie_id: m.id, title: m.title, release_year: m.release_year, tmdb_matched: false };
          }

          const [details, credits] = await Promise.all([
            tmdbFetch(`/movie/${match.id}`, { language: "ja-JP" }),
            tmdbFetch(`/movie/${match.id}/credits`, { language: "ja-JP" }),
          ]);

          const directors = (credits?.crew || []).filter((c: any) => c.job === "Director").map((c: any) => c.name);
          const cast = (credits?.cast || []).slice(0, 5).map((c: any) => c.name);
          const countries = (details?.production_countries || []).map((c: any) => c.name);

          return {
            movie_id: m.id,
            title: m.title,
            release_year: m.release_year,
            tmdb_matched: true,
            tmdb_id: match.id,
            tmdb_title: details?.title ?? match.title,
            year_corroborated: searched?.yearCorroborated ?? true,
            director: directors.join("、") || null,
            cast: cast.length ? cast : null,
            country: countries.join("・") || null,
            synopsis: details?.overview || null,
          };
        }),
      );
      results.push(...chunkResults);
      await sleep(150);
    }

    return new Response(JSON.stringify({ offset, limit, processed: todo.length, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
