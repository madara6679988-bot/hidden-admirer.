require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const helmet = require("helmet");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must be set and contain at least 32 characters.");
  process.exit(1);
}
if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: true } : undefined
});

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'"],
      imgSrc: ["'self'", "data:", "https:"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      upgradeInsecureRequests: isProduction ? [] : null
    }
  }
}));
app.use(express.json({ limit: "100kb" }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true, tableName: "user_sessions" }),
  name: "ha.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 12, standardHeaders: "draft-7", legacyHeaders: false });
const scanLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 20, standardHeaders: "draft-7", legacyHeaders: false });

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS app_users (
      id UUID PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE TABLE IF NOT EXISTS tracked_profiles (
      id UUID PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
      username TEXT NOT NULL,
      current_snapshot JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_scanned_at TIMESTAMPTZ,
      UNIQUE(user_id, username)
    );
    CREATE TABLE IF NOT EXISTS profile_scans (
      id UUID PRIMARY KEY,
      profile_id UUID NOT NULL REFERENCES tracked_profiles(id) ON DELETE CASCADE,
      snapshot JSONB NOT NULL,
      changes JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS profile_scans_profile_date_idx
      ON profile_scans(profile_id, created_at DESC);
  `);
}

function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "سجّل الدخول أولاً." });
  next();
}
function cleanUsername(value) {
  return String(value || "").trim().replace(/^@/, "");
}
function validUsername(value) {
  return /^[A-Za-z0-9._]{1,30}$/.test(value);
}
function safeSnapshot(raw) {
  const account = raw && raw.business_discovery;
  if (!account) throw new Error("لم تُرجع Meta بيانات لهذا الحساب. قد لا يكون حساباً احترافياً عاماً أو قد لا تسمح الصلاحيات بالوصول إليه.");
  const media = account.media && Array.isArray(account.media.data) ? account.media.data : [];
  return {
    username: account.username || "",
    name: account.name || "",
    biography: account.biography || "",
    website: account.website || "",
    followers_count: Number(account.followers_count || 0),
    follows_count: Number(account.follows_count || 0),
    media_count: Number(account.media_count || 0),
    profile_picture_url: account.profile_picture_url || "",
    media: media.map(m => ({
      id: String(m.id || ""),
      caption: String(m.caption || "").slice(0, 2200),
      media_type: m.media_type || "",
      media_url: m.media_url || "",
      thumbnail_url: m.thumbnail_url || "",
      permalink: m.permalink || "",
      timestamp: m.timestamp || ""
    }))
  };
}
function makeChanges(previous, next) {
  if (!previous) return [{ type: "first_scan", label: "تم إنشاء أول لقطة للحساب", detail: "سيبدأ رصد التغييرات من الآن." }];
  const changes = [];
  const fields = [
    ["name", "اسم العرض"],
    ["biography", "النبذة التعريفية"],
    ["website", "رابط الموقع"],
    ["profile_picture_url", "صورة الملف الشخصي"]
  ];
  for (const [key, label] of fields) {
    if ((previous[key] || "") !== (next[key] || "")) {
      changes.push({ type: "profile_change", label: `تغيّر ${label}`, detail: "اختلفت القيمة عن آخر فحص محفوظ." });
    }
  }
  const oldIds = new Set((previous.media || []).map(m => m.id));
  const newPosts = (next.media || []).filter(m => m.id && !oldIds.has(m.id));
  if (newPosts.length) changes.push({
    type: "new_posts",
    label: `محتوى جديد: ${newPosts.length}`,
    detail: newPosts.slice(0, 5).map(m => m.caption).filter(Boolean).join(" · ") || "تم رصد منشورات أحدث من آخر فحص."
  });
  if (previous.followers_count !== next.followers_count) {
    changes.push({ type: "counter_change", label: "تغيّر عدد المتابعين", detail: `${previous.followers_count} ← ${next.followers_count}` });
  }
  if (previous.media_count !== next.media_count) {
    changes.push({ type: "counter_change", label: "تغيّر عدد المنشورات", detail: `${previous.media_count} ← ${next.media_count}` });
  }
  if (!changes.length) changes.push({ type: "no_change", label: "لم تُرصد تغييرات في البيانات المتاحة", detail: "هذه مقارنة بين آخر لقطتين فقط." });
  return changes;
}

// Simple, non-sensitive topic hints from visible captions only.
function extractTopics(snapshot) {
  const text = (snapshot.media || []).map(m => m.caption || "").join(" ").toLowerCase();
  const vocab = [
    ["الألعاب", ["gaming", "game", "games", "playstation", "xbox", "minecraft", "steam", "ألعاب", "لعبة"]],
    ["السفر", ["travel", "trip", "เที่ยว", "vacation", "رحلة", "سفر"]],
    ["التصوير", ["photography", "camera", "photo", "portrait", "تصوير", "كاميرا"]],
    ["الموسيقى", ["music", "song", "album", "concert", "أغنية", "موسيقى"]],
    ["الرياضة", ["football", "soccer", "basketball", "gym", "رياضة", "كرة"]],
    ["الطعام", ["food", "coffee", "recipe", "restaurant", "قهوة", "طبخ"]],
    ["الكتب", ["book", "reading", "novel", "كتاب", "قراءة"]],
    ["الأفلام", ["movie", "film", "cinema", "series", "فيلم", "مسلسل"]]
  ];
  return vocab.filter(([, terms]) => terms.some(term => text.includes(term))).map(([label]) => label);
}

app.get("/api/health", (_req, res) => res.json({ ok: true, service: "hidden-admirer" }));
app.get("/api/config", (_req, res) => {
  res.json({ metaConfigured: Boolean(process.env.META_IG_USER_ID && process.env.META_ACCESS_TOKEN), graphVersion: process.env.META_GRAPH_VERSION || "v27.0" });
});

app.post("/api/register", authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "أدخل بريداً إلكترونياً صحيحاً." });
    if (password.length < 10) return res.status(400).json({ error: "كلمة المرور يجب أن تكون 10 أحرف على الأقل." });
    const id = crypto.randomUUID();
    const hash = await bcrypt.hash(password, 12);
    await pool.query("INSERT INTO app_users(id,email,password_hash) VALUES($1,$2,$3)", [id, email, hash]);
    req.session.userId = id;
    res.status(201).json({ user: { id, email } });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "هذا البريد مسجل بالفعل." });
    console.error(err);
    res.status(500).json({ error: "تعذر إنشاء الحساب." });
  }
});

app.post("/api/login", authLimiter, async (req, res) => {
  try {
    const email = String(req.body.email || "").trim().toLowerCase();
    const password = String(req.body.password || "");
    const result = await pool.query("SELECT id,email,password_hash FROM app_users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || !(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "بيانات الدخول غير صحيحة." });
    req.session.userId = user.id;
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "تعذر تسجيل الدخول." });
  }
});

app.post("/api/logout", (req, res) => {
  req.session.destroy(() => {
    res.clearCookie("ha.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/me", requireAuth, async (req, res) => {
  const r = await pool.query("SELECT id,email,created_at FROM app_users WHERE id=$1", [req.session.userId]);
  if (!r.rows[0]) return res.status(401).json({ error: "الجلسة غير صالحة." });
  res.json({ user: r.rows[0] });
});

app.get("/api/profiles", requireAuth, async (req, res) => {
  const r = await pool.query(
    `SELECT p.id,p.username,p.created_at,p.last_scanned_at,
            p.current_snapshot->>'name' AS display_name,
            COALESCE(jsonb_array_length(p.current_snapshot->'media'),0) AS media_count
     FROM tracked_profiles p WHERE p.user_id=$1 ORDER BY p.last_scanned_at DESC NULLS LAST`,
    [req.session.userId]
  );
  res.json({ profiles: r.rows });
});

app.post("/api/scan", requireAuth, scanLimiter, async (req, res) => {
  const username = cleanUsername(req.body.username);
  const hasPermission = req.body.hasPermission === true;
  if (!validUsername(username)) return res.status(400).json({ error: "اسم المستخدم غير صالح." });
  if (!hasPermission) return res.status(400).json({ error: "أكد أنك تملك الحساب أو لديك إذن صريح لتحليله." });
  if (!process.env.META_IG_USER_ID || !process.env.META_ACCESS_TOKEN) {
    return res.status(503).json({ error: "تكامل Meta غير مهيأ على السيرفر بعد. أضف META_IG_USER_ID و META_ACCESS_TOKEN في إعدادات السيرفر." });
  }
  try {
    const version = process.env.META_GRAPH_VERSION || "v27.0";
    const fields = `business_discovery.username(${username}){username,name,biography,website,followers_count,follows_count,media_count,profile_picture_url,media.limit(12){id,caption,media_type,media_url,permalink,timestamp,thumbnail_url}}`;
    const url = new URL(`https://graph.facebook.com/${version}/${encodeURIComponent(process.env.META_IG_USER_ID)}`);
    url.searchParams.set("fields", fields);
    url.searchParams.set("access_token", process.env.META_ACCESS_TOKEN);
    const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
    const payload = await response.json();
    if (!response.ok || payload.error) {
      const detail = payload.error?.message || "Meta API request failed";
      return res.status(502).json({ error: `تعذر جلب البيانات من Meta: ${detail}` });
    }
    const snapshot = safeSnapshot(payload);
    const profileResult = await pool.query(
      "SELECT id,current_snapshot FROM tracked_profiles WHERE user_id=$1 AND username=$2",
      [req.session.userId, username]
    );
    const prior = profileResult.rows[0] || null;
    const changes = makeChanges(prior?.current_snapshot || null, snapshot);
    const profileId = prior?.id || crypto.randomUUID();
    if (prior) {
      await pool.query("UPDATE tracked_profiles SET current_snapshot=$1,last_scanned_at=NOW() WHERE id=$2", [snapshot, profileId]);
    } else {
      await pool.query("INSERT INTO tracked_profiles(id,user_id,username,current_snapshot,last_scanned_at) VALUES($1,$2,$3,$4,NOW())",
        [profileId, req.session.userId, username, snapshot]);
    }
    await pool.query("INSERT INTO profile_scans(id,profile_id,snapshot,changes) VALUES($1,$2,$3,$4)",
      [crypto.randomUUID(), profileId, snapshot, changes]);
    res.json({ profileId, snapshot, changes, topics: extractTopics(snapshot), scannedAt: new Date().toISOString() });
  } catch (err) {
    console.error("Scan failed:", err);
    res.status(502).json({ error: err.message || "فشل فحص الحساب." });
  }
});

app.get("/api/profiles/:id/history", requireAuth, async (req, res) => {
  const owner = await pool.query("SELECT id FROM tracked_profiles WHERE id=$1 AND user_id=$2", [req.params.id, req.session.userId]);
  if (!owner.rows[0]) return res.status(404).json({ error: "الملف غير موجود." });
  const r = await pool.query("SELECT id,snapshot,changes,created_at FROM profile_scans WHERE profile_id=$1 ORDER BY created_at DESC LIMIT 20", [req.params.id]);
  res.json({ scans: r.rows });
});

app.use(express.static(path.join(__dirname, "..", "public"), { maxAge: isProduction ? "1h" : 0 }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "..", "public", "index.html")));

initDb().then(() => {
  app.listen(PORT, () => console.log(`Hidden Admirer listening on port ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err);
  process.exit(1);
});
