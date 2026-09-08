import "dotenv/config";
import express from "express";
import http from "http";
import https from "https";
import path from "path";
import fs from "fs";
import os from "os";
import crypto from "crypto";
import { spawn, execSync, ChildProcess } from "child_process";
import httpProxy from "http-proxy";
import QRCode from "qrcode";
import { Agent as UndiciAgent, setGlobalDispatcher } from "undici";

// -----------------------------------------------------------------------------
// Outbound HTTP concurrency ("threads" for the bot)
// -----------------------------------------------------------------------------
// Node's global fetch() (used for every Telegram API call) is powered by
// undici, whose default dispatcher only keeps a small pool of sockets open
// per origin (api.telegram.org). With a public/multi-user bot (potentially
// thousands of users pressing buttons around the same time), that small pool
// becomes the real bottleneck -- replies start queueing up even though the
// event loop itself is idle. Raising the pool size here lets far more
// Telegram API calls run truly in parallel instead of waiting in line.
setGlobalDispatcher(new UndiciAgent({
  connections: 512,       // concurrent sockets kept open to api.telegram.org
  pipelining: 1,
  keepAliveTimeout: 30_000,
  keepAliveMaxTimeout: 60_000
}));

// =============================================================================
// V2Ray VLESS/VMess/Trojan server -- Telegram-bot-only admin panel
// -----------------------------------------------------------------------------
// The former React/Vite web dashboard (with username/password login) has been
// completely removed. The ONLY way to administer this server now is through
// the Telegram bot below.
// =============================================================================

process.on("uncaughtException", (err) => {
  console.error("[Uncaught Exception] Error:", err?.message || err);
  if (err && (err as any).stack) {
    console.error((err as any).stack);
  }
});

process.on("unhandledRejection", (reason) => {
  console.error("[Unhandled Rejection] Reason:", reason);
});

const PORT = Number(process.env.PORT) || 3000;
// -----------------------------------------------------------------------------
// Active bot token
// -----------------------------------------------------------------------------
// IMPORTANT: this must be a function, not a module-level constant. Once a
// Murad-bot config is saved via the "/" setup wizard (saveMuradBotConfigOnce),
// THAT token becomes the one actually driving the bot -- every call site below
// must re-read it live rather than capturing whatever token was active at
// process startup, otherwise the server keeps talking to the old bot forever
// even after a new botId/token has been saved (which was exactly the bug: the
// old hardcoded/env token kept responding because nothing ever switched over
// to the newly-saved one).
function getActiveBotToken(): string {
  const murad = getMuradBotConfig();
  if (murad && murad.botToken) return murad.botToken;
  // No hardcoded fallback token: the bot must not silently start against a
  // token that isn't yours. Set TELEGRAM_BOT_TOKEN in your own .env, or run
  // the "/" setup wizard, before deploying.
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is not set. Set it in your .env (see .env.example) or complete the '/' setup wizard before starting the bot."
    );
  }
  return token;
}

// -----------------------------------------------------------------------------
// Telegram delivery mode: WEBHOOK instead of long-polling.
// -----------------------------------------------------------------------------
// Why: this app runs on Cloud Run, where the platform can (and regularly does)
// keep more than one container instance alive at the same time -- e.g. the old
// and new revision briefly overlap during every redeploy ("إنشاء تكوين جديد
// للسيرفر"), or the service scales out under load. The previous implementation
// used an in-process `while (true) { getUpdates(...) }` long-polling loop that
// each instance started independently with its own in-memory offset and its
// own local clients.json/admin.json. Whenever two instances were alive at
// once, BOTH polled Telegram concurrently and BOTH answered the same button
// press, which is exactly the "نسخة ثانية / تشغيلين" (duplicate replies, with
// different, out-of-sync data) symptom.
//
// Telegram webhooks don't have this problem: Telegram pushes each update
// exactly once, over HTTPS, to the single URL we register. Cloud Run's load
// balancer hands that one HTTP request to exactly one instance, so only one
// process ever handles a given update -- no more duplicate answers even if
// several instances happen to be running.
const TELEGRAM_WEBHOOK_PATH = "/telegram/webhook";
function getWebhookSecret(): string {
  return crypto.createHash("sha256").update(getActiveBotToken()).digest("hex").slice(0, 32);
}

// Where admin.json/settings.json/clients.json live. Defaults to process.cwd()
// (unchanged behavior for local dev), but can be pointed at a mounted,
// persistent volume (see docker-compose.yml's /app/data mount) so these
// files survive container restarts/redeploys instead of silently resetting
// -- a reset admin.json is what let a random first-message sender become
// the (unremovable) primary admin. On Cloud Run there is no persistent
// volume at all, so TELEGRAM_ADMIN_CHAT_ID (now authoritative over this
// file, see getAdminConfig) is still the recommended way to pin ownership.
const DATA_DIR = process.env.DATA_DIR ? process.env.DATA_DIR : process.cwd();
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
} catch { /* fall through -- individual file writes will log their own errors */ }

const adminFilePath = path.join(DATA_DIR, "admin.json");

// -----------------------------------------------------------------------------
// "Murad bot" setup -- a password-gated, one-time-only panel exposed on the
// root ("/") endpoint that lets someone enter a second Telegram bot's
// id/token. Once saved it is permanent: write-once, nobody (not even with
// the correct password) can overwrite it afterwards short of deleting the
// file on disk directly.
// -----------------------------------------------------------------------------
const MURAD_SETUP_PASSWORD = process.env.MURAD_SETUP_PASSWORD || "moon2026";
const muradBotFilePath = path.join(DATA_DIR, "murad-bot.json");

interface MuradBotConfig {
  botId: string;
  botToken: string;
  savedAt: string;
}

function getMuradBotConfig(): MuradBotConfig | null {
  if (!fs.existsSync(muradBotFilePath)) return null;
  try {
    const data = JSON.parse(fs.readFileSync(muradBotFilePath, "utf8"));
    if (data && data.botId && data.botToken) return data as MuradBotConfig;
    return null;
  } catch {
    return null;
  }
}

// Returns true if this call is the one that actually persisted the config,
// false if it was already set (first-write-wins -- callers must treat
// `false` as "not allowed", not silently overwrite).
function saveMuradBotConfigOnce(botId: string, botToken: string): boolean {
  if (getMuradBotConfig()) return false;
  const config: MuradBotConfig = { botId, botToken, savedAt: new Date().toISOString() };
  try {
    // Fail closed against a race between two near-simultaneous requests: open
    // with "wx" so the write itself atomically fails if the file already
    // exists, instead of trusting the getMuradBotConfig() check above alone.
    const fd = fs.openSync(muradBotFilePath, "wx");
    fs.writeFileSync(fd, JSON.stringify(config, null, 2), "utf8");
    fs.closeSync(fd);
    addLog(`[Murad Bot] Config saved permanently (bot id ${botId}).`);
    return true;
  } catch {
    return false;
  }
}

// Basic in-memory throttle against password guessing on the setup panel --
// not a substitute for a strong password, but cheap insurance. Resets on
// restart; that's fine, this isn't meant to be a hard security boundary.
const muradSetupAttempts = new Map<string, { count: number; lockedUntil: number }>();
const MURAD_SETUP_MAX_ATTEMPTS = 5;
const MURAD_SETUP_LOCKOUT_MS = 10 * 60 * 1000;

function checkMuradSetupThrottle(ip: string): boolean {
  const rec = muradSetupAttempts.get(ip);
  if (!rec) return true;
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) return false;
  return true;
}

function recordMuradSetupFailure(ip: string) {
  const rec = muradSetupAttempts.get(ip) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MURAD_SETUP_MAX_ATTEMPTS) {
    rec.lockedUntil = Date.now() + MURAD_SETUP_LOCKOUT_MS;
    rec.count = 0;
  }
  muradSetupAttempts.set(ip, rec);
}

function recordMuradSetupSuccess(ip: string) {
  muradSetupAttempts.delete(ip);
}

function escapeHtml(str: any): string {
  if (str === null || str === undefined) return "";
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// -----------------------------------------------------------------------------
// Server location (country + flag) -- detected once from this server's own
// outbound/egress IP and cached, since it very rarely changes. Used to show
// e.g. "🌍 موقع السيرفر: 🇩🇪 ألمانيا" next to a client's details.
// -----------------------------------------------------------------------------
function countryCodeToFlagEmoji(countryCode: string): string {
  if (!countryCode || countryCode.length !== 2) return "🌍";
  const codePoints = countryCode
    .toUpperCase()
    .split("")
    .map(c => 127397 + c.charCodeAt(0));
  return String.fromCodePoint(...codePoints);
}

interface ServerLocationInfo {
  flag: string;
  countryName: string;
  countryCode: string;
  ip: string;
  city: string;
  isp: string;
}

let cachedServerLocation: ServerLocationInfo | null = null;
let cachedServerLocationAt = 0;
const SERVER_LOCATION_CACHE_MS = 6 * 60 * 60 * 1000; // 6 hours

// Builds one "🌍 IP: ... | 🏙️ City: ... | 🛰️ ISP: ..." style line from a
// resolved location, for messages that want more than just the country.
function formatServerLocationDetail(loc: ServerLocationInfo): string {
  const parts: string[] = [];
  if (loc.ip) parts.push(`🌐 IP: <code>${escapeHtml(loc.ip)}</code>`);
  if (loc.city) parts.push(`🏙️ ${escapeHtml(loc.city)}`);
  if (loc.isp) parts.push(`🛰️ ${escapeHtml(loc.isp)}`);
  return parts.join("  |  ");
}

// Tries several free geo-IP providers in order and returns the first one
// that answers with usable data. A single provider (what we had before) is
// fragile in practice: providers like ipapi.co frequently rate-limit or
// outright block requests coming from cloud/datacenter IP ranges (exactly
// what a Cloud Run / VPS server has), silently returning an error body with
// no country fields -- which is what was causing "🌍 غير معروف" to show up
// permanently. ip-api.com and ipinfo.io are both far more permissive with
// hosting-provider IPs, so trying them first/also makes this resolve
// reliably in a server context.
// Resolves a 2-letter country code to an Arabic display name using Node's
// built-in ICU data (no hardcoded table to maintain, and no network call).
// Used for every provider below so the displayed name is always in Arabic
// regardless of which one answered, and regardless of whether that
// provider's own "country name" field is in English.
function countryCodeToArabicName(code: string, fallback: string): string {
  if (!code || code.length !== 2) return fallback;
  try {
    const dn = new Intl.DisplayNames(["ar"], { type: "region" });
    return dn.of(code.toUpperCase()) || fallback;
  } catch {
    return fallback;
  }
}

function fetchFromIpApiCom(): Promise<ServerLocationInfo | null> {
  return new Promise((resolve) => {
    // Free tier is HTTP-only (no TLS) -- fine since we're just resolving
    // the server's own public IP/location, not sending anything sensitive.
    const req = http.get(
      "http://ip-api.com/json/?fields=status,country,countryCode,city,isp,query",
      { timeout: 5000 },
      (res) => {
        let data = "";
        res.on("data", chunk => data += chunk);
        res.on("end", () => {
          try {
            const json = JSON.parse(data);
            if (json && json.status === "success" && json.countryCode && json.country) {
              resolve({
                flag: countryCodeToFlagEmoji(json.countryCode),
                countryName: countryCodeToArabicName(json.countryCode, json.country),
                countryCode: json.countryCode,
                ip: json.query || "",
                city: json.city || "",
                isp: json.isp || ""
              });
              return;
            }
            resolve(null);
          } catch {
            resolve(null);
          }
        });
      }
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

// The exact provider requested: ipinfo.io/json (same one behind the
// `python3 -c "import requests; ..."` snippet). It only returns a 2-letter
// country code, not the full name, so we resolve the name from a compact
// lookup table below.
function fetchFromIpInfoIo(): Promise<ServerLocationInfo | null> {
  return new Promise((resolve) => {
    const req = https.get("https://ipinfo.io/json", { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json && json.country) {
            resolve({
              flag: countryCodeToFlagEmoji(json.country),
              countryName: countryCodeToArabicName(json.country, json.country),
              countryCode: json.country,
              ip: json.ip || "",
              city: json.city || "",
              isp: json.org || ""
            });
            return;
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

function fetchFromIpApiCo(): Promise<ServerLocationInfo | null> {
  return new Promise((resolve) => {
    const req = https.get("https://ipapi.co/json/", { timeout: 5000 }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (json && json.country_code && json.country_name) {
            resolve({
              flag: countryCodeToFlagEmoji(json.country_code),
              countryName: countryCodeToArabicName(json.country_code, json.country_name),
              countryCode: json.country_code,
              ip: json.ip || "",
              city: json.city || "",
              isp: json.org || ""
            });
            return;
          }
          resolve(null);
        } catch {
          resolve(null);
        }
      });
    });
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
  });
}

async function fetchServerLocation(): Promise<ServerLocationInfo | null> {
  for (const provider of [fetchFromIpApiCom, fetchFromIpInfoIo, fetchFromIpApiCo]) {
    const result = await provider();
    if (result) return result;
  }
  // All three providers failed (or the container has no outbound internet
  // access at all) -- log it so this is diagnosable from "📝 سجلات الخادم"
  // instead of silently showing "🌍 غير معروف" with no clue why.
  addLog("[GeoIP] Could not resolve server location: all providers (ip-api.com, ipinfo.io, ipapi.co) failed or are unreachable.");
  return null;
}

async function getServerLocation(): Promise<ServerLocationInfo | null> {
  const now = Date.now();
  if (cachedServerLocation && now - cachedServerLocationAt < SERVER_LOCATION_CACHE_MS) {
    return cachedServerLocation;
  }
  const location = await fetchServerLocation();
  if (location) {
    cachedServerLocation = location;
    cachedServerLocationAt = now;
  }
  return cachedServerLocation; // fall back to last known value if this lookup failed
}

interface SecondaryAdmin {
  id: string;
  name: string;
  addedAt: string;
}

interface AdminData {
  primaryAdmin: string | null;
  secondaryAdmins: SecondaryAdmin[];
  updatedAt?: string;
}

// Primary admin: this used to be a permanently hardcoded value that never
// changed even after a new deployer registered their own bot through the
// "/" setup wizard (murad-setup) -- their bot would then reject them as an
// unauthorized admin, since every check still compared against the original
// author's own ID. Fixed to read from the SAME murad-setup config that
// already stores each deployment's own botId/botToken (see
// getMuradBotConfig() above): whichever ID the deployer entered in the
// wizard is the one and only primary admin for their instance from then on.
// Falls back to HARDCODED_PRIMARY_ADMIN only for a fresh, not-yet-configured
// deployment (before anyone has completed the setup wizard).
const HARDCODED_PRIMARY_ADMIN = "1726923679";
function getPrimaryAdminId(): string {
  const murad = getMuradBotConfig();
  if (murad && murad.botId) return murad.botId;
  return HARDCODED_PRIMARY_ADMIN;
}

// The app runs on Cloud Run (see the webhook comment above), where a
// container's local disk is NOT guaranteed to survive redeploys, scale-out,
// or instance recycling -- admin.json can simply vanish and come back empty.
// Primary-admin identity is therefore never sourced from that file (nor from
// an env var, which someone could still forget to set on a fresh deploy) --
// only from getPrimaryAdminId() above, which is itself backed by the
// murad-setup config (persisted the same way the bot token is). admin.json
// is still read for secondaryAdmins, since losing/reshuffling those is a
// much lower-stakes, recoverable annoyance rather than a full loss of bot
// ownership.
function getAdminConfig(): AdminData {
  const primaryAdmin: string = getPrimaryAdminId();
  let secondaryAdmins: SecondaryAdmin[] = [];

  if (fs.existsSync(adminFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(adminFilePath, "utf8"));
      if (Array.isArray(data?.secondaryAdmins)) {
        secondaryAdmins = data.secondaryAdmins.map((a: any) => ({
          id: String(a.id || a).trim(),
          name: a.name ? String(a.name) : `آدمن ثانوي (${a.id || a})`,
          addedAt: a.addedAt || new Date().toISOString()
        }));
      }
    } catch {
      /* ignore */
    }
  }

  return { primaryAdmin, secondaryAdmins };
}

function saveAdminConfig(config: AdminData) {
  try {
    const payload = {
      primaryAdmin: config.primaryAdmin ? String(config.primaryAdmin).trim() : null,
      adminChatId: config.primaryAdmin ? String(config.primaryAdmin).trim() : null,
      secondaryAdmins: config.secondaryAdmins,
      updatedAt: new Date().toISOString()
    };
    fs.writeFileSync(adminFilePath, JSON.stringify(payload, null, 2), "utf8");
    addLog(`Admin config updated. Primary: ${config.primaryAdmin}, Secondaries: ${config.secondaryAdmins.length}`);
  } catch (err: any) {
    addLog(`Failed to save admin config: ${err?.message || err}`);
  }
}

function setPrimaryAdmin(id: string | number) {
  const config = getAdminConfig();
  config.primaryAdmin = String(id).trim();
  saveAdminConfig(config);
}

function addSecondaryAdmin(id: string | number, name?: string): { success: boolean; message: string } {
  const targetId = String(id).trim();
  if (!targetId || !/^\d+$/.test(targetId)) {
    return { success: false, message: "❌ معرف الأدمن يجب أن يكون رقماً صحيحاً (Chat ID)." };
  }
  const config = getAdminConfig();

  if (config.primaryAdmin === targetId) {
    return { success: false, message: "⚠️ هذا المعرف هو بالفعل الأدمن الرئيسي الأول ولا يمكن تحويله لثانوي." };
  }

  if (config.secondaryAdmins.some(a => a.id === targetId)) {
    return { success: false, message: "⚠️ هذا المعرف مضاف بالفعل كأدمن ثانوي." };
  }

  config.secondaryAdmins.push({
    id: targetId,
    name: name && name.trim() ? name.trim() : `آدمن ثانوي (${targetId})`,
    addedAt: new Date().toISOString()
  });

  saveAdminConfig(config);
  return { success: true, message: `✅ تم إضافة الأدمن الثانوي (ID: <code>${targetId}</code>) بنجاح!` };
}

function removeSecondaryAdmin(id: string | number): { success: boolean; message: string } {
  const targetId = String(id).trim();
  const config = getAdminConfig();

  if (config.primaryAdmin === targetId) {
    return { success: false, message: "🚫 <b>عفواً، لا يمكن حذف الأدمن الرئيسي الأول! الأدمن الرئيسي محمي دائماً ولا يستطيع أحد حذفه.</b>" };
  }

  const initialCount = config.secondaryAdmins.length;
  config.secondaryAdmins = config.secondaryAdmins.filter(a => a.id !== targetId);

  if (config.secondaryAdmins.length === initialCount) {
    return { success: false, message: "❌ الأدمن الثانوي غير موجود في القائمة." };
  }

  saveAdminConfig(config);
  return { success: true, message: `✅ تم حذف الأدمن الثانوي (ID: <code>${targetId}</code>) بنجاح.` };
}

// Pure read-only check -- intentionally has NO side effects. It used to
// silently call setPrimaryAdmin(idStr) and grant access the moment
// config.primaryAdmin was empty, which meant *any* caller of this function
// could end up permanently crowning a random id as primary admin. Primary
// admin now always comes from getPrimaryAdminId() (murad-setup's saved
// botId, or the pre-setup fallback) and can never be claimed or reassigned
// at runtime at all, so that failure mode is gone entirely.
function isAuthorizedAdmin(chatId: string | number): boolean {
  const idStr = String(chatId).trim();
  const config = getAdminConfig();

  if (!config.primaryAdmin) return false;
  if (config.primaryAdmin === idStr) return true;
  if (config.secondaryAdmins.some(a => a.id === idStr)) return true;

  return false;
}

function getAdminChatId(): string | null {
  return getAdminConfig().primaryAdmin;
}

function saveAdminChatId(id: string | number) {
  setPrimaryAdmin(id);
}

// -----------------------------------------------------------------------------
// Public bot settings (settings.json) -- controls whether ANY Telegram user can
// self-service a single personal VLESS config, and the default duration/quota
// the admin assigns to those self-service configs.
// -----------------------------------------------------------------------------
const settingsFilePath = path.join(DATA_DIR, "settings.json");

interface BotSettings {
  publicBotEnabled: boolean;
  userConfigDurationMinutes: number;
  userConfigQuotaGB: number;
}

function getSettings(): BotSettings {
  const defaults: BotSettings = {
    publicBotEnabled: false,
    userConfigDurationMinutes: 43200, // 30 days
    userConfigQuotaGB: 0 // unlimited
  };
  if (fs.existsSync(settingsFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(settingsFilePath, "utf8"));
      return { ...defaults, ...data };
    } catch {
      return defaults;
    }
  }
  return defaults;
}

function saveSettings(settings: BotSettings) {
  try {
    fs.writeFileSync(settingsFilePath, JSON.stringify(settings, null, 2), "utf8");
    addLog(`Settings updated: publicBotEnabled=${settings.publicBotEnabled}, userConfigDurationMinutes=${settings.userConfigDurationMinutes}, userConfigQuotaGB=${settings.userConfigQuotaGB}`);
  } catch (err: any) {
    addLog(`Failed to save settings: ${err?.message || err}`);
  }
}

const app = express();
const server = http.createServer(app);

// -----------------------------------------------------------------------------
// Server-level scaling so a burst of many users (up to ~10,000) connecting at
// once still gets accepted and upgraded to WebSocket quickly instead of
// piling up in the OS accept queue or hitting an artificially small socket
// pool.
// -----------------------------------------------------------------------------
server.maxConnections = Infinity; // no artificial cap on simultaneous sockets
server.keepAliveTimeout = 65_000; // keep client connections warm a bit longer
server.headersTimeout = 66_000;   // must stay above keepAliveTimeout

app.use(express.json());

// -----------------------------------------------------------------------------
// Auto-detected public host
// -----------------------------------------------------------------------------
const detectedHostFilePath = path.join(DATA_DIR, "detected-host.json");
let cachedPublicHost: string | null = null;

function isLikelyPublicHost(h: string): boolean {
  if (!h) return false;
  const host = h.split(":")[0].toLowerCase();
  if (host === "localhost" || host === "0.0.0.0") return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (!host.includes(".")) return false;
  return true;
}

function rememberPublicHost(host: string) {
  if (!isLikelyPublicHost(host) || host === cachedPublicHost) return;
  cachedPublicHost = host;
  try {
    fs.writeFileSync(detectedHostFilePath, JSON.stringify({ host, updatedAt: new Date().toISOString() }, null, 2), "utf8");
  } catch {
    /* best-effort only */
  }
  addLog(`Auto-detected public domain: ${host}`);
}

function loadPersistedHost() {
  try {
    if (fs.existsSync(detectedHostFilePath)) {
      const data = JSON.parse(fs.readFileSync(detectedHostFilePath, "utf8"));
      if (data?.host && isLikelyPublicHost(data.host)) {
        cachedPublicHost = data.host;
      }
    }
  } catch {
    /* ignore */
  }
}
loadPersistedHost();

app.use((req, _res, next) => {
  const forwarded = (req.headers["x-forwarded-host"] as string) || req.headers.host;
  if (forwarded) rememberPublicHost(forwarded.split(",")[0].trim());
  next();
});

async function detectCloudRunHostFromMetadata(): Promise<string | null> {
  const service = process.env.K_SERVICE;
  if (!service) return null;

  try {
    const metaHeaders = { "Metadata-Flavor": "Google" };
    const [regionRes, projectRes] = await Promise.all([
      fetch("http://metadata.google.internal/computeMetadata/v1/instance/region", { headers: metaHeaders }),
      fetch("http://metadata.google.internal/computeMetadata/v1/project/numeric-project-id", { headers: metaHeaders })
    ]);
    if (!regionRes.ok || !projectRes.ok) return null;

    const regionRaw = (await regionRes.text()).trim();
    const projectNumber = (await projectRes.text()).trim();
    const region = regionRaw.split("/").pop();
    if (!region || !projectNumber) return null;

    return `${service}-${projectNumber}.${region}.run.app`;
  } catch (e: any) {
    addLog(`Metadata-server domain auto-detection failed: ${e?.message || e}`);
    return null;
  }
}

detectCloudRunHostFromMetadata().then((detected) => {
  if (detected && !cachedPublicHost) rememberPublicHost(detected);
});

function getPublicDomain(): string {
  if (process.env.APP_URL) {
    try {
      const u = new URL(process.env.APP_URL);
      return u.hostname;
    } catch {
      return process.env.APP_URL.replace(/^https?:\/\//, "").split("/")[0];
    }
  }
  if (cachedPublicHost) return cachedPublicHost;
  return "0.0.0.0";
}

// -----------------------------------------------------------------------------
// Keep-Alive self-ping
// -----------------------------------------------------------------------------
// Periodically pings this instance's own public domain in the background so
// the host platform (e.g. Cloud Run) doesn't treat it as idle and spin it
// down, which would otherwise cause cold starts / dropped connections for
// clients. Runs entirely in-process -- no separate bot/service involved.
const KEEP_ALIVE_INTERVAL_MS = 30 * 1000;
const KEEP_ALIVE_TIMEOUT_MS = 10 * 1000;

async function pingSelf() {
  const domain = getPublicDomain();
  if (!domain || domain === "0.0.0.0") {
    // Public domain not detected yet -- nothing to ping.
    return;
  }
  const url = `https://${domain}/health`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), KEEP_ALIVE_TIMEOUT_MS);
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: controller.signal, headers: { "User-Agent": "KeepAlive/1.0" } });
    const elapsedMs = Date.now() - start;
    addLog(`[Keep-Alive] ${res.status === 200 ? "✅" : `⚠️${res.status}`} ${url} (${elapsedMs}ms)`);
  } catch (err: any) {
    addLog(`[Keep-Alive] ❌ ${url} -- ${err?.message || err}`);
  } finally {
    clearTimeout(timeout);
  }
}

