import base64
import importlib
import json
import sys

# Tento skript je lokálnou súčasťou samostatnej Raspberry Pi vetvy.
# Backend ho volá pri verifikácii ML-DSA podpisu, aby nemusel závisieť
# od helpera uloženého mimo priečinka `raspberry/server/`.
mldsa = importlib.import_module("pqcrypto.sign.ml_dsa_44")


def _b64(name: str, value: str) -> bytes:
    # Vstupné polia prichádzajú ako Base64 reťazce, preto ich ešte pred
    # samotnou verifikáciou dekódujeme na binárnu podobu.
    try:
        return base64.b64decode(value, validate=False)
    except Exception as exc:
        raise RuntimeError(f"base64_decode_failed:{name}:{exc}")


def main():
    try:
        # Server odovzdá vstup ako JSON cez štandardný vstup, aby bolo volanie
        # helpera jednoduché a nezávislé od shellových argumentov.
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

        # Rôzne implementácie knižnice môžu používať odlišné poradie parametrov.
        # Preto postupne skúšame známe varianty a pri prvom úspechu vraciame
        # serveru kladný výsledok.
        verify_variants = [
            (
                "verify(message, signature, public_key)",
                lambda: mldsa.verify(message, signature, public_key),
            ),
            (
                "verify(public_key, message, signature)",
                lambda: mldsa.verify(public_key, message, signature),
            ),
            (
                "verify(signature, message, public_key)",
                lambda: mldsa.verify(signature, message, public_key),
            ),
        ]

        for name, fn in verify_variants:
            try:
                fn()
                print(
                    json.dumps(
                        {
                            "ok": True,
                            "variant": name,
                            "len": {
                                "m": len(message),
                                "s": len(signature),
                                "pk": len(public_key),
                            },
                        }
                    )
                )
                return
            except Exception as exc:
                errors.append(f"{name}:{type(exc).__name__}:{exc}")

        print(
            json.dumps(
                {
                    "ok": False,
                    "error": "verify_failed",
                    "len": {
                        "m": len(message),
                        "s": len(signature),
                        "pk": len(public_key),
                    },
                    "tries": errors[:3],
                }
            )
        )
        return

    except Exception as exc:
        # Chybu vraciame vo forme JSON odpovede, aby backend dostal
        # čitateľnú diagnostiku vhodnú na logovanie aj ladenie.
        print(json.dumps({"ok": False, "error": "script_error", "details": str(exc)}))
        return


if __name__ == "__main__":
    main()
