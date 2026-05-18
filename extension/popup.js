// JuriScan — Popup Logic v2 (Supabase Auth + Edge Function)

const SUPABASE_URL = "https://jatevbgbtpwhckizlrqe.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImphdGV2YmdidHB3aGNraXpscnFlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzUyOTAzNzksImV4cCI6MjA5MDg2NjM3OX0.v3cyoXVPktRpWLk2XEZ3JibHpSAMQDrmNsmgblfjMH8";
const FUNCTION_URL = `${SUPABASE_URL}/functions/v1/analyze`;
const FREE_LIMIT = 10;

let currentEmail = "";

// ─── Init ────────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", async () => {
  const session = await getSession();
  if (session) {
    showMain(session);
  } else {
    showView("emailView");
  }

  // Wire events
  document.getElementById("sendOtpBtn").addEventListener("click", sendOtp);
  document.getElementById("verifyOtpBtn").addEventListener("click", verifyOtp);
  document.getElementById("backToEmailBtn").addEventListener("click", () => showView("emailView"));
  document.getElementById("logoutBtn").addEventListener("click", logout);
  document.getElementById("scanBtn").addEventListener("click", scan);
  document.getElementById("relanceBtn").addEventListener("click", toggleRelance);
  document.getElementById("copyBtn").addEventListener("click", copyRelance);
  document.getElementById("historyToggle").addEventListener("click", toggleHistory);

  // Enter key on email input
  document.getElementById("emailInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") sendOtp();
  });

  // Enter key on OTP input
  document.getElementById("otpInput").addEventListener("keydown", (e) => {
    if (e.key === "Enter") verifyOtp();
  });
});

// ─── Views ───────────────────────────────────────────────────────────────────

