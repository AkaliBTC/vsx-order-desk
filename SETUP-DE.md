# VisionX Order Desk — Einrichtung ohne Terminal (GitHub + Vercel + Firebase)

Komplett per Klick. Kein Node, kein Terminal auf deinem Rechner. Vercel baut das
Projekt in der Cloud für dich — wie bei deinem Tracker.

Du brauchst Accounts bei: **GitHub**, **Vercel**, **Firebase (Google)** und einen
**Discord-Server**, auf dem du Admin bist. Dauer beim ersten Mal: ca. 45 Min.

---

## Teil 1 — Code zu GitHub

1. Entpacke das Zip (Rechtsklick → entpacken).
2. Gehe auf https://github.com → **New repository** → Name z. B. `vsx-order-desk`
   → **Private** → **Create repository**.
3. Auf der nächsten Seite: **„uploading an existing file"** anklicken.
4. Ziehe **den gesamten Inhalt** des entpackten Ordners (alle Dateien + Ordner
   `src`, `api`) in das Fenster. Warten bis hochgeladen → **Commit changes**.

> Lieber per App? Lade „GitHub Desktop" (Programm mit Oberfläche) — auch kein Terminal.

---

## Teil 2 — Firebase einrichten (Web-Console)

> Alles hier läuft auf dem **kostenlosen Spark-Plan**. Keine Kreditkarte, kein
> Blaze, kein „300$". Storage nutzen wir bewusst nicht — Beweise/Transcripts gehen
> per Webhook nach Discord, nichts wird bei uns gespeichert.

1. https://console.firebase.google.com → **Projekt hinzufügen** → Name → erstellen.
2. **Firestore Database** → Build → Firestore → **Datenbank erstellen** →
   Produktionsmodus → Region (z. B. europe) → Aktivieren.
3. **Authentication** → Build → Authentication → Los geht's (nichts weiter klicken;
   Login läuft über die `/api`-Funktion).
4. **Web-App-Zugangsdaten holen:** Zahnrad → **Projekteinstellungen** → „Meine Apps"
   → Symbol **`</>`** → Name `shop` → registrieren. Der `firebaseConfig`-Block, der
   erscheint, liefert die `VITE_FIREBASE_*`-Werte. Offen lassen.
5. **Regeln einfügen:** Firestore → Reiter **Regeln** → den Inhalt der Datei
   `firestore.rules` rein kopieren → **Veröffentlichen**.
6. **Service-Account-Schlüssel** (damit die Login-Funktion Tokens ausstellen darf):
   Projekteinstellungen → Reiter **Dienstkonten** → **Neuen privaten Schlüssel
   generieren** → eine `.json`-Datei wird heruntergeladen. Diese Datei gleich
   komplett (gesamter Inhalt) als Wert für `FIREBASE_SERVICE_ACCOUNT` brauchen.

---

## Teil 3 — Discord einrichten

1. https://discord.com/developers/applications → **New Application** → Name → Create.
2. Links **OAuth2**:
   - **Client ID** kopieren.
   - **Reset Secret** → **Client Secret** kopieren (nur einmal sichtbar).
   - **Redirects → Add Redirect**: deine spätere Vercel-Adresse, z. B.
     `https://DEIN-PROJEKT.vercel.app` → **Save**.
3. **IDs:** in Discord **Einstellungen → Erweitert → Entwicklermodus AN**.
   - Rechtsklick auf den Server → **Server-ID kopieren**.
   - Server-Einstellungen → Rollen → Rechtsklick auf eure Mod-Rolle →
     **Rollen-ID kopieren**. (Wer diese Rolle hat, sieht das Admin-Panel.)
4. **Webhooks:** Server-Einstellungen → **Integrationen → Webhooks → Neuer Webhook**
   → Kanal `#tickets` → URL kopieren. Nochmal für `#archiv` → URL kopieren.

---

## Teil 4 — Vercel: importieren & Werte eintragen

