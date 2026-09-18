import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

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

// user_listsのRLSは本人しか読めない設定に戻したため、共有リンク(?share=<token>)
// からの閲覧はこの関数がservice roleで代行する。share_tokenはランダムなuuidなので
// 総当たりで他人のリストを見つけるのは現実的に不可能。ここではリスト名と
// movie_idの配列だけを返し、user_id等は一切含めない。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { share_token?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "リクエストの形式が正しくありません" }, 400);
  }

  const shareToken = typeof payload.share_token === "string" ? payload.share_token.trim() : "";
  if (!UUID_RE.test(shareToken)) return json({ error: "リストが見つかりませんでした" }, 404);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: list, error: listErr } = await supabase
    .from("user_lists")
    .select("id, name")
    .eq("share_token", shareToken)
    .single();
  if (listErr || !list) return json({ error: "リストが見つかりませんでした" }, 404);

  const { data: items, error: itemsErr } = await supabase
    .from("user_list_items")
    .select("movie_id")
    .eq("list_id", list.id);
  if (itemsErr) return json({ error: "リストが見つかりませんでした" }, 404);

  return json({
    name: list.name,
    movie_ids: (items || []).map((row: any) => row.movie_id),
  });
});