function showView(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

async function showMain(session) {
  document.getElementById("logoutBtn").style.display = "block";
  showView("mainView");
  await refreshCounter(session.access_token);
  loadHistory(session.access_token);
}

// ─── Session (chrome.storage) ─────────────────────────────────────────────────

async function getSession() {
  const { session } = await chrome.storage.local.get("session");
  if (!session) return null;
  // Check expiry
  if (Date.now() / 1000 > session.expires_at) {
    // Try refresh
    const refreshed = await refreshSession(session.refresh_token);
    return refreshed;
  }
  return session;
}

async function saveSession(session) {
  await chrome.storage.local.set({ session });
}

async function refreshSession(refreshToken) {
  try {
    const res = await supabaseFetch("/auth/v1/token?grant_type=refresh_token", "POST", { refresh_token: refreshToken });
    if (res.access_token) {
      await saveSession(res);
      return res;
    }
  } catch {}
  await chrome.storage.local.remove("session");
  return null;
}

async function logout() {
  await chrome.storage.local.remove("session");
  document.getElementById("logoutBtn").style.display = "none";
  document.getElementById("results").style.display = "none";
  showView("emailView");
}

// ─── Supabase REST helpers ────────────────────────────────────────────────────

async function supabaseFetch(path, method = "GET", body = null, accessToken = null) {
  const headers = {
    "Content-Type": "application/json",
    "apikey": SUPABASE_ANON_KEY,
  };
  if (accessToken) headers["Authorization"] = `Bearer ${accessToken}`;

  const res = await fetch(`${SUPABASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

// ─── Auth: OTP ───────────────────────────────────────────────────────────────

async function sendOtp() {
  const email = document.getElementById("emailInput").value.trim();
  if (!email) return;

  const btn = document.getElementById("sendOtpBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Envoi...';
  document.getElementById("emailMsg").textContent = "";

  try {
    const res = await supabaseFetch("/auth/v1/otp", "POST", { email, create_user: true });
    if (res.error) throw new Error(res.error.message || res.msg);

    currentEmail = email;
    document.getElementById("otpSub").textContent = `Code envoyé à ${email}`;
    showView("otpView");
    document.querySelectorAll(".otp-digit")[0].focus();
  } catch (e) {
    document.getElementById("emailMsg").textContent = e.message;
    document.getElementById("emailMsg").className = "msg error";
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Recevoir mon code";
  }
}

async function verifyOtp() {
  const digits = document.getElementById("otpInput").value.trim();
  if (!digits) return;

  const btn = document.getElementById("verifyOtpBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Vérification...';
  document.getElementById("otpMsg").textContent = "";

  try {
    const res = await supabaseFetch("/auth/v1/verify", "POST", {
      email: currentEmail,
      token: digits,
      type: "email",
    });

    if (res.error || !res.access_token) throw new Error(res.error?.message || "Code invalide");

    await saveSession(res);
    showMain(res);
  } catch (e) {
    document.getElementById("otpMsg").textContent = e.message;
    document.getElementById("otpMsg").className = "msg error";
    document.getElementById("otpInput").value = "";
    document.getElementById("otpInput").focus();
  } finally {
    btn.disabled = false;
    btn.innerHTML = "Vérifier";
  }
}

// ─── Counter ─────────────────────────────────────────────────────────────────

async function refreshCounter(accessToken) {
  try {
    const data = await supabaseFetch(
      "/rest/v1/profiles?select=scans_used,plan&limit=1",
      "GET", null, accessToken
    );
    const profile = Array.isArray(data) ? data[0] : null;
    if (!profile) return;

    const used = profile.scans_used;
    const limit = profile.plan === "pro" ? "∞" : FREE_LIMIT;
    const pct = profile.plan === "pro" ? 5 : Math.min((used / FREE_LIMIT) * 100, 100);

    document.getElementById("counterText").textContent = `${used} / ${limit}`;
    const bar = document.getElementById("counterBar");
    bar.style.width = `${pct}%`;
    bar.className = "counter-bar" + (pct >= 100 ? " full" : pct >= 70 ? " warn" : "");

    // Upgrade banner
    const remaining = FREE_LIMIT - used;
    if (profile.plan === "free" && remaining <= 3 && remaining > 0) {
      document.getElementById("remaining").textContent = remaining;
      document.getElementById("upgradeBanner").style.display = "block";
    }
  } catch {}
}

// ─── Scan ────────────────────────────────────────────────────────────────────

async function scan() {
  const session = await getSession();
  if (!session) { logout(); return; }

  const btn = document.getElementById("scanBtn");
  btn.disabled = true;
  btn.innerHTML = '<div class="spinner"></div> Analyse en cours...';
  document.getElementById("results").style.display = "none";

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const isPDF = tab.url?.toLowerCase().includes(".pdf");

    let type, content;

    if (isPDF) {
      const screenshot = await chrome.tabs.captureVisibleTab(null, { format: "jpeg", quality: 85 });
      type = "image";
      content = screenshot.replace(/^data:image\/jpeg;base64,/, "");
    } else {
      let pageText = "";
      try {
        const response = await chrome.tabs.sendMessage(tab.id, { action: "extractText" });
        pageText = response?.text || "";
      } catch {}
      if (!pageText || pageText.length < 50) {
        showError("Impossible de lire cette page. Ouvrez un PDF ou une page de facture.");
        return;
      }
      type = "text";
      content = pageText;
    }

    // Call Edge Function
    const res = await fetch(FUNCTION_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
        "apikey": SUPABASE_ANON_KEY,
      },
      body: JSON.stringify({ type, content }),
    });

    const data = await res.json();

    console.log("Edge Function response:", res.status, JSON.stringify(data));

    if (res.status === 429 || data.error === "quota_exceeded") {
      showView("quotaView");
      return;
    }
    if (data.error || data.msg || data.message) {
      throw new Error(data.error || data.msg || data.message);
    }

    displayResults(data);
    await refreshCounter(session.access_token);

  } catch (e) {
    showError(e.message || "Une erreur est survenue.");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "🔍 Analyser cette page";
  }
}

// ─── Display ─────────────────────────────────────────────────────────────────

function displayResults(result) {
  document.getElementById("results").style.display = "block";

  if (!result.is_invoice) {
    setScore("warn", "🤔", `Document détecté : ${result.document_type}. JuriScan analyse les factures et devis.`);
    document.getElementById("issuesList").innerHTML = "";
    document.getElementById("issuesTitle").textContent = "";
    document.getElementById("relanceBtn").style.display = "none";
    return;
  }

  const score = result.compliance_score;
  if (result.status === "conforme") {
    setScore("ok", "✅", `Conforme (${score}/100) — ${result.summary}`);
  } else if (result.status === "attention") {
    setScore("warn", "⚠️", `Attention (${score}/100) — ${result.summary}`);
  } else {
    setScore("error", "❌", `Non conforme (${score}/100) — ${result.summary}`);
  }

  const list = document.getElementById("issuesList");
  list.innerHTML = "";

  if (result.missing?.length > 0) {
    document.getElementById("issuesTitle").textContent = `⚠️ ${result.missing.length} mention(s) manquante(s)`;
    result.missing.forEach(item => {
      const li = document.createElement("li");
      li.textContent = "✗ " + item;
      list.appendChild(li);
    });
  } else if (result.present?.length > 0) {
    document.getElementById("issuesTitle").textContent = "✅ Mentions vérifiées";
    result.present.slice(0, 5).forEach(item => {
      const li = document.createElement("li");
      li.className = "ok";
      li.textContent = "✓ " + item;
      list.appendChild(li);
    });
  }

  if (result.relance_email) {
    document.getElementById("relanceBtn").style.display = "flex";
    document.getElementById("relanceText").value = result.relance_email;
  }
}

function setScore(type, emoji, label) {
  document.getElementById("scoreBlock").className = `score-block ${type}`;
  document.getElementById("scoreEmoji").textContent = emoji;
  document.getElementById("scoreLabel").textContent = label;
}

function showError(msg) {
  document.getElementById("results").style.display = "block";
  setScore("error", "❌", msg);
  document.getElementById("issuesList").innerHTML = "";
  document.getElementById("issuesTitle").textContent = "";
  document.getElementById("relanceBtn").style.display = "none";
}

function toggleRelance() {
  const div = document.getElementById("relanceEmail");
  const visible = div.style.display === "block";
  div.style.display = visible ? "none" : "block";
  document.getElementById("relanceBtn").textContent = visible
    ? "✉️ Générer un email de relance"
    : "✉️ Masquer l'email";
}

// ─── History ─────────────────────────────────────────────────────────────────

async function loadHistory(accessToken) {
  try {
    const data = await supabaseFetch(
      "/rest/v1/scan_history?select=document_type,compliance_score,status,summary,created_at&order=created_at.desc&limit=5",
      "GET", null, accessToken
    );
    if (Array.isArray(data)) renderHistory(data);
  } catch {}
}

function renderHistory(scans) {
  const container = document.getElementById("historyList");
  if (!scans.length) {
    container.innerHTML = '<div style="font-size:12px;color:#9ca3af;text-align:center;padding:8px 0;">Aucune analyse pour l\'instant.</div>';
    return;
  }
  container.innerHTML = scans.map(s => {
    const icon = s.status === "conforme" ? "✅" : s.status === "attention" ? "⚠️" : "❌";
    const date = new Date(s.created_at).toLocaleDateString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    const raw = s.summary || "";
    const summary = raw.length > 72 ? raw.slice(0, 72).replace(/\s\S*$/, "") + "…" : raw;
    return `<div class="history-item">
      <div class="history-meta">${icon} ${s.document_type || "document"} · ${s.compliance_score ?? "—"}/100</div>
      <div class="history-summary">${summary}</div>
      <div class="history-date">${date}</div>
    </div>`;
  }).join("");
}

function toggleHistory() {
  const section = document.getElementById("historySection");
  const btn = document.getElementById("historyToggle");
  const visible = section.style.display === "block";
  section.style.display = visible ? "none" : "block";
  btn.textContent = visible ? "Historique ▾" : "Historique ▴";
}

async function copyRelance() {
  await navigator.clipboard.writeText(document.getElementById("relanceText").value);
  const btn = document.getElementById("copyBtn");
  btn.textContent = "✅ Copié !";
  setTimeout(() => btn.textContent = "📋 Copier", 1500);
}