function startKeepAlive() {
  setInterval(() => {
    pingSelf().catch(() => { /* pingSelf already logs its own errors */ });
  }, KEEP_ALIVE_INTERVAL_MS);
  addLog(`[Keep-Alive] Started -- self-pinging every ${KEEP_ALIVE_INTERVAL_MS / 1000}s.`);
}

// -----------------------------------------------------------------------------
// Logging
// -----------------------------------------------------------------------------
const logs: string[] = [];
function addLog(message: string) {
  const timestamp = new Date().toISOString();
  const formattedLog = `[${timestamp}] ${message}`;
  logs.push(formattedLog);
  if (logs.length > 500) {
    logs.shift();
  }
  console.log(formattedLog);
}

// -----------------------------------------------------------------------------
// V2Ray process state
// -----------------------------------------------------------------------------
let v2rayProcessA: ChildProcess | null = null;
let v2rayProcessB: ChildProcess | null = null;
let activeSlot: "A" | "B" = "A";
// Tracks how many currently-open proxied connections are using each slot's
// V2Ray process, so a restart can wait for the old slot to actually drain
// instead of SIGKILL-ing it (and everyone connected through it) right away.
const slotConnectionCounts: Record<"A" | "B", number> = { A: 0, B: 0 };

function getSlotPorts(slot: string) {
  if (slot === "B") {
    return { vless: 10090, vmess: 10091, trojan: 10092 };
  }
  return { vless: 10080, vmess: 10081, trojan: 10082 };
}

// -----------------------------------------------------------------------------
// Clients database (clients.json)
// -----------------------------------------------------------------------------
const clientsFilePath = path.join(DATA_DIR, "clients.json");

interface ClientConfig {
  id: string;
  name: string;
  protocol: "vless" | "vmess" | "trojan";
  uuid: string;
  path: string;
  limitGB: number;
  consumedUpload: number;
  consumedDownload: number;
  duration: string;
  durationValue: number;
  createdAt: string;
  expiresAt: string | null;
  enabled: boolean;
  ownerId?: string;       // Telegram user id, set for self-service public-bot configs
  isUserOwned?: boolean;  // true for configs created by a regular (non-admin) user
  sharedFlag?: boolean;   // true if auto-disabled because it was detected being used from 2+ devices at once
}

function initClientsDB() {
  if (!fs.existsSync(clientsFilePath)) {
    const nowIso = new Date().toISOString();
    const defaultDB = {
      clients: [
        {
          id: "default",
          name: "Default Client",
          protocol: "vless",
          uuid: "d2cb8181-233c-4d18-9972-8a1b04db0044",
          path: "/by_moon",
          limitGB: 0,
          consumedUpload: 0,
          consumedDownload: 0,
          duration: "unlimited",
          durationValue: 0,
          createdAt: nowIso,
          expiresAt: null,
          enabled: true
        },
        {
          id: "default-vmess",
          name: "Default Client (VMess)",
          protocol: "vmess",
          uuid: "b7e2a4d0-5f1c-4a8e-9b3d-6c2f0e4a7d19",
          path: "/by_moon_vmess",
          limitGB: 0,
          consumedUpload: 0,
          consumedDownload: 0,
          duration: "unlimited",
          durationValue: 0,
          createdAt: nowIso,
          expiresAt: null,
          enabled: true
        },
        {
          id: "default-trojan",
          name: "Default Client (Trojan)",
          protocol: "trojan",
          uuid: "f3c8b6a2-1d9e-4c7b-a5f0-8e2d4b6c9a31",
          path: "/by_moon_trojan",
          limitGB: 0,
          consumedUpload: 0,
          consumedDownload: 0,
          duration: "unlimited",
          durationValue: 0,
          createdAt: nowIso,
          expiresAt: null,
          enabled: true
        }
      ]
    };
    fs.writeFileSync(clientsFilePath, JSON.stringify(defaultDB, null, 2), "utf8");
    addLog("Created initial clients.json database (default VLESS + VMess + Trojan clients).");
    return;
  }

  // Migration: a clients.json created before this change only has the
  // default VLESS client. Seed the missing default VMess/Trojan clients
  // once so upgraded deployments also get permanent default configs for
  // all three protocols, without touching any existing user clients.
  try {
    const raw = JSON.parse(fs.readFileSync(clientsFilePath, "utf8"));
    const existingClients: ClientConfig[] = Array.isArray(raw?.clients) ? raw.clients : [];
    const nowIso = new Date().toISOString();
    let changed = false;

    if (!existingClients.some((c) => c.id === "default-vmess")) {
      existingClients.push({
        id: "default-vmess",
        name: "Default Client (VMess)",
        protocol: "vmess",
        uuid: "b7e2a4d0-5f1c-4a8e-9b3d-6c2f0e4a7d19",
        path: "/by_moon_vmess",
        limitGB: 0,
        consumedUpload: 0,
        consumedDownload: 0,
        duration: "unlimited",
        durationValue: 0,
        createdAt: nowIso,
        expiresAt: null,
        enabled: true
      } as ClientConfig);
      changed = true;
    }

    if (!existingClients.some((c) => c.id === "default-trojan")) {
      existingClients.push({
        id: "default-trojan",
        name: "Default Client (Trojan)",
        protocol: "trojan",
        uuid: "f3c8b6a2-1d9e-4c7b-a5f0-8e2d4b6c9a31",
        path: "/by_moon_trojan",
        limitGB: 0,
        consumedUpload: 0,
        consumedDownload: 0,
        duration: "unlimited",
        durationValue: 0,
        createdAt: nowIso,
        expiresAt: null,
        enabled: true
      } as ClientConfig);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(clientsFilePath, JSON.stringify({ clients: existingClients }, null, 2), "utf8");
      addLog("Migrated clients.json: added missing default VMess/Trojan clients.");
    }
  } catch (e: any) {
    addLog(`clients.json migration check failed: ${e?.message || e}`);
  }
}

// In-memory, write-through cache of clients.json. getPersistedClients() is
// called on the hot path -- once per incoming WebSocket connection, and again
// per data packet while sniffing a VLESS UUID -- so re-reading and
// JSON-parsing the file from disk synchronously every time becomes a real
// bottleneck once there are many clients/connections (this blocks Node's
// single event loop, which is exactly what "connections feel heavy past ~8
// concurrent users" looks like). The cache is kept in sync on every write via
// savePersistedClients(), so it can never go stale within this process.
let clientsCache: ClientConfig[] | null = null;
// Index maps rebuilt alongside clientsCache so the hot connection-routing path
// (every WS upgrade, and every VLESS UUID sniffed from a first data frame)
// does an O(1) lookup instead of scanning the entire clients array -- this is
// what actually lets thousands of concurrent clients stay snappy.
let clientsByUuid: Map<string, ClientConfig> | null = null;
let clientsByPath: Map<string, ClientConfig> | null = null;

function rebuildClientIndexes(clients: ClientConfig[]) {
  const byUuid = new Map<string, ClientConfig>();
  const byPath = new Map<string, ClientConfig>();
  for (const c of clients) {
    if (c.uuid) byUuid.set(c.uuid.toLowerCase(), c);
    if (c.path) byPath.set(c.path, c);
  }
  clientsByUuid = byUuid;
  clientsByPath = byPath;
}

function getPersistedClients(): ClientConfig[] {
  if (clientsCache !== null) {
    return clientsCache;
  }
  if (fs.existsSync(clientsFilePath)) {
    try {
      const data = JSON.parse(fs.readFileSync(clientsFilePath, "utf8"));
      clientsCache = data.clients || [];
      rebuildClientIndexes(clientsCache!);
      return clientsCache!;
    } catch {
      clientsCache = [];
      rebuildClientIndexes(clientsCache);
      return clientsCache;
    }
  }
  clientsCache = [];
  rebuildClientIndexes(clientsCache);
  return clientsCache;
}

function savePersistedClients(clients: ClientConfig[]) {
  let db: any = { clients };
  try {
    if (fs.existsSync(clientsFilePath)) {
      const existing = JSON.parse(fs.readFileSync(clientsFilePath, "utf8"));
      db = { ...existing, clients };
    }
  } catch {
    /* fallback */
  }
  fs.writeFileSync(clientsFilePath, JSON.stringify(db, null, 2), "utf8");
  clientsCache = clients;
  rebuildClientIndexes(clients);
}

// O(1) lookups for the connection-routing hot path (see comment above).
function getClientByUuidFast(uuid: string): ClientConfig | undefined {
  getPersistedClients();
  return clientsByUuid?.get(uuid.toLowerCase());
}

function getClientByPathFast(p: string): ClientConfig | undefined {
  getPersistedClients();
  return clientsByPath?.get(p);
}

// -----------------------------------------------------------------------------
// V2Ray binary bootstrap
// -----------------------------------------------------------------------------
const binDir = path.join(process.cwd(), "bin");
const v2rayPath = path.join(binDir, "v2ray");

function ensureV2RayBinary() {
  if (fs.existsSync(v2rayPath)) {
    addLog("V2Ray binary exists at " + v2rayPath);
    return;
  }

  addLog("V2Ray binary not found. Downloading...");
  try {
    if (!fs.existsSync(binDir)) {
      fs.mkdirSync(binDir, { recursive: true });
    }

    const zipPath = path.join(binDir, "v2ray-linux-64.zip");
    addLog("Downloading V2Ray core zip from GitHub releases...");

    execSync(`curl -L -o "${zipPath}" "https://github.com/v2fly/v2ray-core/releases/download/v5.14.1/v2ray-linux-64.zip"`, {
      stdio: "inherit"
    });

    addLog("Extracting V2Ray core zip...");
    execSync(`unzip -o "${zipPath}" -d "${binDir}"`, {
      stdio: "inherit"
    });

    addLog("Setting executable permission on v2ray...");
    execSync(`chmod +x "${v2rayPath}"`, {
      stdio: "inherit"
    });

    if (fs.existsSync(zipPath)) {
      fs.unlinkSync(zipPath);
    }

    addLog("V2Ray binary successfully installed.");
  } catch (error: any) {
    addLog(`ERROR installing V2Ray binary: ${error?.message || error}`);
  }
}

