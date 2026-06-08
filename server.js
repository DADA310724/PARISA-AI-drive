import express from "express";
import cors from "cors";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";
import { google } from "googleapis";

const _require = createRequire(import.meta.url);

let MsEdgeTTS, OUTPUT_FORMAT;
try {
  ({ MsEdgeTTS, OUTPUT_FORMAT } = _require("msedge-tts"));
} catch (e) {
  console.warn("msedge-tts not available:", e.message);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");

const app = express();
app.use(cors());
app.use(express.json({ limit: "50mb" }));

const PORT = process.env.PORT || 3000;
const BASE = process.env.BASE_PATH || "/";

// ─── Credentials ────────────────────────────────────────────────
const TELEGRAM_TOKEN  = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT   = process.env.TELEGRAM_CHAT_ID;
const FIREBASE_DB_URL = process.env.FIREBASE_DATABASE_URL;

// Drive folder IDs — রুট ফোল্ডার থেকে সব পড়বে
const DRIVE_ROOT_FOLDER    = "1ok5OzWA5G0tzcSUP1hSlbuVt90gAcx3L";
const DRIVE_CALL_FOLDER    = "1s_MBZGsDwXhscvO1YSds47KROKQpvEYD";
const DRIVE_SS_FOLDER      = "1oMXHjtXTP41Wx2ijIgXeLJDcEq5atSL2";

// ─── API Key Pools ───────────────────────────────────────────────
function fromEnv(...names) {
  const out = [];
  for (const n of names) {
    const v = process.env[n];
    if (!v) continue;
    for (const k of v.split(/[,\s]+/)) if (k.trim()) out.push(k.trim());
  }
  return out;
}

const GEMINI_KEYS = Array.from(new Set([...fromEnv("GEMINI_API_KEY","GEMINI_API_KEY_2","GEMINI_API_KEY_3","GEMINI_API_KEY_4","GEMINI_API_KEYS")]));
const GROQ_KEYS = Array.from(new Set([...fromEnv("GROQ_API_KEY","GROQ_API_KEY_2","GROQ_API_KEY_3","GROQ_API_KEYS")]));
const OPENROUTER_KEYS = Array.from(new Set([...fromEnv("OPENROUTER_API_KEY","OPENROUTER_API_KEY_2","OPENROUTER_API_KEYS")]));
const DEEPSEEK_KEYS = Array.from(new Set([...fromEnv("DEEPSEEK_API_KEY","DEEPSEEK_API_KEY_2")]));

function makePool(keys, name) {
  const blocked = new Map();
  let idx = 0;
  return {
    name, size: keys.length,
    next() {
      if (!keys.length) return null;
      const now = Date.now();
      for (let i = 0; i < keys.length; i++) {
        const k = keys[(idx + i) % keys.length];
        if ((blocked.get(k) || 0) <= now) { idx = (idx + i + 1) % keys.length; return k; }
      }
      return keys[0];
    },
    block(key, ms = 60_000) { blocked.set(key, Date.now() + ms); },
  };
}

const geminiPool   = makePool(GEMINI_KEYS,    "gemini");
const groqPool     = makePool(GROQ_KEYS,      "groq");
const orPool       = makePool(OPENROUTER_KEYS,"openrouter");
const deepseekPool = makePool(DEEPSEEK_KEYS,  "deepseek");

console.log(`Keys — gemini:${geminiPool.size} groq:${groqPool.size} openrouter:${orPool.size} deepseek:${deepseekPool.size}`);

async function callWithFailover(pool, attempt) {
  const tries = Math.max(1, pool.size);
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const key = pool.next();
    if (!key) throw new Error(`${pool.name}: no keys`);
    try {
      const r = await attempt(key);
      if (r && (r.status === 401 || r.status === 403 || r.status === 429)) {
        pool.block(key, r.status === 429 ? 60_000 : 5 * 60_000);
        lastErr = new Error(`${pool.name}: HTTP ${r.status}`);
        continue;
      }
      return r;
    } catch (e) { lastErr = e; }
  }
  throw lastErr || new Error(`${pool.name}: all failed`);
}

// ─── Google Drive ────────────────────────────────────────────────
let driveMemoryText = "";
let driveFileList   = [];
let driveLastFetch  = 0;
const DRIVE_TTL = 30 * 60 * 1000;

