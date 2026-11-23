// 투지 "오늘의 술" 사진 칸
// - POST {t, img}        : 사진 보관 + AI가 무슨 술인지 설명 → {id, ai}
// - POST {t, id, ask:1}  : 보관한 사진으로 AI 설명만 다시 받기 → {id, ai}
// - POST {t, id, del:1}  : 사진 지우기
// - GET  ?t=..&id=..     : 사진 보기
// t 는 둘만 아는 암호로 만든 우편함 이름이에요. 이걸 모르면 사진을 볼 수도 올릴 수도 없어요.
// AI 열쇠는 Netlify 사이트 설정의 환경 변수 ANTHROPIC_API_KEY 에 넣어요(코드에는 없음).
import { getStore } from "@netlify/blobs";
import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";

export const config = { path: "/api/drink-photo" };

const TOPIC = /^tuji(pv)?-[0-9a-f]{32}$/;
const ID = /^[a-z0-9]{8,32}$/;
const MAX_B64 = 2_000_000; // 사진 약 1.5MB까지 (폰에서 줄여서 보내요)
const DAY_LIMIT = 60; // 하루에 우편함 하나당 올릴 수 있는 사진 수
const ALLOWED = ["https://tujii.netlify.app", "https://sportsplayer0510.github.io"];

const Drink = z.object({
  is_drink: z.boolean().describe("사진에 술(또는 술잔)이 보이면 true"),
  name: z.string().describe("술 이름. 라벨이 보이면 정확한 제품명, 안 보이면 '레드 와인'처럼 짐작한 이름"),
  kind: z.string().describe("종류: 소주, 맥주, 와인, 막걸리, 위스키, 칵테일, 하이볼, 사케, 전통주, 기타 중 하나"),
  abv: z.string().describe("도수. 예: '약 13%'. 모르면 빈 문자열"),
  desc: z.string().describe("특징 2~3문장, 120자 안. 맛·향·산지나 만드는 법·어울리는 안주"),
});

const SYSTEM =
  "너는 친구 둘이 쓰는 앱의 다정한 술 소믈리에야. 사진 속 술을 보고 무엇인지, 어떤 특징이 있는지 짧게 알려 줘. " +
  "말투는 친근한 해요체. 라벨 글자가 보이면 그걸 근거로 제품을 맞히고, 확실하지 않으면 '~같아요'처럼 짐작이라고 말해. " +
  "과음을 부추기는 말은 하지 마. 사진에 술이 없으면 is_drink를 false로 하고 desc에 무엇이 보이는지 한 문장으로 적어.";

function cors(req) {
  const o = req.headers.get("origin") || "";
  return {
    "access-control-allow-origin": ALLOWED.includes(o) ? o : ALLOWED[0],
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "origin",
  };
}
function json(req, body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...cors(req), "content-type": "application/json; charset=utf-8" } });
}
function newId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}
function cut(s, n) {
  s = String(s || "").trim();
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

// AI에게 사진을 보여 주고 술 설명 받기. 열쇠가 없으면 null
export async function askAI(b64, mime, client) {
  if (!client && !process.env.ANTHROPIC_API_KEY) return { ai: null, why: "nokey" };
  const anthropic = client || new Anthropic();
  try {
    const res = await anthropic.messages.parse({
      model: "claude-opus-5-5",
      max_tokens: 4000,
      system: SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: mime, data: b64 } },
            { type: "text", text: "이 술 뭐예요? 특징도 알려 주세요." },
          ],
        },
      ],
      output_config: { format: zodOutputFormat(Drink) },
    });
    if (res.stop_reason === "refusal" || !res.parsed_output) return { ai: null, why: "refusal" };
    const p = res.parsed_output;
    return {
      ai: { ok: p.is_drink ? 1 : 0, n: cut(p.name, 60), kd: cut(p.kind, 20), ab: cut(p.abv, 20), ds: cut(p.desc, 300) },
    };
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return { ai: null, why: "badkey" };
    if (e instanceof Anthropic.RateLimitError) return { ai: null, why: "busy" };
    if (e instanceof Anthropic.APIError) return { ai: null, why: "api" };
    return { ai: null, why: "error" };
  }
}

export default async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors(req) });
  const photos = getStore("tuji-photos");

  if (req.method === "GET") {
    const u = new URL(req.url);
    const t = u.searchParams.get("t") || "", id = u.searchParams.get("id") || "";
    if (!TOPIC.test(t) || !ID.test(id)) return new Response("not found", { status: 404, headers: cors(req) });
    const r = await photos.getWithMetadata(t + "/" + id, { type: "arrayBuffer" });
    if (!r) return new Response("not found", { status: 404, headers: cors(req) });
    return new Response(r.data, {
      headers: { ...cors(req), "content-type": r.metadata?.mime || "image/jpeg", "cache-control": "private, max-age=31536000, immutable" },
    });
  }
  if (req.method !== "POST") return json(req, { error: "method" }, 405);

  let body;
  try {
    body = await req.json();
  } catch {
    return json(req, { error: "body" }, 400);
  }
  const t = String(body?.t || "");
  if (!TOPIC.test(t)) return json(req, { error: "topic" }, 400);

  // 지우기
  if (body.del) {
    if (!ID.test(String(body.id || ""))) return json(req, { error: "id" }, 400);
    await photos.delete(t + "/" + body.id);
    return json(req, { ok: 1 });
  }
  // 보관한 사진으로 AI만 다시
  if (body.ask) {
    const id = String(body.id || "");
    if (!ID.test(id)) return json(req, { error: "id" }, 400);
    const r = await photos.getWithMetadata(t + "/" + id, { type: "arrayBuffer" });
    if (!r) return json(req, { error: "gone" }, 404);
    const out = await askAI(Buffer.from(r.data).toString("base64"), r.metadata?.mime || "image/jpeg");
    return json(req, { id, ...out });
  }

  // 새 사진
  const img = String(body.img || "");
  const mime = ["image/jpeg", "image/png", "image/webp"].includes(body.mime) ? body.mime : "image/jpeg";
  if (!img || img.length > MAX_B64 || !/^[A-Za-z0-9+/=]+$/.test(img)) return json(req, { error: "img" }, 400);
  const meta = getStore("tuji-meta");
  const day = new Date().toISOString().slice(0, 10), ck = t + "/count-" + day;
  const n = Number((await meta.get(ck)) || 0);
  if (n >= DAY_LIMIT) return json(req, { error: "limit" }, 429);
  await meta.set(ck, String(n + 1));
  const id = newId();
  await photos.set(t + "/" + id, Buffer.from(img, "base64"), { metadata: { mime, at: Date.now() } });
  const out = body.noai ? { ai: null, why: "skip" } : await askAI(img, mime);
  return json(req, { id, ...out });
};