// -----------------------------------------------------------------------------
// V2Ray Config Generation & Process Management
// -----------------------------------------------------------------------------
function generateV2RayConfigForSlot(slot: "A" | "B", clients: ClientConfig[]) {
  const ports = getSlotPorts(slot);
  const domain = getPublicDomain();
  const nowTime = Date.now();
  const activeClients = clients.filter(c => {
    if (!c.enabled) return false;
    if (c.expiresAt && new Date(c.expiresAt).getTime() < nowTime) return false;
    if (c.limitGB > 0) {
      const consumed = (c.consumedUpload || 0) + (c.consumedDownload || 0);
      const limitBytes = c.limitGB * 1024 * 1024 * 1024;
      if (consumed >= limitBytes) return false;
    }
    return true;
  });

  const vlessClients = activeClients.filter(c => c.protocol === "vless").map(c => ({ id: c.uuid, level: 0 }));
  const vmessClients = activeClients.filter(c => c.protocol === "vmess").map(c => ({ id: c.uuid, alterId: 0, level: 0 }));
  const trojanClients = activeClients.filter(c => c.protocol === "trojan").map(c => ({ password: c.uuid, level: 0 }));

  const wsHeaders = { Host: domain };

  // Standard paths
  const inbounds: any[] = [];

  // Add VLESS inbound
  inbounds.push({
    listen: "0.0.0.0",
    port: ports.vless,
    protocol: "vless",
    settings: {
      clients: vlessClients.length > 0 ? vlessClients : [{ id: "d2cb8181-233c-4d18-9972-8a1b04db0044", level: 0 }],
      decryption: "none"
    },
    streamSettings: {
      network: "ws",
      wsSettings: { path: "/by_moon", headers: wsHeaders },
      sockopt: { tcpFastOpen: true, tcpKeepAliveInterval: 15 }
    }
  });

  // Add VMess inbound
  inbounds.push({
    listen: "0.0.0.0",
    port: ports.vmess,
    protocol: "vmess",
    settings: {
      clients: vmessClients.length > 0 ? vmessClients : [{ id: "d2cb8181-233c-4d18-9972-8a1b04db0044", alterId: 0, level: 0 }]
    },
    streamSettings: {
      network: "ws",
      wsSettings: { path: "/by_moon_vmess", headers: wsHeaders },
      sockopt: { tcpFastOpen: true, tcpKeepAliveInterval: 15 }
    }
  });

  // Add Trojan inbound
  inbounds.push({
    listen: "0.0.0.0",
    port: ports.trojan,
    protocol: "trojan",
    settings: {
      clients: trojanClients.length > 0 ? trojanClients : [{ password: "d2cb8181-233c-4d18-9972-8a1b04db0044", level: 0 }]
    },
    streamSettings: {
      network: "ws",
      wsSettings: { path: "/by_moon_trojan", headers: wsHeaders },
      sockopt: { tcpFastOpen: true, tcpKeepAliveInterval: 15 }
    }
  });

  // NOTE: individual clients are NOT given their own inbound/port here.
  // Xray/V2Ray-core cannot bind two inbounds to the same listen+port (which a
  // "per-client custom path" inbound would require, since all clients share
  // the same 3 ports). Every client -- default-path or custom-path alike --
  // is already included by UUID in the shared inbounds' `clients` arrays
  // above; that's the standard, scalable way v2ray-core differentiates many
  // users on one inbound. The per-client "path" (e.g. /by_moon_xxxxxxxx) is
  // only used at OUR OWN reverse-proxy layer (see the `upgrade` handler) to
  // identify which client is connecting for bookkeeping/anti-sharing/expiry
  // checks -- the proxy then rewrites the request to the shared path before
  // forwarding it to xray, so xray itself only ever needs these 3 inbounds
  // no matter how many thousands of clients exist.

  const config = {
    log: { loglevel: "warning" },
    // `policy` tunes xray-core's per-connection resource handling so it
    // scales comfortably to thousands of simultaneously-connected clients
    // instead of using the (fairly conservative) built-in defaults:
    //  - handshake: how long a client has to complete the protocol
    //    handshake before being dropped -- kept short so a slow/dead
    //    connection attempt doesn't tie up a slot.
    //  - connIdle: how long an idle-but-open connection is kept around.
    //  - bufferSize: per-connection read/write buffer (KB); larger buffers
    //    reduce syscall overhead under high concurrent throughput.
    policy: {
      levels: {
        "0": {
          handshake: 4,
          connIdle: 300,
          uplinkOnly: 2,
          downlinkOnly: 5,
          bufferSize: 512
        }
      },
      system: {
        statsInboundUplink: false,
        statsInboundDownlink: false
      }
    },
    inbounds,
    outbounds: [
      {
        protocol: "freedom",
        settings: { domainStrategy: "UseIPv4" },
        streamSettings: { sockopt: { tcpFastOpen: true } }
      }
    ]
  };

  const configFile = path.join(process.cwd(), `config_${slot}.json`);
  fs.writeFileSync(configFile, JSON.stringify(config, null, 2), "utf8");
  return configFile;
}

function startV2RayProcess(slot: "A" | "B") {
  if (!fs.existsSync(v2rayPath)) {
    addLog("Cannot start V2Ray: binary not found.");
    return;
  }

  const clients = getPersistedClients();
  const configFile = generateV2RayConfigForSlot(slot, clients);

  addLog(`Starting V2Ray on Slot ${slot} using ${configFile}...`);
  // xray-core (Go) parallelizes connection handling across OS threads
  // automatically via goroutines, using one OS thread per CPU core by
  // default -- but explicitly setting GOMAXPROCS guards against containers
  // where the CPU count isn't detected correctly (e.g. a misreported cgroup
  // limit leaving it pinned at 1 thread), which is what actually causes
  // "slow to connect under load" at scale, not a missing per-config thread
  // setting (there's no such concept in xray -- all clients already share
  // the same few inbounds, see the note above generateV2RayConfigForSlot).
  const child = spawn(v2rayPath, ["run", "-c", configFile], {
    env: { ...process.env, GOMAXPROCS: String(Math.max(1, os.cpus().length)) }
  });

  child.stdout?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) addLog(`[V2Ray ${slot}] ${msg}`);
  });

  child.stderr?.on("data", (data) => {
    const msg = data.toString().trim();
    if (msg) addLog(`[V2Ray ${slot} Err] ${msg}`);
  });

  child.on("exit", (code) => {
    addLog(`V2Ray process Slot ${slot} exited with code ${code}`);
    if (slot === "A") v2rayProcessA = null;
    if (slot === "B") v2rayProcessB = null;
  });

  if (slot === "A") v2rayProcessA = child;
  if (slot === "B") v2rayProcessB = child;
}

function stopV2RayProcess(slot: "A" | "B") {
  const proc = slot === "A" ? v2rayProcessA : v2rayProcessB;
  if (proc) {
    addLog(`Stopping V2Ray Slot ${slot}...`);
    proc.kill("SIGKILL");
    if (slot === "A") v2rayProcessA = null;
    if (slot === "B") v2rayProcessB = null;
  }
}

// How long to wait for currently-open connections on the old slot to finish
// naturally before we give up and force-kill it anyway (safety net so an old
// process can never linger forever).
const SLOT_DRAIN_MAX_WAIT_MS = 3 * 60 * 1000;
const SLOT_DRAIN_POLL_MS = 2000;

function restartV2Ray() {
  const nextSlot: "A" | "B" = activeSlot === "A" ? "B" : "A";
  startV2RayProcess(nextSlot);

  setTimeout(() => {
    const oldSlot = activeSlot;
    // Flip immediately: every new incoming connection starts using the new
    // slot right away, so the old slot only has to serve out connections
    // that were already open before this restart -- nothing new lands on it.
    activeSlot = nextSlot;
    addLog(`Active V2Ray slot switched to ${activeSlot}`);

    const startedDrainAt = Date.now();
    const tryStopOldSlot = () => {
      const stillActive = slotConnectionCounts[oldSlot] > 0;
      const timedOut = Date.now() - startedDrainAt > SLOT_DRAIN_MAX_WAIT_MS;
      if (!stillActive || timedOut) {
        if (stillActive && timedOut) {
          addLog(`[Slot Drain] Slot ${oldSlot} still has ${slotConnectionCounts[oldSlot]} active connection(s) after ${SLOT_DRAIN_MAX_WAIT_MS / 1000}s -- stopping it anyway.`);
        }
        stopV2RayProcess(oldSlot);
        return;
      }
      setTimeout(tryStopOldSlot, SLOT_DRAIN_POLL_MS);
    };
    tryStopOldSlot();
  }, 1000);
}

// Coalesces multiple rapid client changes (several people creating/renewing
// configs within a couple seconds of each other -- realistic at real scale)
// into a single V2Ray restart instead of one full restart per action. Each
// restart already avoids dropping other users' live connections (slot drain
// above); debouncing on top of that avoids doing many of those restarts
// back-to-back when it isn't necessary.
let restartDebounceTimer: NodeJS.Timeout | null = null;
function scheduleV2RayRestart() {
  if (restartDebounceTimer) {
    clearTimeout(restartDebounceTimer);
  }
  restartDebounceTimer = setTimeout(() => {
    restartDebounceTimer = null;
    restartV2Ray();
  }, 1500);
}

function parseVlessUUID(chunk: any): string | null {
  try {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (!buf || buf.length < 23) return null;

    const opcode = buf[0] & 0x0f;
    if (opcode !== 0x02) return null;

    const isMasked = (buf[1] & 0x80) !== 0;
    let payloadLen = buf[1] & 0x7f;
    let maskingKeyOffset = 2;
    let payloadStart = 6;

    if (payloadLen === 126) {
      if (buf.length < 25) return null;
      payloadLen = buf.readUInt16BE(2);
      maskingKeyOffset = 4;
      payloadStart = 8;
    } else if (payloadLen === 127) {
      if (buf.length < 31) return null;
      maskingKeyOffset = 10;
      payloadStart = 14;
    }

    if (buf.length < payloadStart + 17) return null;

    const uuidBytes = Buffer.alloc(16);
    if (isMasked) {
      const maskingKey = buf.slice(maskingKeyOffset, maskingKeyOffset + 4);
      for (let i = 0; i < 16; i++) {
        const maskedByte = buf[payloadStart + 1 + i];
        const maskKeyByte = maskingKey[(1 + i) % 4];
        uuidBytes[i] = maskedByte ^ maskKeyByte;
      }
    } else {
      for (let i = 0; i < 16; i++) {
        uuidBytes[i] = buf[payloadStart + 1 + i];
      }
    }

    const hex = uuidBytes.toString("hex");
    if (hex.length !== 32) return null;

    return [hex.substring(0, 8), hex.substring(8, 12), hex.substring(12, 16), hex.substring(16, 20), hex.substring(20, 32)].join("-");
  } catch (err) {
    return null;
  }
}

// -----------------------------------------------------------------------------
// Per-client traffic tracking (buffered writes to clients.json every 5s)
// -----------------------------------------------------------------------------
interface TrafficBatch {
  upload: number;
  download: number;
}
const trafficBuffer: Record<string, TrafficBatch> = {};
const activeSockets: Record<string, Set<any>> = {};

function accumulateTraffic(clientId: string, bytes: number, type: "upload" | "download") {
  if (!trafficBuffer[clientId]) {
    trafficBuffer[clientId] = { upload: 0, download: 0 };
  }
  trafficBuffer[clientId][type] += bytes;
}

setInterval(() => {
  const clientIds = Object.keys(trafficBuffer);
  if (clientIds.length === 0) return;

  const clients = getPersistedClients();
  if (clients.length === 0) return;
  let modified = false;

  for (const id of clientIds) {
    const buffer = trafficBuffer[id];
    if (buffer.upload === 0 && buffer.download === 0) continue;

    const client = clients.find(c => c.id === id);
    if (client) {
      client.consumedUpload = (client.consumedUpload || 0) + buffer.upload;
      client.consumedDownload = (client.consumedDownload || 0) + buffer.download;
      modified = true;
    }

    trafficBuffer[id] = { upload: 0, download: 0 };
  }

  if (modified) {
    savePersistedClients(clients);
  }
}, 5000);

// Periodically sweep for clients who expired or exceeded quota mid-session and
// hot-restart V2Ray so they get dropped from the freshly generated config
// (generateV2RayConfigForSlot already filters them out).
setInterval(() => {
  const clients = getPersistedClients();
  const nowTime = Date.now();
  let needsRestart = false;

  for (const client of clients) {
    if (!client.enabled) continue;
    const hasExpired = client.expiresAt && new Date(client.expiresAt).getTime() < nowTime;
    const consumed = (client.consumedUpload || 0) + (client.consumedDownload || 0);
    const limitBytes = (client.limitGB || 0) * 1024 * 1024 * 1024;
    const hasExceededLimit = client.limitGB > 0 && consumed >= limitBytes;

    if (hasExpired || hasExceededLimit) {
      const sockets = activeSockets[client.id];
      if (sockets && sockets.size > 0) {
        addLog(`[Quota Monitor] Cutting off active connections for ${client.name} (${hasExceededLimit ? "quota exceeded" : "expired"}).`);
        for (const s of Array.from(sockets)) {
          try { s.destroy(); } catch (e) { /* ignore */ }
        }
        sockets.clear();
        needsRestart = true;
      }
    }
  }

  if (needsRestart) {
    scheduleV2RayRestart();
  }
}, 15000);


// -----------------------------------------------------------------------------
// Minimal ZIP writer (STORE method, no compression, no external dependency).
// Used to package a DarkTunnel config file + an HTTP Custom config file
// together whenever a new client config is created, so the admin/user gets
// one .zip with both ready-to-import files.
// -----------------------------------------------------------------------------
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Buffer): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    crc = CRC32_TABLE[(crc ^ buf[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d: Date): { time: number; date: number } {
  const time = ((d.getHours() & 0x1F) << 11) | ((d.getMinutes() & 0x3F) << 5) | ((Math.floor(d.getSeconds() / 2)) & 0x1F);
  const date = (((d.getFullYear() - 1980) & 0x7F) << 9) | (((d.getMonth() + 1) & 0xF) << 5) | (d.getDate() & 0x1F);
  return { time, date };
}

function createZip(entries: { name: string; data: Buffer }[]): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const { time, date } = dosDateTime(new Date());

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const crc = crc32(entry.data);
    const size = entry.data.length;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(size, 18);
    localHeader.writeUInt32LE(size, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuf, entry.data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(size, 20);
    centralHeader.writeUInt32LE(size, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + entry.data.length;
  }

  const centralDirStart = offset;
  const centralDirBuf = Buffer.concat(centralParts);

  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirBuf.length, 12);
  end.writeUInt32LE(centralDirStart, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirBuf, end]);
}

// The SNI/Host shown on the wire is always faked to a well-known, rarely
// blocked domain to help the connection blend in with normal traffic.
const FAKE_SNI_HOST = "youtube.com";

// Builds the exact DarkTunnel import format: a single-line
// "darktunnel://<base64 JSON>" string. Confirmed against a real DarkTunnel
// export (مستخدم_1772564386.dark):
//   {"type":"VLESS","name":"...","vlessTunnelConfig":{"v2rayConfig":{
//     "host":"<domain>","port":443,"uuid":"<uuid>",
//     "serverNameIndication":"youtube.com","wsPath":"<path>",
//     "wsHeaderHost":"<domain>"
//   }}}
// Note serverNameIndication (TLS SNI) is faked to youtube.com while
// wsHeaderHost (the WebSocket Host header) stays the real domain -- that's
// what actually lets the connection reach and be routed to this server.
function buildDarkTunnelLink(client: ClientConfig): string {
  const domain = getPublicDomain();
  const clientPath = client.path || "/by_moon";

  const v2rayConfig: any = {
    host: domain,
    port: 443,
    uuid: client.uuid
  };

  let typeTag: string;
  let wrapperKey: string;
  if (client.protocol === "vmess") {
    typeTag = "VMESS";
    wrapperKey = "vmessTunnelConfig";
  } else if (client.protocol === "trojan") {
    typeTag = "TROJAN";
    wrapperKey = "trojanTunnelConfig";
    // Trojan configs additionally carry this field in DarkTunnel's schema
    // (must come right after uuid to match the app's exact export order).
    v2rayConfig.transportNetwork = "Websocket";
  } else {
    typeTag = "VLESS";
    wrapperKey = "vlessTunnelConfig";
  }

  v2rayConfig.serverNameIndication = FAKE_SNI_HOST;
  v2rayConfig.wsPath = clientPath;
  v2rayConfig.wsHeaderHost = domain;

  const payload: any = {
    type: typeTag,
    name: client.name || "V2Ray",
    [wrapperKey]: { v2rayConfig }
  };

  const b64 = Buffer.from(JSON.stringify(payload), "utf8").toString("base64");
  return `darktunnel://${b64}`;
}