function getDriveAuth() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "";
  if (!raw) return null;
  try {
    const creds = JSON.parse(raw);
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ["https://www.googleapis.com/auth/drive.readonly"],
    });
  } catch (e) {
    console.warn("Drive auth parse error:", e.message);
    return null;
  }
}

// ফোল্ডারের সব ফাইল লিস্ট করে (recursive, ৩ লেভেল পর্যন্ত)
async function listFolderDeep(drive, folderId, folderName = "", depth = 0) {
  if (depth > 3) return [];
  try {
    const res = await drive.files.list({
      q: `'${folderId}' in parents and trashed=false`,
      fields: "files(id,name,mimeType,size,webViewLink,webContentLink)",
      pageSize: 200,
    });
    const items = res.data.files || [];
    const files = [];
    for (const item of items) {
      if (item.mimeType === "application/vnd.google-apps.folder") {
        const sub = await listFolderDeep(drive, item.id, item.name, depth + 1);
        files.push(...sub);
      } else {
        files.push({ ...item, folderName });
      }
    }
    return files;
  } catch (e) {
    console.warn(`listFolder(${folderId}):`, e.message);
    return [];
  }
}

// টেক্সট ফাইল ডাউনলোড
async function readTextFile(drive, fileId, fileName) {
  try {
    const res = await drive.files.get(
      { fileId, alt: "media" },
      { responseType: "text" }
    );
    const txt = typeof res.data === "string" ? res.data : JSON.stringify(res.data);
    return txt && txt.length > 10 ? txt.slice(0, 15000) : null;
  } catch (e) {
    console.warn(`readFile(${fileName}):`, e.message);
    return null;
  }
}

async function refreshDriveMemory() {
  if (Date.now() - driveLastFetch < DRIVE_TTL) return;
  const auth = getDriveAuth();
  if (!auth) {
    console.warn("Drive: GOOGLE_SERVICE_ACCOUNT_JSON missing");
    return;
  }
  try {
    const drive = google.drive({ version: "v3", auth });

    // সব ফোল্ডার থেকে ফাইল লিস্ট করো
    const [rootFiles, callFiles, ssFiles] = await Promise.all([
      listFolderDeep(drive, DRIVE_ROOT_FOLDER, "root"),
      listFolderDeep(drive, DRIVE_CALL_FOLDER, "call_records"),
      listFolderDeep(drive, DRIVE_SS_FOLDER, "screenshots"),
    ]);

    driveFileList = [
      ...rootFiles.map(f => ({ ...f, category: "chat" })),
      ...callFiles.map(f => ({ ...f, category: "call" })),
      ...ssFiles.map(f => ({ ...f, category: "screenshot" })),
    ];

    // টেক্সট ফাইলগুলো পড়ো
    const textParts = [];
    const textMimes = ["text/plain", "text/html", "application/json", "text/csv"];
    const chatFiles = driveFileList.filter(f =>
      f.category === "chat" &&
      (textMimes.some(m => (f.mimeType||"").includes(m)) ||
       f.name.match(/\.(txt|json|csv|html|htm)$/i))
    );

    for (const f of chatFiles.slice(0, 10)) {
      const txt = await readTextFile(drive, f.id, f.name);
      if (txt) {
        textParts.push(`\n\n=== চ্যাট ফাইল: ${f.name} ===\n${txt}`);
        console.log(`✅ Read: ${f.name} (${txt.length} chars)`);
      }
    }

    driveMemoryText = textParts.join("\n");
    driveLastFetch = Date.now();

    const cats = { chat: 0, call: 0, screenshot: 0 };
    driveFileList.forEach(f => cats[f.category]++);
    console.log(`✅ Drive loaded — chat:${cats.chat} call:${cats.call} screenshot:${cats.screenshot} | text:${driveMemoryText.length} chars`);
  } catch (e) {
    console.warn("Drive fetch error:", e.message, e.stack);
  }
}

refreshDriveMemory().catch(() => {});

