# tools/fingerprint/agent.py
# Spustenie: python agent.py --host 127.0.0.1 --port 5555

import argparse
import base64
import csv
import importlib
import json
import os
import time
from typing import Any, Dict, Tuple

import requests
import urllib3
from Crypto.Cipher import AES
from Crypto.Random import get_random_bytes
from flask import Flask, jsonify, request
from flask_cors import CORS

from as608_ops import AS608, AS608Error
from metrics import get_trace_id_from_request, install_flask_request_metrics, span

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# PQC knižnicu importujeme dynamicky, aby bolo hneď vidno, akú konkrétnu implementáciu používame.
mldsa = importlib.import_module("pqcrypto.sign.ml_dsa_44")

API_BASE = os.environ.get("API_BASE", "https://127.0.0.1:4000/api")
FRONTEND_ORIGIN = os.environ.get("FRONTEND_ORIGIN", "https://127.0.0.1:5173")
SIG_ALG = "ML-DSA-44"

KEY_DIR = "pqc_keys"
DEVICE_MASTER_PATH = os.path.join(KEY_DIR, "device_master.key")
FP_DB_PATH = os.path.join(KEY_DIR, "fp_templates.json")
SIGN_COUNTER_PATH = os.path.join(KEY_DIR, "sign_counter.json")
PROBE_RESULTS_PATH = os.path.join(os.path.dirname(__file__), "biometric_probe_results.csv")


# -------------------------------
# Pomocné funkcie pre lokálne úložisko
# -------------------------------
def _ensure_dirs():
    os.makedirs(KEY_DIR, exist_ok=True)


def _load_json(path: str, default: Any) -> Any:
    if not os.path.exists(path):
        return default
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _save_json(path: str, obj: Any):
    # Zápis cez dočasný súbor znižuje riziko poškodenia dát pri neočakávanom prerušení procesu.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(obj, f, indent=2, ensure_ascii=False)
    os.replace(tmp, path)


def user_paths(username: str) -> Tuple[str, str, str]:
    """
    Vráti cesty k súborom konkrétneho používateľa:
    enc_priv = zašifrovaný súkromný kľúč
    enc_kek = zašifrovaný KEK kľúč
    pub = verejný kľúč
    """
    _ensure_dirs()
    enc_priv_path = os.path.join(KEY_DIR, f"{username}_priv.enc")
    enc_kek_path = os.path.join(KEY_DIR, f"{username}_kek.enc")
    pub_path = os.path.join(KEY_DIR, f"{username}_pub.key")
    return enc_priv_path, enc_kek_path, pub_path


def load_or_create_device_master_key() -> bytes:
    # Device master key je lokálny koreňový kľúč zariadenia, ktorý obaľuje KEK pre každého používateľa.
    _ensure_dirs()
    if os.path.exists(DEVICE_MASTER_PATH):
        with open(DEVICE_MASTER_PATH, "rb") as f:
            k = f.read()
        if len(k) != 32:
            raise RuntimeError("device_master_key_invalid_length")
        return k

    k = get_random_bytes(32)
    with open(DEVICE_MASTER_PATH, "wb") as f:
        f.write(k)
    return k


# -------------------------------
# Pomocné funkcie AES-256-GCM
# -------------------------------
def aead_encrypt(key32: bytes, plaintext: bytes, aad: bytes = b"") -> bytes:
    # Súkromný kľúč aj KEK ukladáme iba v šifrovanej podobe a viažeme ich na AAD kontext.
    if len(key32) != 32:
        raise ValueError("key32_invalid")
    nonce = get_random_bytes(12)
    cipher = AES.new(key32, AES.MODE_GCM, nonce=nonce)
    if aad:
        cipher.update(aad)
    ct, tag = cipher.encrypt_and_digest(plaintext)
    return nonce + tag + ct


