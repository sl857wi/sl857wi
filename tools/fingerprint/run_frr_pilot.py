import argparse
import csv
import os
import sys
import time

# Skript slúži na interaktívne pilotné meranie FRR (False Rejection Rate).
# Operátor vždy prikladá správny prst a skript sleduje, pri akých prahoch
# systém používateľa mylne odmietne.
try:
    import requests
    import urllib3
except ModuleNotFoundError as e:
    missing_module = getattr(e, "name", "unknown")
    venv_python = os.path.join(os.path.dirname(__file__), ".venv", "Scripts", "python.exe")
    current_args = " ".join(sys.argv[1:])

    print(f"Chýba Python balík: {missing_module}")
    print("Skript bol pravdepodobne spustený mimo virtuálneho prostredia projektu.")

    if os.path.exists(venv_python):
        print("Odporúčané spustenie vo Windows:")
        print(f'{venv_python} run_frr_pilot.py {current_args}'.strip())
    else:
        print("Najprv vytvor a nainštaluj virtuálne prostredie v priečinku tools/fingerprint:")
        print(r"py -m venv .venv")
        print(r".venv\Scripts\python.exe -m pip install -r requirements.txt")

    sys.exit(1)

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

THRESHOLDS = [20, 30, 40]
ATTEMPTS_PER_THRESHOLD = 20
DEFAULT_OUTPUT = os.path.join(os.path.dirname(__file__), "frr_pilot_results.csv")


def save_results_csv(path: str, rows: list[dict]):
    # Súhrnné výsledky pilotu ukladáme do samostatného CSV, ktoré sa dá priamo
    # použiť pri spracovaní výsledkov alebo priložiť k technickej dokumentácii.
    with open(path, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(
            f,
            fieldnames=[
                "timestamp",
                "username",
                "port",
                "threshold",
                "attempt",
                "accepted",
                "score",
                "template_id",
                "error",
            ],
        )
        writer.writeheader()
        writer.writerows(rows)


def main():
    parser = argparse.ArgumentParser(description="Pilotné meranie FRR pre AS608.")
    parser.add_argument("--username", required=True, help="Používateľ, pre ktorého je zaregistrovaný odtlačok.")
    parser.add_argument("--port", required=True, help="Sériový port senzora, napríklad COM3.")
    parser.add_argument(
        "--agent-base",
        "--agent-url",
        dest="agent_base",
        default="https://127.0.0.1:5555",
        help="Základná adresa fingerprint agenta.",
    )
    parser.add_argument("--output", default=DEFAULT_OUTPUT, help="Cesta k výstupnému CSV súboru.")
    args = parser.parse_args()

    probe_url = f"{args.agent_base}/biometric/probe"
    rows: list[dict] = []

    for threshold in THRESHOLDS:
        print(f"\n=== Prah {threshold} ===")
        for attempt in range(1, ATTEMPTS_PER_THRESHOLD + 1):
            # Každý pokus je manuálne potvrdený obsluhou, aby bolo jasné,
            # že sa do merania započítal iba vedome vykonaný odtlačok.
            input(f"[{threshold}] Pokus {attempt}/{ATTEMPTS_PER_THRESHOLD}: Prilož správny prst a stlač Enter...")

            # Samotné overenie realizuje agent cez endpoint /biometric/probe,
            # takže skript zostáva tenký a iba orchestruje meranie.
            response = requests.post(
                probe_url,
                json={
                    "username": args.username,
                    "port": args.port,
                    "min_score": threshold,
                },
                timeout=30,
                verify=False,
            )
            response.raise_for_status()
            data = response.json()

            row = {
                "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S"),
                "username": data.get("username", args.username),
                "port": args.port,
                "threshold": threshold,
                "attempt": attempt,
                "accepted": data.get("accepted"),
                "score": data.get("score"),
                "template_id": data.get("templateId"),
                "error": data.get("error"),
            }
            rows.append(row)

            # Priebežný výpis pomáha obsluhe hneď vidieť, či bol pokus prijatý
            # a aké skóre zhody senzor vrátil.
            print(
                f"Výsledok: accepted={row['accepted']}, "
                f"score={row['score']}, template_id={row['template_id']}, error={row['error']}"
            )

    save_results_csv(args.output, rows)

    print("\n=== Súhrn FRR ===")
    for threshold in THRESHOLDS:
        # FRR počítame ako podiel odmietnutých pokusov pri použití správneho prsta.
        threshold_rows = [row for row in rows if row["threshold"] == threshold]
        total = len(threshold_rows)
        rejected = sum(1 for row in threshold_rows if not row["accepted"])
        frr = (rejected / total) if total else 0.0
        print(f"Prah {threshold}: rejected={rejected}, total={total}, FRR={frr:.4f}")

    print(f"\nVýsledky boli uložené do: {args.output}")


if __name__ == "__main__":
    main()
