import React, { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";

// Dashboard si načítava údaje z backendu bežiaceho na rovnakej doméne.
const API = `${window.location.origin}/api`;

export default function Dashboard() {
  // Meno prihláseného používateľa zobrazujeme z lokálneho úložiska, pretože
  // po úspešnom prihlásení ho frontend uloží spolu s finálnym tokenom.
  const username = localStorage.getItem("username");
  const navigate = useNavigate();

  // Zoznam používateľov aj príznak načítania si držíme ako lokálny React stav,
  // keďže tieto údaje patria výlučne tejto obrazovke.
  const [users, setUsers] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // Funkcia načíta prehľad používateľov z backendu pre demonštračnú tabuľku
  // na dashboarde.
  async function loadUsers() {
    try {
      setLoading(true);
      const res = await fetch(`${API}/admin/users`);
      const data = await res.json();
      setUsers(data);
    } catch (err) {
      console.error("Fetch users failed:", err);
    } finally {
      setLoading(false);
    }
  }

  // Po prvom zobrazení stránky automaticky vyžiadame údaje z databázy.
  useEffect(() => {
    loadUsers();
  }, []);

  return (
    <div
      style={{
        fontFamily: "Inter, sans-serif",
        minHeight: "100vh",
        background: "linear-gradient(135deg, #1e293b, #0f172a)",
        color: "white",
        padding: "40px",
      }}
    >
      <h2 style={{ fontSize: 26, marginBottom: 20 }}>Firemný portál - Dashboard</h2>

      <p style={{ fontSize: 14, color: "#cbd5e1" }}>
        Vitaj, <strong>{username}</strong>
      </p>

      <button
        onClick={() => {
          // Odhlásenie odstráni všetky lokálne tokeny a používateľa vráti
          // späť na prihlasovaciu obrazovku.
          localStorage.clear();
          navigate("/");
        }}
        style={{
          marginTop: 10,
          marginBottom: 30,
          background: "#f87171",
          border: "none",
          padding: "8px 16px",
          color: "white",
          borderRadius: 6,
          cursor: "pointer",
          fontWeight: 500,
        }}
      >
        Odhlásiť sa
      </button>

      <h3 style={{ marginBottom: 10 }}>Používatelia v databáze</h3>

      {/* Počas komunikácie so serverom zobrazíme informatívny text namiesto
          prázdnej plochy, aby bolo zrejmé, že aplikácia práve načítava údaje. */}
      {loading && <p>Načítavam dáta...</p>}

      {!loading && users.length === 0 && (
        <p style={{ color: "#94a3b8" }}>V databáze sa zatiaľ nenachádzajú žiadni používatelia.</p>
      )}

      {!loading && users.length > 0 && (
        <table
          style={{
            width: "100%",
            borderCollapse: "collapse",
            background: "rgba(255,255,255,0.05)",
            borderRadius: 8,
          }}
        >
          <thead>
            <tr style={{ textAlign: "left", borderBottom: "1px solid rgba(255,255,255,0.2)" }}>
              <th style={{ padding: 8 }}>Používateľ</th>
              <th style={{ padding: 8 }}>User Identifier</th>
              <th style={{ padding: 8 }}>Hash biometrie</th>
              <th style={{ padding: 8 }}>OPAQUE credential</th>
            </tr>
          </thead>

          <tbody>
            {users.map((u) => (
              <tr key={u.username} style={{ borderBottom: "1px solid rgba(255,255,255,0.1)" }}>
                <td style={{ padding: 8 }}>{u.username}</td>

                {/* Dlhšie kryptografické reťazce skracujeme, aby ostala tabuľka
                    čitateľná aj pri väčšom počte záznamov. */}
                <td style={{ padding: 8, fontSize: 12, color: "#94a3b8" }}>
                  {u.userIdentifier}
                </td>

                <td style={{ padding: 8, fontSize: 12, color: "#94a3b8" }}>
                  {u.bio_key_hash ? u.bio_key_hash.substring(0, 12) + "..." : "-"}
                </td>

                <td style={{ padding: 8, fontSize: 12, color: "#94a3b8" }}>
                  {u.registrationRecord ? u.registrationRecord.substring(0, 12) + "..." : "-"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
