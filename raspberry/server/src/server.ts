import express, { Request, Response } from "express";
import cors from "cors";
import * as opaque from "@serenity-kit/opaque";
import Database from "better-sqlite3";
import jwt from "jsonwebtoken";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";
import https from "https";
import { metricsMiddleware, withSpan, traceId } from "./metrics.js";

// Tento server prepája frontend, OPAQUE autentizáciu, SQLite databázu
// aj pomocné kroky potrebné pre PQC podpis a prácu s lokálnym agentom.
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

await opaque.ready;

const app = express();
app.use(
  cors({
    origin: true,
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-Trace-Id"],
  })
);

// Niektoré helper endpointy môžu prenášať väčšie JSON payloady,
// preto zvýšime limit pre parser tela požiadavky.
app.use(express.json({ limit: "20mb" }));
app.use(metricsMiddleware());

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-key";
const clientDistPath = path.resolve(process.cwd(), "..", "client", "dist");

if (fs.existsSync(clientDistPath)) {
  // Ak je klient zostavený, server ho vie obsluhovať priamo ako statický obsah.
  app.use(express.static(clientDistPath));

  app.get(/^\/(?!api).*/, (_req, res) => {
    res.sendFile(path.join(clientDistPath, "index.html"));
  });
}

// Finálny JWT token sa vydáva až po dokončení celého prihlásenia.
function createJwt(username: string) {
  return jwt.sign({ username }, JWT_SECRET, { expiresIn: "2h" });
}

// Scoped tokeny majú užší účel než bežný JWT a obmedzujú,
// na ktorý krok ich možno použiť.
type ScopedPayload = { sub: string; scope: "register_device" | "pqc_2fa" };

function issueScopedToken(
  sub: string,
  scope: ScopedPayload["scope"],
  expiresInSec: number
) {
  return jwt.sign({ sub, scope } satisfies ScopedPayload, JWT_SECRET, {
    expiresIn: expiresInSec,
  });
}

function readScopedToken(req: Request): ScopedPayload | null {
  const h = req.headers["authorization"];
  if (!h || typeof h !== "string") return null;
  const m = h.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;

  try {
    const decoded = jwt.verify(m[1], JWT_SECRET) as any;
    if (!decoded?.sub || !decoded?.scope) return null;
    return { sub: String(decoded.sub), scope: decoded.scope } as ScopedPayload;
  } catch {
    return null;
  }
}

function requireScope(scope: ScopedPayload["scope"]) {
  // Middleware overí, či klient poslal správny dočasný token pre daný endpoint.
  return (req: Request, res: Response, next: Function) => {
    const tok = readScopedToken(req);
    if (!tok || tok.scope !== scope) {
      return res.status(401).json({ error: "missing_or_invalid_scoped_token" });
    }
    (req as any).scoped = tok;
    next();
  };
}

type UserPqcRow = {
  pqc_public_key: string | null;
};
type PqcChallengeRow = {
  id: string;
  username: string;
  challenge: Buffer;
  expires_at: number;
  used: number;
};

type UserPqcVerifyRow = {
  pqc_public_key: string | null;
  pqc_algorithm: string | null;
};



// ---------------------------
// Inicializácia SQLite a migrácie
// ---------------------------
const db = new Database("users.db");

// 1) Základná tabuľka
db.prepare(`
  CREATE TABLE IF NOT EXISTS users (
    username TEXT PRIMARY KEY,
    userIdentifier TEXT NOT NULL,
    registrationRecord TEXT NOT NULL,
    bio_helper_index INTEGER,
    bio_helper_data TEXT,
    bio_key_hash TEXT
  )
`).run();

function columnExists(db: any, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some((r: any) => r.name === column);
}

// 2) Doplnenie stĺpcov pre PQC údaje
if (!columnExists(db, "users", "pqc_public_key")) {
  console.log("[DB] Adding pqc_public_key to users");
  db.prepare(`ALTER TABLE users ADD COLUMN pqc_public_key TEXT`).run();
}

if (!columnExists(db, "users", "pqc_algorithm")) {
  console.log("[DB] Adding pqc_algorithm to users");
  db.prepare(`ALTER TABLE users ADD COLUMN pqc_algorithm TEXT`).run();
}

if (!columnExists(db, "users", "pqc_created_at")) {
  console.log("[DB] Adding pqc_created_at to users");
  db.prepare(`ALTER TABLE users ADD COLUMN pqc_created_at TEXT`).run();
}