// Builds the DarkTunnel config file for a client and sends it directly to the
// chat as "<name>.dark" (no zip). Called right after a config is created or
// renewed (admin-created clients and self-service user configs alike).
async function sendAppConfigZip(chatId: number | string, client: ClientConfig) {
  try {
    const darkTunnelLink = buildDarkTunnelLink(client);
    const safeName = (client.name || "config")
      .replace(/[\/\\:*?"<>|\x00-\x1F]+/g, "_")
      .replace(/\s+/g, "_")
      .slice(0, 60) || "config";

    const caption =
      `📦 <b>ملف تكوين DarkTunnel (${escapeHtml(client.name || "")})</b>\n\n` +
      `📱 افتح تطبيق DarkTunnel ← استيراد (Import) ← اختر هذا الملف <code>${safeName}.dark</code>\n\n` +
      `⚠️ تم ضبط الـ SNI تلقائياً على <code>${FAKE_SNI_HOST}</code> للتمويه.`;

    const docRes = await sendTelegramDocumentBuffer(
      chatId,
      Buffer.from(darkTunnelLink, "utf8"),
      `${safeName}.dark`,
      caption
    );
    if (!docRes || !docRes.ok) {
      addLog(`sendAppConfigZip: sendDocument did not confirm success for chat ${chatId}`);
    }
  } catch (err: any) {
    addLog(`Failed to build/send DarkTunnel config file: ${err?.message || err}`);
  }
}


function generateClientLinks(client: ClientConfig): { link: string; type: string } {
  const domain = getPublicDomain();
  const clientPath = client.path || "/by_moon";
  const name = client.name || "V2Ray";

  if (client.protocol === "vmess") {
    const vmessObj = {
      v: "2",
      ps: name,
      add: domain,
      port: "443",
      id: client.uuid,
      aid: "0",
      scy: "auto",
      net: "ws",
      type: "none",
      host: domain,
      sni: domain,
      path: clientPath,
      tls: "tls"
    };
    const encoded = Buffer.from(JSON.stringify(vmessObj)).toString("base64");
    return { link: `vmess://${encoded}`, type: "VMess" };
  } else if (client.protocol === "trojan") {
    const link = `trojan://${client.uuid}@${domain}:443?type=ws&security=tls&host=${encodeURIComponent(domain)}&sni=${encodeURIComponent(domain)}&path=${encodeURIComponent(clientPath)}#${encodeURIComponent(name)}`;
    return { link, type: "Trojan" };
  } else {
    // VLESS
    const link = `vless://${client.uuid}@${domain}:443?type=ws&security=tls&host=${encodeURIComponent(domain)}&sni=${encodeURIComponent(domain)}&path=${encodeURIComponent(clientPath)}#${encodeURIComponent(name)}`;
    return { link, type: "VLESS" };
  }
}

function parseDurationInput(text: string): { minutes: number; label: string } {
  const t = text.trim().toLowerCase();

  if (t.includes("غير محدود") || t === "0" || t === "unlimited") {
    return { minutes: 0, label: "غير محدود" };
  }

  // Check minutes: e.g. "15 دقيقة", "30 دقائق", "15m", "15min"
  const minMatch = t.match(/(\d+)\s*(دقيقة|دقائق|m|min)/i);
  if (minMatch) {
    const mins = parseInt(minMatch[1], 10);
    return { minutes: mins, label: `${mins} دقيقة` };
  }

  // Check hours: e.g. "1 ساعة", "6 ساعات", "2h", "12hr"
  const hourMatch = t.match(/(\d+)\s*(ساعة|ساعات|h|hr)/i);
  if (hourMatch) {
    const hrs = parseInt(hourMatch[1], 10);
    return { minutes: hrs * 60, label: `${hrs} ساعة` };
  }

  // Check days: e.g. "1 يوم", "7 أيام", "30d", "30"
  const dayMatch = t.match(/(\d+)\s*(يوم|أيام|d|day)?/i);
  if (dayMatch && dayMatch[1]) {
    const days = parseInt(dayMatch[1], 10);
    return { minutes: days * 1440, label: `${days} يوم` };
  }

  return { minutes: 30 * 1440, label: "30 يوم" };
}

function parseQuotaInput(text: string): number {
  const t = text.trim().toLowerCase();
  if (t.includes("غير محدود") || t === "0" || t.includes("unlimited")) {
    return 0;
  }
  const match = t.match(/(\d+(?:\.\d+)?)/);
  if (match) {
    const val = parseFloat(match[1]);
    return isNaN(val) ? 0 : val;
  }
  return 0;
}

function formatQuotaUsage(cli: ClientConfig): string {
  const usedBytes = (cli.consumedUpload || 0) + (cli.consumedDownload || 0);
  const usedGB = usedBytes / (1024 * 1024 * 1024);

  if (!cli.limitGB || cli.limitGB <= 0) {
    return `${usedGB.toFixed(2)} GB (غير محدود)`;
  }

  const percent = Math.min(100, (usedGB / cli.limitGB) * 100);
  const filledBlocks = Math.round(percent / 10);
  const bar = "▰".repeat(filledBlocks) + "▱".repeat(10 - filledBlocks);
  return `${usedGB.toFixed(2)} / ${cli.limitGB} GB — ${percent.toFixed(1)}%\n${bar}`;
}

function formatMinutesLabel(minutes: number): string {
  if (!minutes || minutes <= 0) return "غير محدود";
  if (minutes % 1440 === 0) return `${minutes / 1440} يوم`;
  if (minutes % 60 === 0) return `${minutes / 60} ساعة`;
  return `${minutes} دقيقة`;
}

function formatDurationDisplay(cli: ClientConfig): string {
  if (!cli.expiresAt) {
    return "غير محدود ♾️";
  }
  const expDate = new Date(cli.expiresAt);
  const now = new Date();
  const diffMs = expDate.getTime() - now.getTime();
  if (diffMs <= 0) {
    return "منتهي الصلاحية ❌";
  }
  const diffMins = Math.floor(diffMs / (1000 * 60));
  if (diffMins < 60) {
    return `باقي ${diffMins} دقيقة ⏳`;
  }
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) {
    const remMins = diffMins % 60;
    return `باقي ${diffHours} ساعة و ${remMins} دقيقة ⏳`;
  }
  const diffDays = Math.floor(diffHours / 24);
  const remHours = diffHours % 24;
  return `باقي ${diffDays} يوم و ${remHours} ساعة ⏳`;
}

// -----------------------------------------------------------------------------
// Telegram Bot Long-Polling Client
// -----------------------------------------------------------------------------
interface UserSession {
  action?: string;
  step?: string;
  data?: any;
  selectedClientId?: string;
}

const userSessions: Record<string, UserSession> = {};

async function telegramApi(method: string, payload: any) {
  try {
    const res = await fetch(`https://api.telegram.org/bot${getActiveBotToken()}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload)
    });
    const json = await res.json();
    if (json && !json.ok) {
      addLog(`Telegram API (${method}) returned ok=false: ${json.description || JSON.stringify(json)}`);
    }
    return json;
  } catch (err: any) {
    addLog(`Telegram API Error (${method}): ${err?.message || err}`);
    return null;
  }
}

function sendTelegramPhotoBuffer(chatId: string | number, photoBuffer: Buffer, caption: string, replyMarkup?: any): Promise<any> {
  return new Promise((resolve) => {
    const boundary = "----TelegramBotBoundary" + Date.now().toString(16);
    const postData: Buffer[] = [];

    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
    if (replyMarkup) {
      postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="reply_markup"\r\n\r\n${JSON.stringify(replyMarkup)}\r\n`));
    }
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="qr.png"\r\nContent-Type: image/png\r\n\r\n`));
    postData.push(photoBuffer);
    postData.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const payload = Buffer.concat(postData);

    const req = https.request(`https://api.telegram.org/bot${getActiveBotToken()}/sendPhoto`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) addLog(`sendPhoto returned error: ${json.description}`);
          resolve(json);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      addLog(`sendPhoto request error: ${err.message}`);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

// Sends a raw file (used for the DarkTunnel/HTTP Custom config .zip) via
// Telegram's sendDocument endpoint. Mirrors sendTelegramPhotoBuffer above.
function sendTelegramDocumentBuffer(chatId: string | number, fileBuffer: Buffer, filename: string, caption: string): Promise<any> {
  return new Promise((resolve) => {
    const boundary = "----TelegramBotBoundary" + Date.now().toString(16);
    const postData: Buffer[] = [];

    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}\r\n`));
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}\r\n`));
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="parse_mode"\r\n\r\nHTML\r\n`));
    postData.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="document"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`));
    postData.push(fileBuffer);
    postData.push(Buffer.from(`\r\n--${boundary}--\r\n`));

    const payload = Buffer.concat(postData);

    const req = https.request(`https://api.telegram.org/bot${getActiveBotToken()}/sendDocument`, {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": payload.length
      }
    }, (res) => {
      let data = "";
      res.on("data", chunk => data += chunk);
      res.on("end", () => {
        try {
          const json = JSON.parse(data);
          if (!json.ok) addLog(`sendDocument returned error: ${json.description}`);
          resolve(json);
        } catch {
          resolve(null);
        }
      });
    });

    req.on("error", (err) => {
      addLog(`sendDocument request error: ${err.message}`);
      resolve(null);
    });

    req.write(payload);
    req.end();
  });
}

const MAIN_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: "📊 حالة الخادم" }, { text: "👥 إدارة العملاء" }],
    [{ text: "➕ إضافة عميل جديد" }, { text: "🔄 إعادة تشغيل V2Ray" }],
    [{ text: "👑 إدارة الأدمنز" }, { text: "📝 سجلات الخادم" }],
    [{ text: "📡 الأجهزة المتصلة" }, { text: "⚙️ إعدادات البوت العام" }],
    [{ text: "🆔 معرف حسابي" }, { text: "🏠 القائمة الرئيسية" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const PROTO_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: "⚡ VLESS" }, { text: "🚀 VMess" }, { text: "🛡️ Trojan" }],
    [{ text: "🏠 القائمة الرئيسية" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const DURATION_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: "15 دقيقة" }, { text: "30 دقيقة" }, { text: "1 ساعة" }, { text: "6 ساعات" }],
    [{ text: "12 ساعة" }, { text: "1 يوم" }, { text: "7 أيام" }, { text: "30 يوم" }],
    [{ text: "365 يوم" }, { text: "غير محدود" }],
    [{ text: "🏠 القائمة الرئيسية" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

const QUOTA_REPLY_KEYBOARD = {
  keyboard: [
    [{ text: "1 GB" }, { text: "5 GB" }, { text: "10 GB" }, { text: "20 GB" }],
    [{ text: "50 GB" }, { text: "100 GB" }, { text: "غير محدود" }],
    [{ text: "🏠 القائمة الرئيسية" }]
  ],
  resize_keyboard: true,
  is_persistent: true
};

async function registerBotCommands() {
  try {
    const res = await telegramApi("setMyCommands", {
      commands: [
        { command: "start", description: "🏠 القائمة الرئيسية" },
        { command: "status", description: "📊 حالة الخادم والذاكرة" },
        { command: "clients", description: "👥 قائمة العملاء وإدارتهم" },
        { command: "devices", description: "📡 الأجهزة المتصلة الآن" },
        { command: "add", description: "➕ إضافة عميل V2Ray جديد" },
        { command: "admins", description: "👑 إدارة مشرفي البوت (Admins)" },
        { command: "restart", description: "🔄 إعادة تشغيل خدمة V2Ray" },
        { command: "logs", description: "📝 عرض سجلات الخادم" },
        { command: "id", description: "🆔 عرض ID حسابك والأدمن" }
      ]
    });
    if (res && res.ok) {
      addLog("Telegram bot commands registered successfully in Telegram menu.");
    }
  } catch (err: any) {
    addLog(`Failed to register bot commands: ${err?.message || err}`);
  }
}

async function sendAdminsList(chatId: number | string) {
  const config = getAdminConfig();
  const primary = config.primaryAdmin || "غير محدد";
  const secondaries = config.secondaryAdmins;

  let text = `👑 <b>إدارة مشرفي البوت (Admins):</b>\n\n` +
    `🥇 <b>الأدمن الرئيسي الأولي (محمي من الحذف دائماً):</b>\n` +
    `• <code>${primary}</code>\n\n` +
    `🥈 <b>الآدمنز الثانويين (${secondaries.length}):</b>\n`;

  if (secondaries.length === 0) {
    text += `<i>لا يوجد أي أدمن ثانوي مضاف حالياً.</i>\n`;
  } else {
    secondaries.forEach((sec, idx) => {
      text += `${idx + 1}. 👤 <b>${escapeHtml(sec.name)}</b> - <code>${sec.id}</code>\n`;
    });
  }

  text += `\nإرشادات سريعة للأوامر النصية:\n` +
    `• <code>/addadmin &lt;chat_id&gt; [الاسم]</code> - لإضافة أدمن ثانوي\n` +
    `• <code>/deladmin &lt;chat_id&gt;</code> - لحذف أدمن ثانوي`;

  const inlineButtons: any[] = [];
  if (secondaries.length > 0) {
    secondaries.forEach(sec => {
      inlineButtons.push([{ text: `❌ حذف الثانوي: ${sec.name}`, callback_data: `del_sec_admin_${sec.id}` }]);
    });
  }

  const adminsReplyKeyboard = {
    keyboard: [
      [{ text: "➕ إضافة أدمن ثانوي" }, { text: "👑 إدارة الأدمنز" }],
      [{ text: "👥 إدارة العملاء" }, { text: "🏠 القائمة الرئيسية" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };

  if (inlineButtons.length > 0) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: { inline_keyboard: inlineButtons }
    });
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "لوحة التحكم بالمشرفين مجهزة على المفاتيح:",
      reply_markup: adminsReplyKeyboard
    });
  } else {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: adminsReplyKeyboard
    });
  }
}

async function sendPublicSettingsMenu(chatId: number | string) {
  const s = getSettings();
  const usersCount = getPersistedClients().filter(c => c.isUserOwned).length;

  const text = `⚙️ <b>إعدادات البوت العام:</b>\n\n` +
    `📢 <b>حالة الوضع العام:</b> ${s.publicBotEnabled ? "✅ مفعل (يمكن لأي شخص استخدام البوت لإنشاء تكوين خاص به)" : "🚫 معطل (البوت خاص بالأدمن والمشرفين فقط)"}\n` +
    `⏳ <b>مدة صلاحية تكوين المستخدم الافتراضية:</b> ${formatMinutesLabel(s.userConfigDurationMinutes)}\n` +
    `📊 <b>حد بيانات تكوين المستخدم:</b> ${s.userConfigQuotaGB > 0 ? `${s.userConfigQuotaGB} GB` : "غير محدود"}\n` +
    `👥 <b>عدد تكوينات المستخدمين الحالية:</b> ${usersCount}\n\n` +
    `عندما يكون الوضع العام مفعلاً:\n` +
    `• يمكن لأي مستخدم إنشاء تكوين VLESS واحد فقط خاص به (بروتوكول واحد و UUID خاص به).\n` +
    `• إذا تم رصد استخدام نفس التكوين من أكثر من جهاز/شبكة في نفس الوقت (أي مشاركته)، سيتم إيقافه تلقائياً.\n` +
    `• عند انتهاء صلاحية تكوينه يمكنه تجديده بنفسه من داخل البوت.`;

  const inlineButtons = [
    [{ text: s.publicBotEnabled ? "🚫 تعطيل الوضع العام" : "✅ تفعيل الوضع العام", callback_data: "toggle_public_bot" }],
    [{ text: "⏳ تغيير مدة صلاحية تكوين المستخدم", callback_data: "set_user_duration_start" }],
    [{ text: "📊 تغيير حد بيانات تكوين المستخدم", callback_data: "set_user_quota_start" }],
    [{ text: "👥 عرض تكوينات المستخدمين", callback_data: "list_user_clients" }]
  ];

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: inlineButtons }
  });
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "لوحة التحكم الرئيسية مجهزة:",
    reply_markup: MAIN_REPLY_KEYBOARD
  });
}

async function promptSetUserDuration(chatId: number | string) {
  userSessions[chatId] = { action: "set_user_duration" };
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "⏳ <b>أرسل مدة الصلاحية الافتراضية الجديدة لتكوينات المستخدمين</b>\n(اختر من الأزرار أو اكتب مثلاً: \"30 يوم\"، \"6 ساعات\"، \"غير محدود\"):",
    parse_mode: "HTML",
    reply_markup: DURATION_REPLY_KEYBOARD
  });
}

async function promptSetUserQuota(chatId: number | string) {
  userSessions[chatId] = { action: "set_user_quota" };
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "📊 <b>أرسل حد البيانات الافتراضي الجديد لتكوينات المستخدمين</b>\n(اختر من الأزرار أو اكتب مثلاً: \"20 GB\" أو \"غير محدود\"):",
    parse_mode: "HTML",
    reply_markup: QUOTA_REPLY_KEYBOARD
  });
}

const USER_CLIENTS_PAGE_SIZE = 10;

async function sendUserClientsListForAdmin(chatId: number | string, page: number = 1) {
  const clients = getPersistedClients().filter(c => c.isUserOwned);

  if (clients.length === 0) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "👥 <b>لا يوجد أي تكوين تابع للمستخدمين حالياً.</b>",
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_KEYBOARD
    });
    return;
  }

  const totalPages = Math.max(1, Math.ceil(clients.length / USER_CLIENTS_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (currentPage - 1) * USER_CLIENTS_PAGE_SIZE;
  const pageClients = clients.slice(startIdx, startIdx + USER_CLIENTS_PAGE_SIZE);

  let text = `👥 <b>تكوينات المستخدمين (${clients.length})${totalPages > 1 ? ` - صفحة ${currentPage}/${totalPages}` : ""}:</b>\n\n`;
  const inlineButtons: any[] = [];

  pageClients.forEach(c => {
    const isExpired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();
    const statusIcon = c.sharedFlag ? "🚫" : !c.enabled ? "🔴" : isExpired ? "⏳" : "🟢";
    text += `${statusIcon} <b>مالك التكوين (ID):</b> <code>${escapeHtml(c.ownerId || "-")}</code> - ${formatDurationDisplay(c)}${c.sharedFlag ? " (تم رصد مشاركة التكوين ⚠️)" : ""}\n`;
    inlineButtons.push([{ text: `❌ حذف تكوين المستخدم ${c.ownerId}`, callback_data: `del_cli_${c.id}` }]);
  });

  const navRow: any[] = [];
  if (currentPage > 1) navRow.push({ text: "⬅️ السابق", callback_data: `user_clients_page_${currentPage - 1}` });
  if (currentPage < totalPages) navRow.push({ text: "التالي ➡️", callback_data: `user_clients_page_${currentPage + 1}` });
  if (navRow.length > 0) inlineButtons.push(navRow);

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: { inline_keyboard: inlineButtons }
  });
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: "لوحة التحكم الرئيسية مجهزة:",
    reply_markup: MAIN_REPLY_KEYBOARD
  });
}

// -----------------------------------------------------------------------------
// Public self-service flow for regular (non-admin) Telegram users
// -----------------------------------------------------------------------------
function getUserClient(userId: number | string): ClientConfig | undefined {
  return getPersistedClients().find(c => c.isUserOwned && c.ownerId === String(userId));
}

function buildUserKeyboard(hasClient: boolean, needsRenew: boolean) {
  const rows: any[] = [];
  if (!hasClient) {
    rows.push([{ text: "🆕 إنشاء تكويني (VLESS)" }]);
  } else {
    rows.push([{ text: "📦 تكويني" }]);
    if (needsRenew) rows.push([{ text: "🔄 تجديد تكويني" }]);
  }
  rows.push([{ text: "📖 كيفية التشغيل" }]);
  rows.push([{ text: "🆔 معرف حسابي" }, { text: "🏠 القائمة الرئيسية" }]);
  return { keyboard: rows, resize_keyboard: true, is_persistent: true };
}

async function sendUserMainMenu(chatId: number | string, userId: number | string) {
  const cli = getUserClient(userId);
  const settings = getSettings();

  if (!cli) {
    const text = `⚡ <b>مرحباً بك في بوت التكوينات!</b>\n\n` +
      `لم تقم بإنشاء أي تكوين بعد.\n` +
      `يحق لك إنشاء <b>تكوين VLESS واحد فقط</b> خاص بك (ببروتوكول واحد و UUID خاص بك).\n\n` +
      `⏳ <b>مدة صلاحية التكوين عند الإنشاء:</b> ${formatMinutesLabel(settings.userConfigDurationMinutes)}\n` +
      `📊 <b>حد البيانات:</b> ${settings.userConfigQuotaGB > 0 ? `${settings.userConfigQuotaGB} GB` : "غير محدود"}\n\n` +
      `⚠️ <b>تنبيه:</b> ممنوع مشاركة تكوينك مع أي شخص آخر، فور رصد استخدامه من أكثر من جهاز في نفس الوقت سيتم إيقافه تلقائياً.\n\n` +
      `اضغط "🆕 إنشاء تكويني (VLESS)" للبدء، أو "📖 كيفية التشغيل" لمعرفة طريقة استخدام التكوين.`;

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      reply_markup: buildUserKeyboard(false, false)
    });
    return;
  }

  const isExpired = !!(cli.expiresAt && new Date(cli.expiresAt).getTime() < Date.now());
  const isShared = !!cli.sharedFlag;
  const needsRenew = isExpired || isShared || !cli.enabled;

  const statusLine = isShared
    ? "🚫 موقوف (تم رصد استخدامه من أكثر من 3 أجهزة في نفس الوقت)"
    : !cli.enabled
      ? "🔴 موقوف"
      : isExpired
        ? "⏳ منتهي الصلاحية"
        : "🟢 نشط";

  const text = `⚡ <b>مرحباً بك مجدداً!</b>\n\n` +
    `📊 <b>حالة تكوينك:</b> ${statusLine}\n` +
    `📅 <b>الصلاحية:</b> ${formatDurationDisplay(cli)}\n\n` +
    `اختر من الأزرار أدناه:`;

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: buildUserKeyboard(true, needsRenew)
  });
}

