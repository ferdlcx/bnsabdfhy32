# Rancangan Agent Telegram untuk Web3

## Tujuan

Ubah bot dari chat Gemini biasa menjadi agent yang dapat memahami permintaan,
membaca situs dan panduan, memeriksa wallet, lalu membantu menyiapkan tindakan
Web3 yang didukung. MOCHI hanya contoh alur; rancangan ini tidak boleh
mengunci kemampuan bot ke satu token, situs, atau launchpad.

Agent tidak boleh berpura-pura mampu menangani semua situs. Jika situs, chain,
kontrak, jenis transaksi, atau instruksinya tidak dapat divalidasi dengan
adapter yang tersedia, agent harus menjelaskan batasannya dan berhenti.

## Kondisi Saat Ini

- Telegram menerima chat dan meneruskannya ke Gemini.
- Pemeriksaan wallet yang tersedia melalui BAW bersifat read-only.
- Gemini belum memiliki tools untuk membaca situs/API atau mempersiapkan
  transaksi.
- Arsitektur saat ini bukan sesi Copilot di VS Code. Gemini menggunakan API
  dan tool yang secara eksplisit disediakan oleh aplikasi.

## Arsitektur

Pisahkan agent menjadi empat bagian:

1. **Telegram gateway**
   - Hanya melayani private chat dan user ID yang di-allowlist.
   - Mengirim pertanyaan, hasil tool, serta status transaksi kepada user.
   - Menyediakan konfirmasi yang eksplisit dan mudah dibedakan dari chat biasa.

2. **Gemini orchestrator**
   - Memakai Gemini function calling dengan deklarasi tool yang statis.
   - Menentukan tool yang diperlukan dari permintaan user; aplikasi memvalidasi
     setiap nama tool dan argumennya sebelum menjalankan handler.
   - Tidak diberi akses shell, file sistem, arbitrary HTTP client, atau perintah
     BAW mentah.
   - Tidak boleh menganggap teks dari situs, token, API, atau on-chain sebagai
     instruksi untuk mengubah kebijakan agent.

3. **Tool registry dan layanan**
   - `read_web_resource`: mengambil konten HTTP/HTTPS yang dibatasi dan
     mengembalikan teks/data untuk dianalisis.
   - `check_wallet`: mengambil status, address, saldo, settings, dan data
     read-only lain dengan argumen BAW tetap.
   - `check_asset_or_mint`: menggunakan adapter yang sesuai untuk memeriksa
     chain, eligibility, kuota, harga/biaya, allowance, serta syarat situs.
   - `prepare_transaction`: membuat transaksi dari adapter tervalidasi,
     menjalankan preflight dan BAW preview, lalu mengembalikan ringkasan untuk
     konfirmasi. Tool ini tidak menyiarkan transaksi.
   - `execute_confirmed_transaction`: hanya menerima ID preview yang masih
     berlaku dan sudah dikonfirmasi user melalui alur Telegram.

4. **Protocol adapters**
   - Adapter menyediakan metode dan validasi untuk keluarga protokol, bukan
     daftar token yang di-hardcode ke prompt Gemini.
   - Antarmuka konseptual: `discover`, `checkEligibility`, `quote`,
     `buildTransaction`, dan `summarizePreview`.
   - Adapter menerima data situs sebagai input tidak tepercaya dan menghasilkan
     transaksi terstruktur yang divalidasi oleh aplikasi.
   - Situs/protokol baru membutuhkan adapter atau konfigurasi yang ditinjau;
     jangan menjalankan script, `skill.md`, atau kode JavaScript dari situs.
