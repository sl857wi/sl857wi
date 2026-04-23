import React, { useState } from "react";
import * as opaque from "@serenity-kit/opaque";
import { useNavigate } from "react-router-dom";

// Backend v raspberry topológii zabezpečuje OPAQUE autentizáciu, serverové
// API aj finálne overenie PQC podpisu.
const API = import.meta.env.VITE_API_BASE || "/api";

// V tejto topológii sa frontend otvára z Raspberry Pi, ale prehliadač beží
// na tom istom PC ako lokálny agent, preto agent zostáva na 127.0.0.1.
const AGENT = import.meta.env.VITE_AGENT_BASE || "https://127.0.0.1:5555";

export default function Login() {
  // Formulárové hodnoty a pomocné UI stavy sú lokálne pre tento komponent.
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [serialPort, setSerialPort] = useState("COM3");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const navigate = useNavigate();

  // Spinner prekryje obrazovku počas dlhších operácií, najmä pri práci so
  // senzorom, pri OPAQUE výpočte alebo pri čakaní na backend.
  const Spinner = () => (
    <div
      style={{
        position: "fixed",
        top: 0,
        left: 0,
        width: "100vw",
        height: "100vh",
        background: "rgba(255,255,255,0.6)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        backdropFilter: "blur(3px)",
        zIndex: 9999,
      }}
    >
      <div
        style={{
          width: 60,
          height: 60,
          border: "6px solid #d1d5db",
          borderTopColor: "#1e3a8a",
          borderRadius: "50%",
          animation: "spin 0.8s linear infinite",
        }}
      />
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );

  // Prvá fáza registrácie uloží OPAQUE registračný záznam hesla a vydá
  // krátkodobý token potrebný pre lokálnu registráciu zariadenia.
  async function registerFlow() {
    setLoading(true);
    setMsg("Prebieha registrácia...");

    try {
      if (!username || !password) {
        setMsg("Zadaj používateľa a heslo.");
        return;
      }

      await opaque.ready;

      // Klient vytvorí registračnú správu bez odosielania hesla v otvorenej
      // forme do siete.
      const { clientRegistrationState, registrationRequest } =
        opaque.client.startRegistration({ password });

      const startRes = await fetch(`${API}/register/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, registrationRequest }),
      }).then((r) => r.json());

      if (!startRes?.registrationResponse) {
        setMsg("Registrácia zlyhala v úvodnom kroku.");
        return;
      }

      // Na základe odpovede servera klient dokončí svoju časť OPAQUE
      // registrácie a pripraví finálny registračný záznam.
      const { registrationRecord } = opaque.client.finishRegistration({
        clientRegistrationState,
        registrationResponse: startRes.registrationResponse,
        password,
      });

      const finishRes = await fetch(`${API}/register/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, registrationRecord }),
      }).then((r) => r.json());

      if (finishRes?.ok) {
        if (finishRes?.regToken) {
          localStorage.setItem("regToken", finishRes.regToken);
        }
        setMsg("Registrácia hesla prebehla úspešne. Pokračuj registráciou zariadenia.");
      } else {
        setMsg("Registrácia zlyhala pri ukladaní záznamu.");
      }
    } catch (e: any) {
      setMsg(`Chyba registrácie: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Druhá fáza registrácie prebieha priamo v lokálnom agente na PC
  // používateľa. Agent zaregistruje odtlačok, vygeneruje PQC kľúče a
  // odošle verejný kľúč serveru bežiacemu na Raspberry Pi.
  async function registerDeviceFlow() {
    setLoading(true);
    setMsg("Registrujem zariadenie, prilož prst...");

    try {
      if (!username) {
        setMsg("Zadaj používateľa.");
        return;
      }

      const regToken = localStorage.getItem("regToken");
      if (!regToken) {
        setMsg("Chýba registračný token. Najprv dokonči registráciu hesla.");
        return;
      }

      const r = await fetch(`${AGENT}/pqc/register`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${regToken}`,
        },
        body: JSON.stringify({
          username,
          port: serialPort,
          regToken,
        }),
      });

      const j = await r.json();

      if (!r.ok || !j?.ok) {
        setMsg(
          j?.error
            ? `Registrácia zariadenia zlyhala: ${j.error}`
            : "Registrácia zariadenia zlyhala."
        );
        return;
      }

      setMsg("Zariadenie bolo úspešne zaregistrované. Teraz sa môžeš prihlásiť.");
    } catch (e: any) {
      setMsg(`Chyba registrácie zariadenia: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Prihlásenie je dvojstupňové. Najprv sa overí heslo cez OPAQUE a následne
  // lokálny agent podpíše challenge po úspešnom overení odtlačku.
  async function loginFlow() {
    setLoading(true);
    setMsg("Prebieha prihlásenie...");

    try {
      if (!username || !password) {
        setMsg("Zadaj používateľa a heslo.");
        return;
      }

      await opaque.ready;

      const { clientLoginState, startLoginRequest } =
        opaque.client.startLogin({ password });

      const startRes = await fetch(`${API}/login/start`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, startLoginRequest }),
      }).then((r) => r.json());

      if (!startRes?.loginResponse) {
        setMsg("Prihlásenie zlyhalo v úvodnom kroku.");
        return;
      }

      const result = opaque.client.finishLogin({
        clientLoginState,
        loginResponse: startRes.loginResponse,
        password,
      });

      if (!result) {
        setMsg("Prihlásenie zlyhalo pri klientskom dokončení OPAQUE.");
        return;
      }

      const { finishLoginRequest, sessionKey } = result;

      const finishRes = await fetch(`${API}/login/finish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, finishLoginRequest }),
      }).then((r) => r.json());

      if (!finishRes?.sessionKey) {
        setMsg("Prihlásenie zlyhalo pri serverovom dokončení OPAQUE.");
        return;
      }

      // Zhoda session key potvrdzuje, že klient aj server vypočítali rovnaký
      // výsledok protokolu.
      if (finishRes.sessionKey !== sessionKey) {
        setMsg("Nezhoduje sa odvodený session key.");
        return;
      }

      const pre2faToken = finishRes?.pre2faToken as string | undefined;
      if (!pre2faToken) {
        setMsg("Server nevrátil token pre druhý faktor.");
        return;
      }

      setMsg("Heslo bolo overené. Pokračujem overením odtlačku a PQC podpisom.");

      // Backend vydá challenge, ktorú musí lokálny agent na PC podpísať po
      // biometrickom overení.
      const chRes = await fetch(`${API}/pqc/challenge`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pre2faToken}`,
        },
        body: JSON.stringify({}),
      }).then((r) => r.json());

      if (!chRes?.challengeId || !chRes?.challenge) {
        setMsg("Nepodarilo sa získať challenge pre druhý faktor.");
        return;
      }

      // Agent overí odtlačok a až potom vytvorí podpis lokálnym
      // postkvantovým súkromným kľúčom.
      const signRes = await fetch(`${AGENT}/pqc/sign`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          port: serialPort,
          challenge: chRes.challenge,
          rp_id: "opaque-server",
          origin: window.location.origin,
        }),
      }).then((r) => r.json());

      if (!signRes?.ok || !signRes?.payload || !signRes?.signature) {
        setMsg("Lokálny agent nedokázal vytvoriť podpis.");
        return;
      }

      const payload = signRes.payload;
      const signature = signRes.signature;

      // Server overí konzistenciu payloadu, rast čítača podpisov aj samotný
      // PQC podpis.
      const vRes = await fetch(`${API}/pqc/verify`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${pre2faToken}`,
        },
        body: JSON.stringify({
          challengeId: chRes.challengeId,
          payload,
          signature,
        }),
      }).then((r) => r.json());

      if (!vRes?.ok || !vRes?.token) {
        setMsg(
          vRes?.error
            ? `Overenie druhého faktora zlyhalo: ${vRes.error}`
            : "Overenie druhého faktora zlyhalo."
        );
        return;
      }

      localStorage.setItem("token", vRes.token);
      localStorage.setItem("username", username);
      navigate("/dashboard");
    } catch (e: any) {
      setMsg(`Chyba prihlásenia: ${String(e?.message || e)}`);
    } finally {
      setLoading(false);
    }
  }

  // Komponent zámerne zhŕňa celý demonštračný tok registrácie aj prihlásenia,
  // aby bol sieťový scenár s Raspberry Pi ľahko čitateľný v jednom súbore.
  return (
    <div
      style={{
        fontFamily: "Inter, sans-serif",
        minHeight: "100vh",
        background: "linear-gradient(135deg, #2563eb, #1e3a8a)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {loading && <Spinner />}

      <div
        style={{
          background: "white",
          borderRadius: "16px",
          boxShadow: "0 0 20px rgba(0,0,0,0.15)",
          width: "100%",
          maxWidth: 420,
          padding: 40,
        }}
      >
        <h2 style={{ textAlign: "center", marginBottom: 20, color: "#1e3a8a" }}>
          Firemný portál
        </h2>

        <label style={{ fontWeight: 500 }}>Používateľ</label>
        <input
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            marginTop: 5,
            marginBottom: 15,
            border: "1px solid #cbd5e1",
            borderRadius: 6,
          }}
        />

        <label style={{ fontWeight: 500 }}>Heslo</label>
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            marginTop: 5,
            marginBottom: 15,
            border: "1px solid #cbd5e1",
            borderRadius: 6,
          }}
        />

        {/* Sériový port určuje, na ktorom rozhraní je pripojený senzor AS608
            lokálneho používateľského počítača. */}
        <label style={{ fontWeight: 500 }}>Port senzora (AS608)</label>
        <input
          value={serialPort}
          onChange={(e) => setSerialPort(e.target.value)}
          style={{
            width: "100%",
            padding: 10,
            marginTop: 5,
            marginBottom: 25,
            border: "1px solid #cbd5e1",
            borderRadius: 6,
          }}
        />

        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <button
            onClick={registerFlow}
            style={{
              flex: 1,
              background: "#3b82f6",
              border: "none",
              padding: "10px 16px",
              color: "white",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Registrovať
          </button>

          <button
            onClick={loginFlow}
            style={{
              flex: 1,
              background: "#1e3a8a",
              border: "none",
              padding: "10px 16px",
              color: "white",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 500,
            }}
          >
            Prihlásiť
          </button>
        </div>

        <button
          onClick={registerDeviceFlow}
          style={{
            width: "100%",
            background: "#2563eb",
            color: "white",
            border: "none",
            padding: "10px 16px",
            borderRadius: 6,
            cursor: "pointer",
            fontWeight: 500,
            marginTop: 10,
          }}
        >
          Registrácia zariadenia (PQC + odtlačok)
        </button>

        {/* Stavová správa používateľovi vysvetľuje priebeh sieťového scenára
            a jednotlivé kroky autentifikácie. */}
        {msg && (
          <div
            style={{
              marginTop: 20,
              background: "#f1f5f9",
              borderRadius: 6,
              padding: 10,
              fontSize: 13,
              color: "#1e3a8a",
              whiteSpace: "pre-wrap",
            }}
          >
            {msg}
          </div>
        )}
      </div>
    </div>
  );
}