// 3) Serverové počítadlo podpisov podobné FIDO2
if (!columnExists(db, "users", "pqc_sign_count_last")) {
  console.log("[DB] Adding pqc_sign_count_last to users");
  db.prepare(`ALTER TABLE users ADD COLUMN pqc_sign_count_last INTEGER DEFAULT 0`).run();

  // SQLite použije DEFAULT len pri nových riadkoch; staršie záznamy môžu
  // zostať s hodnotou NULL. Preto ich hneď normalizujeme na 0.
  db.prepare(`UPDATE users SET pqc_sign_count_last = 0 WHERE pqc_sign_count_last IS NULL`).run();
}

// 4) Tabuľka výziev pre ochranu proti opakovanému použitiu
db.prepare(`
  CREATE TABLE IF NOT EXISTS pqc_challenges (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    challenge BLOB NOT NULL,
    expires_at INTEGER NOT NULL,
    used INTEGER DEFAULT 0,
    FOREIGN KEY(username) REFERENCES users(username)
  )
`).run();

console.log("[DB] users and pqc_challenges tables ready");


console.log("[DB] pqc_challenges table ready");

interface DBUser {
  username: string;
  userIdentifier: string;
  registrationRecord: string;
  bio_helper_index?: number | null;
  bio_helper_data?: string | null;
  bio_key_hash?: string | null;
}

// ---------------------------
// Nastavenie OPAQUE servera
// ---------------------------
const setupPath = path.join(process.cwd(), "server_setup.txt");
let SERVER_SETUP: string;

// Nastavenie OPAQUE servera je dlhodobý parameter servera,
// preto ho po prvom vytvorení uložíme na disk a pri ďalších štartoch znovu použijeme.
if (fs.existsSync(setupPath)) {
  SERVER_SETUP = fs.readFileSync(setupPath, "utf8");
  console.log("[OPAQUE] Loaded existing server setup");
} else {
  SERVER_SETUP = opaque.server.createSetup();
  fs.writeFileSync(setupPath, SERVER_SETUP, "utf8");
  console.log("[OPAQUE] Generated and saved new server setup");
}

// ---------------------------
// Stav prihlásenia
// ---------------------------
type ServerLoginState =
  ReturnType<typeof opaque.server.startLogin>["serverLoginState"];

// Dočasný stav loginu si server drží v pamäti medzi štartom a dokončením
// OPAQUE protokolu.
const loginStates = new Map<string, ServerLoginState>();

// ---------------------------
// Pomocné funkcie
// ---------------------------
function getUser(username: string): DBUser | undefined {
  return db
    .prepare("SELECT * FROM users WHERE username = ?")
    .get(username) as DBUser | undefined;
}

function saveUser(
  username: string,
  userIdentifier: string,
  registrationRecord: string
) {
  db.prepare(
    `
    INSERT INTO users (username, userIdentifier, registrationRecord)
    VALUES (?, ?, ?)
  `
  ).run(username, userIdentifier, registrationRecord);
}

function reqTraceId(req: Request): string {
  return (req as any).trace_id || traceId(req);
}




// ---------------------------
// Routy
// ---------------------------

app.get("/api/health", (_req, res) => res.json({ ok: true }));

// ---------------------------
// Registrácia – OPAQUE
// ---------------------------
app.post("/api/register/start", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, registrationRequest } = req.body;

  if (!username || !registrationRequest) {
    return res.status(400).json({ error: "missing_fields" });
  }

  console.log(`[OPAQUE] /register/start ${username}`);

  const userIdentifier = `uid:${username}`;

  const { registrationResponse } = await withSpan(
    {
      phase: "register",
      operation: "opaque_register_start",
      trace_id,
      extra: { username },
    },
    async () => {
      return opaque.server.createRegistrationResponse({
        serverSetup: SERVER_SETUP,
        userIdentifier,
        registrationRequest,
      });
    }
  );

  await withSpan(
    {
      phase: "db",
      operation: "insert_user_stub",
      trace_id,
      extra: { username },
    },
    async () => {
      saveUser(username, userIdentifier, "");
    }
  );

  res.json({ registrationResponse });
});