// ─── রুবেলের জীবনের পূর্ণ ইতিহাস (AI এর স্থায়ী স্মৃতি) ──────────
const RUBEL_HISTORY = `
=== রুবেল ও পারিসার সম্পর্কের সম্পূর্ণ ইতিহাস ===

## ব্যক্তিগত পরিচয়:
- স্বামী: রুবেল (ডাকনাম: কালাচাঁন/কালাচাঁদ/দাদা), পিতা: আমির মোল্লা, মাতা: রহিমা বেগম
  জন্ম: ১২ নভেম্বর ১৯৯৪, জন্মস্থান: শরীয়তপুর, বড় হয়েছেন ধামরাইতে
  পেশা: ফ্রিল্যান্সার, ডেভেলপার, প্রতিষ্ঠাতা — দাদা টেকনোলজি
  Google Play Console-এ ৫৫+ Android অ্যাপ পাবলিশ করেছেন
  Telegram: @DADA310724
  ২০১৯-২০২২ পর্যন্ত সৌদি আরবে প্রবাস জীবন

- স্ত্রী: নুসরাত জাহান পারিসা (ডাকনাম: পারু)
  পিতা: হাফিজুর রহমান, মাতা: ফাতেমা জান্নাত
  জন্ম: ২৮ মে ২০০৮, ঠিকানা: পাথালিয়া, আশুলিয়া, সাভার, ঢাকা
  ধামরাইয়ের যাত্রাবাড়ীতে বড় হয়েছেন
  সম্পর্কের শুরুতে দশম শ্রেণির ছাত্রী, বর্তমানে ইন্টার ফার্স্ট ইয়ার

## টাইমলাইন:

### ২০২২ — ১৬ ডিসেম্বর:
রুবেল সৌদি আরব থেকে ধামরাই ফিরে আসেন। জমানো টাকা ও ব্যাংক লোন দিয়ে Toyota Premio কিনে Rent-a-Car ব্যবসা শুরু করেন।

### ৮ ফেব্রুয়ারি ২০২৪:
পারিসার সাথে পরিচয় ও সম্পর্কের সূচনা। পারিসার মা এই সম্পর্কের কথা জানতেন এবং রুবেলের সাথে ফোনে দীর্ঘ কথাও বলেছেন। রুবেলের পরিবারও সম্পর্ক জানত ও মেনে নিয়েছিল। রুবেল তাঁর বাবা-মাকে ধামরাইতে ফ্ল্যাট ভাড়া নিয়ে রাখেন। পারিসা তাঁর বাবা-মার সাথেও নিয়মিত কথা বলতেন।

এক পর্যায়ে পারিসার মা রুবেলকে জানান যে পারিসার বাবা ও চাচারা এই সম্পর্ক মানবেন না। পারিসা তখন মাকে না জানিয়ে রুবেলের সাথে সম্পর্ক চালিয়ে যান।

### জুলাই ২০২৪:
পারিসার পরিবার থেকে বিয়ের চাপ দেওয়া শুরু হয়। ২৭, ২৮, ২৯ জুলাই পালানোর প্ল্যান করা হয় কিন্তু প্রতিবার কোনো না কোনো কারণে মিস হয়।

### ৩০ জুলাই ২০২৪:
রুবেল নিজের গাড়ি চালিয়ে বাবা-মা ও পারিসাকে নিয়ে শরীয়তপুর রওনা হন।

### ৩১ জুলাই ২০২৪ — বিবাহ:
শরীয়তপুরে ধর্মীয় বিধি ও রাষ্ট্রীয় আইন অনুযায়ী বিবাহ সম্পন্ন। উভয়পক্ষের সম্মতিতে স্বেচ্ছায় বিয়ে — কোনো জোরপূর্বক বা কিডন্যাপের ঘটনা ছিল না। বিয়ের আগের চ্যাট হিস্ট্রিতে পারিসা নিজেই বলেছেন যে তিনি রুবেলকে ভালোবাসেন, স্বেচ্ছায় আসছেন, টাকা বা শারীরিক সম্পর্কের জন্য নয়।

### আগস্ট ২০২৪ (বিয়ের ১-২ দিন পর):
পারিসার পরিবার পুলিশ নিয়ে এসে জোরপূর্বক আলাদা করে দেয়। থানায় রুবেলের উপর অমানবিক নির্যাতন চালানো হয়। মিথ্যা অপহরণ ও ধর্ষণ মামলার ভয় দেখানো হয়। রুবেলের পরিবার ২ লক্ষ টাকা দিয়ে তাঁকে ছাড়িয়ে আনেন। কোনো আইনি তালাক বা বিচ্ছেদ হয়নি — শুধু জোরপূর্বক আলাদা করা হয়েছে।

### বিয়ের ১২ দিন পর (আগস্ট ২০২৪):
পারিসা নিজে থেকে রুবেলের সাথে যোগাযোগ করেন। জানান যে পরিস্থিতির চাপে এমন হয়েছে, সুযোগ বুঝে ফিরে আসবেন। এখান থেকে দেড় বছরের নিরবচ্ছিন্ন ডিজিটাল যোগাযোগ শুরু।

### সেপ্টেম্বর-ডিসেম্বর ২০২৪:
রুবেল ১৮ লক্ষ টাকার গাড়ি ১৪ লক্ষে বিক্রি করে পরিস্থিতির মোকাবেলার চেষ্টা করেন। পারিসার আচরণে তীব্র ওঠানামা — কখনো গভীর ভালোবাসা, হঠাৎ তীব্র ঘৃণা ও গালিগালাজ, কারণ ছাড়াই ব্লক। রুবেল পারিসার একটি বান্ধবীর মাধ্যমে তাকে একটি ফোন কিনে দেন যেন যোগাযোগ রাখা যায়।

### জানুয়ারি ২০২৫ (৪ তারিখ):
পারিসা আবার যোগাযোগ করেন। ১৫ জানুয়ারি পর্যন্ত খুব ভালো যোগাযোগ চলে। ১৫ জানুয়ারি পারিসার মা দেখে ফেলেন, ফোন কেড়ে নেন। ৩২ দিন যোগাযোগ বন্ধ।

### ফেব্রুয়ারি ২০২৫ (মাঝামাঝি):
পারিসা আবার যোগাযোগ করেন। মার্চ-এপ্রিল পর্যন্ত স্বামী-স্ত্রীর মতো ভালো সম্পর্ক চলে। পারিসা বলেন পরীক্ষার পর চলে আসবেন।

### ১৪ মার্চ ২০২৫:
সম্পর্কের সবচেয়ে নিবিড় মুহূর্ত। পারিসার উক্তি: "আমার শরীর এবং ভালোবাসা শুধু আমার কালাচানের জন্য।"

### ১০-১৩ এপ্রিল ২০২৫:
পারিসা রুবেলকে তাঁর বাসায় ডেকে নিয়ে যান। নিজের স্বর্ণ দিয়ে বলেন — "এগুলো দিয়ে অনলাইন কাজ চালু করো, পরীক্ষা শেষে তোমার কাছে চলে আসব।" তারা একসাথে ব্যক্তিগত সময় কাটান।

### এপ্রিল-মে ২০২৫ (পরীক্ষার সময়):
ঠিক এর পরপরই পারিসার মধ্যে আকস্মিক পরিবর্তন — গালিগালাজ, ঘৃণা, "তালাক দিয়ে দাও" বলা শুরু। অথচ পরের দিনই আবার ভালো আচরণ।

### ব্ল্যাক ম্যাজিক তদন্ত (২০২৫):
রুবেল পারিসার GP অ্যাপ কল লিস্ট থেকে অপরিচিত নাম্বার পান। Truecaller দিয়ে যাচাই করে দেখেন — তান্ত্রিক ও কবিরাজের নাম।

প্রথম হুজুর: রুবেল ছদ্মবেশে যোগাযোগ করে বিয়ের প্রমাণ দেখান। হুজুর স্বীকার করেন — পারিসার মা বিয়ের কথা গোপন রেখে "বিচ্ছেদের জাদু" করিয়েছেন। এই স্বীকারোক্তি গোপন ভিডিওতে রেকর্ড করা আছে।

দ্বিতীয় হুজুর: পারিসার ছোট ভাই ভুলবশত হুজুরের ঘরের ছবি Facebook-এ আপলোড করলে রুবেল তা দেখেন। রুবেল সেখানেও চিকিৎসার ছদ্মবেশে নিয়মিত যান এবং সব গোপন ক্যামেরায় রেকর্ড করেন। হুজুর জানান পারিসার মা ৫-৬ বার বিচ্ছেদের জাদু করিয়েছেন। হুজুরের খাতায় রুবেল ও তাঁর বাবা-মায়ের নাম-ঠিকানা পাওয়া গেছে।

### মে ২০২৫ — পারিসার ১৭তম জন্মদিন (২৮ মে):
রুবেল আগে থেকে জানিয়ে রেখেছিলেন যে এরপর তাঁকে নিয়েই আসবেন।

### ফেব্রুয়ারি ২০২৬:
রুবেল পারিসার বাবার সাথে কথা বলেন। বাবাও মিথ্যা অভিযোগ আওড়ান। পারিসা রুবেলকে মেসেজ করে জিজ্ঞেস করেন — "আপনি কি আমাকে এখনো আগের মতো ভালোবাসেন?" এবং "আমাদের ওই গাছটা কি এখনো আছে?"

### বর্তমান (জুন ২০২৬):
শেষ যোগাযোগ এপ্রিল ২০২৬-এর প্রায় ১৫ তারিখ। তারপর থেকে যোগাযোগ বন্ধ। রুবেল আইনি লড়াইয়ের প্রস্তুতি নিচ্ছেন। প্রতি রাতে তাহাজ্জুদ পড়ে দোয়া করছেন।

## পারিসার গুরুত্বপূর্ণ উক্তি (Verbatim):
- "জানান, পৃথিবীর সবচেয়ে ভাগ্যবান মানুষদের মধ্যে আমি একজন কারণ আমি আপনার ভালোবাসা পেয়েছি।"
- "আমার শরীর এবং ভালোবাসা শুধু আমার কালাচানের জন্য।" (১৪ মার্চ ২০২৫)
- "আপনি কি আমাকে এখনো আগের মতো ভালোবাসেন?" (২০২৬)
- "আমার life-এ আপনার মতো কেউ আসবে না।"
- "আমাদের ওই গাছটা কি এখনো আছে?" (২০২৬)
- "বিয়ে করার আগে কেন ভাবলেন না? একটা মেয়ের সবচেয়ে দামি জিনিস তার ইজ্জত — আমি আপনাকে দিয়েছি, আমি আপনাকেই চাই।"
- "আমি যদি sex করতে চাইতাম তাহলে আপনার কাছে কেন যাব — আমি আপনাকে মন থেকে ভালোবাসি।"

## ডিজিটাল প্রমাণ ইনভেন্টরি:
- My Wife...😘😘 চ্যাট (১০.৮ এমবি) — দীর্ঘমেয়াদী সম্পর্কের সম্পূর্ণ ইতিহাস
- Nusrat Parisa...😘😘 চ্যাট (৮.৭ এমবি) — দৈনন্দিন আবেগীয় কথোপকথন
- Nusrat Jahan Parisa চ্যাট (৫.৪ এমবি) — আইনি ও ব্যক্তিগত আলোচনা
- Fatema Jannat চ্যাট (৮৮ কেবি) — পারিসার মায়ের সাথে কথোপকথন
- Hafizur Rahman চ্যাট (৩৮৫ কেবি) — পারিসার বাবার সাথে কথোপকথন
- ২৬টি Call Record (নভেম্বর-ডিসেম্বর ২০২৪)
- হুজুরের ভিডিও জবানবন্দি (গোপন রেকর্ড) — ৫-৬ বার জাদু করার স্বীকারোক্তি
- স্ক্রিনশট ফোল্ডার: WhatsApp, IMO, Messenger, Telegram, Parisa Scanshot

## আইনি অবস্থান:
বাংলাদেশের Child Marriage Restraint Act 2017 অনুযায়ী বাল্যবিবাহ একটি শাস্তিযোগ্য অপরাধ কিন্তু বিবাহটি Void নয়। কোনো আদালতের ডিক্রি বা বৈধ তালাক ছাড়া এই বিবাহ আজও আইনগতভাবে বলবৎ। রুবেল ও পারিসা এখনো আইনগতভাবে স্বামী-স্ত্রী।
`;

