README pre Raspberry Pi 5
=========================

Tento priečinok je pripravený ako samostatný balík pre Raspberry Pi 5
na strane servera. Môžeš skopírovať iba `raspberry/` na Raspberry Pi,
nainštalovať závislosti podľa tohto návodu a spustiť backend aj
frontend bez zvyšku hlavného projektu.

Tento balík rieši serverovú stranu. Používateľský počítač stále
potrebuje lokálneho agenta z hlavného projektu, pretože:

- senzor je pripojený k používateľskému počítaču,
- súkromný podpisový kľúč zostáva len na používateľskom počítači,
- webová aplikácia komunikuje s agentom cez `https://127.0.0.1:5555`.


Čo je v tomto priečinku
=======================

- `client/`
  frontend pre sieťový scenár s Raspberry Pi.

- `server/`
  backend pre Raspberry Pi.

- `server/tools/pqc_verify.py`
  lokálna kópia Python skriptu na verifikáciu ML-DSA podpisu.

- `server/tools/requirements.txt`
  minimálne Python závislosti potrebné pre verifikáciu podpisu.

Vďaka tomu priečinok `raspberry/` nepotrebuje na Raspberry Pi žiadny
ďalší Python helper z koreňa projektu.


Ako tento scenár funguje
========================

Rozdelenie rolí je takéto:

- Raspberry Pi 5 hostuje backend.
- Raspberry Pi 5 môže hostovať aj zostavený frontend.
- Používateľský počítač otvára webovú aplikáciu cez sieť.
- Na používateľskom počítači beží lokálny agent.
- Senzor AS608 je pripojený k používateľskému počítaču.

Najdôležitejší detail je tento:

- volania na `/api` idú na Raspberry Pi,
- volania na `https://127.0.0.1:5555` idú stále na používateľský
  počítač, pretože `127.0.0.1` vždy znamená lokálny počítač
  používateľa.


Čo v čistom stave chýba
=======================

Po prenose priečinka `raspberry/` ešte nebudú existovať:

- `client/node_modules/`
- `client/dist/`
- `server/node_modules/`
- `server/.venv/`
- `server/logs/`
- `server/users.db`
- `server/server_setup.txt`

Tieto súbory vzniknú až po inštalácii a prvom spustení.


Požiadavky na Raspberry Pi
==========================

Na Raspberry Pi 5 potrebuješ:

- Node.js 20 alebo novší,
- `npm`,
- Python 3.11 alebo 3.12,
- prístup k lokálnej sieti,
- voľný port pre backend, štandardne `4000`.


Požiadavky na používateľský počítač
===================================

Na počítači používateľa potrebuješ:

- kópiu priečinka `tools/fingerprint/` z hlavného projektu,
- Python 3.11 alebo 3.12,
- Windows prostredie, ak používaš AS608 cez COM port,
- vytvorené virtuálne prostredie pre agenta,
- pripojený senzor AS608,
- správny port senzora, napríklad `COM3`.


Postup na Raspberry Pi
======================

1. Skopíruj priečinok `raspberry/` na Raspberry Pi.

2. Nainštaluj Node.js závislosti backendu:

   cd raspberry/server
   npm install

3. Vytvor Python prostredie pre verifikáciu podpisu:

   cd raspberry/server
   python3 -m venv .venv
   .venv/bin/python -m pip install -r tools/requirements.txt

4. Nainštaluj Node.js závislosti frontendu:

   cd raspberry/client
   npm install

5. Odporúčaný postup je vytvoriť build frontendu:

   cd raspberry/client
   npm run build

   Build sa uloží do `raspberry/client/dist` a backend ho potom vie
   obslúžiť na tej istej HTTPS adrese.

6. Spusti backend:

   cd raspberry/server
   npm run dev

   Server býva dostupný na:
   `https://<raspberry-ip>:4000`


Postup na používateľskom počítači
=================================

Na počítači so senzorom priprav a spusti lokálneho agenta z hlavného
projektu:

1. Prejdi do priečinka agenta:

   cd tools\fingerprint

2. Vytvor virtuálne prostredie:

   py -m venv .venv

3. Nainštaluj závislosti:

   .venv\Scripts\python.exe -m pip install -r requirements.txt

4. Spusti agenta:

   .venv\Scripts\python.exe agent.py --host 127.0.0.1 --port 5555

   Agent bude dostupný na:
   `https://127.0.0.1:5555`


Ako otestovať celý tok
======================

1. Na Raspberry Pi musí bežať backend.
2. Na používateľskom počítači musí bežať agent.
3. V prehliadači na používateľskom počítači otvor:

   `https://<raspberry-ip>:4000`

4. Pri prvom otvorení potvrď HTTPS výnimku pre:

   `https://<raspberry-ip>:4000`
   `https://127.0.0.1:5555`

5. Potom môže používateľ:

   - zaregistrovať meno a heslo,
   - zaregistrovať zariadenie a odtlačok prsta,
   - prihlásiť sa heslom,
   - potvrdiť druhý faktor odtlačkom prsta.


Čo je iné oproti hlavnej vetve
==============================

- Backend v `raspberry/server/` vie verifikovať podpis bez koreňového
  `tools/pqc_verify.py`.

- Na Raspberry Pi sa používa lokálne Python prostredie
  `raspberry/server/.venv/`.

- Frontend a backend sú pripravené tak, aby ich bolo možné spustiť na
  Raspberry Pi a klient ich používal cez sieť.


Rýchla kontrola chýb
====================

- Backend sa nespustí
  Skontroluj `npm install` v `raspberry/server`.

- Overenie podpisu zlyhá
  Skontroluj Python prostredie `raspberry/server/.venv/` a balík
  `pqcrypto`.

- Frontend sa neotvorí cez backend
  Skontroluj, či v `raspberry/client/` existuje `dist/` po
  `npm run build`.

- Prehliadač sa nevie spojiť s agentom
  Skontroluj, či agent na používateľskom počítači beží na
  `https://127.0.0.1:5555`.
