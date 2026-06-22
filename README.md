# VisionX · Order Desk (GitHub + Vercel + Firebase)

Serverless Bestell- & Ticketing-System im VisionX-Look. Deployt komplett ohne
Terminal: GitHub-Repo → Vercel baut & hostet → Firestore als Datenbank.
Laeuft auf dem kostenlosen Firebase **Spark-Plan** (keine Kreditkarte).

## Architektur

- Frontend: React/Vite (VisionX UI), gebaut von Vercel.
- Datenbank: Firebase Firestore (Realtime, fuer OFFENE Tickets). Kein Storage.
- Login: Discord OAuth2. Der geheime Tausch laeuft in EINER Vercel-Funktion
  `api/discord-auth.js`, die ein Firebase Custom Token mit `mod`-Claim ausstellt.
- Discord-Posts (aus dem Browser, wie im Tracker):
  - Ticket geoeffnet  → Embed nach #tickets
  - PayPal-Beweis     → Screenshot direkt nach #tickets (nichts gespeichert)
  - Ticket geschlossen → Transcript-Datei nach #archiv, danach Ticket geloescht
- TRC20-Check: On-Chain-Pruefung per Knopf im Admin-Panel (TronGrid, Browser).

## "Nichts speichern"

Solange ein Ticket offen ist, liegt es in Firestore (fuer Chat + Status). Beim
Schliessen wird das Transcript ins #archiv gepostet und das Ticket samt Chat
aus Firestore geloescht. Einziger bleibender Datensatz: das Transcript in Discord.
Zahlungs-Screenshots werden nie bei uns gespeichert, nur nach Discord gepostet.

## Dateien

- `SETUP-DE.md` — Schritt-fuer-Schritt, komplett per Klick. **Hier starten.**
- `src/data.js` — Produkte, Preise, Disclaimer, Zahlungs-Adressen.
- `src/theme.css` — VisionX Branding (Charcoal/Gold/Off-White).
- `firestore.rules` — in die Firebase-Console einfuegen.
- `api/discord-auth.js` — die einzige Server-Funktion (Login).

## Hinweise

- Es liegen KEINE Geheimnisse im Code. Discord-Schluessel und Firebase
  Service-Account stehen nur in Vercels Environment Variables (serverseitig).
- Die Webhook-URLs sind im Browser sichtbar (wie beim Tracker). Folge: jemand
  koennte damit nur in die zwei Kanaele posten (Spam), nichts lesen/aendern.
- Mods werden ueber die Discord-Rolle bestimmt. Rollenwechsel greift nach
  erneutem Login.