def aead_decrypt(key32: bytes, blob: bytes, aad: bytes = b"") -> bytes:
    if len(key32) != 32:
        raise ValueError("key32_invalid")
    if blob is None or len(blob) < 12 + 16 + 1:
        raise ValueError("blob_invalid")
    nonce = blob[:12]
    tag = blob[12:28]
    ct = blob[28:]
    cipher = AES.new(key32, AES.MODE_GCM, nonce=nonce)
    if aad:
        cipher.update(aad)
    return cipher.decrypt_and_verify(ct, tag)


# -------------------------------
# Lokálna databáza šablón odtlačkov
# -------------------------------
def fp_db_load() -> Dict[str, Any]:
    # Agent si udržiava mapovanie používateľ -> template_id priamo v lokálnom JSON súbore.
    return _load_json(FP_DB_PATH, {"next_id": 1, "users": {}})


def fp_db_save(db: Dict[str, Any]):
    _save_json(FP_DB_PATH, db)


def fp_alloc_template_id(username: str) -> int:
    # Ak už má používateľ pridelené ID šablóny, vrátime pôvodné; inak pridelíme nové.
    db = fp_db_load()
    if username in db["users"]:
        return int(db["users"][username]["template_id"])

    tid = int(db.get("next_id", 1))
    db["users"][username] = {"template_id": tid, "created_at": int(time.time())}
    db["next_id"] = tid + 1
    fp_db_save(db)
    return tid


def fp_get_template_id(username: str) -> int:
    db = fp_db_load()
    u = db.get("users", {}).get(username)
    if not u:
        raise RuntimeError("missing_fingerprint_template")
    return int(u["template_id"])


def load_sign_counter(username: str) -> int:
    # Lokálne počítadlo podpisov pomáha napodobniť správanie bezpečného autentifikátora.
    db = _load_json(SIGN_COUNTER_PATH, {})
    return int(db.get(username, 0))


def save_sign_counter(username: str, val: int):
    db = _load_json(SIGN_COUNTER_PATH, {})
    db[username] = int(val)
    _save_json(SIGN_COUNTER_PATH, db)


def append_probe_result(
    *,
    username: str,
    threshold: int,
    accepted: bool,
    score: int | None,
    template_id: int | None,
    error: str | None,
):
    # Každý pilotný pokus zapisujeme do CSV, aby bolo možné spätne dopočítať FRR
    # a zároveň zachovať surové výsledky pre dokumentáciu a analýzu v práci.
    file_exists = os.path.exists(PROBE_RESULTS_PATH)
    with open(PROBE_RESULTS_PATH, "a", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "timestamp",
                "username",
                "threshold",
                "accepted",
                "score",
                "template_id",
                "error",
            ],
        )
        if not file_exists:
            writer.writeheader()
        writer.writerow(
            {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "username": username,
                "threshold": threshold,
                "accepted": accepted,
                "score": score,
                "template_id": template_id,
                "error": error,
            }
        )


# -------------------------------
# Flask aplikácia
# -------------------------------
app = Flask(__name__)
CORS(
    app,
    resources={
        r"/*": {
            "origins": [
                "https://localhost:5173",
                "https://localhost:4000",
                FRONTEND_ORIGIN,
            ]
        }
    },
)
install_flask_request_metrics(app)


@app.get("/health")
def health():
    # Jednoduchý healthcheck je užitočný pri lokálnom ladení a pri kontrole, či agent beží.
    trace_id = get_trace_id_from_request(request)
    return jsonify({"ok": True, "trace_id": trace_id})


