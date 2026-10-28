# AiBro

Piccolo assistente nella taskbar di Windows per tenere d'occhio gli agenti AI e interagire con loro.

- **Sessioni Claude Code** aperte nei terminali: stato in tempo reale (al lavoro, in attesa, attende approvazione), ultimo prompt e ultima risposta, cronologia.
- **Approvazioni**: quando una sessione chiede un permesso (Bash, Write, …) il popup si apre e puoi scegliere *Consenti*, *Consenti sempre* o *Rifiuta*. Se AiBro è chiuso, o se rispondi prima nel terminale, Claude Code si comporta come sempre.
- **Chat**: avvia nuove sessioni Claude Code dalla finestra, oppure continua da qui una sessione nata nel terminale (riprende la conversazione tramite Claude Agent SDK).
- **GitHub**: notifiche non lette e PR che aspettano la tua review, con notifica desktop per le novità.
- **GitHub Actions**: ultimo run per workflow e branch (in corso, riuscito, fallito, annullato) sui repo con push negli ultimi 7 giorni oppure su una lista fissa. Notifica quando un run fallisce o quando uno che era in corso termina con successo, badge rosso nella tray e pulsante *Rilancia* per rieseguire i job falliti. Mentre ci sono run in corso il polling passa da 60 a 20 secondi.
- **App desktop**: rileva ChatGPT, Claude, Copilot, VS Code, Cursor e le schede web di ChatGPT/Claude/Copilot/Gemini e le porta in primo piano. Queste app non espongono API, quindi AiBro non può leggere le loro conversazioni.

## Avvio

```powershell
npm install
npm start            # aggiungi -- --hidden per partire solo in tray
```

## Exe per Windows

```powershell
npm run dist
```

In `dist/` trovi `AiBro-Setup-<versione>.exe` (installazione per l'utente corrente, con collegamenti nel menu Start e sul desktop) e `AiBro-<versione>-portable.exe` (senza installazione). L'exe non include il binario di Claude Code dell'SDK: usa `claude.exe` installato sul PC (`~/.local/bin` o `PATH`). Gli hook eseguono una copia dello script in `~/.aibro/aibro-hook.js`, aggiornata a ogni avvio, quindi restano validi anche spostando o aggiornando l'app. L'exe non è firmato: al primo avvio Windows SmartScreen può chiedere conferma.

L'icona dell'app è `build/icon-256.ico` (usata anche nella tray, con un badge colorato per approvazioni, risposte attese e Actions fallite); `build/icon.ico` è la versione 32×32. Per l'exe `scripts/make-icon.js` crea `build/exe.ico` con il disegno grande portato a 256×256 più il 32×32, e `ui/logo.png`.

Clic sull'icona nella tray per mostrare o nascondere la finestra; clic destro per il menu (hook, sempre in primo piano, avvio con Windows, esci).

## Collegare Claude Code

Dalla finestra (banner o ⚙ Impostazioni) oppure:

```powershell
npm run hooks:install     # npm run hooks:uninstall per rimuoverli
```

Gli hook vengono aggiunti a `~/.claude/settings.json` (backup in `settings.json.aibro-backup`) ed eseguono `hooks/aibro-hook.js`, che inoltra gli eventi al server locale `127.0.0.1:47821`, protetto da un token in `~/.aibro/runtime.json`. Le sessioni avviate da AiBro hanno `AIBRO_MANAGED=1` e gestiscono i permessi via SDK, quindi gli hook le ignorano.

## GitHub

Impostazioni → incolla un personal access token (classic con scope `notifications` + `repo` + `workflow`, oppure fine-grained con Actions in lettura/scrittura). Nella stessa schermata puoi indicare i repository da monitorare per le Actions (`owner/repo`, uno per riga). Il token viene cifrato con `safeStorage` (DPAPI). In alternativa puoi usare la variabile d'ambiente `GITHUB_TOKEN`.

## Struttura

| File | Ruolo |
|---|---|
| `src/main.js` | Tray, finestra, notifiche, IPC, polling |
| `src/hookServer.js` | Server HTTP che riceve gli hook di Claude Code |
| `src/agentRunner.js` | Sessioni avviate o riprese con `@anthropic-ai/claude-agent-sdk` |
| `src/store.js` | Stato di sessioni e approvazioni |
| `src/github.js` | API GitHub |
| `src/desktopApps.js` | Rilevamento delle app AI aperte |
| `src/hooksInstaller.js` | Installazione hook in `~/.claude/settings.json` |
| `hooks/aibro-hook.js` | Script eseguito da Claude Code per ogni evento |
| `ui/` | Interfaccia (HTML/CSS/JS senza framework) |