async function sendUserOwnConfig(chatId: number | string, userId: number | string, knownClient?: ClientConfig) {
  const cli = knownClient || getUserClient(userId);
  if (!cli) {
    await sendUserMainMenu(chatId, userId);
    return;
  }

  const isExpired = !!(cli.expiresAt && new Date(cli.expiresAt).getTime() < Date.now());
  const isShared = !!cli.sharedFlag;
  const usable = cli.enabled && !isExpired;
  const needsRenew = isExpired || isShared || !cli.enabled;

  const statusLine = isShared
    ? "🚫 موقوف (تم رصد استخدامه من أكثر من 3 أجهزة في نفس الوقت)"
    : !cli.enabled
      ? "🔴 موقوف"
      : isExpired
        ? "⏳ منتهي الصلاحية"
        : "🟢 نشط";

  const { link, type } = generateClientLinks(cli);
  const domain = getPublicDomain();
  const location = await getServerLocation();
  const locationText = location ? `${location.flag} ${location.countryName}` : "🌍 غير معروف";
  const locationDetail = location ? formatServerLocationDetail(location) : "";
  const isConnectedNow = getLiveDeviceCount(cli.id).devices > 0;
  const connectionStatusText = isConnectedNow ? "🟢 متصل الآن" : "⚪ غير متصل حالياً";

  const caption = `📦 <b>تكوينك الخاص:</b>\n\n` +
    `⚡ <b>البروتوكول:</b> ${type}\n` +
    `🌐 <b>الهوست (Host / SNI):</b> <code>${escapeHtml(domain)}</code>\n` +
    `🗺️ <b>موقع السيرفر:</b> ${locationText}\n` +
    (locationDetail ? `${locationDetail}\n` : "") +
    `🔌 <b>حالة الاتصال:</b> ${connectionStatusText}\n` +
    `📅 <b>الصلاحية:</b> ${formatDurationDisplay(cli)}\n` +
    `📊 <b>الاستهلاك:</b> ${formatQuotaUsage(cli)}\n` +
    `📈 <b>الحالة:</b> ${statusLine}\n\n` +
    (usable
      ? `🔗 <b>رابط الاتصال:</b>\n<code>${escapeHtml(link)}</code>\n\n⚠️ يمكنك استخدام هذا الرابط من حتى ${MAX_CONCURRENT_DEVICES} أجهزة في نفس الوقت. أي جهاز رابع سيؤدي لإيقافه تلقائياً.`
      : `⚠️ لا يمكنك استخدام هذا التكوين حالياً${isShared ? ` بسبب رصد استخدامه من أكثر من ${MAX_CONCURRENT_DEVICES} أجهزة في نفس الوقت` : ""}. اضغط "🔄 تجديد تكويني" أدناه للحصول على تكوين جديد.`);

  const kb = buildUserKeyboard(true, needsRenew);

  if (usable) {
    try {
      const qrBuffer = await QRCode.toBuffer(link, { width: 300, margin: 2 });
      const photoRes = await sendTelegramPhotoBuffer(chatId, qrBuffer, caption, kb);
      if (photoRes && photoRes.ok) return;
    } catch (e: any) {
      addLog(`QR photo sending error (user config): ${e?.message || e}`);
    }
  }

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    reply_markup: kb
  });
}

// Prevents a double-tap (or a duplicate Telegram update) from racing two
// concurrent create/renew calls for the same user, which could otherwise
// each generate their own uuid/path and leave the link message and the
// .dark file showing two different paths for what looks like "one" config.
const userConfigOpInProgress = new Set<string>();

async function createUserConfig(chatId: number | string, userId: number | string) {
  const lockKey = String(userId);
  if (userConfigOpInProgress.has(lockKey)) {
    return;
  }
  userConfigOpInProgress.add(lockKey);
  try {
    const existing = getUserClient(userId);
    if (existing) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "⚠️ <b>لديك بالفعل تكوين خاص بك.</b>\nيحق لك إنشاء تكوين واحد فقط. يمكنك تجديده عند الحاجة بدلاً من إنشاء تكوين جديد.",
        parse_mode: "HTML"
      });
      await sendUserOwnConfig(chatId, userId);
      return;
    }

    const settings = getSettings();
    const durationMinutes = settings.userConfigDurationMinutes ?? 43200;
    const now = new Date();
    const expiresAt = durationMinutes > 0 ? new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString() : null;

    const newClient: ClientConfig = {
      id: "usr_" + userId + "_" + Date.now(),
      name: `مستخدم_${userId}`,
      protocol: "vless",
      uuid: crypto.randomUUID(),
      path: `/by_moon_${crypto.randomBytes(4).toString("hex")}`,
      limitGB: settings.userConfigQuotaGB || 0,
      consumedUpload: 0,
      consumedDownload: 0,
      duration: formatMinutesLabel(durationMinutes),
      durationValue: durationMinutes,
      createdAt: now.toISOString(),
      expiresAt,
      enabled: true,
      ownerId: String(userId),
      isUserOwned: true,
      sharedFlag: false
    };

    const clients = getPersistedClients();
    clients.push(newClient);
    savePersistedClients(clients);
    scheduleV2RayRestart();

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "✅ <b>تم إنشاء تكوينك بنجاح!</b>",
      parse_mode: "HTML"
    });
    // Pass newClient directly (instead of re-reading from disk) so the link/QR
    // message and the .dark file are always built from the exact same path/uuid.
    await sendUserOwnConfig(chatId, userId, newClient);
    await sendAppConfigZip(chatId, newClient);
  } finally {
    userConfigOpInProgress.delete(lockKey);
  }
}

async function renewUserConfig(chatId: number | string, userId: number | string) {
  const lockKey = String(userId);
  if (userConfigOpInProgress.has(lockKey)) {
    return;
  }
  userConfigOpInProgress.add(lockKey);
  try {
    const clients = getPersistedClients();
    const cli = clients.find(c => c.isUserOwned && c.ownerId === String(userId));

    if (!cli) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "❌ <b>ليس لديك أي تكوين بعد.</b>\nاضغط \"🆕 إنشاء تكويني (VLESS)\" لإنشاء واحد أولاً.",
        parse_mode: "HTML"
      });
      await sendUserMainMenu(chatId, userId);
      return;
    }

    const settings = getSettings();
    const durationMinutes = settings.userConfigDurationMinutes ?? 43200;
    const now = new Date();

    cli.uuid = crypto.randomUUID();
    cli.path = `/by_moon_${crypto.randomBytes(4).toString("hex")}`;
    cli.consumedUpload = 0;
    cli.consumedDownload = 0;
    cli.enabled = true;
    cli.sharedFlag = false;
    cli.limitGB = settings.userConfigQuotaGB || 0;
    cli.createdAt = now.toISOString();
    cli.expiresAt = durationMinutes > 0 ? new Date(now.getTime() + durationMinutes * 60 * 1000).toISOString() : null;
    cli.duration = formatMinutesLabel(durationMinutes);
    cli.durationValue = durationMinutes;

    savePersistedClients(clients);
    scheduleV2RayRestart();

    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "🔄 <b>تم تجديد تكوينك بنجاح!</b>\nتم إصدار رابط ورمز QR جديدين، تجاهل أي رابط قديم.",
      parse_mode: "HTML"
    });
    // Pass cli directly for the same reason as createUserConfig above.
    await sendUserOwnConfig(chatId, userId, cli);
    await sendAppConfigZip(chatId, cli);
  } finally {
    userConfigOpInProgress.delete(lockKey);
  }
}

async function sendHowToGuide(chatId: number | string) {
  const text =
    `📖 <b>كيفية تشغيل التكوين عبر تطبيق Dark Tunnel:</b>\n\n` +
    `1️⃣ نزّل تطبيق <b>Dark Tunnel</b> من متجر التطبيقات.\n` +
    `2️⃣ افتح التطبيق واضغط على زر إضافة تكوين جديد (+).\n` +
    `3️⃣ اختر "استيراد من الحافظة" والصق رابط الاتصال الذي أرسله لك البوت، أو اختر "مسح QR" وامسح صورة الكود المرسلة.\n` +
    `4️⃣ بعد الاستيراد، افتح إعدادات التكوين للتأكد من الحقول التالية:\n` +
    `   • <b>Host</b>: يُملأ تلقائياً بنطاق الخادم (كما في الرابط)، اتركه كما هو.\n` +
    `   • <b>SNI</b>: يمكنك كتابة <code>youtube.com</code> بدلاً من نطاق الخادم في هذا الحقل تحديداً، فهذا قد يحسّن الاتصال في بعض الشبكات التي تراقب أو تحجب حسب اسم النطاق.\n` +
    `   • تأكد أن <b>TLS/Security</b> مفعّل على <code>tls</code>.\n` +
    `5️⃣ احفظ التكوين، ثم اضغط على زر الاتصال (▶️) في الشاشة الرئيسية للتطبيق.\n` +
    `6️⃣ إذا لم يتصل، جرّب تغيير حقل SNI بين نطاق الخادم و <code>youtube.com</code> حتى تجد الأنسب لشبكتك.\n\n` +
    `⚠️ <b>تذكير:</b> تكوينك شخصي ولا يجوز مشاركته مع أي شخص آخر، وإلا سيتوقف تلقائياً عند رصد استخدامه من أكثر من جهاز في نفس الوقت.`;

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML"
  });
}

async function handleRegularUserMessage(chatId: number | string, userId: number | string, text: string, textLower: string) {
  if (text === "/start" || text === "/menu" || text === "/help" ||
      text === "🏠 القائمة الرئيسية" || text === "القائمة الرئيسية" || text === "الرئيسية" ||
      textLower === "start" || textLower === "menu") {
    delete userSessions[chatId];
    await sendUserMainMenu(chatId, userId);
    return;
  }

  if (text === "/id" || text === "/myid" || text === "🆔 معرف حسابي" || text === "معرف حسابي") {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: `🆔 <b>معرف حسابك (Chat ID):</b> <code>${chatId}</code>`,
      parse_mode: "HTML",
      reply_markup: buildUserKeyboard(!!getUserClient(userId), false)
    });
    return;
  }

  if (text === "🆕 إنشاء تكويني (VLESS)" || text === "إنشاء تكويني" || text === "انشاء تكويني") {
    await createUserConfig(chatId, userId);
    return;
  }

  if (text === "📦 تكويني" || text === "تكويني") {
    await sendUserOwnConfig(chatId, userId);
    return;
  }

  if (text === "🔄 تجديد تكويني" || text === "تجديد تكويني" || text === "تجديد") {
    await renewUserConfig(chatId, userId);
    return;
  }

  if (text === "📖 كيفية التشغيل" || text === "كيفية التشغيل" || textLower === "help") {
    await sendHowToGuide(chatId);
    return;
  }

  // Default fallback for regular users
  await sendUserMainMenu(chatId, userId);
}

