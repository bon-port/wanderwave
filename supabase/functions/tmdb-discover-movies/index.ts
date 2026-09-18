import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-expression-estimate/tmdb-movie-metadataは「既にmoviesテーブルにある行」を
// 対象に補完するツールだが、こちらはTMDbから新しい候補作品そのものを見つけて
// moviesテーブルに新規追加する。genre/emotion_tagsはTMDbには無い独自分類なので、
// TMDbの標準ジャンル(genre_id)から機械的にマッピングする。既存869本の
// genre×emotion_tagsの実際の対応(手動選定されたもの)を参考にしたヒューリスティック。
const GENRE_MAP: Record<number, { ja: string; tags: string[] }> = {
  28: { ja: "アクション", tags: ["ワクワク", "ドキドキ"] },
  12: { ja: "アドベンチャー", tags: ["ワクワク", "美しい"] },
  16: { ja: "アニメーション", tags: ["楽しい", "ワクワク", "美しい"] },
  35: { ja: "コメディ", tags: ["楽しい", "笑い"] },
  80: { ja: "クライム", tags: ["ドキドキ", "考えさせられる"] },
  99: { ja: "ドキュメンタリー", tags: ["考えさせられる"] },
  18: { ja: "ドラマ", tags: ["感動", "悲しい", "考えさせられる"] },
  10751: { ja: "ファミリー", tags: ["楽しい", "ワクワク"] },
  14: { ja: "ファンタジー", tags: ["ワクワク", "美しい"] },
  36: { ja: "歴史", tags: ["考えさせられる", "感動"] },
  27: { ja: "ホラー", tags: ["怖い", "ドキドキ"] },
  10402: { ja: "音楽", tags: ["感動", "楽しい"] },
  9648: { ja: "ミステリー", tags: ["考えさせられる", "ドキドキ"] },
  10749: { ja: "恋愛", tags: ["感動", "悲しい", "美しい"] },
  878: { ja: "SF", tags: ["考えさせられる", "ワクワク"] },
  10770: { ja: "TVムービー", tags: ["感動"] },
  53: { ja: "スリラー", tags: ["ドキドキ", "怖い"] },
  10752: { ja: "戦争", tags: ["悲しい", "考えさせられる"] },
  37: { ja: "西部劇", tags: ["ワクワク", "ドキドキ"] },
};

// TMDbのproduction_countries.nameはlanguage=ja-JPを指定しても英語のまま返る
// (TMDb API側の既知の制約)。既存データは日本語国名を「・」区切りで持つため、
// iso_3166_1コードから日本語名へ変換する(主要国のみ。未知のコードは英語名のまま)。
const COUNTRY_NAME_JA: Record<string, string> = {
  US: "アメリカ", JP: "日本", GB: "イギリス", FR: "フランス", DE: "ドイツ",
  KR: "韓国", IT: "イタリア", NZ: "ニュージーランド", AU: "オーストラリア",
  CA: "カナダ", ES: "スペイン", CN: "中国", HK: "香港", IN: "インド",
  CH: "スイス", BE: "ベルギー", NL: "オランダ", SE: "スウェーデン",
  DK: "デンマーク", NO: "ノルウェー", FI: "フィンランド", RU: "ロシア",
  MX: "メキシコ", BR: "ブラジル", TW: "台湾", TH: "タイ", HU: "ハンガリー",
  IE: "アイルランド", AT: "オーストリア", PL: "ポーランド", CZ: "チェコ",
};

function countryNameJa(iso: string, fallback: string): string {
  return COUNTRY_NAME_JA[iso] || fallback;
}

const SYNOPSIS_MAX_LEN = 400;

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

function pickEmotionTags(genreIds: number[]): string[] {
  const freq: Record<string, number> = {};
  const order: string[] = [];
  genreIds.forEach((id) => {
    const g = GENRE_MAP[id];
    if (!g) return;
    g.tags.forEach((t) => {
      if (!(t in freq)) order.push(t);
      freq[t] = (freq[t] || 0) + 1;
    });
  });
  return order.sort((a, b) => freq[b] - freq[a]).slice(0, 3);
}

function normalizeTitle(t: string): string {
  return (t || "").trim().toLowerCase();
}

