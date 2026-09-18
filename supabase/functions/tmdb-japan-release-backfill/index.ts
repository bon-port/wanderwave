import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// ホームの「今話題の新作」棚が、日本未公開の作品を拾ってしまわないよう、
// 既存movies(japan_release_dateがまだnullなもの)に対して後から
// TMDbのrelease_datesを引き、JP国の公開日を埋める。tmdb-discover-movies側は
// 新規インポート時に自動でこの値を持つようになったので、この関数は
// それより前に追加された行の穴埋め専用。

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
      const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language, year: String(year) });
      if (data?.results?.length) return data.results[0];
    }
  }
  const candidates: any[] = [];
  for (const language of ["ja-JP", "en-US"]) {
    const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language });
    if (data?.results?.length) candidates.push(...data.results);
  }
  if (candidates.length === 0) return null;
  if (!year) return candidates[0];
  for (const c of candidates) {
    const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return c;
  }
  return null;
}

function extractJapanReleaseDate(releaseDatesResults: any[]): string | null {
  const jp = releaseDatesResults.find((r: any) => r.iso_3166_1 === "JP");
  if (!jp || !jp.release_dates?.length) return null;
  const dates = jp.release_dates
    .map((rd: any) => rd.release_date)
    .filter(Boolean)
    .sort();
  return dates.length ? dates[0].slice(0, 10) : null;
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 50 } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: movies, error } = await supabase
      .from("movies")
      .select("id, title, release_year")
      .is("japan_release_checked_at", null)
      .order("release_year", { ascending: false, nullsFirst: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    let updated = 0;
    let notFound = 0;
    const CONCURRENCY = 3;
    const todo = movies || [];
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (m: any) => {
          const match = await searchMovie(m.title, m.release_year);
          const jpDate = match
            ? extractJapanReleaseDate((await tmdbFetch(`/movie/${match.id}/release_dates`, {}))?.results || [])
            : null;
          if (!match) notFound++;
          // TMDb側で見つからない/JP公開情報が無い場合もchecked_atだけは打って、
          // 次回以降スキャン対象から外す(毎回同じ問い合わせをやり直さないため)。
          const { error: updateErr } = await supabase
            .from("movies")
            .update({ japan_release_date: jpDate, japan_release_checked_at: new Date().toISOString() })
            .eq("id", m.id);
          if (!updateErr) updated++;
        }),
      );
      await sleep(150);
    }

    return new Response(
      JSON.stringify({ offset, limit, processed: todo.length, updated, not_found: notFound }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
