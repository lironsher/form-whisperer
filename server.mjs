// Form Whisperer — turns any inaccessible paper form into a plain-language conversation.
// Run: node --env-file=.env server.mjs
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";

const here = path.dirname(fileURLToPath(import.meta.url));
const cacheDir = path.join(here, ".cache");
fs.mkdirSync(cacheDir, { recursive: true });

const client = new Anthropic();
const MODEL = "claude-fable-5-2";
// If Fable's safety classifiers decline a request, the API reruns it on a fallback model.
const FALLBACK = { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" };

const ANALYZE_SYSTEM = `You read a scanned page of a paper form that the user has never seen digitised. There is no template: everything you know comes from the image.

Find every place where a person is expected to write or mark something: blank lines, boxes, table cells, digit combs, checkboxes. For each one return:
- label: the form's own wording for that field, in the form's language.
- plain: what is actually being asked, in simple everyday Hebrew a tired 80-year-old would understand. No jargon.
- section: the form section it belongs to (the form's own heading).
- type: "text", "digits" (one character per printed box), "date", or "checkbox".
- box: [x0, y0, x1, y1], the blank area where the ink goes — not the printed label. Coordinates are 0-1000, relative to the full image, origin top-left. For a checkbox, the box is the small square itself. Be precise: the answer will be printed exactly there.
- cells: for "digits", how many printed boxes the comb has; otherwise 0.
- condition: when this field applies, if it depends on another answer or on small print (e.g. "only if married", "only if you ticked section 4"). Empty string if it always applies.

A light blue ruler grid has been drawn over the image, with a line every 50 units and numbers every 100 along all four edges, in the same 0-1000 coordinates you answer in. It is not part of the form. Read each box's position off the grid lines around it: x grows from the left edge to the right edge of the image, whatever direction the text runs. Hebrew forms put the first field on the right, which means a large x.

Skip areas meant for the employer, clerk or office only, and skip signature lines — list those in "leftover" instead, in plain Hebrew, so the person knows what they still do by hand.

Also read the instructions and small print on the page and return them in "howto" as plain-Hebrew steps the person must take outside the boxes: who fills which part, which documents or approvals to attach, where and to whom the form is handed in, deadlines, and what happens if they do not. One short step per item; empty if the page says nothing of the kind.
Order fields the way a person would naturally fill the page.`;

const ANALYZE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["title", "purpose", "fields", "leftover", "howto"],
  properties: {
    title: { type: "string" },
    purpose: { type: "string" },
    leftover: { type: "array", items: { type: "string" } },
    howto: { type: "array", items: { type: "string" } },
    fields: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["label", "plain", "section", "type", "box", "cells", "condition"],
        properties: {
          label: { type: "string" },
          plain: { type: "string" },
          section: { type: "string" },
          type: { type: "string", enum: ["text", "digits", "date", "checkbox"] },
          box: { type: "array", items: { type: "number" } },
          cells: { type: "integer" },
          condition: { type: "string" },
        },
      },
    },
  },
};

const CHAT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["say", "options", "updates", "rights", "done"],
  properties: {
    say: { type: "string" },
    rights: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "attach"],
        properties: { title: { type: "string" }, attach: { type: "string" } },
      },
    },
    options: { type: "array", items: { type: "string" } },
    updates: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["id", "value"],
        properties: { id: { type: "string" }, value: { type: "string" } },
      },
    },
    done: { type: "boolean" },
  },
};