async function handleTelegramUpdate(update: any) {
  const adminConf = getAdminConfig();

  if (update.message) {
    const msg = update.message;
    const chatId = msg.chat.id;
    const userId = msg.from?.id || chatId;
    const text = msg.text?.trim() || "";
    const textLower = text.toLowerCase();

    // Primary admin now comes from the murad-setup config (getPrimaryAdminId()
    // above) -- there is no bootstrap/claim path, and /setadmin can no longer
    // change who the primary admin is. This keeps ownership immune to a wiped
    // admin.json or anyone racing to claim it, while still letting each
    // deployer's own bot recognize THEM (not the template author) as primary
    // admin, since it's their own botId that was saved during setup.
    if (text.startsWith("/setadmin")) {
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `ℹ️ <b>الأدمن الرئيسي مثبّت تلقائياً من إعداد البوت الأولي (murad-setup) ولا يمكن تغييره عبر أمر البوت.</b>\n\n` +
              `👑 <b>الأدمن الرئيسي الحالي:</b> <code>${getPrimaryAdminId()}</code>\n\n` +
              `لإضافة مستخدمين آخرين بصلاحيات إدارية دون المساس بالأدمن الرئيسي، استخدم "➕ إضافة أدمن ثانوي" من القائمة.`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    // Verify admin access (must be primary or secondary admin)
    if (!isAuthorizedAdmin(userId) && !isAuthorizedAdmin(chatId)) {
      const publicSettings = getSettings();

      if (publicSettings.publicBotEnabled) {
        // Public mode is on: treat this person as a regular self-service user
        // instead of rejecting them.
        await handleRegularUserMessage(chatId, userId, text, textLower);
        return;
      }

      const currentConf = getAdminConfig();
      addLog(`Unauthorized access attempt from Chat ID: ${chatId}, User ID: ${userId} (Primary Admin: ${currentConf.primaryAdmin})`);
      // Silent mode: unauthorized users get no reply at all (just logged
      // for the admin). Nothing is sent back to them.
      return;
    }

    // Admin-only "/id" reply (includes primary-admin ID and secondary-admin
    // count). This must run AFTER the authorization check above so that
    // non-admin / regular users never see admin-only info -- they get the
    // plain chat-id-only reply from handleRegularUserMessage() instead.
    if (text === "/id" || text === "/myid" || text === "🆔 معرف حسابي" || text === "🆔 معرف حسابي (/id)" || text === "معرف حسابي") {
      const currentConf = getAdminConfig();
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `🆔 <b>معرف حسابك (Chat ID):</b> <code>${chatId}</code>\n` +
              `👑 <b>الأدمن الرئيسي الأولي:</b> <code>${currentConf.primaryAdmin}</code>\n` +
              `👥 <b>عدد الأدمنز الثانويين:</b> ${currentConf.secondaryAdmins.length}`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    // Direct command / button text routing
    if (text === "/start" || text === "/menu" || text === "/help" ||
        text === "🏠 القائمة الرئيسية" || text === "القائمة الرئيسية" || text === "الرئيسية" ||
        textLower === "start" || textLower === "menu") {
      delete userSessions[chatId];
      await sendMainMenu(chatId);
      return;
    }

    if (text === "/status" || text === "/server" ||
        text === "📊 حالة الخادم" || text === "حالة الخادم" || text === "الحالة" ||
        textLower === "status" || textLower === "server") {
      await sendServerStatus(chatId);
      return;
    }

    if (text === "/clients" || text === "/list" ||
        text === "👥 إدارة العملاء" || text === "👥 قائمة العملاء" || text === "📋 قائمة العملاء" || text === "📋 العودة للعملاء" || text === "إدارة العملاء" || text === "قائمة العملاء" || text === "العملاء" ||
        textLower === "clients" || textLower === "list") {
      await sendClientsList(chatId);
      return;
    }

    if (text === "/devices" || text === "📡 الأجهزة المتصلة" || text === "الأجهزة المتصلة" ||
        textLower === "devices") {
      await sendConnectedDevicesReport(chatId);
      return;
    }

    if (text === "/admins" || text === "👑 إدارة الأدمنز" || text === "إدارة الأدمنز" || text === "قائمة الأدمنز" || text === "الأدمنز") {
      await sendAdminsList(chatId);
      return;
    }

    if (text === "/addadmin" || text === "➕ إضافة أدمن ثانوي" || text === "إضافة أدمن ثانوي" || text === "اضافة ادمن") {
      userSessions[chatId] = { action: "add_secondary_admin_id" };
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "➕ <b>إضافة أدمن ثانوي جديد:</b>\n\nأرسل معرف حساب تلجرام (Chat ID) الخاص بالأدمن الثانوي في رسالة نصية:\n(يمكنه إرسال الأمر <code>/id</code> للبوت لمعرفة معرف حسابه)",
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    if (text.startsWith("/addadmin ")) {
      const parts = text.split(/\s+/);
      const targetId = parts[1]?.trim();
      const name = parts.slice(2).join(" ").trim();
      if (!targetId) {
        await telegramApi("sendMessage", { chat_id: chatId, text: "❌ يرجى كتابة ID الحساب. مثال: <code>/addadmin 123456789 علي</code>", parse_mode: "HTML" });
        return;
      }
      const res = addSecondaryAdmin(targetId, name);
      await telegramApi("sendMessage", { chat_id: chatId, text: res.message, parse_mode: "HTML" });
      await sendAdminsList(chatId);
      return;
    }

    if (text.startsWith("/deladmin ")) {
      const parts = text.split(/\s+/);
      const targetId = parts[1]?.trim();
      if (!targetId) {
        await telegramApi("sendMessage", { chat_id: chatId, text: "❌ يرجى كتابة ID الحساب للحذف. مثال: <code>/deladmin 123456789</code>", parse_mode: "HTML" });
        return;
      }
      const res = removeSecondaryAdmin(targetId);
      await telegramApi("sendMessage", { chat_id: chatId, text: res.message, parse_mode: "HTML" });
      await sendAdminsList(chatId);
      return;
    }

    if (text === "/add" || text === "/new" ||
        text === "➕ إضافة عميل جديد" || text === "إضافة عميل جديد" || text === "إضافة عميل" || text === "اضافة عميل" ||
        textLower === "add" || textLower === "new") {
      await startAddClientWizard(chatId);
      return;
    }

    if (text === "/restart" ||
        text === "🔄 إعادة تشغيل V2Ray" || text === "إعادة تشغيل V2Ray" || text === "إعادة التشغيل" || text === "اعادة تشغيل" ||
        textLower === "restart") {
      scheduleV2RayRestart();
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "🔄 <b>تم طلب إعادة تشغيل V2Ray بنجاح!</b>",
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    if (text === "/logs" || text === "/log" ||
        text === "📝 سجلات الخادم" || text === "📝 سجلات التشغيل" || text === "سجلات الخادم" || text === "سجلات التشغيل" || text === "السجلات" ||
        textLower === "logs" || textLower === "log") {
      const recent = escapeHtml(logs.slice(-25).join("\n"));
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `📝 <b>آخر سجلات الخادم:</b>\n\n<code>${recent || "لا توجد سجلات بعد"}</code>`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    if (text === "⚙️ إعدادات البوت العام" || text === "إعدادات البوت العام") {
      await sendPublicSettingsMenu(chatId);
      return;
    }

    const session = userSessions[chatId] || {};

    if (session.action === "set_user_duration") {
      const parsed = parseDurationInput(text);
      const s = getSettings();
      s.userConfigDurationMinutes = parsed.minutes;
      saveSettings(s);
      delete userSessions[chatId];
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `✅ <b>تم تحديث مدة الصلاحية الافتراضية لتكوينات المستخدمين إلى:</b> ${parsed.label}`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      await sendPublicSettingsMenu(chatId);
      return;
    }

    if (session.action === "set_user_quota") {
      const gb = parseQuotaInput(text);
      const s = getSettings();
      s.userConfigQuotaGB = gb;
      saveSettings(s);
      delete userSessions[chatId];
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `✅ <b>تم تحديث حد البيانات الافتراضي لتكوينات المستخدمين إلى:</b> ${gb > 0 ? `${gb} GB` : "غير محدود"}`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      await sendPublicSettingsMenu(chatId);
      return;
    }

    // Secondary Admin creation wizard sessions
    if (session.action === "add_secondary_admin_id") {
      const targetId = text.trim();
      if (!/^\d+$/.test(targetId)) {
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text: "❌ <b>معرف الحساب يجب أن يتكون من أرقام فقط (Chat ID).</b>\nيرجى إعادة إرسال ID الصحيح:",
          parse_mode: "HTML"
        });
        return;
      }
      userSessions[chatId] = { action: "add_secondary_admin_name", data: { targetId } };
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `✏️ <b>أدخل اسماً توضيحياً للأدمن الثانوي</b>\n(أو أرسل "تخطي" لاستخدام المعرف تلقائياً):`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    if (session.action === "add_secondary_admin_name") {
      const targetId = session.data?.targetId;
      let name = text.trim();
      if (name === "تخطي" || name.toLowerCase() === "skip" || !name) name = undefined;
      const res = addSecondaryAdmin(targetId, name);
      delete userSessions[chatId];
      await telegramApi("sendMessage", { chat_id: chatId, text: res.message, parse_mode: "HTML" });
      await sendAdminsList(chatId);
      return;
    }

    // Actions on selected client from Reply Keyboard
    if (text.includes("إيقاف العميل") || text.includes("تفعيل العميل") || text === "⏸️ إيقاف" || text === "▶️ تفعيل") {
      const selectedId = session.selectedClientId;
      if (selectedId) {
        const clients = getPersistedClients();
        const cli = clients.find(c => c.id === selectedId);
        if (cli) {
          cli.enabled = !cli.enabled;
          savePersistedClients(clients);
          scheduleV2RayRestart();
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: cli.enabled ? "✅ <b>تم تفعيل العميل بنجاح!</b>" : "⏸️ <b>تم إيقاف العميل بنجاح!</b>",
            parse_mode: "HTML"
          });
          await sendClientDetails(chatId, cli.id);
          return;
        }
      }
    }

    if (text.includes("حذف العميل")) {
      const selectedId = session.selectedClientId;
      if (selectedId) {
        let clients = getPersistedClients();
        const cli = clients.find(c => c.id === selectedId);
        clients = clients.filter(c => c.id !== selectedId);
        savePersistedClients(clients);
        scheduleV2RayRestart();
        delete userSessions[chatId]?.selectedClientId;
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text: `🗑️ <b>تم حذف العميل ${cli ? escapeHtml(cli.name) : ''} بنجاح!</b>`,
          parse_mode: "HTML"
        });
        await sendClientsList(chatId);
        return;
      }
    }

    // Wizard input handling - STRICT SESSION ACTION PRIORITIZATION
    if (session.action === "add_client_name") {
      const clientName = text.trim() || "Client_" + Date.now().toString().slice(-4);
      const protocol = session.data?.protocol || "vless";
      const durationMinutes = session.data?.durationMinutes ?? (session.data?.durationDays ? session.data.durationDays * 1440 : 43200);
      const durationLabel = session.data?.durationLabel || (durationMinutes > 0 ? `${durationMinutes} دقيقة` : "غير محدود");
      const limitGB = session.data?.limitGB || 0;

      const uuid = crypto.randomUUID();
      const clientPath = `/by_moon_${crypto.randomBytes(4).toString("hex")}`;
      const now = new Date();
      let expiresAt: string | null = null;
      if (durationMinutes > 0) {
        const exp = new Date(now.getTime() + durationMinutes * 60 * 1000);
        expiresAt = exp.toISOString();
      }

      const newClient: ClientConfig = {
        id: "cli_" + Date.now(),
        name: clientName,
        protocol,
        uuid,
        path: clientPath,
        limitGB,
        consumedUpload: 0,
        consumedDownload: 0,
        duration: durationLabel,
        durationValue: durationMinutes,
        createdAt: now.toISOString(),
        expiresAt,
        enabled: true
      };

      const clients = getPersistedClients();
      clients.push(newClient);
      savePersistedClients(clients);
      scheduleV2RayRestart();

      delete userSessions[chatId];

      const { link, type } = generateClientLinks(newClient);
      const domain = getPublicDomain();
      const expiryText = formatDurationDisplay(newClient);

      const caption = `✅ <b>تم إنشاء التكوين بنجاح!</b>\n\n` +
        `👤 <b>الاسم:</b> ${escapeHtml(newClient.name)}\n` +
        `⚡ <b>البروتوكول:</b> ${type}\n` +
        `🌐 <b>الهوست (Host / SNI):</b> <code>${escapeHtml(domain)}</code>\n` +
        `📅 <b>الصلاحية:</b> ${expiryText}\n` +
        `📊 <b>الحد:</b> ${limitGB > 0 ? `${limitGB} GB` : 'غير محدود'}\n` +
        `📈 <b>الاستهلاك:</b> ${formatQuotaUsage(newClient)}\n\n` +
        `🔗 <b>رابط الاتصال:</b>\n<code>${escapeHtml(link)}</code>`;

      try {
        const qrBuffer = await QRCode.toBuffer(link, { width: 300, margin: 2 });
        const photoRes = await sendTelegramPhotoBuffer(chatId, qrBuffer, caption, MAIN_REPLY_KEYBOARD);
        if (!photoRes || !photoRes.ok) {
          await telegramApi("sendMessage", {
            chat_id: chatId,
            text: caption,
            parse_mode: "HTML",
            reply_markup: MAIN_REPLY_KEYBOARD
          });
        }
      } catch {
        await telegramApi("sendMessage", {
          chat_id: chatId,
          text: caption,
          parse_mode: "HTML",
          reply_markup: MAIN_REPLY_KEYBOARD
        });
      }

      await sendAppConfigZip(chatId, newClient);
      return;
    }

    if (session.action === "add_client_proto") {
      let proto = "vless";
      if (text.includes("VMess") || textLower.includes("vmess")) proto = "vmess";
      else if (text.includes("Trojan") || textLower.includes("trojan")) proto = "trojan";

      userSessions[chatId] = { action: "add_client_duration", data: { protocol: proto } };
      await selectDurationStep(chatId);
      return;
    }

    if (session.action === "add_client_duration") {
      const parsed = parseDurationInput(text);

      const currentData = session.data || { protocol: "vless" };
      userSessions[chatId] = {
        action: "add_client_quota",
        data: { ...currentData, durationMinutes: parsed.minutes, durationLabel: parsed.label }
      };
      await selectQuotaStep(chatId);
      return;
    }

    if (session.action === "add_client_quota") {
      const gb = parseQuotaInput(text);

      const currentData = session.data || { protocol: "vless", durationMinutes: 43200, durationLabel: "30 يوم" };
      userSessions[chatId] = { action: "add_client_name", data: { ...currentData, limitGB: gb } };

      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `📊 <b>تم تحديد الكوتا:</b> ${gb > 0 ? `${gb} GB` : 'غير محدود'}\n\n✏️ <b>أدخل اسم العميل الآن:</b>\n(أرسل اسم العميل في رسالة نصية)`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
      return;
    }

    // Direct reply keyboard selections when starting fresh or out-of-order
    if (text.includes("VLESS") || text.includes("VMess") || text.includes("Trojan")) {
      let proto = "vless";
      if (text.includes("VMess") || textLower.includes("vmess")) proto = "vmess";
      else if (text.includes("Trojan") || textLower.includes("trojan")) proto = "trojan";

      userSessions[chatId] = { action: "add_client_duration", data: { protocol: proto } };
      await selectDurationStep(chatId);
      return;
    }

    // Clients-list pagination nav buttons ("⬅️ السابق (صفحة N)" / "التالي ➡️ (صفحة N)")
    const pageNavMatch = text.match(/^(?:⬅️ السابق|التالي ➡️) \(صفحة (\d+)\)$/);
    if (pageNavMatch) {
      await sendClientsList(chatId, parseInt(pageNavMatch[1], 10));
      return;
    }

    // Check if user clicked a client button from the Reply Keyboard
    const allClients = getPersistedClients();
    const matchedClient = allClients.find(c => text.includes(c.name) || c.name === text.trim());
    if (matchedClient) {
      await sendClientDetails(chatId, matchedClient.id);
      return;
    }

    // Default fallback: show main menu
    await sendMainMenu(chatId);
  } else if (update.callback_query) {
    const cb = update.callback_query;
    const chatId = cb.message?.chat?.id || cb.from?.id;
    const userId = cb.from?.id || chatId;
    const data = cb.data;

    addLog(`Received Callback Query: "${data}" from User ${userId}`);

    // NOTE: primary-admin claiming intentionally does NOT happen here.
    // Inline-button callbacks can be triggered by anyone who can see a
    // message with buttons the bot sent (e.g. in a group, or a forwarded
    // message), so auto-crowning whoever clicks first would let a random
    // person silently become the unremovable owner. Bootstrapping only
    // happens through the explicit /start guard in handleTelegramUpdate.

    // Acknowledge callback query immediately so Telegram stops button loading spinner
    try {
      await telegramApi("answerCallbackQuery", { callback_query_id: cb.id });
    } catch {
      /* ignore expired query error */
    }

    // Verify admin access
    if (!isAuthorizedAdmin(userId) && !isAuthorizedAdmin(chatId)) {
      const publicSettings = getSettings();
      if (publicSettings.publicBotEnabled) {
        await sendUserMainMenu(chatId, userId);
        return;
      }
      addLog(`Unauthorized callback attempt from User ID: ${userId}, Chat ID: ${chatId}`);
      // Silent mode here too: no reply sent, just logged for the admin.
      return;
    }

    if (data === "main_menu") {
      await sendMainMenu(chatId);
    } else if (data === "server_status") {
      await sendServerStatus(chatId);
    } else if (data === "list_clients") {
      await sendClientsList(chatId);
    } else if (data === "list_admins") {
      await sendAdminsList(chatId);
    } else if (data.startsWith("del_sec_admin_")) {
      const secAdminId = data.replace("del_sec_admin_", "");
      const res = removeSecondaryAdmin(secAdminId);
      await telegramApi("sendMessage", { chat_id: chatId, text: res.message, parse_mode: "HTML" });
      await sendAdminsList(chatId);
    } else if (data === "add_client_start") {
      await startAddClientWizard(chatId);
    } else if (data.startsWith("add_proto_")) {
      const proto = data.replace("add_proto_", "");
      userSessions[chatId] = { action: "add_client_duration", data: { protocol: proto } };
      await selectDurationStep(chatId);
    } else if (data.startsWith("add_dur_")) {
      const days = Number(data.replace("add_dur_", ""));
      const session = userSessions[chatId] || {};
      session.data = { ...session.data, durationDays: days };
      userSessions[chatId] = session;
      await selectQuotaStep(chatId);
    } else if (data.startsWith("add_quota_")) {
      const gb = Number(data.replace("add_quota_", ""));
      const session = userSessions[chatId] || {};
      session.data = { ...session.data, limitGB: gb };
      session.action = "add_client_name";
      userSessions[chatId] = session;

      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "✏️ <b>أدخل اسم العميل الآن:</b>\n(أرسل اسم العميل في رسالة نصية)",
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
    } else if (data.startsWith("view_cli_")) {
      const cliId = data.replace("view_cli_", "");
      await sendClientDetails(chatId, cliId);
    } else if (data.startsWith("toggle_cli_")) {
      const cliId = data.replace("toggle_cli_", "");
      const clients = getPersistedClients();
      const cli = clients.find(c => c.id === cliId);
      if (cli) {
        cli.enabled = !cli.enabled;
        savePersistedClients(clients);
        scheduleV2RayRestart();
        await sendClientsList(chatId);
      }
    } else if (data.startsWith("del_cli_")) {
      const cliId = data.replace("del_cli_", "");
      let clients = getPersistedClients();
      clients = clients.filter(c => c.id !== cliId);
      savePersistedClients(clients);
      scheduleV2RayRestart();
      await sendClientsList(chatId);
    } else if (data === "restart_v2ray") {
      scheduleV2RayRestart();
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: "🔄 <b>تم طلب إعادة تشغيل V2Ray عبر Hot-Swap A/B!</b>",
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
    } else if (data === "toggle_public_bot") {
      const s = getSettings();
      s.publicBotEnabled = !s.publicBotEnabled;
      saveSettings(s);
      await sendPublicSettingsMenu(chatId);
    } else if (data === "set_user_duration_start") {
      await promptSetUserDuration(chatId);
    } else if (data === "set_user_quota_start") {
      await promptSetUserQuota(chatId);
    } else if (data === "list_user_clients") {
      await sendUserClientsListForAdmin(chatId);
    } else if (data.startsWith("user_clients_page_")) {
      const page = parseInt(data.replace("user_clients_page_", ""), 10) || 1;
      await sendUserClientsListForAdmin(chatId, page);
    } else if (data === "view_logs") {
      const recent = escapeHtml(logs.slice(-25).join("\n"));
      await telegramApi("sendMessage", {
        chat_id: chatId,
        text: `📝 <b>آخر سجلات الخادم:</b>\n\n<code>${recent || "لا توجد سجلات بعد"}</code>`,
        parse_mode: "HTML",
        reply_markup: MAIN_REPLY_KEYBOARD
      });
    }
  }
}

async function sendOrEditMenu(chatId: number | string, messageId: number | undefined, text: string, keyboard?: any) {
  if (messageId) {
    const res = await telegramApi("editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: "HTML",
      reply_markup: keyboard
    });
    if (res && res.ok) {
      return res;
    }
    if (res && !res.ok && res.description && res.description.toLowerCase().includes("message is not modified")) {
      return res;
    }
    try {
      await telegramApi("deleteMessage", { chat_id: chatId, message_id: messageId });
    } catch {
      /* ignore delete error */
    }
  }

  let res = await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: keyboard
  });

  // Fallback if HTML parse failed
  if (res && !res.ok) {
    addLog(`sendMessage HTML parse error (${res.description}), retrying plain text...`);
    const plainText = text.replace(/<[^>]+>/g, "");
    res = await telegramApi("sendMessage", {
      chat_id: chatId,
      text: plainText,
      reply_markup: keyboard
    });
  }

  return res;
}

async function sendMainMenu(chatId: number | string) {
  const clients = getPersistedClients();
  const activeCount = clients.filter(c => c.enabled).length;

  const text = `⚡ <b>مرحباً بك في لوحة تحكم V2Ray Server!</b>\n\n` +
    `🖥️ <b>المجال العلني:</b> <code>${getPublicDomain()}</code>\n` +
    `👥 <b>العملاء النشطون:</b> ${activeCount} / ${clients.length}\n` +
    `🔄 <b>الـ Slot الحالي:</b> ${activeSlot}\n\n` +
    `اختر إحدى الخيارات من لوحة المفاتيح أدناه للإدارة:`;

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: MAIN_REPLY_KEYBOARD
  });
}

// Admin-only detailed breakdown of exactly which configs are connected right
// now and from how many devices each -- the server-status summary above only
// gives the totals, this lists them per client.
async function sendConnectedDevicesReport(chatId: number | string) {
  const clients = getPersistedClients();
  const rows: { name: string; protocol: string; devices: number; isUserOwned: boolean }[] = [];

  for (const c of clients) {
    const { devices } = getLiveDeviceCount(c.id);
    if (devices === 0) continue;
    rows.push({ name: c.name, protocol: c.protocol, devices, isUserOwned: !!c.isUserOwned });
  }

  rows.sort((a, b) => b.devices - a.devices);

  const totalDevices = rows.reduce((sum, r) => sum + r.devices, 0);

  if (rows.length === 0) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "📡 <b>الأجهزة المتصلة الآن:</b>\n\nلا يوجد أي جهاز متصل حالياً بأي تكوين.",
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_KEYBOARD
    });
    return;
  }

  let text = `📡 <b>الأجهزة المتصلة الآن (${totalDevices} جهاز على ${rows.length} تكوين):</b>\n\n`;
  rows.forEach((r) => {
    const limitTag = r.isUserOwned ? `/${MAX_CONCURRENT_DEVICES}` : "";
    text += `🔌 <b>${escapeHtml(r.name)}</b> (${r.protocol.toUpperCase()}) — ${r.devices}${limitTag} جهاز\n`;
  });

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: MAIN_REPLY_KEYBOARD
  });
}

