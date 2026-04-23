import base64
import importlib
import json
import sys

# Verifikácia podpisu prebieha v samostatnom Python procese,
# aby server v Node.js vedel použiť knižnicu dostupnú iba v Pythone.
mldsa = importlib.import_module("pqcrypto.sign.ml_dsa_44")


def _b64(name: str, v: str) -> bytes:
    # Vstupné polia prichádzajú ako Base64 reťazce, preto ich na začiatku dekódujeme.
    try:
        return base64.b64decode(v, validate=False)
    except Exception as e:
        raise RuntimeError(f"base64_decode_failed:{name}:{e}")


def main():
    try:
        # Skript číta JSON zo štandardného vstupu, aby sa dal jednoducho volať zo servera.
        raw = sys.stdin.read()
        data = json.loads(raw)

        alg = data.get("alg")
        if alg != "ML-DSA-44":
            print(json.dumps({"ok": False, "error": "unsupported_alg"}))
            return

        message = _b64("message_b64", data["message_b64"])
        signature = _b64("signature_b64", data["signature_b64"])
        public_key = _b64("public_key_b64", data["public_key_b64"])

        errors = []

        # Rôzne implementácie knižníc môžu používať odlišné poradie parametrov,
        # preto postupne skúšame známe varianty a úspešný výsledok vrátime serveru.
        verify_variants = [
            ("verify(message, signature, public_key)", lambda: mldsa.verify(message, signature, public_key)),
            ("verify(public_key, message, signature)", lambda: mldsa.verify(public_key, message, signature)),
            ("verify(signature, message, public_key)", lambda: mldsa.verify(signature, message, public_key)),
        ]

        for name, fn in verify_variants:
            try:
                fn()
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "variant": name,
                            "len": {"m": len(message), "s": len(signature), "pk": len(public_key)},
                        }
                    )
                )
                return
            except Exception as e:
                errors.append(f"{name}:{type(e).__name__}:{e}")

        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "verify_failed",
                    "len": {"m": len(message), "s": len(signature), "pk": len(public_key)},
                    "tries": errors[:3],
                }
            )
        )
        return

    except Exception as e:
        # Chybu vraciame vo forme JSON odpovede, aby server dostal čitateľnú diagnostiku.
        print(json.dumps({"ok": False, "error": "script_error", "details": str(e)}))
        return


if __name__ == "__main__":
    main()