@app.route("/biometric/probe", methods=["POST"])
def biometric_probe():
    trace_id = get_trace_id_from_request(request)
    data = request.get_json(force=True)

    username = data.get("username")
    port = data.get("port")
    min_score_raw = data.get("min_score")

    if not username:
        return jsonify({"ok": False, "error": "missing_username"}), 400
    if not port:
        return jsonify({"ok": False, "error": "missing_port"}), 400
    if min_score_raw is None:
        return jsonify({"ok": False, "error": "missing_min_score"}), 400

    try:
        min_score = int(min_score_raw)
    except Exception:
        return jsonify({"ok": False, "error": "invalid_min_score"}), 400

    accepted = False
    score = None
    template_id = None
    error = None

    try:
        with span("biometric", "fp_probe_lookup_template_id", trace_id=trace_id, extra={"username": username}):
            template_id = fp_get_template_id(username)

        with span(
            "biometric",
            "fp_probe_verify_sensor",
            trace_id=trace_id,
            extra={"username": username, "port": port, "template_id": template_id, "threshold": min_score},
        ):
            sensor = AS608(port=port, baud=57600, timeout=0.6)
            try:
                res = sensor.verify_matches(expected_template_id=template_id, capture_timeout_s=6.0)
                score = int(res.score)
                template_id = int(res.template_id)
                accepted = score >= min_score
            finally:
                sensor.close()
    except AS608Error as e:
        error = str(e)
    except Exception as e:
        error = str(e)

    append_probe_result(
        username=username,
        threshold=min_score,
        accepted=accepted,
        score=score,
        template_id=template_id,
        error=error,
    )

    return jsonify(
        {
            "ok": True,
            "username": username,
            "threshold": min_score,
            "accepted": accepted,
            "score": score,
            "templateId": template_id,
            "error": error,
        }
    )


@app.route("/pqc/register", methods=["POST"])
def pqc_register():
    # Tento endpoint robí lokálnu registráciu zariadenia: odtlačok + PQC kľúče + zápis public key na server.
    trace_id = get_trace_id_from_request(request)
    auth_header = request.headers.get("Authorization", "")
    data = request.get_json(force=True)
    username = data.get("username")
    port = data.get("port")
    reg_token = data.get("regToken")

    if not reg_token or not isinstance(reg_token, str):
        return jsonify({"error": "missing_reg_token"}), 400
    if not username:
        return jsonify({"error": "missing_username"}), 400
    if not port:
        return jsonify({"error": "missing_port"}), 400

    enc_priv_path, enc_kek_path, pub_path = user_paths(username)

    with span("register", "fp_alloc_template_id", trace_id=trace_id, extra={"username": username}):
        template_id = fp_alloc_template_id(username)

    try:
        # Najprv zaregistrujeme odtlačok do senzora AS608 a zviažeme ho s lokálnym template_id.
        with span(
            "biometric",
            "fp_enroll_sensor",
            trace_id=trace_id,
            extra={"username": username, "port": port, "template_id": template_id},
        ):
            sensor = AS608(port=port, baud=57600, timeout=0.6)
            try:
                sensor.enroll(template_id=template_id, capture_timeout_s=10.0)
            finally:
                sensor.close()
    except AS608Error as e:
        return jsonify({"error": "fp_enroll_failed", "details": str(e)}), 500

    # Po úspešnej biometrickej registrácii agent vygeneruje PQC pár kľúčov.
    with span("crypto", "mldsa_keygen", trace_id=trace_id, extra={"username": username, "algorithm": SIG_ALG}):
        public_key, secret_key = mldsa.generate_keypair()

    if not isinstance(public_key, (bytes, bytearray)) or not isinstance(secret_key, (bytes, bytearray)):
        return jsonify({"error": "pqc_keygen_failed", "details": "keys_not_bytes"}), 500

    if len(secret_key) != 2560:
        return jsonify({"error": "pqc_keygen_failed", "details": f"secret_key_len={len(secret_key)}"}), 500

    # Verejný kľúč nie je tajný, preto ho môžeme uložiť samostatne aj v čitateľnej podobe.
    with span("storage", "write_public_key_file", trace_id=trace_id, extra={"username": username, "pub_path": pub_path}):
        with open(pub_path, "wb") as f:
            f.write(public_key)

    # Súkromný kľúč šifrujeme cez náhodný KEK a ten zase šifrujeme device master kľúčom.
    with span("crypto", "encrypt_private_key_and_kek", trace_id=trace_id, extra={"username": username}):
        device_master = load_or_create_device_master_key()
        kek = get_random_bytes(32)

        enc_priv = aead_encrypt(kek, secret_key, aad=username.encode("utf-8"))
        enc_kek = aead_encrypt(device_master, kek, aad=b"KEK|" + username.encode("utf-8"))

    def _atomic_write(path: str, data: bytes):
        tmp = path + ".tmp"
        with open(tmp, "wb") as f:
            f.write(data)
        os.replace(tmp, path)

    with span(
        "storage",
        "store_encrypted_materials",
        trace_id=trace_id,
        extra={
            "username": username,
            "enc_priv_path": enc_priv_path,
            "enc_kek_path": enc_kek_path,
            "pub_path": pub_path,
        },
    ):
        _atomic_write(enc_priv_path, enc_priv)
        _atomic_write(enc_kek_path, enc_kek)
        _atomic_write(pub_path, public_key)

    try:
        # Samotest overí, že sa šifrovaný materiál dá bezprostredne po zápise korektne dešifrovať.
        with span("crypto", "self_test_decrypt", trace_id=trace_id, extra={"username": username}):
            kek2 = aead_decrypt(device_master, enc_kek, aad=b"KEK|" + username.encode("utf-8"))
            sk2 = aead_decrypt(kek2, enc_priv, aad=username.encode("utf-8"))
            if sk2 != secret_key:
                return jsonify({"error": "self_test_failed"}), 500
    except Exception as e:
        return jsonify({"error": "self_test_failed", "details": str(e)}), 500

    # Na záver pošleme verejný PQC kľúč na backend, aby ho server vedel použiť pri overení podpisu.
    with span(
        "network",
        "backend_register_public_key",
        trace_id=trace_id,
        extra={"username": username, "api": f"{API_BASE}/pqc/register"},
    ):
        r = requests.post(
            f"{API_BASE}/pqc/register",
            headers={
                "Authorization": auth_header,
                "Content-Type": "application/json",
                "X-Trace-Id": trace_id,
            },
            json={
                "username": username,
                "pqcPublicKey": base64.b64encode(public_key).decode("ascii"),
                "algorithm": SIG_ALG,
            },
            timeout=20,
            verify=False,
        )

    if r.status_code != 200:
        try:
            with span("network", "backend_register_public_key_parse_error", trace_id=trace_id, extra={"username": username}):
                details = r.json()
        except Exception:
            details = {"text": r.text}
        return jsonify({"error": "server_register_failed", "details": details}), 500

    return jsonify(
        {
            "ok": True,
            "msg": "PQC keys generated; private key gated by AS608 fingerprint match",
            "templateId": template_id,
            "trace_id": trace_id,
        }
    )