app.post("/api/register/finish", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, registrationRecord } = req.body;

  const user = await withSpan(
    {
      phase: "db",
      operation: "get_user_for_register_finish",
      trace_id,
      extra: { username },
    },
    async () => getUser(username)
  );

  if (!user) {
    return res.status(400).json({ error: "unknown_user" });
  }

  await withSpan(
    {
      phase: "register",
      operation: "opaque_register_finish_store_record",
      trace_id,
      extra: { username },
    },
    async () => {
      db.prepare(`
        UPDATE users SET registrationRecord=? WHERE username=?
      `).run(registrationRecord, username);
    }
  );

  const regToken = await withSpan(
    {
      phase: "auth",
      operation: "issue_register_device_token",
      trace_id,
      extra: { username },
    },
    async () => issueScopedToken(username, "register_device", 10 * 60)
  );

  console.log(`[OPAQUE] Registered ${username}`);
  res.json({ ok: true, regToken });
});


app.post(
  "/api/pqc/register-device",
  requireScope("register_device"),
  async (req, res) => {
    // Tento endpoint je užitočný v topológii, kde server priamo vidí lokálneho
    // agenta. V Raspberry simulácii sa však registrácia zariadenia štandardne
    // vykonáva priamo z prehliadača na PC do lokálneho agenta cez 127.0.0.1.
    const trace_id = reqTraceId(req);
    const scoped = (req as any).scoped as ScopedPayload;
    const { username, port } = req.body;

    const authHeader = req.headers["authorization"];
    if (!authHeader || typeof authHeader !== "string") {
      return res.status(401).json({ error: "missing_authorization_header" });
    }

    if (!username || !port) {
      return res.status(400).json({ error: "missing_fields" });
    }
    if (scoped.sub !== username) {
      return res.status(401).json({ error: "token_username_mismatch" });
    }

    try {
      const ac = new AbortController();
      const TIMEOUT_MS = 180_000;
      const t = setTimeout(() => ac.abort(), TIMEOUT_MS);

      const r = await withSpan(
        {
          phase: "network",
          operation: "agent_register_device_call",
          trace_id,
          extra: { username, port, timeout_ms: TIMEOUT_MS },
        },
        async () => {
          return await fetch("https://127.0.0.1:5555/pqc/register", {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Trace-Id": trace_id,
            },
            body: JSON.stringify({ username, port, regToken: authHeader }),
            signal: ac.signal,
          }).finally(() => clearTimeout(t));
        }
      );

      const j = await withSpan(
        {
          phase: "network",
          operation: "agent_register_device_parse_json",
          trace_id,
          extra: { username },
        },
        async () => {
          return await r.json().catch(() => ({}));
        }
      );

      if (!r.ok) {
        return res.status(500).json(j);
      }

      return res.json(j);
    } catch (e: any) {
      const isAbort =
        e?.name === "AbortError" ||
        String(e?.name || "").toLowerCase().includes("abort");

      return res
        .status(isAbort ? 504 : 500)
        .json({ error: isAbort ? "agent_timeout" : "agent_unreachable" });
    }
  }
);