async function sendServerStatus(chatId: number | string) {
  const memUsage = process.memoryUsage();
  const freeMemGB = (os.freemem() / (1024 * 1024 * 1024)).toFixed(2);
  const totalMemGB = (os.totalmem() / (1024 * 1024 * 1024)).toFixed(2);
  const uptimeHours = (process.uptime() / 3600).toFixed(1);

  const clients = getPersistedClients();
  const activeCount = clients.filter(c => c.enabled).length;

  // Connected-devices snapshot: how many distinct sockets are live right
  // now across every client, and on how many different configs.
  let connectedDevices = 0;
  let connectedConfigs = 0;
  for (const clientId of Object.keys(activeSockets)) {
    const { devices } = getLiveDeviceCount(clientId);
    if (devices > 0) {
      connectedDevices += devices;
      connectedConfigs++;
    }
  }

  const location = await getServerLocation();
  const locationText = location ? `${location.flag} ${location.countryName}` : "🌍 غير معروف";
  const locationDetail = location ? formatServerLocationDetail(location) : "";

  const statusText = `📊 <b>حالة الخادم و V2Ray:</b>\n\n` +
    `🟢 <b>Slot النشط:</b> Slot ${activeSlot}\n` +
    `⏱️ <b>مدة التشغيل:</b> ${uptimeHours} ساعة\n` +
    `💾 <b>الذاكرة المستخدمة:</b> ${(memUsage.rss / (1024 * 1024)).toFixed(1)} MB\n` +
    `🖥️ <b>الذاكرة الإجمالية:</b> ${freeMemGB} GB / ${totalMemGB} GB\n` +
    `👥 <b>العملاء النشطون:</b> ${activeCount} من أصل ${clients.length}\n` +
    `📡 <b>الأجهزة المتصلة الآن:</b> ${connectedDevices} جهاز على ${connectedConfigs} تكوين\n` +
    `🗺️ <b>موقع السيرفر:</b> ${locationText}\n` +
    (locationDetail ? `${locationDetail}\n` : "") +
    `🌐 <b>النطاق:</b> <code>${getPublicDomain()}</code>`;

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: statusText,
    parse_mode: "HTML",
    reply_markup: MAIN_REPLY_KEYBOARD
  });
}

const CLIENTS_LIST_PAGE_SIZE = 10;

async function sendClientsList(chatId: number | string, page: number = 1) {
  const clients = getPersistedClients();

  if (clients.length === 0) {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "❌ <b>لا يوجد أي عميل حالياً.</b>\n\nيمكنك إضافة عميل جديد باستخدام الزر أسفله على الكيبورد.",
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_KEYBOARD
    });
    return;
  }

  const totalPages = Math.max(1, Math.ceil(clients.length / CLIENTS_LIST_PAGE_SIZE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const startIdx = (currentPage - 1) * CLIENTS_LIST_PAGE_SIZE;
  const pageClients = clients.slice(startIdx, startIdx + CLIENTS_LIST_PAGE_SIZE);

  const location = await getServerLocation();
  const locationText = location ? `${location.flag} ${location.countryName}` : "🌍 غير معروف";
  const locationDetail = location ? formatServerLocationDetail(location) : "";

  let text = `👥 <b>قائمة العملاء (${clients.length})${totalPages > 1 ? ` - صفحة ${currentPage}/${totalPages}` : ""}:</b>\n` +
    `🗺️ <b>موقع السيرفر:</b> ${locationText}\n` +
    (locationDetail ? `${locationDetail}\n` : "") +
    `\n` +
    `اضغط على اسم أي عميل أسفله في الكيبورد لعرض تفاصيله وإدارته:\n\n`;

  const keyboardRows: any[] = [];
  let currentRow: any[] = [];

  pageClients.forEach((c) => {
    const isExpired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();
    const statusIcon = !c.enabled ? "🔴" : isExpired ? "⏳" : "🟢";
    const connectedNow = getLiveDeviceCount(c.id).devices > 0;
    const connIcon = connectedNow ? "🔌" : "";
    const safeName = escapeHtml(c.name);
    const durationText = formatDurationDisplay(c);
    const usedBytes = (c.consumedUpload || 0) + (c.consumedDownload || 0);
    const usedGB = usedBytes / (1024 * 1024 * 1024);
    const quotaText = c.limitGB > 0 ? `${((usedGB / c.limitGB) * 100).toFixed(0)}%` : "غير محدود";
    const ownerTag = c.isUserOwned ? ` 👤(مستخدم عام: ${c.ownerId})` : "";
    const shareTag = c.sharedFlag ? " ⚠️مشاركة" : "";
    text += `${statusIcon}${connIcon} <b>${safeName}</b> (${c.protocol.toUpperCase()}) - ${durationText} - 📈 ${quotaText}${ownerTag}${shareTag}\n`;

    currentRow.push({ text: `${statusIcon} ${c.name}` });
    if (currentRow.length === 2) {
      keyboardRows.push(currentRow);
      currentRow = [];
    }
  });

  if (currentRow.length > 0) {
    keyboardRows.push(currentRow);
  }

  const navRow: any[] = [];
  if (currentPage > 1) navRow.push({ text: `⬅️ السابق (صفحة ${currentPage - 1})` });
  if (currentPage < totalPages) navRow.push({ text: `التالي ➡️ (صفحة ${currentPage + 1})` });
  if (navRow.length > 0) keyboardRows.push(navRow);

  keyboardRows.push([{ text: "➕ إضافة عميل جديد" }, { text: "🏠 القائمة الرئيسية" }]);

  const clientsReplyMarkup = {
    keyboard: keyboardRows,
    resize_keyboard: true,
    is_persistent: true
  };

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: clientsReplyMarkup
  });
}

async function startAddClientWizard(chatId: number | string) {
  userSessions[chatId] = { action: "add_client_proto" };

  const text = `➕ <b>إضافة عميل جديد - الخطوة 1/4:</b>\n\nاختر نوع البروتوكول من أزرار الكيبورد أدناه:`;
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: PROTO_REPLY_KEYBOARD
  });
}

async function selectDurationStep(chatId: number | string) {
  const text = `📅 <b>إضافة عميل جديد - الخطوة 2/4:</b>\n\nاختر مدة الاشتراك (بالدقائق أو الساعات أو الأيام) من أزرار الكيبورد أو أرسلها نصياً (مثال: "30 دقيقة"، "2 ساعة"، "7 أيام"):`;
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: DURATION_REPLY_KEYBOARD
  });
}

async function selectQuotaStep(chatId: number | string) {
  const text = `📊 <b>إضافة عميل جديد - الخطوة 3/4:</b>\n\nاختر حد البيانات (الكوتا) من أزرار الكيبورد أدناه، أو أرسل القيمة بالجيجابايت نصياً (مثال: "20 GB" أو "15" أو "غير محدود"):`;
  await telegramApi("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    reply_markup: QUOTA_REPLY_KEYBOARD
  });
}

async function sendClientDetails(chatId: number | string, clientId: string) {
  const clients = getPersistedClients();
  const cli = clients.find(c => c.id === clientId);
  if (!cli) {
    await sendClientsList(chatId);
    return;
  }

  userSessions[chatId] = { ...userSessions[chatId], selectedClientId: cli.id };

  const { link, type } = generateClientLinks(cli);
  const domain = getPublicDomain();
  const durationText = formatDurationDisplay(cli);
  const location = await getServerLocation();
  const locationText = location ? `${location.flag} ${location.countryName}` : "🌍 غير معروف";
  const locationDetail = location ? formatServerLocationDetail(location) : "";
  const { devices: deviceCount } = getLiveDeviceCount(cli.id);
  const isConnectedNow = deviceCount > 0;
  const connectionStatusText = isConnectedNow
    ? (cli.isUserOwned
        ? `🟢 متصل الآن (${deviceCount}/${MAX_CONCURRENT_DEVICES} أجهزة)`
        : `🟢 متصل الآن (${deviceCount} جهاز/أجهزة)`)
    : "⚪ غير متصل حالياً";

  const caption = `👤 <b>تفاصيل العميل: ${escapeHtml(cli.name)}</b>\n\n` +
    `⚡ <b>البروتوكول:</b> ${type}\n` +
    `🌐 <b>الهوست (Host / SNI):</b> <code>${escapeHtml(domain)}</code>\n` +
    `🗺️ <b>موقع السيرفر:</b> ${locationText}\n` +
    (locationDetail ? `${locationDetail}\n` : "") +
    `🔌 <b>حالة الاتصال:</b> ${connectionStatusText}\n` +
    `🔑 <b>UUID/Pass:</b> <code>${escapeHtml(cli.uuid)}</code>\n` +
    `📍 <b>المسار:</b> <code>${escapeHtml(cli.path)}</code>\n` +
    `📅 <b>الصلاحية المتبقية:</b> ${durationText}\n` +
    `📊 <b>الحد:</b> ${cli.limitGB > 0 ? `${cli.limitGB} GB` : 'غير محدود'}\n` +
    `📈 <b>الاستهلاك:</b> ${formatQuotaUsage(cli)}\n` +
    `🟢 <b>الحالة:</b> ${cli.enabled ? 'مفعل 🟢' : 'معطل 🔴'}\n\n` +
    `🔗 <b>رابط الاتصال:</b>\n<code>${escapeHtml(link)}</code>`;

  const clientActionKeyboard = {
    keyboard: [
      [{ text: cli.enabled ? "⏸️ إيقاف العميل" : "▶️ تفعيل العميل" }, { text: "❌ حذف العميل" }],
      [{ text: "📋 قائمة العملاء" }, { text: "🏠 القائمة الرئيسية" }]
    ],
    resize_keyboard: true,
    is_persistent: true
  };

  try {
    const qrBuffer = await QRCode.toBuffer(link, { width: 300, margin: 2 });
    const photoRes = await sendTelegramPhotoBuffer(chatId, qrBuffer, caption, clientActionKeyboard);
    if (photoRes && photoRes.ok) {
      return;
    }
  } catch (e: any) {
    addLog(`QR photo sending error: ${e?.message || e}`);
  }

  await telegramApi("sendMessage", {
    chat_id: chatId,
    text: caption,
    parse_mode: "HTML",
    reply_markup: clientActionKeyboard
  });
}

async function sendReplyKeyboard(chatId: number | string) {
  try {
    await telegramApi("sendMessage", {
      chat_id: chatId,
      text: "⚡ <b>لوحة التحكم السريعة مجهزة:</b>",
      parse_mode: "HTML",
      reply_markup: MAIN_REPLY_KEYBOARD
    });
  } catch {
    /* ignore error */
  }
}

// Registers (and keeps retrying to register, if the public domain isn't known
// yet) a Telegram webhook pointing at this exact instance's public URL. This
// replaces the old long-polling loop -- see comment above TELEGRAM_WEBHOOK_PATH
// for why. Safe to call from every instance/redeploy: Telegram's setWebhook is
// idempotent, and always overwrites the previous webhook with the last value
// set, so the newest instance to boot "wins" and the old one simply stops
// receiving anything once its revision is drained by Cloud Run.
async function setupTelegramWebhook(attempt = 1): Promise<void> {
  await registerBotCommands();

  let domain = getPublicDomain();
  if (domain === "0.0.0.0") {
    const detected = await detectCloudRunHostFromMetadata();
    if (detected) {
      rememberPublicHost(detected);
      domain = getPublicDomain();
    }
  }

  if (domain === "0.0.0.0") {
    addLog(`[Webhook] Public domain not detected yet (attempt ${attempt}) -- retrying in 5s...`);
    setTimeout(() => setupTelegramWebhook(attempt + 1), 5000);
    return;
  }

  const webhookUrl = `https://${domain}${TELEGRAM_WEBHOOK_PATH}`;
  const res = await telegramApi("setWebhook", {
    url: webhookUrl,
    secret_token: getWebhookSecret(),
    drop_pending_updates: false,
    allowed_updates: ["message", "callback_query"]
  });

  if (res && res.ok) {
    addLog(`[Webhook] Telegram webhook registered at ${webhookUrl}`);
  } else {
    addLog(`[Webhook] Failed to register webhook (${res?.description || "unknown error"}) -- retrying in 10s...`);
    setTimeout(() => setupTelegramWebhook(attempt + 1), 10000);
  }
}

// -----------------------------------------------------------------------------
// WebSocket Proxy for Express
// -----------------------------------------------------------------------------
// `agent` reuses keep-alive sockets to the local xray process instead of
// opening a fresh one per client, and removes the default per-host socket
// cap (Node's http.Agent defaults to 5/Infinity depending on version) --
// important once thousands of configs are proxying through the same 3 local
// xray ports at once.
const proxyAgent = new http.Agent({ keepAlive: true, maxSockets: Infinity, maxFreeSockets: 256 });
const proxy = httpProxy.createProxyServer({ ws: true, agent: proxyAgent });

proxy.on("error", (err, _req, _res) => {
  addLog(`Proxy error: ${err.message}`);
});

// How long a tracked socket can go without any traffic before it's treated
// as a dead/zombie connection instead of genuine concurrent use.
const STALE_SOCKET_MS = 25000;
// After spotting what looks like an over-limit device/IP on the same config,
// wait this long and re-check before actually disabling it, so a brief
// overlap during a normal reconnect isn't mistaken for sharing.
const SHARE_CONFIRM_DELAY_MS = 8000;
// Each self-service config may be used from up to this many distinct
// devices/networks at the same time (the owner plus this many shared
// devices). A genuinely new (4th) distinct IP triggers the auto-disable.
const MAX_CONCURRENT_DEVICES = 3;

function getRequestIP(req: any, socket: any): string {
  const fwd = (req.headers && req.headers["x-forwarded-for"]) as string | undefined;
  if (fwd) return fwd.split(",")[0].trim();
  return (socket && socket.remoteAddress) || "unknown";
}

// A single physical device/app commonly opens *several* raw WebSocket
// sockets at once through this proxy (one per outbound connection the app
// is tunneling -- e.g. multiple site connections in a browser), so raw
// `activeSockets[id].size` massively overcounts real devices (a single
// phone can easily show 10+ sockets). The actual number of *devices* is the
// number of distinct source IPs behind those sockets, and only sockets that
// have exchanged traffic recently (STALE_SOCKET_MS) count as genuinely
// live -- a dropped network can leave old sockets lingering uncleanly.
// This mirrors the anti-sharing detection logic above so the number shown
// to admins/users always matches the number actually enforced.
function getLiveDeviceCount(clientId: string): { devices: number; sockets: number } {
  const sockets = activeSockets[clientId];
  if (!sockets || sockets.size === 0) return { devices: 0, sockets: 0 };
  const now = Date.now();
  const distinctIPs = new Set<string>();
  let liveSockets = 0;
  for (const s of Array.from(sockets)) {
    const ss = s as any;
    if (!ss.lastActive || now - ss.lastActive > STALE_SOCKET_MS) continue; // zombie socket
    liveSockets++;
    distinctIPs.add(ss.clientIP || `socket:${liveSockets}`); // fall back to per-socket if IP wasn't tagged
  }
  return { devices: distinctIPs.size, sockets: liveSockets };
}

// Detects that a self-service user config (isUserOwned) is being used from
// more than MAX_CONCURRENT_DEVICES devices/networks at the same time,
// disables it, kills all its sockets, and notifies the owner via Telegram.
function handleConfigSharingDetected(clientId: string, newIP: string, existingIPs: string[]) {
  const clients = getPersistedClients();
  const cli = clients.find(c => c.id === clientId);
  if (!cli || cli.sharedFlag) return;

  cli.enabled = false;
  cli.sharedFlag = true;
  savePersistedClients(clients);

  addLog(`[Anti-Share] Config "${cli.name}" (owner ${cli.ownerId}) disabled automatically -- detected ${existingIPs.length + 1} simultaneous devices (${[...existingIPs, newIP].join(", ")}), exceeding the ${MAX_CONCURRENT_DEVICES}-device limit.`);

  const sockets = activeSockets[clientId];
  if (sockets) {
    for (const s of Array.from(sockets)) {
      try { s.destroy(); } catch { /* ignore */ }
    }
    sockets.clear();
  }

  scheduleV2RayRestart();

  if (cli.ownerId) {
    telegramApi("sendMessage", {
      chat_id: cli.ownerId,
      text: `🚫 <b>تم إيقاف تكوينك تلقائياً!</b>\n\n` +
            `تم رصد استخدام تكوينك (VLESS) من ${existingIPs.length + 1} أجهزة/شبكات مختلفة في نفس الوقت، وهذا يتجاوز الحد المسموح به (${MAX_CONCURRENT_DEVICES} أجهزة كحد أقصى في نفس الوقت).\n\n` +
            `يمكنك الحصول على تكوين جديد عبر زر "🔄 تجديد تكويني" من القائمة الرئيسية.`,
      parse_mode: "HTML"
    }).catch(() => { /* best-effort notification */ });
  }
}