Deno.serve(async (req: Request) => {
  try {
    const {
      pages = [1],
      min_vote_count = 300,
      min_vote_average = 6.0,
      dry_run = true,
    } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 重複チェック用に既存作品の(タイトル正規化, 公開年)を一度だけ取得しておく
    const { data: existingRows, error: existingErr } = await supabase
      .from("movies")
      .select("title, release_year");
    if (existingErr) throw existingErr;
    const existingKeys = new Set(
      (existingRows || []).map((r: any) => `${normalizeTitle(r.title)}|${r.release_year}`),
    );

    // 1) TMDbのdiscoverでページ分の候補一覧を取得
    const candidates: any[] = [];
    for (const page of pages) {
      const data = await tmdbFetch("/discover/movie", {
        language: "ja-JP",
        sort_by: "vote_count.desc",
        "vote_count.gte": String(min_vote_count),
        "vote_average.gte": String(min_vote_average),
        include_adult: "false",
        page: String(page),
      });
      if (data?.results?.length) candidates.push(...data.results);
      await sleep(150);
    }

    // 2) 既存作品との重複を除外(タイトル+公開年で判定)
    const fresh = candidates.filter((c: any) => {
      const year = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
      const key = `${normalizeTitle(c.title)}|${year}`;
      return !existingKeys.has(key);
    });

    // 3) 詳細情報(監督・出演・制作国・あらすじ)を取得し、挿入用の行を組み立てる
    const rows: any[] = [];
    const skipped: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < fresh.length; i += CONCURRENCY) {
      const chunk = fresh.slice(i, i + CONCURRENCY);
      const chunkRows = await Promise.all(
        chunk.map(async (c: any) => {
          const [details, credits] = await Promise.all([
            tmdbFetch(`/movie/${c.id}`, { language: "ja-JP" }),
            tmdbFetch(`/movie/${c.id}/credits`, { language: "ja-JP" }),
          ]);
          if (!details) return null;

          const genreIds: number[] = (details.genres || []).map((g: any) => g.id);
          const emotionTags = pickEmotionTags(genreIds);
          if (emotionTags.length === 0) {
            skipped.push({ tmdb_id: c.id, title: c.title, reason: "no_genre_mapping" });
            return null;
          }
          const genreNames = genreIds.map((id) => GENRE_MAP[id]?.ja).filter(Boolean);
          const directors = (credits?.crew || []).filter((p: any) => p.job === "Director").map((p: any) => p.name);
          const cast = (credits?.cast || []).slice(0, 5).map((p: any) => p.name);
          const countries = (details.production_countries || []).map((co: any) => countryNameJa(co.iso_3166_1, co.name));
          const year = details.release_date ? parseInt(String(details.release_date).slice(0, 4), 10) : null;
          const synopsis = (details.overview || "").slice(0, SYNOPSIS_MAX_LEN);

          return {
            title: details.title || c.title,
            release_year: year,
            emotion_tags: emotionTags,
            genre: genreNames.length ? genreNames : null,
            director: directors.join("、") || null,
            cast_members: cast.length ? cast : null,
            country: countries.join("・") || null,
            synopsis: synopsis || null,
            tmdb_id: c.id,
            tmdb_vote_count: c.vote_count,
            tmdb_vote_average: c.vote_average,
          };
        }),
      );
      chunkRows.forEach((r) => { if (r) rows.push(r); });
      await sleep(150);
    }

    let inserted = 0;
    if (!dry_run && rows.length > 0) {
      const insertPayload = rows.map(({ tmdb_id, tmdb_vote_count, tmdb_vote_average, ...rest }) => rest);
      const { error: insertErr } = await supabase.from("movies").insert(insertPayload);
      if (insertErr) throw insertErr;
      inserted = insertPayload.length;
    }

    return new Response(
      JSON.stringify({
        dry_run,
        candidates_fetched: candidates.length,
        duplicates_skipped: candidates.length - fresh.length,
        no_genre_mapping_skipped: skipped.length,
        would_insert: rows.length,
        inserted,
        rows,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(
      JSON.stringify({ error: err?.message || String(err), details: err?.details, hint: err?.hint, code: err?.code }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
