import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const TIER = { LOW: 15, MILD: 40, STRONG: 65, INTENSE: 85 };

const CERT_MAP: Record<string, Record<string, number>> = {
  JP: { G: TIER.LOW, PG12: TIER.MILD, "R15+": TIER.STRONG, "R18+": TIER.INTENSE },
  US: { G: TIER.LOW, PG: TIER.LOW, "PG-13": TIER.MILD, R: TIER.STRONG, "NC-17": TIER.INTENSE },
  GB: { U: TIER.LOW, PG: TIER.LOW, "12A": TIER.MILD, "12": TIER.MILD, "15": TIER.STRONG, "18": TIER.INTENSE },
  DE: { "0": TIER.LOW, "6": TIER.LOW, "12": TIER.MILD, "16": TIER.STRONG, "18": TIER.INTENSE },
};
const CERT_COUNTRY_PRIORITY = ["US", "JP", "GB", "DE"];

const GENRE_FEAR = new Set([27, 53, 9648]);
const GENRE_VIOLENCE = new Set([28, 80, 10752, 53]);
const GENRE_SEXUAL = new Set([10749]);
const GENRE_HEAVY = new Set([27, 53, 80, 10752, 28]);

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function selectAllRows(supabase: any, table: string, columns: string): Promise<any[]> {
  const PAGE_SIZE = 1000;
  let all: any[] = [];
  let from = 0;
  while (true) {
    const { data, error } = await supabase.from(table).select(columns).range(from, from + PAGE_SIZE - 1);
    if (error) throw error;
    all = all.concat(data || []);
    if (!data || data.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return all;
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

const CERT_ALIASES: Record<string, string> = {
  "R-15": "R15+",
  "R15": "R15+",
  "R-18": "R18+",
  "R18": "R18+",
  "PG-12": "PG12",
};
function normalizeCert(raw: string): string {
  const trimmed = raw.trim();
  return CERT_ALIASES[trimmed] ?? trimmed;
}

function pickCertification(releaseDatesResult: any[]): { cert: string; country: string } | null {
  for (const country of CERT_COUNTRY_PRIORITY) {
    const entry = releaseDatesResult?.find((r: any) => r.iso_3166_1 === country);
    if (!entry) continue;
    const withCert = (entry.release_dates || []).find((rd: any) => rd.certification?.trim());
    if (withCert) return { cert: normalizeCert(withCert.certification), country };
  }
  return null;
}

function scoreMovie(opts: {
  cert: { cert: string; country: string } | null;
  genreIds: number[];
  adult: boolean;
}) {
  let tier: number;
  let tags = new Set<string>();
  let basis: string;

  if (opts.cert) {
    const map = CERT_MAP[opts.cert.country] || {};
    tier = map[opts.cert.cert] ?? TIER.MILD;
    basis = `cert:${opts.cert.country}:${opts.cert.cert}`;
  } else {
    const heavy = opts.genreIds.some((g) => GENRE_HEAVY.has(g));
    tier = heavy ? TIER.MILD : TIER.LOW;
    basis = heavy ? "fallback:genre-heavy" : "fallback:genre-light";
  }

  if (opts.adult) {
    tier = TIER.INTENSE;
    tags.add("sexual");
    basis += "+adult";
  }

  if (tier > TIER.LOW) {
    if (opts.genreIds.some((g) => GENRE_FEAR.has(g))) tags.add("fear");
    if (opts.genreIds.some((g) => GENRE_VIOLENCE.has(g))) tags.add("violence");
    if (opts.genreIds.some((g) => GENRE_SEXUAL.has(g)) && tier >= TIER.MILD) tags.add("sexual");
  } else {
    tags = new Set();
  }

  return { expression_level: tier, reason_tags: Array.from(tags), basis };
}

Deno.serve(async (req: Request) => {
  try {
    const {
      offset = 0,
      limit = 25,
      ids = null,
      tmdb_id_overrides = null,
      debug_title = null,
      debug_year = null,
      debug_release_dates = null,
      debug_keywords = null,
      persist = false,
    } = await req.json().catch(() => ({}));

    if (debug_release_dates) {
      const rd = await tmdbFetch(`/movie/${debug_release_dates}/release_dates`, {});
      return new Response(JSON.stringify(rd), { headers: { "Content-Type": "application/json" } });
    }

    if (debug_keywords) {
      const kw = await tmdbFetch(`/movie/${debug_keywords}/keywords`, {});
      return new Response(JSON.stringify(kw), { headers: { "Content-Type": "application/json" } });
    }

    if (debug_title) {
      const jaWithYear = debug_year
        ? await tmdbFetch("/search/movie", {
          query: debug_title,
          include_adult: "false",
          language: "ja-JP",
          year: String(debug_year),
        })
        : null;
      const jaNoYear = await tmdbFetch("/search/movie", { query: debug_title, include_adult: "false", language: "ja-JP" });
      const enWithYear = debug_year
        ? await tmdbFetch("/search/movie", {
          query: debug_title,
          include_adult: "false",
          language: "en-US",
          year: String(debug_year),
        })
        : null;
      return new Response(JSON.stringify({ jaWithYear, jaNoYear, enWithYear }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    let todo: any[];
    if (ids) {
      const { data: movies, error } = await supabase
        .from("movies")
        .select("id, title, release_year, genre")
        .in("id", ids);
      if (error) throw error;
      todo = movies || [];
    } else {
      const { data: movies, error } = await supabase
        .from("movies")
        .select("id, title, release_year, genre")
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;

      const existing = await selectAllRows(supabase, "movie_expression_estimates", "movie_id");
      const existingIds = new Set(existing.map((e: any) => e.movie_id));
      todo = (movies || []).filter((m: any) => !existingIds.has(m.id));
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
            return {
              movie_id: m.id,
              title: m.title,
              release_year: m.release_year,
              tmdb_matched: false,
              ...scoreMovie({ cert: null, genreIds: [], adult: false }),
            };
          }
          const [releaseDates, details] = await Promise.all([
            tmdbFetch(`/movie/${match.id}/release_dates`, {}),
            tmdbFetch(`/movie/${match.id}`, { language: "ja-JP" }),
          ]);
          const cert = pickCertification(releaseDates?.results || []);
          const genreIds = (details?.genres || []).map((g: any) => g.id);
          const adult = !!details?.adult;
          const scored = scoreMovie({ cert, genreIds, adult });
          return {
            movie_id: m.id,
            title: m.title,
            release_year: m.release_year,
            tmdb_matched: true,
            tmdb_id: match.id,
            tmdb_title: details?.title ?? match.title,
            year_corroborated: searched?.yearCorroborated ?? true,
            certification: cert ? `${cert.country}:${cert.cert}` : null,
            genres: (details?.genres || []).map((g: any) => g.name),
            adult,
            vote_average: details?.vote_average ?? null,
            overview: (details?.overview || "").slice(0, 160),
            ...scored,
          };
        }),
      );
      results.push(...chunkResults);
      await sleep(150);
    }

    let inserted = 0;
    if (persist && results.length > 0) {
      const today = new Date().toISOString().slice(0, 10);
      const rows = results.map((r: any) => ({
        movie_id: r.movie_id,
        expression_level: r.expression_level,
        reason_tags: r.reason_tags,
        source: r.tmdb_matched
          ? `tmdb_batch(${today}):${r.basis};tmdb_id=${r.tmdb_id};tmdb_title=${r.tmdb_title}`
          : `tmdb_batch(${today}):${r.basis}`,
        method: "rating_mapping",
      }));
      const { error: upsertErr, count } = await supabase
        .from("movie_expression_estimates")
        .upsert(rows, { onConflict: "movie_id", ignoreDuplicates: true, count: "exact" });
      if (upsertErr) throw upsertErr;
      inserted = count ?? rows.length;
      return new Response(JSON.stringify({ offset, limit, processed: todo.length, inserted }), {
        headers: { "Content-Type": "application/json" },
      });
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