function pqcVerifyViaPython(args: {
  alg: string;
  messageB64: string;
  signatureB64: string;
  publicKeyB64: string;
}): boolean {

  // Raspberry vetva má byť samostatná. Preto helper skript hľadáme
  // priamo vo vnútri `raspberry/server/tools/` a nepredpokladáme
  // prítomnosť koreňového priečinka hlavného projektu.
  const serverRootsToTry = [
    process.cwd(),
    path.resolve(__dirname, ".."),
  ];

  const SERVER_ROOT = serverRootsToTry.find((r) =>
    fs.existsSync(path.resolve(r, "tools", "pqc_verify.py"))
  );

  if (!SERVER_ROOT) {
    throw new Error(
      `server root not found; tried: ${serverRootsToTry.join(" | ")}`
    );
  }

  // Po nájdení koreňa servera zostavíme absolútnu cestu k helperu
  // `pqc_verify.py`.
  const scriptPath = path.resolve(SERVER_ROOT, "tools", "pqc_verify.py");

  if (!fs.existsSync(scriptPath)) {
    throw new Error(`pqc_verify.py not found: ${scriptPath}`);
  }

  // Python interpreter berieme prednostne z lokálneho virtuálneho prostredia
  // v `raspberry/server/.venv`. Ak neexistuje, môžeme použiť aj explicitne
  // nastavený `PYTHON_EXE` alebo systémový `python3` či `python`.
  const pythonCandidates = [
    process.env.PYTHON_EXE,
    process.platform === "win32"
      ? path.resolve(SERVER_ROOT, ".venv", "Scripts", "python.exe")
      : path.resolve(SERVER_ROOT, ".venv", "bin", "python"),
    process.platform === "win32" ? "python" : "python3",
    "python",
  ].filter((candidate): candidate is string => Boolean(candidate));

  const pythonExe = pythonCandidates.find(
    (candidate) =>
      candidate === "python" ||
      candidate === "python3" ||
      fs.existsSync(candidate)
  );

  if (!pythonExe) {
    throw new Error(`Python interpreter not found; tried: ${pythonCandidates.join(" | ")}`);
  }

  const input = JSON.stringify({
    alg: args.alg,
    message_b64: args.messageB64,
    signature_b64: args.signatureB64,
    public_key_b64: args.publicKeyB64,
  });
  const p = spawnSync(pythonExe, [scriptPath], {
    input,
    encoding: "utf-8",
    maxBuffer: 20 * 1024 * 1024,
  });

  // 4) Tvrdý debug ak python spadne
  // Ak Python helper zlyhá, vrátime do Node.js servera čo najčitateľnejšiu
  // diagnostiku.
  if (p.error) {
    throw new Error(`spawn_error: ${p.error.message}`);
  }

  if (p.status !== 0) {
    throw new Error(
      `python_exit_nonzero status=${p.status} signal=${p.signal || ""} stderr=${p.stderr || "<empty>"} stdout=${p.stdout || "<empty>"}`
    );
  }

  let out: any;
  try {
    out = JSON.parse(p.stdout);
  } catch {
    throw new Error(`bad_python_json: ${p.stdout || "<empty>"}`);
  }

  return out.ok === true;
}








// ===============================
// PQC – registrácia verejného kľúča
// ===============================
app.post("/api/pqc/register", requireScope("register_device"), async (req, res) => {
  const trace_id = reqTraceId(req);
  const scoped = (req as any).scoped as ScopedPayload;
  const { username, pqcPublicKey, algorithm } = req.body;

  if (!username || !pqcPublicKey || !algorithm) {
    return res.status(400).json({ error: "Missing username, pqcPublicKey or algorithm" });
  }
  if (scoped.sub !== username) {
    return res.status(401).json({ error: "token_username_mismatch" });
  }

  const user = await withSpan(
    {
      phase: "db",
      operation: "pqc_register_lookup_user",
      trace_id,
      extra: { username },
    },
    async () => db.prepare(`SELECT username FROM users WHERE username = ?`).get(username)
  );

  if (!user) {
    return res.status(404).json({ error: "User not found" });
  }

  await withSpan(
    {
      phase: "register",
      operation: "pqc_register_store_public_key",
      trace_id,
      extra: { username, algorithm },
    },
    async () => {
      db.prepare(`
        UPDATE users
        SET pqc_public_key = ?,
            pqc_algorithm = ?,
            pqc_created_at = ?
        WHERE username = ?
      `).run(pqcPublicKey, algorithm, new Date().toISOString(), username);
    }
  );

  console.log(`[PQC] Public key registered for ${username}`);
  res.json({ ok: true });
});

// ===============================
// PQC – vydanie výzvy
// ===============================
app.post("/api/pqc/challenge", requireScope("pqc_2fa"), async (req, res) => {
  const trace_id = reqTraceId(req);
  const scoped = (req as any).scoped as ScopedPayload;
  const username = scoped.sub;

  const u = await withSpan(
    {
      phase: "db",
      operation: "challenge_lookup_user",
      trace_id,
      extra: { username },
    },
    async () => db.prepare(`SELECT username FROM users WHERE username = ?`).get(username)
  );

  if (!u) {
    return res.status(404).json({ error: "User not found" });
  }

  const { challenge, challengeId, expiresAt } = await withSpan(
    {
      phase: "network",
      operation: "challenge_generate",
      trace_id,
      extra: { username },
    },
    async () => {
      const challenge = crypto.randomBytes(32);
      const challengeId = crypto.randomUUID();
      const expiresAt = Date.now() + 3 * 60_000;

      return { challenge, challengeId, expiresAt };
    }
  );

  await withSpan(
    {
      phase: "db",
      operation: "challenge_insert_db",
      trace_id,
      extra: { username, challengeId },
    },
    async () => {
      db.prepare(`
        INSERT INTO pqc_challenges (id, username, challenge, expires_at, used)
        VALUES (?, ?, ?, ?, 0)
      `).run(challengeId, username, challenge, expiresAt);
    }
  );

  console.log(`[PQC] Challenge issued for ${username}`);
  res.json({
    challengeId,
    challenge: challenge.toString("base64"),
    expiresAt,
  });
});



