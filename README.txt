README projektu
===============

Toto je demonštračný projekt viacfaktorového prihlasovania pre webový
portál. Prihlasovanie kombinuje:

- heslo spracované cez OPAQUE,
- zariadenie s lokálne uloženým kľúčom ML-DSA-44,
- biometrické overenie cez senzor odtlačku prsta AS608,
- HTTPS komunikáciu medzi frontendom, backendom a lokálnym agentom.


Čo je v projekte
================

Najdôležitejšie priečinky a súbory:

- `client/`
  frontend v Reacte a TypeScripte.

- `server/`
  backend v Node.js a Express, SQLite databáza a logika autentizácie.

- `tools/fingerprint/`
  lokálny agent pre senzor AS608, správu PQC kľúčov a podpisovanie
  challenge.

- `tools/pqc_verify.py`
  Python skript, ktorý backend používa na verifikáciu ML-DSA podpisu.

- `raspberry/`
  samostatný balík pre Raspberry Pi 5 na strane servera.
  Tento priečinok môžeš skopírovať na Raspberry Pi bez zvyšku projektu.
  Podrobný návod je v `raspberry/README_raspberry.txt`.


Čo v čistom stave chýba
=======================

Repozitár zámerne neobsahuje súbory, ktoré vznikajú až po inštalácii
alebo pri behu:

- `client/node_modules/`
- `client/dist/`
- `server/node_modules/`
- `server/logs/`
- `server/users.db`
- `server/server_setup.txt`
- `tools/fingerprint/.venv/`
- `tools/fingerprint/logs/`
- `tools/fingerprint/pqc_keys/`
- `raspberry/client/node_modules/`
- `raspberry/client/dist/`
- `raspberry/server/node_modules/`
- `raspberry/server/.venv/`
- `raspberry/server/logs/`
- `raspberry/server/users.db`
- `raspberry/server/server_setup.txt`

Tieto priečinky a súbory sa vytvoria až po `npm install`, po vytvorení
Python prostredia alebo po prvom spustení projektu.


Požiadavky
==========

Na lokálnu reprodukciu potrebuješ:

- Node.js 20 alebo novší,
- `npm`,
- Python 3.11 alebo 3.12,
- Windows, ak chceš používať senzor AS608 cez lokálneho agenta,
- pripojený senzor AS608 a správny sériový port, napríklad `COM3`,
- internet pri prvom sťahovaní balíkov.

Projekt obsahuje vlastné lokálne TLS súbory v priečinkoch
`server/tls/` a `tools/fingerprint/tls/`. Pri prvom otvorení môže byť
potrebné potvrdiť výnimku v prehliadači.

Ak PowerShell blokuje `npm`, použi `npm.cmd`.


Rýchly štart na jednom počítači
===============================

Toto je hlavný scenár, v ktorom frontend, backend, agent aj senzor
bežia na jednom počítači.

1. Nainštaluj backend:

   cd server
   npm install

2. Nainštaluj frontend:

   cd client
   npm install

3. Priprav lokálneho agenta:

   cd tools/fingerprint
   py -m venv .venv
   .venv\Scripts\python.exe -m pip install -r requirements.txt

4. Spusti backend:

   cd server
   npm run dev

   Backend bude štandardne dostupný na:
   `https://127.0.0.1:4000`

5. Spusti agenta:

   cd tools/fingerprint
   .venv\Scripts\python.exe agent.py --host 127.0.0.1 --port 5555

   Agent bude štandardne dostupný na:
   `https://127.0.0.1:5555`

6. Spusti frontend:

   cd client
   npm run dev

   Frontend bude štandardne dostupný na:
   `https://127.0.0.1:5173`

7. Pri prvom otvorení potvrď bezpečnostnú výnimku pre adresy:

   `https://127.0.0.1:5173`
   `https://127.0.0.1:4000`
   `https://127.0.0.1:5555`


Ako prebieha prihlasovanie
==========================

1. Používateľ sa zaregistruje cez OPAQUE.
2. Lokálny agent zaregistruje odtlačok prsta a vytvorí PQC kľúče.
3. Verejný kľúč sa uloží na server.
4. Pri prihlásení backend najprv overí heslo.
5. Backend vydá jednorazovú challenge.
6. Agent po úspešnom odtlačku challenge podpíše.
7. Backend podpis overí a vydá finálny JWT token.

Súkromný podpisový kľúč zostáva len na používateľskom zariadení.


Kde vznikajú dáta počas behu
============================

Pri práci so systémom sa vytvárajú hlavne tieto súbory:

- `server/users.db`
  SQLite databáza používateľov a challenge záznamov.

- `server/server_setup.txt`
  perzistentné nastavenie OPAQUE servera.

- `server/logs/metrics.server.jsonl`
  serverové prevádzkové metriky.

- `tools/fingerprint/logs/metrics.agent.jsonl`
  metriky lokálneho agenta.

- `tools/fingerprint/pqc_keys/`
  lokálne šifrované súkromné kľúče, mapovanie šablón
  a čítače podpisov.


Najčastejšie problémy
=====================

- Chýba `node_modules/`
  Spusť `npm install` v príslušnom priečinku.

- Agent sa nespustí
  Skontroluj Python, virtuálne prostredie a súbor `requirements.txt`.

- Prehliadač blokuje spojenie
  Potvrď výnimku pre lokálne HTTPS certifikáty.

- Senzor nereaguje
  Skontroluj fyzické pripojenie a správny port, napríklad `COM3`.

- Overenie podpisu zlyhá
  Skontroluj, či má backend dostupný Python a knižnicu `pqcrypto`.


Raspberry Pi varianta
=====================

Ak chceš serverovú časť presunúť na Raspberry Pi 5, použi priečinok
`raspberry/`. Je pripravený ako samostatná jednotka pre Raspberry Pi na
strane backendu a frontendu. Postup nájdeš v:

`raspberry/README_raspberry.txt`


Ďalšia dokumentácia
===================

Podrobnejší technický opis je aj v súboroch:

- `priloha-a.tex`
- `system-manual.tex`
- `user-manul.tex`
