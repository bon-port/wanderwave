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

// 開発者(自分)がお問い合わせメールを読む時の心理的負担を減らすための、
// 簡易な言い換え辞書。内容そのものは一切書き換えず(元の文面はこの処理を
// 通さない状態でも保持できるが、現状はメール本文に流し込むテキストだけを
// 和らげている)、きつい単語だけを穏当な表現に置き換える。
// 脅迫的な言葉は中身を見せる必要が薄いため、伏字にする。
const SEVERE_WORDS = ["死ね", "殺す", "殺してやる", "消えろ", "くたばれ", "自殺しろ"];
const HARSH_WORD_MAP: Record<string, string> = {
  "クソ": "(強い言葉)",
  "ゴミ": "(強い言葉)",
  "バカ": "(強い言葉)",
  "馬鹿": "(強い言葉)",
  "ふざけるな": "(強い言葉)",
  "最悪": "改善してほしい点がある",
  "使えない": "使いづらい",
  "意味がわからない": "わかりにくい",
  "金返せ": "返金の要望",
  "金返して": "返金の要望",
  "詐欺": "不信感の指摘",
};

function softenText(text: string): string {
  let out = text;
  for (const w of SEVERE_WORDS) out = out.split(w).join("(強い言葉のため伏字)");
  for (const [w, replacement] of Object.entries(HARSH_WORD_MAP)) out = out.split(w).join(replacement);
  return out;
}

// キーワードに一致したら、返信先が指定されている場合に限り定型文で自動返信する。
// (返信先が無ければ本人には届けようがないので、通常通りオーナー宛の通知だけ行う)
// 誤爆のリスクがあるため、自動返信した場合もオーナー宛メールへの転送は必ず行い、
// 「自動応答済み」である旨だけ分かるようにする。
const FAQ_ENTRIES: { keywords: string[]; answer: string }[] = [
  {
    keywords: ["ログインリンク", "メールが届かない", "ログインできない", "メール届かない"],
    answer:
      "ログイン用のメールが届かない場合は、まず迷惑メールフォルダをご確認ください。また、一度も登録したことのないメールアドレスの場合は「ログイン」ではなく「新規登録」からお試しください。数分待っても届かない場合は、このメールにご返信ください。",
  },
  {
    keywords: ["映画が見つからない", "作品がない", "検索してもでてこない", "検索しても出てこない", "本数が少ない"],
    answer:
      "現在、検索で見つかる作品を継続的に増やしています。お探しの作品が見つからない場合は、別のキーワード(原題やシリーズ名など)でもお試しください。",
  },
  {
    keywords: ["退会", "アカウント削除", "データを消したい", "データ削除"],
    answer:
      "現在、アプリ内から直接アカウントを削除する機能はご用意できていません。このメールにご返信いただければ、登録されているメールアドレスのデータを手動で削除いたします。",
  },
  {
    keywords: ["パスワード"],
    answer:
      "このサービスはパスワードを使用しておらず、登録したメールアドレスに届くリンクからログインする仕組みです。パスワードの設定・入力は不要です。",
  },
];

function findFaqAnswer(text: string): string | null {
  for (const entry of FAQ_ENTRIES) {
    if (entry.keywords.some((k) => text.includes(k))) return entry.answer;
  }
  return null;
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

  const faqAnswer = replyEmail ? findFaqAnswer(body) : null;
  const softenedBody = softenText(body);

  const ownerHtml = `
    <p><b>種類:</b> ${escapeHtml(category)}</p>
    <p><b>ニックネーム:</b> ${escapeHtml(nickname || "(未設定)")}</p>
    <p><b>返信先:</b> ${escapeHtml(replyEmail || "(未入力)")}</p>
    ${faqAnswer ? "<p><b>※定型文で自動返信済みです。</b>内容を確認し、必要であれば追加で対応してください。</p>" : ""}
    <p><b>内容:</b></p>
    <p>${escapeHtml(softenedBody).replace(/\n/g, "<br>")}</p>
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

  // 返信用アドレスが入力されていた場合だけ、受領確認(またはFAQに一致していれば
  // その定型回答)を送る(任意・1通のみ)。定型回答を送った場合でも、上のオーナー宛
  // メールは必ず届くので、内容によっては別途フォローできる。
  if (replyEmail) {
    const confirmationHtml = faqAnswer
      ? `<p>お問い合わせありがとうございます。内容に近いご案内がありましたので、先にお送りします。</p><p>${escapeHtml(faqAnswer)}</p><p>解決しない場合は、このメールにそのままご返信ください。</p>`
      : `<p>お問い合わせありがとうございます。内容を確認のうえ対応いたします。</p><p>(このメールは自動送信です。返信いただいても届きません)</p>`;
    const confirmationPayload: Record<string, unknown> = {
      from: `Wander <${FROM_ADDRESS}>`,
      to: [replyEmail],
      subject: "【Wander】お問い合わせを受け付けました",
      html: confirmationHtml,
    };
    // FAQ回答の場合は「解決しなければ返信してください」と案内しているため、
    // 返信が実際にオーナーへ届くようreply_toを設定する
    if (faqAnswer) confirmationPayload.reply_to = OWNER_EMAIL;
    await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(confirmationPayload),
    }).catch((err) => console.error("confirmation email failed", err));
  }

  return json({ success: true });
});