// ===============================
// PQC – overenie podpisu
// ===============================
function canonicalJson(obj: any): string {
  // kompatibilné s agent.py: json.dumps(payload, sort_keys=True, separators=(",",":"))
  // Stabilné poradie kľúčov je dôležité, inak by server a agent hashovali
  // odlišný obsah.
  const sortKeysDeep = (v: any): any => {
    if (Array.isArray(v)) return v.map(sortKeysDeep);
    if (v && typeof v === "object") {
      const out: any = {};
      for (const k of Object.keys(v).sort()) out[k] = sortKeysDeep(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sortKeysDeep(obj));
}

app.post("/api/pqc/verify", requireScope("pqc_2fa"), async (req, res) => {
  const trace_id = reqTraceId(req);
  const scoped = (req as any).scoped as ScopedPayload;
  const username = scoped.sub;

  const { challengeId, payload, signature } = req.body;
  if (!challengeId || !payload || !signature) {
    return res.status(400).json({ error: "Missing fields" });
  }

  const challengeRow = await withSpan(
    {
      phase: "db",
      operation: "verify_load_challenge",
      trace_id,
      extra: { username, challengeId },
    },
    async () => {
      return db.prepare(`
        SELECT id, username, challenge, expires_at, used
        FROM pqc_challenges
        WHERE id = ?
      `).get(challengeId) as PqcChallengeRow | undefined;
    }
  );

  if (!challengeRow) return res.status(404).json({ error: "Challenge not found" });
  if (challengeRow.used) return res.status(400).json({ error: "Challenge already used" });
  if (Date.now() > challengeRow.expires_at) return res.status(400).json({ error: "Challenge expired" });
  if (challengeRow.username !== username) return res.status(401).json({ error: "Challenge user mismatch" });

  await withSpan(
    {
      phase: "verify",
      operation: "verify_payload_checks",
      trace_id,
      extra: { username, challengeId },
    },
    async () => {
      if (payload.username !== username) {
        throw new Error("Payload user mismatch");
      }
      if (payload.uv !== true) {
        throw new Error("User verification required");
      }
      if (typeof payload.signCount !== "number" || payload.signCount < 1) {
        throw new Error("Invalid signCount");
      }

      const dbChallengeB64 = Buffer.from(challengeRow.challenge).toString("base64");
      if (payload.challenge !== dbChallengeB64) {
        throw new Error("Challenge mismatch");
      }
    }
  ).catch((e: any) => {
    const msg = String(e?.message || e);
    if (msg === "Payload user mismatch") return res.status(401).json({ error: msg });
    if (msg === "User verification required") return res.status(401).json({ error: msg });
    if (msg === "Invalid signCount") return res.status(400).json({ error: msg });
    if (msg === "Challenge mismatch") return res.status(401).json({ error: msg });
    return res.status(400).json({ error: msg });
  });

  if (res.headersSent) return;

  const user = await withSpan(
    {
      phase: "db",
      operation: "verify_load_user_pqc",
      trace_id,
      extra: { username },
    },
    async () => {
      return db.prepare(`
        SELECT pqc_public_key, pqc_algorithm, COALESCE(pqc_sign_count_last, 0) AS lastSignCount
        FROM users
        WHERE username = ?
      `).get(username) as (UserPqcVerifyRow & { lastSignCount: number }) | undefined;
    }
  );

  if (!user || !user.pqc_public_key || !user.pqc_algorithm) {
    return res.status(404).json({ error: "User or PQC key not found" });
  }

  const counterOk = await withSpan(
    {
      phase: "security",
      operation: "verify_sign_counter_check",
      trace_id,
      extra: { username, signCount: payload.signCount, lastSignCount: user.lastSignCount },
    },
    async () => payload.signCount > user.lastSignCount
  );

  if (!counterOk) {
    return res.status(401).json({ error: "signCount not increasing" });
  }

  const { canon, hashB64 } = await withSpan(
    {
      phase: "crypto",
      operation: "verify_canonicalize_and_hash",
      trace_id,
      extra: { username },
    },
    async () => {
      const canon = canonicalJson(payload);
      const hash = crypto.createHash("sha256").update(canon, "utf8").digest();
      return {
        canon,
        hashB64: hash.toString("base64"),
      };
    }
  );

  let ok = false;
  try {
    ok = await withSpan(
      {
        phase: "crypto",
        operation: "verify_pqc_signature_python",
        trace_id,
        extra: {
          username,
          algorithm: user.pqc_algorithm,
          canon_len: canon.length,
        },
      },
      async () => {
        return pqcVerifyViaPython({
          alg: user.pqc_algorithm!,
          messageB64: hashB64,
          signatureB64: signature,
          publicKeyB64: user.pqc_public_key!,
        });
      }
    );
  } catch (e: any) {
    return res.status(500).json({
      error: "PQC verify error",
      details: String(e?.message || e),
    });
  }

  if (!ok) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  await withSpan(
    {
      phase: "db",
      operation: "verify_mark_challenge_used",
      trace_id,
      extra: { username, challengeId },
    },
    async () => {
      db.prepare(`UPDATE pqc_challenges SET used = 1 WHERE id = ?`).run(challengeId);
    }
  );

  await withSpan(
    {
      phase: "db",
      operation: "verify_update_sign_counter",
      trace_id,
      extra: { username, signCount: payload.signCount },
    },
    async () => {
      db.prepare(`UPDATE users SET pqc_sign_count_last = ? WHERE username = ?`)
        .run(payload.signCount, username);
    }
  );

  const token = await withSpan(
    {
      phase: "auth",
      operation: "issue_final_jwt",
      trace_id,
      extra: { username },
    },
    async () => createJwt(username)
  );

  console.log(`[PQC] Challenge verified for ${username} (signCount=${payload.signCount})`);
  res.json({ ok: true, token });
});





// ---------------------------
// Registrácia – biometria (fuzzy extractor)
// ---------------------------
app.post("/api/register/biometric", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, bio_helper_index, bio_helper_data, bio_key_hash } = req.body;

  if (
    !username ||
    bio_helper_index === undefined ||
    !bio_helper_data ||
    !bio_key_hash
  ) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const user = await withSpan(
    {
      phase: "db",
      operation: "biometric_register_lookup_user",
      trace_id,
      extra: { username },
    },
    async () => getUser(username)
  );

  if (!user) return res.status(404).json({ error: "unknown_user" });

  await withSpan(
    {
      phase: "biometric",
      operation: "biometric_register_store_helper",
      trace_id,
      extra: { username, helper_index: bio_helper_index },
    },
    async () => {
      db.prepare(`
        UPDATE users
        SET bio_helper_index=?, bio_helper_data=?, bio_key_hash=?
        WHERE username=?
      `).run(bio_helper_index, bio_helper_data, bio_key_hash, username);
    }
  );

  console.log(`[BIO] Registered fingerprint for ${username}`);
  res.json({ ok: true });
});

