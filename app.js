const $ = id => document.getElementById(id);
let registerMode = false;
let currentUser = null;
let scanCount = 0;
let toastTimer;

function toast(message) {
  const el = $("toast"); el.textContent = message; el.classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
}
async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || "حدث خطأ غير متوقع.");
  return body;
}
function setAuthMode() {
  $("authTitle").textContent = registerMode ? "أنشئ مساحة عمل" : "مرحباً بعودتك";
  $("authSubtitle").textContent = registerMode ? "ابدأ مساحة خاصة لحفظ لقطات الحسابات المصرح بها." : "سجّل الدخول إلى مساحة العمل الخاصة بك.";
  $("authSubmit").innerHTML = registerMode ? "إنشاء حساب <span>←</span>" : "تسجيل الدخول <span>←</span>";
  $("switchText").textContent = registerMode ? "لديك حساب بالفعل؟" : "ليس لديك حساب؟";
  $("switchMode").textContent = registerMode ? "سجّل الدخول" : "أنشئ حساباً";
  $("password").autocomplete = registerMode ? "new-password" : "current-password";
  $("authError").textContent = "";
}
function showApp(user) {
  currentUser = user;
  $("authView").classList.add("hidden"); $("appView").classList.remove("hidden");
  $("sideEmail").textContent = user.email;
  $("todayText").textContent = new Intl.DateTimeFormat("ar", { dateStyle: "full" }).format(new Date());
  refreshDashboard();
}
function showAuth() {
  $("appView").classList.add("hidden"); $("authView").classList.remove("hidden");
}
$("switchMode").addEventListener("click", () => { registerMode = !registerMode; setAuthMode(); });
$("authForm").addEventListener("submit", async e => {
  e.preventDefault(); $("authError").textContent = "";
  const email = $("email").value.trim(), password = $("password").value;
  const path = registerMode ? "/api/register" : "/api/login";
  $("authSubmit").disabled = true;
  try {
    const result = await api(path, { method: "POST", body: JSON.stringify({ email, password }) });
    showApp(result.user);
  } catch (err) { $("authError").textContent = err.message; }
  finally { $("authSubmit").disabled = false; }
});
$("logoutBtn").addEventListener("click", async () => {
  try { await api("/api/logout", { method: "POST", body: "{}" }); } catch {}
  currentUser = null; showAuth();
});

async function refreshConfig() {
  try {
    const cfg = await api("/api/config");
    $("apiStatus").textContent = cfg.metaConfigured ? "تكامل Meta مهيأ" : "تكامل Meta يحتاج إعداداً";
    $("apiStatus").parentElement.style.color = cfg.metaConfigured ? "var(--green)" : "var(--pink)";
  } catch { $("apiStatus").textContent = "تعذر التحقق من الاتصال"; }
}
function switchView(name) {
  ["overview", "scan", "history"].forEach(v => $(v + "View").classList.toggle("hidden", v !== name));
  document.querySelectorAll(".nav-item").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  const labels = { overview: "نظرة عامة", scan: "فحص حساب", history: "سجل التغييرات" };
  $("pageName").textContent = labels[name];
  if (name === "history") refreshHistory();
}
document.querySelectorAll("[data-view]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.view)));
document.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => switchView(b.dataset.go)));

