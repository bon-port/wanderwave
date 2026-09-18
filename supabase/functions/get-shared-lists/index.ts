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

// get-shared-list(単体のリスト共有)の「マイリスト一覧」版。profiles.lists_share_token
// で本人を特定し、その人のis_public=trueなリストだけをまとめて返す。user_id等は返さない。
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { profile_token?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "リクエストの形式が正しくありません" }, 400);
  }

  const profileToken = typeof payload.profile_token === "string" ? payload.profile_token.trim() : "";
  if (!UUID_RE.test(profileToken)) return json({ error: "リストが見つかりませんでした" }, 404);

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: profile, error: profileErr } = await supabase
    .from("profiles")
    .select("id, user_name")
    .eq("lists_share_token", profileToken)
    .single();
  if (profileErr || !profile) return json({ error: "リストが見つかりませんでした" }, 404);

  const { data: lists, error: listsErr } = await supabase
    .from("user_lists")
    .select("id, name, user_list_items(movie_id)")
    .eq("user_id", profile.id)
    .eq("is_public", true)
    .order("created_at", { ascending: true });
  if (listsErr) return json({ error: "リストが見つかりませんでした" }, 404);

  return json({
    user_name: profile.user_name,
    lists: (lists || []).map((row: any) => ({
      name: row.name,
      movie_ids: (row.user_list_items || []).map((item: any) => item.movie_id),
    })),
  });
});