// ---------------------------
// Login – OPAQUE
// ---------------------------
app.post("/api/login/start", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, startLoginRequest } = req.body;

  const user = await withSpan(
    {
      phase: "db",
      operation: "login_lookup_user",
      trace_id,
      extra: { username },
    },
    async () => getUser(username)
  );

  if (!user || !user.registrationRecord) {
    return res.status(400).json({ error: "invalid_credentials" });
  }

  const { serverLoginState, loginResponse } = await withSpan(
    {
      phase: "login",
      operation: "opaque_login_start",
      trace_id,
      extra: { username },
    },
    async () => {
      return opaque.server.startLogin({
        serverSetup: SERVER_SETUP,
        userIdentifier: user.userIdentifier,
        registrationRecord: user.registrationRecord,
        startLoginRequest,
      });
    }
  );

  await withSpan(
    {
      phase: "login",
      operation: "store_login_state",
      trace_id,
      extra: { username },
    },
    async () => {
      loginStates.set(username, serverLoginState);
    }
  );

  res.json({ loginResponse });
});

app.post("/api/login/finish", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, finishLoginRequest } = req.body;

  const state = await withSpan(
    {
      phase: "login",
      operation: "load_login_state",
      trace_id,
      extra: { username },
    },
    async () => loginStates.get(username)
  );

  if (!state) {
    return res.status(400).json({ error: "no_login_in_progress" });
  }

  const { sessionKey } = await withSpan(
    {
      phase: "login",
      operation: "opaque_login_finish",
      trace_id,
      extra: { username },
    },
    async () => {
      return opaque.server.finishLogin({
        finishLoginRequest,
        serverLoginState: state,
      });
    }
  );

  await withSpan(
    {
      phase: "login",
      operation: "delete_login_state",
      trace_id,
      extra: { username },
    },
    async () => {
      loginStates.delete(username);
    }
  );

  const pre2faToken = await withSpan(
    {
      phase: "auth",
      operation: "issue_pre2fa_token",
      trace_id,
      extra: { username },
    },
    async () => issueScopedToken(username, "pqc_2fa", 10 * 60)
  );

  console.log(`[OPAQUE] Login OK: ${username}`);

  res.json({
    sessionKey,
    needsPqc: true,
    username,
    pre2faToken,
  });
});