function number(n) { return new Intl.NumberFormat("en-US").format(Number(n || 0)); }
function dateTime(s) {
  if (!s) return "—";
  return new Intl.DateTimeFormat("ar", { dateStyle: "medium", timeStyle: "short" }).format(new Date(s));
}
async function refreshDashboard() {
  try {
    const { profiles } = await api("/api/profiles");
    $("statProfiles").textContent = number(profiles.length);
    $("statScans").textContent = number(scanCount);
    const latest = profiles.find(p => p.last_scanned_at)?.last_scanned_at;
    $("statLatest").textContent = latest ? new Intl.DateTimeFormat("ar", { day: "numeric", month: "short" }).format(new Date(latest)) : "—";
    $("updatedText").textContent = latest ? "آخر فحص: " + dateTime(latest) : "لم يتم الفحص بعد";
    $("profileList").innerHTML = profiles.length ? profiles.slice(0, 5).map(p => `
      <div class="profile-row"><div class="profile-picture">${escapeHtml((p.username || "HA").slice(0,2).toUpperCase())}</div>
      <div class="profile-info"><b>@${escapeHtml(p.username)}</b><small>${escapeHtml(p.display_name || "حساب Instagram")} · آخر فحص ${dateTime(p.last_scanned_at)}</small></div>
      <span class="profile-count">${number(p.media_count)} منشور</span></div>`).join("") :
      `<div class="empty-state"><span>⌕</span><b>لا توجد حسابات بعد</b><small>ابدأ بإضافة حساب تملكه أو لديك إذن بتحليله.</small></div>`;
  } catch (err) { toast(err.message); }
}
function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}
function renderResult(data) {
  const s = data.snapshot;
  const changes = (data.changes || []).map(c => `<div class="change-item"><b>${escapeHtml(c.label)}</b><p>${escapeHtml(c.detail)}</p></div>`).join("");
  const media = (s.media || []).map(m => {
    const img = m.media_url || m.thumbnail_url;
    return `<div class="media-tile">${img ? `<img src="${escapeHtml(img)}" alt="منشور" loading="lazy" referrerpolicy="no-referrer">` : ""}<p>${escapeHtml(m.caption || m.media_type || "محتوى Instagram")}</p></div>`;
  }).join("");
  $("scanResult").innerHTML = `
    <div class="panel-heading"><div><h3>نتيجة الفحص</h3><p>تم حفظ لقطة جديدة في سجل الحساب</p></div><span class="api-label">SNAPSHOT SAVED</span></div>
    <div class="result-header">${s.profile_picture_url ? `<img src="${escapeHtml(s.profile_picture_url)}" alt="" referrerpolicy="no-referrer">` : `<div class="profile-picture">IG</div>`}<div><h3>@${escapeHtml(s.username)}</h3><p>${escapeHtml(s.name || "")} · ${escapeHtml(s.biography || "لا توجد نبذة متاحة")}</p></div></div>
    <div class="result-stats"><div class="result-stat"><small>المتابعون</small><b>${number(s.followers_count)}</b></div><div class="result-stat"><small>يتابع</small><b>${number(s.follows_count)}</b></div><div class="result-stat"><small>المنشورات</small><b>${number(s.media_count)}</b></div></div>
    <div class="section-heading"><div><div class="eyebrow muted-eyebrow">CHANGE DETECTION</div><h2>التغييرات المرصودة</h2></div></div>
    <div class="change-list">${changes}</div>
    ${data.topics?.length ? `<div class="section-heading"><div><div class="eyebrow muted-eyebrow">VISIBLE CONTENT TOPICS</div><h2>موضوعات ظهرت في النصوص</h2></div></div><div class="chips">${data.topics.map(t=>`<span class="chip">${escapeHtml(t)}</span>`).join("")}</div>` : ""}
    ${media ? `<div class="section-heading"><div><div class="eyebrow muted-eyebrow">RECENT MEDIA</div><h2>أحدث المحتوى المتاح</h2></div></div><div class="media-grid">${media}</div>` : ""}
    <p class="guide-foot">هذه البيانات هي ما أعادته Meta API فقط. ليست تحليلاً نفسياً ولا إثباتاً لاهتمامات الشخص، وقد تتغير الحقول المتاحة حسب الصلاحيات ونوع الحساب.</p>`;
  $("scanResult").classList.remove("hidden");
  $("scanResult").scrollIntoView({ behavior: "smooth", block: "start" });
}
$("scanForm").addEventListener("submit", async e => {
  e.preventDefault();
  $("scanError").textContent = ""; $("scanResult").classList.add("hidden");
  const username = $("username").value.trim().replace(/^@/, "");
  const hasPermission = $("permission").checked;
  $("scanButton").disabled = true; $("scanButton").innerHTML = "جارٍ الفحص والحفظ…";
  try {
    const data = await api("/api/scan", { method: "POST", body: JSON.stringify({ username, hasPermission }) });
    scanCount += 1; renderResult(data); await refreshDashboard(); toast("تم الفحص وحفظ اللقطة بنجاح.");
  } catch (err) { $("scanError").textContent = err.message; }
  finally { $("scanButton").disabled = false; $("scanButton").innerHTML = 'بدء الفحص <span>⌕</span>'; }
});
async function refreshHistory() {
  const { profiles } = await api("/api/profiles");
  if (!profiles.length) {
    $("historyList").innerHTML = `<div class="empty-state"><span>◷</span><b>السجل فارغ</b><small>ستظهر اللقطات هنا بعد أول فحص ناجح.</small></div>`;
    return;
  }
  const chunks = [];
  for (const profile of profiles) {
    const { scans } = await api(`/api/profiles/${profile.id}/history`);
    scanCount += scans.length;
    chunks.push(`<div class="history-profile"><div class="history-profile-head"><b>@${escapeHtml(profile.username)}</b><span>${scans.length} لقطات محفوظة</span></div>
      ${scans.map(scan => `<div class="history-scan"><b>${dateTime(scan.created_at)}</b><p>${(scan.changes || []).map(c => escapeHtml(c.label)).join(" · ") || "لا توجد تفاصيل"}</p></div>`).join("")}</div>`);
  }
  $("historyList").innerHTML = chunks.join("");
}
async function init() {
  setAuthMode(); refreshConfig();
  try {
    const { user } = await api("/api/me");
    showApp(user);
  } catch { showAuth(); }
}
init();