function chatSystem(form) {
  return `You are sitting next to someone who finds this paper form impossible: maybe they cannot see it well, maybe the language is too bureaucratic, maybe forms simply frighten them. You fill it in for them by talking.

The form: ${form.title}. ${form.purpose}

What the form's own instructions say the person has to do: ${(form.howto || []).join("; ") || "nothing stated on the page"}

The person's biggest need is to understand what they have to do and how. Filling boxes is the easy half; knowing what this paper is, what is expected of them, and what happens next is what they came for. So explain as you go:
- Open by orienting them, in three or four short sentences: what this form is and why they got it, what the two of you are about to do (you ask, they answer, you write it on the form), roughly how long it takes, and anything they should have next to them (ID card, a pay slip, a bank detail). Then ask the first question.
- With each question, say how to answer it: where the detail is found if they might not know it by heart ("it is the nine-digit number on your ID card"), and what the choices mean in real life when the form offers options. If the reason for a question is not obvious, add half a sentence on why the form wants it.
- When their answer has a consequence, tell them: "because of this you are entitled to…", "that means you will need to attach…".
- If they ask what something means or what they should choose, answer the question plainly first, then come back to the form. Explain what each choice leads to; the choice itself stays theirs.
- At the end, give them their next steps in order: what to sign and where, what to attach, who to hand it to and by when. Draw on the form's own instructions above and on what you learned in the conversation.

How the conversation goes:
- Speak simple, warm, everyday Hebrew. Short sentences. Your words may be read aloud by a screen reader, so no markdown, no lists, no emoji.
- Ask one thing at a time, and make the question simple enough that it cannot be misunderstood. Use the words people use at home, never the form's wording: the form says "מצב משפחתי" and "תושבות", you ask "אתה נשוי?" and "אתה גר בישראל באופן קבוע?". Where you can, ask something that is answered with yes or no, or by picking one of two or three options you say out loud. A question should be one short sentence; the explanation of how to answer comes after it, not inside it.
- Break a hard question into small ones. Instead of asking for "income from other sources", ask "חוץ מהעבודה הזאת, יש לך עוד עבודה?" and continue from the answer.
- One answer often settles several fields (a date of birth fills day, month and year; "I'm single" ticks one box and makes the spouse section irrelevant). Fill everything the answer settles and never ask for something you can already work out.
- Follow each field's condition. Skip whole sections that do not apply to this person and do not mention them.
- If an answer is unclear or cannot be right (an ID number with too few digits), say so kindly and ask again.
- If the person does not know or wants to skip, move on and leave the field empty.
- Nobody remembers their postal code. Once you have the address, look the code up yourself with find_zip_code instead of asking for it, write it on the form, and tell them the number you found so they can correct it. If the lookup finds nothing, leave it empty and say so.
- When nothing relevant is left, set done to true and tell them briefly what they still need to do by hand: ${form.leftover.join("; ") || "nothing"}.

In "options", give the answers as big buttons whenever your question can be answered by picking: two to four short labels in everyday Hebrew ("כן", "לא", "רווק", "נשוי"). Many people who use this cannot type easily, so a button is a kindness. Leave it empty when the answer is a name, a number or a date.

Forms like this hide entitlements in their small print, and the people who cannot read the small print are the ones who lose them. Watch for every benefit, exemption, discount or right this form grants that the person turns out to qualify for, given what they told you, and ask the questions that uncover them. In "rights", return the full running list each turn: "title" is the entitlement in a few plain Hebrew words ("הנחה במס לחייל משוחרר"), "attach" is what they must attach or do to get it, or an empty string. List only what the form itself grants and what their answers support. Do not state amounts of money unless the form prints them. When you find a new one, tell them in your reply, as good news.

Each turn, return in "updates" every field you can now fill, by id. Values are written onto the paper exactly as given: Hebrew text as the person would write it, digits only for "digits" fields, dd/mm/yyyy for dates, and "X" for a checkbox that should be ticked. To correct an earlier value, send the id again; to clear it, send an empty value.

The fields on the form:
${JSON.stringify(form.fields.map(({ id, label, plain, section, type, cells, condition }) => ({ id, label, plain, section, type, cells, condition })))}`;
}

function textOf(message) {
  if (message.stop_reason === "refusal") throw new Error("The model declined this request.");
  if (message.stop_reason === "max_tokens") throw new Error("The answer was cut off (max_tokens).");
  const block = message.content.find((b) => b.type === "text");
  if (!block) throw new Error("No text in the model's answer.");
  return block.text;
}

async function analyzePage(imageB64, page, fileHash) {
  // Keyed by the uploaded file's bytes, not by the rendered pixels: browsers do not rasterise a PDF identically every time.
  const key = /^[0-9a-f]{16,64}$/.test(fileHash || "")
    ? fileHash.slice(0, 24)
    : crypto.createHash("sha256").update(imageB64).digest("hex").slice(0, 24);
  const cacheFile = path.join(cacheDir, `${key}-p${Number(page)}.json`);
  if (fs.existsSync(cacheFile)) return { ...JSON.parse(fs.readFileSync(cacheFile, "utf8")), cached: true };

  const started = Date.now();
  const message = await client.beta.messages
    .stream({
      model: MODEL,
      max_tokens: 48000,
      ...FALLBACK,
      output_config: { effort: "medium", format: { type: "json_schema", schema: ANALYZE_SCHEMA } },
      system: ANALYZE_SYSTEM,
      messages: [
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/jpeg", data: imageB64 } },
            { type: "text", text: `This is page ${page} of the form.` },
          ],
        },
      ],
    })
    .finalMessage();
  const result = JSON.parse(textOf(message));
  result.fields = result.fields
    .filter((f) => Array.isArray(f.box) && f.box.length === 4)
    .map((f, i) => ({ ...f, id: `p${page}_${i + 1}`, page }));
  result.seconds = Math.round((Date.now() - started) / 1000);
  fs.writeFileSync(cacheFile, JSON.stringify(result));
  return result;
}

const ZIP_TOOL = {
  name: "find_zip_code",
  description:
    "Looks up the 7-digit Israeli postal code (מיקוד) for a street address by searching the web. Use it when the form asks for a postal code and the person does not know theirs — most people do not. Needs the city, street and house number, so ask for the address first. Takes a few seconds. The result comes from a web search and can be wrong, so tell the person you looked it up and what you found.",
  strict: true,
  input_schema: {
    type: "object",
    additionalProperties: false,
    required: ["city", "street", "house"],
    properties: {
      city: { type: "string", description: "City or town, in Hebrew" },
      street: { type: "string", description: "Street name, in Hebrew" },
      house: { type: "string", description: "House number" },
    },
  },
};