1. https://vercel.com → **Add New… → Project** → dein GitHub-Repo **Import**.
2. Vercel erkennt „Vite" automatisch. **Noch nicht deployen** — erst die
   **Environment Variables** aufklappen und eintragen (Name = Wert):

   | Name | Wert |
   |---|---|
   | `VITE_FIREBASE_API_KEY` | aus firebaseConfig |
   | `VITE_FIREBASE_AUTH_DOMAIN` | aus firebaseConfig |
   | `VITE_FIREBASE_PROJECT_ID` | aus firebaseConfig |
   | `VITE_FIREBASE_APP_ID` | aus firebaseConfig |
   | `VITE_DISCORD_CLIENT_ID` | Discord Client ID |
   | `VITE_DISCORD_REDIRECT_URI` | `https://DEIN-PROJEKT.vercel.app` |
   | `VITE_WEBHOOK_TICKETS` | Webhook-URL #tickets |
   | `VITE_WEBHOOK_ARCHIVE` | Webhook-URL #archiv |
   | `DISCORD_CLIENT_ID` | Discord Client ID |
   | `DISCORD_CLIENT_SECRET` | Discord Client Secret |
   | `DISCORD_GUILD_ID` | Server-ID |
   | `DISCORD_MOD_ROLE_ID` | Mod-Rollen-ID |
   | `FIREBASE_SERVICE_ACCOUNT` | gesamter Inhalt der `.json`-Datei aus Teil 2.7 |

3. **Deploy** klicken. Nach ein paar Minuten bekommst du deine Live-URL
   `https://DEIN-PROJEKT.vercel.app`.

> **Zwei-Schritt-Hinweis:** Falls deine echte Vercel-URL anders heißt als geraten,
> korrigiere danach `VITE_DISCORD_REDIRECT_URI` (Vercel → Settings → Environment
> Variables) **und** die Redirect-URL in Discord, sodass beide identisch sind.
> Dann in Vercel → Deployments → **Redeploy**.

---

## Teil 5 — Erster Test

1. Öffne deine Vercel-URL → **Mit Discord anmelden** → zustimmen.
2. Produkt in den Warenkorb → **Ticket öffnen** → Disclaimer bestätigen.
   → In `#tickets` erscheint eine Nachricht.
3. Hast du die Mod-Rolle, siehst du oben **Admin**. Dort:
   - bei USDT/TRC20: **On-Chain prüfen** sucht den Eingang und setzt „bezahlt".
   - bei PayPal: Screenshot ansehen → **Zahlung bestätigen**.
   - **Ticket schließen** → Transcript landet in `#archiv`, Ticket verschwindet.

---

## Wenn etwas hakt

- **Login dreht sich:** `VITE_DISCORD_REDIRECT_URI` und die Discord-Redirect-URL
  müssen **buchstabengenau** gleich sein (https, kein „/" am Ende).
- **Login-Fehler „auth failed":** `FIREBASE_SERVICE_ACCOUNT` unvollständig
  eingefügt — die komplette JSON-Datei muss rein. Danach Redeploy.
- **Admin-Tab fehlt:** Du hast die Mod-Rolle nicht, oder `DISCORD_MOD_ROLE_ID` ist
  falsch. Aus- und wieder einloggen, damit die Rolle neu geprüft wird.
- **Admin-Liste lädt nicht (Konsole zeigt „index"):** Firestore braucht einmalig
  einen Index — die Fehlermeldung enthält einen Link, anklicken → erstellen.
- **Keine #tickets-Nachricht:** Webhook-URL falsch. Neu eintragen, Redeploy.
- **„On-Chain prüfen" findet nichts:** Der Betrag muss exakt inkl. Nachkommastellen
  eingegangen sein; sonst paar Minuten warten und erneut prüfen.

## Änderungen später

Datei `src/data.js` für Produkte/Preise/Disclaimer ändern, auf GitHub speichern —
Vercel baut automatisch neu. Kein Terminal, nie.