@app.route("/pqc/sign", methods=["POST"])
def pqc_sign():
    import hashlib

    # Podpisovanie slúži ako druhý faktor: agent najprv overí odtlačok a až potom odomkne súkromný kľúč.
    trace_id = get_trace_id_from_request(request)
    data = request.get_json(force=True)

    username = data.get("username")
    port = data.get("port")
    challenge_b64 = data.get("challenge")

    rp_id = data.get("rp_id", "opaque-server")
    origin = data.get("origin", "")

    if not username or not challenge_b64:
        return jsonify({"error": "missing_fields"}), 400
    if not port:
        return jsonify({"error": "missing_port"}), 400

    enc_priv_path, enc_kek_path, _ = user_paths(username)
    if not os.path.exists(enc_priv_path) or not os.path.exists(enc_kek_path):
        return jsonify({"error": "missing_keys"}), 400

    try:
        with span(
            "network",
            "challenge_decode",
            trace_id=trace_id,
            extra={"username": username, "challenge_b64_len": len(challenge_b64)},
        ):
            challenge = base64.b64decode(challenge_b64)
    except Exception:
        return jsonify({"error": "challenge_decode_failed"}), 400

    if len(challenge) < 16:
        return jsonify({"error": "challenge_invalid", "details": f"challenge_len={len(challenge)}"}), 400

    try:
        with span("biometric", "fp_lookup_template_id", trace_id=trace_id, extra={"username": username}):
            template_id = fp_get_template_id(username)
    except Exception as e:
        return jsonify({"error": "missing_fingerprint_template", "details": str(e)}), 400

    try:
        # Senzor potvrdí, že aktuálny odtlačok patrí tomu istému používateľovi, ktorý má prístup ku kľúču.
        with span(
            "biometric",
            "fp_verify_sensor",
            trace_id=trace_id,
            extra={"username": username, "port": port, "template_id": template_id},
        ):
            sensor = AS608(port=port, baud=57600, timeout=0.6)
            try:
                res = sensor.verify_matches(expected_template_id=template_id, capture_timeout_s=6.0)
                min_score = 30
                if res.score < min_score:
                    return jsonify({"error": "fp_verify_failed", "details": f"low_score:{res.score}"}), 401
            finally:
                sensor.close()
    except AS608Error as e:
        return jsonify({"error": "fp_verify_failed", "details": str(e)}), 401

    with span("storage", "load_encrypted_key_files", trace_id=trace_id, extra={"username": username}):
        device_master = load_or_create_device_master_key()
        with open(enc_kek_path, "rb") as f:
            enc_kek = f.read()
        with open(enc_priv_path, "rb") as f:
            enc_priv = f.read()

    try:
        # Ak biometria vyšla, odomkneme KEK a cez neho aj súkromný PQC kľúč.
        with span("crypto", "decrypt_kek_and_secret_key", trace_id=trace_id, extra={"username": username}):
            kek = aead_decrypt(device_master, enc_kek, aad=b"KEK|" + username.encode("utf-8"))
            secret_key = aead_decrypt(kek, enc_priv, aad=username.encode("utf-8"))
            if len(secret_key) != 2560:
                return jsonify({"error": "decrypt_failed", "details": f"secret_key_len={len(secret_key)}"}), 401
    except Exception as e:
        return jsonify({"error": "decrypt_failed", "details": str(e)}), 401

    with span("security", "load_sign_counter", trace_id=trace_id, extra={"username": username}):
        prev_sign_count = load_sign_counter(username)

    sign_count = prev_sign_count + 1

    with span(
        "security",
        "save_sign_counter",
        trace_id=trace_id,
        extra={"username": username, "prev_sign_count": prev_sign_count, "new_sign_count": sign_count},
    ):
        save_sign_counter(username, sign_count)

    # Payload je zostavený podobne ako pri autentifikátoroch typu WebAuthn:
    # nesie challenge, pôvod, používateľa aj monotónne rastúci čítač.
    with span("crypto", "build_payload_and_hash", trace_id=trace_id, extra={"username": username, "rp_id": rp_id}):
        payload = {
            "challenge": challenge_b64,
            "rp_id": rp_id,
            "origin": origin,
            "username": username,
            "signCount": sign_count,
            "uv": True,
            "ts": int(time.time()),
        }

        msg = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode("utf-8")
        msg_hash = hashlib.sha256(msg).digest()

    try:
        with span("crypto", "mldsa_sign", trace_id=trace_id, extra={"username": username, "algorithm": SIG_ALG}):
            signature = mldsa.sign(secret_key, msg_hash)
    except Exception as e:
        return jsonify({"error": "sign_failed", "details": str(e)}), 500

    return jsonify(
        {
            "ok": True,
            "payload": payload,
            "signature": base64.b64encode(signature).decode("ascii"),
            "algorithm": SIG_ALG,
            "fpScore": res.score,
            "templateId": res.template_id,
            "trace_id": trace_id,
        }
    )


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=5555)
    args = ap.parse_args()

    # Agent beží cez HTTPS, aby jeho API bolo dostupné bez konfliktu s bezpečnostnými pravidlami prehliadača.
    app.run(
        host=args.host,
        port=args.port,
        ssl_context=("tls/cert.pem", "tls/key.pem"),
    )