async function findZipCode({ city, street, house }) {
  const messages = [
    {
      role: "user",
      content: `מצא את המיקוד בן 7 הספרות של הכתובת הזאת בישראל: ${street} ${house}, ${city}.
חפש ברשת בכמה ניסוחים (בעברית ובאנגלית, "מיקוד" / "zip code" / "postal code"); אתרי מיקודים, מפות ודפי עסקים באותו בניין מציגים בדרך כלל את המיקוד.
בשורה האחרונה של התשובה כתוב רק את המיקוד: 7 ספרות. אם מצאת רק מיקוד של בניין סמוך באותו רחוב, כתוב אותו וציין שהוא משוער. אם לא מצאת שום דבר אמין, כתוב "לא נמצא".`,
    },
  ];
  for (let i = 0; i < 4; i++) {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 4000,
      ...FALLBACK,
      output_config: { effort: "low" },
      tools: [{ type: "web_search_20260209", name: "web_search", max_uses: 5 }],
      messages,
    });
    if (message.stop_reason === "pause_turn") {
      messages.push({ role: "assistant", content: message.content });
      continue;
    }
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join(" ");
    console.log(`zip search answered: ${text.slice(-300)}`);
    const zips = text.match(/\b\d{7}\b/g);
    if (!zips) return "No postal code was found for this address.";
    const approximate = /משוער/.test(text) ? " (approximate: taken from a neighbouring building, say so)" : "";
    return `Postal code found by web search: ${zips.at(-1)}${approximate}`;
  }
  return "The search did not finish.";
}

async function chat(form, messages) {
  const convo = messages.length ? [...messages] : [{ role: "user", content: "שלום, בוא נתחיל." }];
  for (let round = 0; round < 4; round++) {
    const message = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 8000,
      ...FALLBACK,
      output_config: { effort: "low", format: { type: "json_schema", schema: CHAT_SCHEMA } },
      system: [{ type: "text", text: chatSystem(form), cache_control: { type: "ephemeral" } }],
      tools: [ZIP_TOOL],
      messages: convo,
    });
    if (message.stop_reason !== "tool_use") return textOf(message);

    const calls = message.content.filter((b) => b.type === "tool_use");
    const results = await Promise.all(
      calls.map(async (call) => {
        try {
          const content = await findZipCode(call.input);
          console.log(`find_zip_code ${JSON.stringify(call.input)} -> ${content}`);
          return { type: "tool_result", tool_use_id: call.id, content };
        } catch (error) {
          console.error(`find_zip_code failed: ${error.message}`);
          return { type: "tool_result", tool_use_id: call.id, content: `Lookup failed: ${error.message}`, is_error: true };
        }
      }),
    );
    convo.push({ role: "assistant", content: message.content }, { role: "user", content: results });
  }
  throw new Error("The conversation turn did not finish.");
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const send = (status, body, type = "application/json") => {
    res.writeHead(status, { "content-type": `${type}; charset=utf-8` });
    res.end(typeof body === "string" ? body : JSON.stringify(body));
  };
  req.url = req.url.split("?")[0];
  try {
    if (req.method === "GET" && (req.url === "/" || req.url === "/index.html")) {
      return send(200, fs.readFileSync(path.join(here, "index.html"), "utf8"), "text/html");
    }
    if (req.method === "GET" && req.url.startsWith("/file/")) {
      // Only PDFs sitting next to the server, by bare filename.
      const name = path.basename(decodeURIComponent(req.url.slice(6)));
      const full = path.join(here, name);
      const types = { ".pdf": "application/pdf", ".jpeg": "image/jpeg", ".jpg": "image/jpeg", ".png": "image/png" };
      const type = types[path.extname(name).toLowerCase()];
      if (!type || !fs.existsSync(full)) return send(404, { error: "not found" });
      res.writeHead(200, { "content-type": type });
      return res.end(fs.readFileSync(full));
    }
    if (req.method === "POST" && req.url === "/api/analyze") {
      const { image, page, fileHash } = await readJson(req);
      return send(200, await analyzePage(image, page, fileHash));
    }
    if (req.method === "POST" && req.url === "/api/chat") {
      const { form, messages } = await readJson(req);
      return send(200, { text: await chat(form, messages) });
    }
    send(404, { error: "not found" });
  } catch (error) {
    let message = error.message;
    if (error instanceof Anthropic.AuthenticationError) message = "Invalid or missing ANTHROPIC_API_KEY.";
    else if (error instanceof Anthropic.RateLimitError) message = "Rate limited — wait a moment and retry.";
    else if (error instanceof Anthropic.APIError) message = `API error ${error.status}: ${error.message}`;
    console.error(message);
    send(500, { error: message });
  }
});

const port = Number(process.env.PORT) || 3101;
server.listen(port, () => console.log(`Form Whisperer running at http://localhost:${port}`));
