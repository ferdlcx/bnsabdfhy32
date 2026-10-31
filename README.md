# Universal Binance Agentic Wallet Automation Engine (`bnbbot` v2.0)

Sistem otomasi Web3 berbasis **Binance Agentic Wallet (BAW)** dengan pemisahan tegas antara **Direct Execution Engine (Deterministik / 0 AI Token)** dan **AI Reasoning Layer (Multi-Provider + Fallback)**, dikendalikan sepenuhnya melalui **Telegram**.

---

## Arsitektur Utama

```text
Telegram Interface (Telegraf + Allowlist Guard)
  ↓
Task Orchestrator
  ├── Direct Execution Engine (0 AI Token: Wallet, Balance, Eligibility, Quote, Preview, Execute, Monitor)
  └── AI Reasoning Router (Gemini + OpenAI-Compatible Fallback + Deterministic NLU Fallback)
  ↓
Universal Skill Loader (SSRF Guard + Security Validator + SHA-256 Registry Cache)
  ↓
Project Adapters (MOCHI Free/Paid Mint Adapter + Generic Contract Adapter)
  ↓
Transaction Guard (Contract Allowlist, Spend Cap, Replay Protection, TTL Confirmation)
  ↓
Binance Agentic Wallet CLI (`baw` via safe `execFile --json`)
  ↓
BNB Smart Chain (Chain 56) & Supported Networks
  ↓
Transaction Monitor → Telegram Notification
```

---

## Fitur Keamanan (Security Guardrails)

1. **Telegram Allowlist & Private Chat Only**: Hanya `TELEGRAM_ALLOWED_USER_IDS` di chat pribadi yang dapat mengakses bot.
2. **Two-Step Preview & Confirmation**: Semua transaksi on-chain wajib melewati simulasi `baw contract-call preview` dan menghasilkan ID unik (`TX-XXXXXX`) yang hanya bisa dieksekusi dengan `/confirm <id>` sebelum batas waktu habis.
3. **Replay & Tamper Protection**: Persetujuan terikat secara kriptografis (SHA-256) pada `(txId, userId, walletAddress, chainId, to, calldata, valueWei, expiresAt)`.
4. **No Arbitrary Shell / Key Exposure**: Eksekusi BAW CLI menggunakan `execFile` tanpa shell, dan seluruh output melewati modul sanitasi [redactor.js](src/security/redactor.js).
5. **SSRF & Untrusted Skill Protection**: [ssrfGuard.js](src/security/ssrfGuard.js) memblokir localhost, IP privat, dan metadata cloud (`169.254.169.254`), sedangkan [skillValidator.js](src/skills/skillValidator.js) memblokir dokumen eksternal yang meminta private key/seed phrase.
6. **Kill Switch**: Gunakan `/killswitch on` kapan saja dari Telegram untuk membatalkan semua transaksi pending dan mengunci eksekusi baru.

---

## Daftar Command Telegram

### Core & Wallet
- `/start` / `/help` — Menu utama & daftar command
- `/status` — Status seluruh komponen (Mode, Kill Switch, BAW CLI, Wallet Session, `.ai` Agent ID, Developer Mode, AI Router, Skills)
- `/wallet` (atau `/address`, `/settings`) — Informasi alamat wallet semua chain, `.ai` Agent ID, dan kuota Developer Mode
- `/balance [symbol]` — Cek saldo semua aset (termasuk token baru / unpriced)
- `/chains` — Daftar jaringan blockchain yang didukung BAW
- `/history` — Riwayat aktivitas & transaksi on-chain
- `/auth` & `/verify <qrCodeId>` — Login sesi QR BAW langsung dari Telegram

### MOCHI Adapter (BNB Smart Chain - 56)
- `/mochi` atau `/mochi stats` — Statistik live MOCHI (`/api/stats`)
- `/mochi check` — Cek eligibility `.ai` Agent ID, sisa kuota, dan status *Free First Share* (`/api/verify`)
- `/mochi quote <shares>` — Estimasi biaya & calldata (`quoteFor` on-chain + deteksi otomatis *Free First Share* `maxCost = 0`)
- `/mochi mint <shares>` — Simulasi preview BAW & pembuatan ID konfirmasi (`/confirm <id>`)
- `/mochi history` — Riwayat mint MOCHI terbaru di jaringan

### Universal Skill Loader & Multi-Project
- `/skills` — Daftar skill yang terdaftar di `skills/registry.json`
- `/addskill <url>` — Import & validasi `SKILL.md` / website baru (contoh: `/addskill https://agenticmochi.xyz/skill.md`)
- `/removeskill <name>` — Hapus skill dari registry
- `/check <project>` — Cek eligibility project (contoh: `/check mochi`)
- `/quote <project> <amount>` — Estimasi biaya project (contoh: `/quote mochi 1`)

### Transaction Guard, Scanner, & AI
- `/pending` — Daftar transaksi yang menunggu persetujuan
- `/confirm <id>` — Setujui dan eksekusi transaksi tertentu
- `/cancel [id]` — Batalkan transaksi pending
- `/cek <0x...>` — Audit keamanan kontrak (GoPlus + DexScreener + BSC RPC)
- `/killswitch [on|off]` — Aktifkan/matikan saklar darurat
- `/task <instruction>` — Instruksi bahasa alami (hemat token AI dengan deterministic bypass)

---

## Cara Update & Menjalankan di GitHub Codespaces (`/workspaces/bnbbot`)

Jalankan perintah berikut di terminal Codespace Anda untuk menarik versi terbaru:

```bash
git pull sync main
npm test
npm start
```

Pastikan file `.env` Anda di Codespace memiliki minimal:
```env
TELEGRAM_BOT_TOKEN=token_bot_telegram_anda
TELEGRAM_ALLOWED_USER_IDS=id_telegram_anda
```

---

## Cara Deploy 24/7 di Cloud VPS (< $5 / Bulan)

Pada VPS Ubuntu 22.04 / 24.04 LTS (misal Hetzner CX22 / CAX11 atau RackNerd KVM):

```bash
git clone https://github.com/ferdlcx/bnsabdfhy32.git bnbbot
cd bnbbot
bash deploy/setup-vps.sh
```