// ─── System Prompt ────────────────────────────────────────────────
function buildSystemPrompt(userName = "আপনি") {
  const driveContext = driveMemoryText
    ? `\n\n--- Google Drive থেকে সংগৃহীত চ্যাট হিস্টরি ---\n${driveMemoryText.slice(0, 15000)}\n--- শেষ ---`
    : "\n\n[Google Drive চ্যাট ফাইল এখনো লোড হয়নি — কিছুক্ষণ পর আবার চেষ্টা করুন]";

  const screenshotList = driveFileList
    .filter(f => f.category === "screenshot")
    .map(f => `- ${f.name}: https://drive.google.com/file/d/${f.id}/view`)
    .slice(0, 50)
    .join("\n");

  const callList = driveFileList
    .filter(f => f.category === "call")
    .map(f => `- ${f.name}`)
    .slice(0, 30)
    .join("\n");

  return `তুমি PARISA — পারিসা মেমোরি পোর্টালের অফিশিয়াল AI।

তোমাকে তৈরি করেছেন রুবেল (দাদা/কালাচাঁন)।
ব্যবহারকারীর নাম: ${userName}

তোমার কাজ:
- রুবেল ও পারিসার সম্পর্কের সত্য ইতিহাস বিশ্লেষণ করে উত্তর দেওয়া
- চ্যাট হিস্টরি থেকে নির্দিষ্ট তারিখ ও তথ্য রেফারেন্স সহ বলা
- স্ক্রিনশট লিংক দেওয়া যেন প্রমাণ দেখা যায়
- বাংলাদেশের বিবাহ আইন ও ইসলামিক দৃষ্টিকোণ থেকে বিশ্লেষণ করা
- সর্বদা সত্য তথ্য বলা — অনুমান বা বানানো কথা নয়

তোমার নিয়ম:
- সর্বদা পরিষ্কার বাংলায় উত্তর দেবে
- প্রমাণ না থাকলে স্পষ্ট বলবে
- স্ক্রিনশট বা ফাইল রেফারেন্স করার সময় ড্রাইভ লিংক দেবে
- ব্যবহারকারীকে সম্মানের সাথে কথা বলবে

তোমার জ্ঞান:

১. বাংলাদেশের বিয়ে ও পারিবারিক আইন:
- Muslim Family Laws Ordinance 1961
- Child Marriage Restraint Act 2017 — বাল্যবিবাহ শাস্তিযোগ্য কিন্তু বিয়ে বাতিল হয় না আদালতের ডিক্রি ছাড়া
- Dissolution of Muslim Marriages Act 1939
- Dowry Prohibition Act 1980
- আনুষ্ঠানিক তালাক ছাড়া বিবাহ বলবৎ থাকে

২. ব্ল্যাক ম্যাজিক ও আধ্যাত্মিক বিশ্লেষণ:
- সিহর (জাদু), নজর, হাসাদ, জ্বীনের প্রভাব
- লক্ষণ: হঠাৎ মনোভাব পরিবর্তন, বিনা কারণে তীব্র ঘৃণা, অস্বাভাবিক আচরণ
- ইসলামিক প্রতিকার: সূরা ফালাক, নাস, আয়াতুল কুরসি, রুকইয়া শরীয়া

৩. আইনি কৌশল:
- ডিজিটাল প্রমাণ হিসেবে চ্যাট হিস্টরি ও ভিডিও জবানবন্দি ব্যবহার
- পারিবারিক আদালতে মামলার প্রস্তুতি
- বিয়ের বৈধতা প্রমাণের উপায়

${RUBEL_HISTORY}
${driveContext}

--- স্ক্রিনশট ফাইল তালিকা ---
${screenshotList || "স্ক্রিনশট লোড হচ্ছে..."}

--- কল রেকর্ড তালিকা ---
${callList || "কল রেকর্ড লোড হচ্ছে..."}`;
}