server.on("upgrade", (req, socket, head) => {
  // Disable Nagle's algorithm on every incoming client socket so the initial
  // VLESS/VMess/Trojan handshake bytes go out immediately instead of being
  // buffered a few dozen ms waiting to be batched -- this is what makes
  // configs "connect fast" from the client's perspective, especially
  // noticeable when many users connect around the same time.
  try { (socket as any).setNoDelay?.(true); } catch { /* ignore */ }

  const url = req.url || "";
  const proxiedSlot: "A" | "B" = activeSlot;
  const ports = getSlotPorts(proxiedSlot);

  let pathname = url;
  try {
    pathname = new URL(url, `http://${req.headers.host || "localhost"}`).pathname;
  } catch {
    pathname = url.split("?")[0];
  }

  // Custom individual path -> matches exactly one client
  const pathClient = getClientByPathFast(pathname);
  const matchingClient = pathClient && pathClient.enabled ? pathClient : undefined;

  if (matchingClient) {
    if (matchingClient.expiresAt && new Date(matchingClient.expiresAt).getTime() < Date.now()) {
      addLog(`[Proxy Denied] Client ${matchingClient.name} has expired (matched by path).`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const consumed = (matchingClient.consumedUpload || 0) + (matchingClient.consumedDownload || 0);
    const limitBytes = (matchingClient.limitGB || 0) * 1024 * 1024 * 1024;
    if (matchingClient.limitGB > 0 && consumed >= limitBytes) {
      addLog(`[Proxy Denied] Client ${matchingClient.name} exceeded traffic limit (${matchingClient.limitGB} GB).`);
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
  }

  let targetPort = ports.vless;
  if (matchingClient) {
    if (matchingClient.protocol === "vmess") targetPort = ports.vmess;
    else if (matchingClient.protocol === "trojan") targetPort = ports.trojan;
    else targetPort = ports.vless;

    // Xray's actual inbound only listens on the shared path per protocol
    // (see generateV2RayConfigForSlot) -- rewrite the request before
    // forwarding so xray accepts it. The client is still uniquely identified
    // by UUID/password inside the encrypted protocol payload, not by this
    // outer WS path, so rewriting it here is safe.
    req.url = matchingClient.protocol === "vmess" ? "/by_moon_vmess"
      : matchingClient.protocol === "trojan" ? "/by_moon_trojan"
      : "/by_moon";
  } else if (url.includes("vmess")) {
    targetPort = ports.vmess;
  } else if (url.includes("trojan")) {
    targetPort = ports.trojan;
  }

  // Track per-client traffic. On the shared default paths (/by_moon, /by_moon_vmess,
  // /by_moon_trojan) several clients share the same inbound, so the individual
  // client is only known once we sniff the UUID out of the first VLESS frame.
  let detectedClientId: string | null = matchingClient ? matchingClient.id : null;
  let uuidParsed = matchingClient ? matchingClient.protocol !== "vless" : false;

  const sockObj = socket as any;
  sockObj.lastActive = Date.now();

  // Anti-sharing check: self-service user configs (isUserOwned) are allowed
  // to be used from up to MAX_CONCURRENT_DEVICES distinct devices/networks
  // at the same time (the owner plus MAX_CONCURRENT_DEVICES - 1 shared
  // devices). Real-world false positives happen because: (a) a device that
  // switches network (WiFi <-> mobile data, or just a mobile carrier
  // rotating its NAT IP) can leave its old socket lingering in
  // `activeSockets` without a clean TCP close for a while, so it looks like
  // a still-active "other device"; and (b) a normal reconnect briefly
  // overlaps the old and new connection for a fraction of a second. To
  // avoid disabling a config that was never actually over the device limit:
  //   1. Ignore/prune sockets that haven't exchanged any traffic recently
  //      (STALE_SOCKET_MS) -- those are dead connections, not a live device.
  //   2. Don't disable immediately on the first sighting of an over-limit
  //      (e.g. 4th) distinct IP; wait SHARE_CONFIRM_DELAY_MS and re-check
  //      that the new connection AND at least MAX_CONCURRENT_DEVICES of the
  //      other distinct IPs are still genuinely alive before treating it as
  //      sharing.
  //
  // NOTE: `clientIP` is tagged on the socket for every client (not just
  // isUserOwned ones) so that device counts shown in the admin UI are
  // always based on distinct IPs -- see the bug note below.
  const requestIP = getRequestIP(req, socket);
  sockObj.clientIP = requestIP;

  if (matchingClient && matchingClient.isUserOwned && detectedClientId) {
    const ownerClientId = detectedClientId;
    const existingSockets = activeSockets[ownerClientId];
    if (existingSockets && existingSockets.size > 0) {
      const now = Date.now();
      const distinctIPs = new Set<string>();
      for (const existingSock of Array.from(existingSockets)) {
        const es = existingSock as any;
        if (!es.lastActive || now - es.lastActive > STALE_SOCKET_MS) {
          // Dead/zombie connection left over from a dropped network -- clean
          // it up instead of treating it as evidence of another device.
          existingSockets.delete(existingSock);
          try { existingSock.destroy(); } catch { /* ignore */ }
          continue;
        }
        if (es.clientIP) distinctIPs.add(es.clientIP);
      }

      // Only a genuinely new IP -- one not already among the currently
      // active devices -- can push the count past the limit. A reconnect
      // from an IP that's already counted never triggers this.
      if (requestIP && !distinctIPs.has(requestIP) && distinctIPs.size >= MAX_CONCURRENT_DEVICES) {
        setTimeout(() => {
          const newStillLive = !sockObj.destroyed && activeSockets[ownerClientId]?.has(sockObj);
          if (!newStillLive) return;

          // Re-derive which of the other sockets are still genuinely
          // active (fresh traffic within STALE_SOCKET_MS) right now,
          // rather than trusting the earlier snapshot -- a socket left
          // behind by airplane mode / a network drop stops producing
          // traffic the instant the network dies, so re-checking recency
          // after the delay actually reflects live devices, not stale
          // ones that merely looked active at detection time.
          const stillActiveIPs = new Set<string>();
          const stillActiveSockets = activeSockets[ownerClientId];
          if (stillActiveSockets) {
            for (const s of Array.from(stillActiveSockets)) {
              const ss = s as any;
              if (ss === sockObj) continue;
              if (ss.clientIP && ss.lastActive && (Date.now() - ss.lastActive) <= STALE_SOCKET_MS) {
                stillActiveIPs.add(ss.clientIP);
              }
            }
          }

          if (stillActiveIPs.size >= MAX_CONCURRENT_DEVICES) {
            handleConfigSharingDetected(ownerClientId, requestIP, Array.from(stillActiveIPs));
          }
        }, SHARE_CONFIRM_DELAY_MS);
      }
    }
  }

  if (detectedClientId) {
    if (!activeSockets[detectedClientId]) activeSockets[detectedClientId] = new Set();
    activeSockets[detectedClientId].add(sockObj);
  }

  slotConnectionCounts[proxiedSlot]++;
  let slotCountedDown = false;
  const cleanupSocket = () => {
    if (detectedClientId && activeSockets[detectedClientId]) {
      activeSockets[detectedClientId].delete(sockObj);
    }
    if (!slotCountedDown) {
      slotCountedDown = true;
      slotConnectionCounts[proxiedSlot] = Math.max(0, slotConnectionCounts[proxiedSlot] - 1);
    }
  };
  socket.on("close", cleanupSocket);
  socket.on("end", cleanupSocket);
  socket.on("error", cleanupSocket);

  const originalEmit = socket.emit;
  socket.emit = function (event: string | symbol, ...args: any[]) {
    if (event === "data") {
      sockObj.lastActive = Date.now();
      const chunk = args[0];
      if (chunk && chunk.length) {
        if (!uuidParsed) {
          const parsedUuid = parseVlessUUID(chunk);
          if (parsedUuid) {
            uuidParsed = true;
            const matchedClient = getClientByUuidFast(parsedUuid);
            if (matchedClient) {
              const clientConsumed = (matchedClient.consumedUpload || 0) + (matchedClient.consumedDownload || 0);
              const clientLimitBytes = (matchedClient.limitGB || 0) * 1024 * 1024 * 1024;
              const clientExpired = matchedClient.expiresAt && new Date(matchedClient.expiresAt).getTime() < Date.now();
              const clientOverQuota = matchedClient.limitGB > 0 && clientConsumed >= clientLimitBytes;
              if (clientExpired || clientOverQuota) {
                addLog(`[Proxy Denied] Auto-detected client ${matchedClient.name} ${clientExpired ? "expired" : "exceeded quota"}. Destroying socket.`);
                try { socket.destroy(); } catch (e) { /* ignore */ }
                return false;
              }

              if (detectedClientId && detectedClientId !== matchedClient.id && activeSockets[detectedClientId]) {
                activeSockets[detectedClientId].delete(sockObj);
              }
              detectedClientId = matchedClient.id;
              if (!activeSockets[detectedClientId]) activeSockets[detectedClientId] = new Set();
              activeSockets[detectedClientId].add(sockObj);
            }
          }
        }

        if (detectedClientId) {
          accumulateTraffic(detectedClientId, chunk.length, "upload");
        }
      }
    } else if (event === "close" || event === "end" || event === "error") {
      cleanupSocket();
    }
    return originalEmit.apply(this, arguments as any);
  };

  const originalWrite = socket.write;
  socket.write = function (chunk: any, encoding?: any, callback?: any) {
    sockObj.lastActive = Date.now();
    if (chunk && detectedClientId) {
      accumulateTraffic(detectedClientId, chunk.length, "download");
    }
    return originalWrite.apply(this, arguments as any);
  };

  proxy.ws(req, socket, head, { target: `http://127.0.0.1:${targetPort}` }, (err) => {
    addLog(`WebSocket Proxy upgrade error: ${err?.message || err}`);
    socket.destroy();
  });
});

// Telegram webhook endpoint: Telegram POSTs each update here exactly once.
// The secret_token header lets us reject any request that didn't actually
// come from Telegram (e.g. someone guessing the URL path).
app.post(TELEGRAM_WEBHOOK_PATH, (req, res) => {
  const secretHeader = req.headers["x-telegram-bot-api-secret-token"];
  if (secretHeader !== getWebhookSecret()) {
    res.sendStatus(401);
    return;
  }
  // Acknowledge immediately so Telegram doesn't consider this a timeout and
  // retry/duplicate the delivery; process the update afterwards.
  res.sendStatus(200);
  handleTelegramUpdate(req.body).catch((err: any) => {
    addLog(`[Webhook] Error handling update: ${err?.message || err}`);
  });
});

function getHttpRequestIP(req: any): string {
  const fwd = req.headers && req.headers["x-forwarded-for"];
  if (fwd) return String(fwd).split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}

function statusPayload() {
  return {
    status: "ok",
    service: "V2Ray Telegram Bot Admin",
    activeSlot,
    domain: getPublicDomain()
  };
}

// Small self-contained setup wizard shown on "/" only until a Murad-bot
// config has been saved. Step 1 asks for the password, step 2 (only shown
// after the password is accepted) asks for the bot id/token. Everything is
// verified server-side on submit -- the client-side step switching is just
// UI convenience.
function muradSetupPageHtml(): string {
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>إعداد بوت مراد</title>
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: #0f1115; color: #e6e6e6; font-family: -apple-system, "Segoe UI", Tahoma, Arial, sans-serif;
    padding: 24px;
  }
  .card {
    background: #171a21; border: 1px solid #262b36; border-radius: 14px;
    padding: 28px; width: 100%; max-width: 380px; box-shadow: 0 8px 30px rgba(0,0,0,.35);
  }
  h1 { font-size: 18px; margin: 0 0 6px; }
  p.sub { color: #9aa3b2; font-size: 13px; margin: 0 0 20px; }
  label { display: block; font-size: 13px; color: #b7bfcc; margin: 14px 0 6px; }
  input {
    width: 100%; padding: 11px 12px; border-radius: 8px; border: 1px solid #2c3140;
    background: #0f1115; color: #e6e6e6; font-size: 14px;
  }
  input:focus { outline: none; border-color: #4c7dff; }
  button {
    width: 100%; margin-top: 20px; padding: 12px; border: none; border-radius: 8px;
    background: #4c7dff; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  button:disabled { opacity: .6; cursor: not-allowed; }
  .msg { margin-top: 14px; font-size: 13px; min-height: 18px; }
  .msg.err { color: #ff6b6b; }
  .msg.ok { color: #52d17c; }
  pre {
    background: #0f1115; border: 1px solid #262b36; border-radius: 8px; padding: 12px;
    font-size: 12px; overflow-x: auto; margin-top: 14px; color: #b9e6c4;
  }
  #step2 { display: none; }
  #result { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div id="step1">
      <h1>🔒 لوحة إعداد بوت مراد</h1>
      <p class="sub">أدخل كلمة السر للمتابعة</p>
      <label for="password">كلمة السر</label>
      <input id="password" type="password" autocomplete="off" />
      <button id="btnVerify">دخول</button>
      <div id="msg1" class="msg"></div>
    </div>

    <div id="step2">
      <h1>🤖 بيانات بوت مراد</h1>
      <p class="sub">تُحفظ هذه البيانات مرة واحدة فقط ولا يمكن تغييرها لاحقاً</p>
      <label for="botId">آيدي بوت تلقرام</label>
      <input id="botId" type="text" autocomplete="off" placeholder="مثال: 123456789" />
      <label for="botToken">توكن بوت تلقرام</label>
      <input id="botToken" type="text" autocomplete="off" placeholder="مثال: 123456789:AA..." />
      <button id="btnSave">حفظ وتفعيل</button>
      <div id="msg2" class="msg"></div>
    </div>

    <div id="result">
      <h1>✅ endpoint جديد مفعل</h1>
      <pre id="resultJson"></pre>
    </div>
  </div>

<script>
let verifiedPassword = "";

document.getElementById("btnVerify").addEventListener("click", async () => {
  const password = document.getElementById("password").value;
  const msg = document.getElementById("msg1");
  msg.textContent = ""; msg.className = "msg";
  if (!password) { msg.textContent = "أدخل كلمة السر."; msg.className = "msg err"; return; }
  try {
    const res = await fetch("/murad-setup/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      verifiedPassword = password;
      document.getElementById("step1").style.display = "none";
      document.getElementById("step2").style.display = "block";
    } else {
      msg.textContent = data.error || "كلمة السر غير صحيحة.";
      msg.className = "msg err";
    }
  } catch (e) {
    msg.textContent = "تعذر الاتصال بالسيرفر.";
    msg.className = "msg err";
  }
});

document.getElementById("btnSave").addEventListener("click", async () => {
  const botId = document.getElementById("botId").value.trim();
  const botToken = document.getElementById("botToken").value.trim();
  const msg = document.getElementById("msg2");
  msg.textContent = ""; msg.className = "msg";
  if (!botId || !botToken) { msg.textContent = "أدخل الآيدي والتوكن."; msg.className = "msg err"; return; }
  const btn = document.getElementById("btnSave");
  btn.disabled = true;
  try {
    const res = await fetch("/murad-setup/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: verifiedPassword, botId, botToken })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      document.getElementById("step2").style.display = "none";
      document.getElementById("result").style.display = "block";
      document.getElementById("resultJson").textContent = JSON.stringify(data.status, null, 2);
    } else {
      msg.textContent = data.error || "تعذر الحفظ.";
      msg.className = "msg err";
      btn.disabled = false;
    }
  } catch (e) {
    msg.textContent = "تعذر الاتصال بالسيرفر.";
    msg.className = "msg err";
    btn.disabled = false;
  }
});
</script>
</body>
</html>`;
}

// Root endpoint: once a Murad-bot config has been saved, this behaves
// exactly like before (plain status JSON). Until then, it serves the
// password-gated setup wizard instead.
app.get("/", (_req, res) => {
  if (getMuradBotConfig()) {
    res.json(statusPayload());
    return;
  }
  res.set("Content-Type", "text/html; charset=utf-8").send(muradSetupPageHtml());
});

app.post("/murad-setup/verify", (req, res) => {
  if (getMuradBotConfig()) {
    res.status(409).json({ ok: false, error: "تم الإعداد مسبقاً." });
    return;
  }
  const ip = getHttpRequestIP(req);
  if (!checkMuradSetupThrottle(ip)) {
    res.status(429).json({ ok: false, error: "محاولات كثيرة، حاول لاحقاً." });
    return;
  }
  const { password } = req.body || {};
  if (typeof password === "string" && password === MURAD_SETUP_PASSWORD) {
    recordMuradSetupSuccess(ip);
    res.json({ ok: true });
  } else {
    recordMuradSetupFailure(ip);
    res.status(401).json({ ok: false, error: "كلمة السر غير صحيحة." });
  }
});

app.post("/murad-setup/save", (req, res) => {
  if (getMuradBotConfig()) {
    res.status(409).json({ ok: false, error: "تم الإعداد مسبقاً ولا يمكن تغييره." });
    return;
  }
  const ip = getHttpRequestIP(req);
  if (!checkMuradSetupThrottle(ip)) {
    res.status(429).json({ ok: false, error: "محاولات كثيرة، حاول لاحقاً." });
    return;
  }
  const { password, botId, botToken } = req.body || {};
  if (typeof password !== "string" || password !== MURAD_SETUP_PASSWORD) {
    recordMuradSetupFailure(ip);
    res.status(401).json({ ok: false, error: "كلمة السر غير صحيحة." });
    return;
  }
  if (typeof botId !== "string" || !botId.trim() || typeof botToken !== "string" || !botToken.trim() || !botToken.includes(":")) {
    res.status(400).json({ ok: false, error: "آيدي أو توكن البوت غير صالح." });
    return;
  }
  const saved = saveMuradBotConfigOnce(botId.trim(), botToken.trim());
  if (!saved) {
    res.status(409).json({ ok: false, error: "تم الإعداد مسبقاً ولا يمكن تغييره." });
    return;
  }
  // Switch the live bot over to the newly-saved token right now, instead of
  // waiting for a redeploy: register a fresh Telegram webhook using the new
  // token (getActiveBotToken()/getWebhookSecret() both already read from the
  // config we just saved). Without this, the old token would keep answering
  // forever since nothing else re-registers the webhook after this point.
  setupTelegramWebhook().catch((err) => {
    addLog(`[Murad-Setup] Failed to register webhook for newly-saved bot: ${err?.message || err}`);
  });
  res.json({ ok: true, status: statusPayload() });
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok" });
});

// Initialize & Boot
initClientsDB();
ensureV2RayBinary();

startV2RayProcess(activeSlot);

// Larger TCP accept-queue backlog (default is only ~511) so a sudden burst of
// thousands of users opening a WebSocket connection at the same time doesn't
// get refused/dropped while Node works through the queue.
const LISTEN_BACKLOG = 8192;

server.listen(PORT, "0.0.0.0", LISTEN_BACKLOG, () => {
  addLog(`Express Server & WebSocket Proxy listening on http://0.0.0.0:${PORT}`);
  startKeepAlive();

  // Durability diagnostics -- this app is designed to run on Cloud Run,
  // where the container filesystem is ephemeral: nothing written to
  // DATA_DIR survives past this instance unless DATA_DIR itself points at a
  // mounted persistent volume (e.g. a Cloud Run "Volume Mounts" Cloud
  // Storage FUSE bucket). Without that, EVERY redeploy/scale-event wipes
  // admin.json (losing the primary-admin identity -- the very bug that keeps
  // recurring) and clients.json (deleting every user's config, which also
  // explains stale .dark files pointing at a host/uuid/path the server no
  // longer knows about). Surface this loudly at boot rather than let it
  // fail silently later.
  if (!process.env.TELEGRAM_ADMIN_CHAT_ID) {
    addLog("⚠️ STARTUP WARNING: TELEGRAM_ADMIN_CHAT_ID is not set. Primary-admin " +
      "identity depends entirely on admin.json in DATA_DIR, which is lost on every " +
      "Cloud Run redeploy unless DATA_DIR is a mounted persistent volume. Set " +
      "TELEGRAM_ADMIN_CHAT_ID as a permanent Cloud Run env var to fix this for good.");
  }
  if (!process.env.APP_URL && process.env.K_SERVICE) {
    addLog(`⚠️ STARTUP WARNING: APP_URL is not set. The public host is being ` +
      `auto-detected from the Cloud Run service name ("${process.env.K_SERVICE}"). ` +
      `If this service is ever redeployed under a different service name, ALL ` +
      `previously issued config links/.dark files will point at the old host and ` +
      `stop working. Set APP_URL to a fixed value to avoid this.`);
  }
  if (!process.env.DATA_DIR) {
    addLog(`⚠️ STARTUP WARNING: DATA_DIR is not set (defaulting to ${DATA_DIR}). On ` +
      `Cloud Run this directory does NOT persist across redeploys/restarts -- mount ` +
      `a persistent volume and set DATA_DIR to it, or admin/client data will keep ` +
      `resetting.`);
  }

  setupTelegramWebhook();
});