// ---------------------------
// Biometria – načítanie helper údajov pre overenie
// ---------------------------
app.get("/api/biometric/helper/:username", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username } = req.params;

  const row = await withSpan(
    {
      phase: "db",
      operation: "biometric_helper_lookup",
      trace_id,
      extra: { username },
    },
    async () => {
      return db
        .prepare(`
          SELECT bio_helper_index, bio_helper_data
          FROM users
          WHERE username=?
        `)
        .get(username) as
        | { bio_helper_index: number | null; bio_helper_data: string | null }
        | undefined;
    }
  );

  if (!row || row.bio_helper_index === null || !row.bio_helper_data) {
    return res.status(404).json({ error: "not_found" });
  }

  res.json({
    bio_helper_index: row.bio_helper_index,
    bio_helper_data: row.bio_helper_data,
  });
});

// Administrácia – zoznam používateľov
app.get("/api/admin/users", async (req, res) => {
  const trace_id = reqTraceId(req);

  // Dashboard načítava len prehľadový výber údajov potrebných pre
  // administratívny pohľad.
  const rows = await withSpan(
    {
      phase: "db",
      operation: "admin_list_users",
      trace_id,
    },
    async () => {
      return db.prepare(`
        SELECT username, userIdentifier,
               bio_key_hash,
               registrationRecord
        FROM users
      `).all();
    }
  );

  res.json(rows);
});

// ---------------------------
// Overenie biometrie
// ---------------------------
app.post("/api/verify/biometric", async (req, res) => {
  const trace_id = reqTraceId(req);
  const { username, bio_key_hash } = req.body;

  if (!username || !bio_key_hash) {
    return res.status(400).json({ error: "missing_fields" });
  }

  const row = await withSpan(
    {
      phase: "db",
      operation: "biometric_verify_load_hash",
      trace_id,
      extra: { username },
    },
    async () => {
      return db
        .prepare("SELECT bio_key_hash FROM users WHERE username = ?")
        .get(username) as { bio_key_hash: string | null } | undefined;
    }
  );

  if (!row || !row.bio_key_hash) {
    return res.status(404).json({ error: "no_biometric_registered" });
  }

  const ok = await withSpan(
    {
      phase: "biometric",
      operation: "biometric_verify_compare_hash",
      trace_id,
      extra: { username },
    },
    async () => row.bio_key_hash === bio_key_hash
  );

  if (!ok) {
    return res.status(401).json({ verified: false });
  }

  const token = await withSpan(
    {
      phase: "auth",
      operation: "issue_biometric_jwt",
      trace_id,
      extra: { username },
    },
    async () => createJwt(username)
  );

  res.json({ verified: true, token });
});

// ---------------------------
const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "0.0.0.0";

const certPath = process.env.TLS_CERT || path.join(process.cwd(), "tls", "cert.pem");
const keyPath  = process.env.TLS_KEY  || path.join(process.cwd(), "tls", "key.pem");

const options: https.ServerOptions = {
  cert: fs.readFileSync(certPath),
  key: fs.readFileSync(keyPath),

  // vynútenie TLS 1.3
  minVersion: "TLSv1.3",
  maxVersion: "TLSv1.3",
};
// Celý backend publikujeme cez HTTPS, aby boli chránené všetky volania
// medzi klientom, serverom a agentom.
https.createServer(options, app).listen(PORT, HOST, () => {
  console.log(`[OPAQUE] HTTPS (TLS1.3) server listening on ${HOST}:${PORT}`);
  if (HOST === "0.0.0.0") {
    console.log(`[OPAQUE] For LAN access use https://<raspberry-ip>:${PORT}`);
  }
});