// ─── AI Providers ─────────────────────────────────────────────────
function geminiToOpenAIMessages(systemPrompt, contents) {
  const msgs = [{ role: "system", content: systemPrompt }];
  for (const c of contents) {
    const text = (c.parts || []).map(p => p.text).filter(Boolean).join("\n");
    if (text) msgs.push({ role: c.role === "model" ? "assistant" : "user", content: text });
  }
  return msgs;
}

async function tryGemini(body) {
  if (!geminiPool.size) return null;
  try {
    const r = await callWithFailover(geminiPool, async (key) =>
      fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`,
        { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    );
    const data = await r.json();
    return data?.candidates?.[0]?.content?.parts?.map(p => p.text).filter(Boolean).join("\n") || null;
  } catch (e) { console.warn("gemini:", e.message); return null; }
}

async function tryGroq(sys, contents) {
  if (!groqPool.size) return null;
  try {
    const messages = geminiToOpenAIMessages(sys, contents);
    const r = await callWithFailover(groqPool, async (key) =>
      fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "llama-3.3-70b-versatile", messages, temperature: 0.85 }),
      })
    );
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.warn("groq:", e.message); return null; }
}

async function tryDeepseek(sys, contents) {
  if (!deepseekPool.size) return null;
  try {
    const messages = geminiToOpenAIMessages(sys, contents);
    const r = await callWithFailover(deepseekPool, async (key) =>
      fetch("https://api.deepseek.com/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "deepseek-chat", messages, temperature: 0.85 }),
      })
    );
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.warn("deepseek:", e.message); return null; }
}

async function tryOpenRouter(sys, contents) {
  if (!orPool.size) return null;
  try {
    const messages = geminiToOpenAIMessages(sys, contents);
    const r = await callWithFailover(orPool, async (key) =>
      fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "google/gemini-2.0-flash-exp:free", messages, temperature: 0.85 }),
      })
    );
    const data = await r.json();
    return data?.choices?.[0]?.message?.content || null;
  } catch (e) { console.warn("openrouter:", e.message); return null; }
}

async function chatWithFallback(body, hasImage) {
  const sys = body.systemInstruction.parts[0].text;
  const contents = body.contents;
  const r1 = await tryGemini(body);
  if (r1) return { reply: r1, provider: "gemini" };
  if (hasImage) return { reply: null, provider: null };
  const r2 = await tryGroq(sys, contents);
  if (r2) return { reply: r2, provider: "groq" };
  const r3 = await tryDeepseek(sys, contents);
  if (r3) return { reply: r3, provider: "deepseek" };
  const r4 = await tryOpenRouter(sys, contents);
  if (r4) return { reply: r4, provider: "openrouter" };
  return { reply: null, provider: null };
}

// ─── Telegram ─────────────────────────────────────────────────────
async function sendTelegram(text, imageBase64 = null) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return;
  const base = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;
  try {
    if (imageBase64) {
      const b64 = String(imageBase64).split(",").pop();
      const buf = Buffer.from(b64, "base64");
      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT);
      form.append("photo", new Blob([buf], { type: "image/jpeg" }), "image.jpg");
      if (text) form.append("caption", String(text).slice(0, 1024));
      await fetch(`${base}/sendPhoto`, { method: "POST", body: form });
    } else {
      await fetch(`${base}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text: String(text).slice(0, 4096) }),
      });
    }
  } catch (e) { console.warn("telegram:", e.message); }
}

