import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY")!;
const TURNSTILE_SECRET_KEY = Deno.env.get("TURNSTILE_SECRET_KEY")!;
const OWNER_EMAIL = "g74197569@gmail.com";
const FROM_ADDRESS = "noreply@send.wander-8.site";

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

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { category?: string; body?: string; reply_email?: string; nickname?: string; captcha_token?: string };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "リクエストの形式が正しくありません" }, 400);
  }

  const category = typeof payload.category === "string" ? payload.category.slice(0, 30) : "その他";
  const body = typeof payload.body === "string" ? payload.body.trim() : "";
  const replyEmail = typeof payload.reply_email === "string" ? payload.reply_email.trim() : "";
  const nickname = typeof payload.nickname === "string" ? payload.nickname.slice(0, 30) : "";
  const captchaToken = payload.captcha_token;

  if (!body) return json({ error: "内容を入力してください" }, 400);
  if (body.length > 2000) return json({ error: "内容は2000字以内で入力してください" }, 400);
  if (replyEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(replyEmail)) {
    return json({ error: "メールアドレスの形式が正しくありません" }, 400);
  }
  if (!captchaToken) return json({ error: "CAPTCHA認証を完了してください" }, 400);

  const verifyRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: TURNSTILE_SECRET_KEY, response: captchaToken }),
  });
  const verifyJson = await verifyRes.json().catch(() => ({ success: false }));
  if (!verifyJson.success) {
    return json({ error: "CAPTCHA認証に失敗しました。もう一度お試しください" }, 400);
  }

  const ownerHtml = `
    <p><b>種類:</b> ${escapeHtml(category)}</p>
    <p><b>ニックネーム:</b> ${escapeHtml(nickname || "(未設定)")}</p>
    <p><b>返信先:</b> ${escapeHtml(replyEmail || "(未入力)")}</p>
    <p><b>内容:</b></p>
    <p>${escapeHtml(body).replace(/\n/g, "<br>")}</p>
  `;

  const ownerPayload: Record<string, unknown> = {
    from: `Wander お問い合わせ <${FROM_ADDRESS}>`,
    to: [OWNER_EMAIL],
    subject: `【Wander】${category}`,
    html: ownerHtml,
  };
  if (replyEmail) ownerPayload.reply_to = replyEmail;

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(ownerPayload),
  });
  if (!sendRes.ok) {
    const errText = await sendRes.text().catch(() => "");
    console.error("owner email send failed", sendRes.status, errText);
    return json({ error: "送信に失敗しました。時間をおいて再度お試しください" }, 500);
  }

  // 返信用アドレスが入力されていた場合だけ、短い受領確認を送る(任意・1通のみ)
  if (replyEmail) {
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: `Wander <${FROM_ADDRESS}>`,
        to: [replyEmail],
        subject: "【Wander】お問い合わせを受け付けました",
        html: `<p>お問い合わせありがとうございます。内容を確認のうえ対応いたします。</p><p>(このメールは自動送信です。返信いただいても届きません)</p>`,
      }),
    }).catch((err) => console.error("confirmation email failed", err));
  }

  return json({ success: true });
});