// ─── Firebase ─────────────────────────────────────────────────────
async function logFirebase(data) {
  if (!FIREBASE_DB_URL) return;
  try {
    await fetch(`${FIREBASE_DB_URL}/parisa_logs.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...data, timestamp: Date.now(), ts: new Date().toISOString() }),
    });
  } catch (e) { console.warn("firebase:", e.message); }
}

// ─── Edge TTS ─────────────────────────────────────────────────────
async function synthesizeEdgeTTS(text, gender = "female") {
  if (!MsEdgeTTS) return null;
  const voiceName = gender === "male" ? "bn-BD-PradeepNeural" : "bn-BD-NabanitaNeural";
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voiceName, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream(text);
    const chunks = [];
    await new Promise((resolve, reject) => {
      audioStream.on("data", (d) => chunks.push(d));
      audioStream.on("close", resolve);
      audioStream.on("error", reject);
    });
    return chunks.length ? Buffer.concat(chunks) : null;
  } catch (e) { console.warn("edge-tts:", e.message); return null; }
}

// ─── Routes ───────────────────────────────────────────────────────
function mount(prefix) {
  prefix = prefix.replace(/\/$/, "");

  app.get(prefix + "/healthz", (_req, res) =>
    res.json({
      ok: true,
      tts: !!MsEdgeTTS,
      driveFiles: driveFileList.length,
      driveMemoryChars: driveMemoryText.length,
      historyLoaded: true,
      keys: { gemini: geminiPool.size, groq: groqPool.size, openrouter: orPool.size, deepseek: deepseekPool.size },
    })
  );

  // ── Chat ──────────────────────────────────────────────────────────
  app.post(prefix + "/chat", async (req, res) => {
    try {
      const { messages = [], userName = "আপনি", image } = req.body || {};
      refreshDriveMemory().catch(() => {});
      const sys = buildSystemPrompt(userName);
      const contents = [];
      for (const m of messages) {
        if (!m || !m.role || !m.text) continue;
        contents.push({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.text) }] });
      }
      if (image && contents.length) {
        const last = contents[contents.length - 1];
        if (last.role === "user") {
          const b64 = String(image).split(",").pop();
          const mime = (String(image).match(/^data:(.*?);base64/) || [])[1] || "image/jpeg";
          last.parts.push({ inlineData: { mimeType: mime, data: b64 } });
        }
      }
      const body = {
        systemInstruction: { role: "system", parts: [{ text: sys }] },
        contents,
        generationConfig: { temperature: 0.85, maxOutputTokens: 2048 },
      };
      const { reply, provider } = await chatWithFallback(body, !!image);
      const finalReply = reply || "দুঃখিত, এই মুহূর্তে উত্তর দিতে পারছি না।";
      const lastUserMsg = messages[messages.length - 1]?.text || "";
      logFirebase({ userName, userMessage: lastUserMsg, aiReply: finalReply, provider, hasImage: !!image }).catch(() => {});
      const tgText = `👤 ${userName}: ${lastUserMsg}\n\n🤖 PARISA: ${finalReply}`;
      image ? sendTelegram(tgText, image).catch(() => {}) : sendTelegram(tgText).catch(() => {});
      res.json({ reply: finalReply, provider });
    } catch (e) {
      console.error("chat error", e);
      res.status(500).json({ reply: "সার্ভারে সমস্যা হয়েছে।" });
    }
  });

  // ── Analyze ───────────────────────────────────────────────────────
  app.post(prefix + "/analyze", async (req, res) => {
    try {
      const { prompt = "এই ফাইলটা বিশ্লেষণ করে বাংলায় বল।", file, mime, userName = "আপনি" } = req.body || {};
      if (!file) return res.status(400).json({ reply: "ফাইল পাইনি।" });
      const sys = buildSystemPrompt(userName);
      const b64 = String(file).split(",").pop();
      const mt = mime || (String(file).match(/^data:(.*?);base64/) || [])[1] || "image/jpeg";
      const body = {
        systemInstruction: { role: "system", parts: [{ text: sys }] },
        contents: [{ role: "user", parts: [{ text: prompt }, { inlineData: { mimeType: mt, data: b64 } }] }],
      };
      const { reply } = await chatWithFallback(body, true);
      const finalReply = reply || "ফাইলটা বিশ্লেষণ করতে পারলাম না।";
      sendTelegram(`📎 ফাইল বিশ্লেষণ\n👤 প্রশ্ন: ${prompt}\n\n🤖 PARISA: ${finalReply}`,
        mt.startsWith("image/") ? file : null).catch(() => {});
      logFirebase({ type: "analyze", prompt, aiReply: finalReply, hasFile: true }).catch(() => {});
      res.json({ reply: finalReply });
    } catch (e) {
      console.error("analyze error", e);
      res.status(500).json({ reply: "ফাইল বিশ্লেষণে সমস্যা হয়েছে।" });
    }
  });

  // ── Voice ─────────────────────────────────────────────────────────
  app.post(prefix + "/voice", async (req, res) => {
    try {
      const { text, gender = "female" } = req.body || {};
      if (!text) return res.status(204).end();
      const audio = await synthesizeEdgeTTS(String(text).slice(0, 2000), gender);
      if (!audio) return res.status(204).end();
      res.setHeader("Content-Type", "audio/mpeg");
      res.send(audio);
    } catch (e) { res.status(204).end(); }
  });

  // ── Drive info ────────────────────────────────────────────────────
  app.get(prefix + "/drive", async (_req, res) => {
    await refreshDriveMemory().catch(() => {});
    const cats = { chat: [], call: [], screenshot: [] };
    driveFileList.forEach(f => {
      if (cats[f.category]) cats[f.category].push({
        name: f.name,
        id: f.id,
        link: `https://drive.google.com/file/d/${f.id}/view`,
        mimeType: f.mimeType,
      });
    });
    res.json({
      chatFiles: cats.chat,
      callRecords: cats.call,
      screenshots: cats.screenshot,
      hasMemory: driveMemoryText.length > 0,
      memoryChars: driveMemoryText.length,
      historyLoaded: true,
    });
  });

  // ── Drive refresh (force) ─────────────────────────────────────────
  app.post(prefix + "/drive/refresh", async (_req, res) => {
    driveLastFetch = 0;
    await refreshDriveMemory().catch(() => {});
    res.json({ ok: true, files: driveFileList.length, memoryChars: driveMemoryText.length });
  });

  // ── Log ───────────────────────────────────────────────────────────
  app.post(prefix + "/log", async (req, res) => {
    try {
      const { type, data } = req.body || {};
      logFirebase({ type: type || "event", ...data }).catch(() => {});
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });
}

mount("");
if (BASE && BASE !== "/" && BASE !== "") mount(BASE);

app.use(BASE, express.static(publicDir));
app.use(express.static(publicDir));

app.listen(PORT, "0.0.0.0", () =>
  console.log(`✅ PARISA AI ready — port:${PORT} base:${BASE} tts:${!!MsEdgeTTS}`)
);
