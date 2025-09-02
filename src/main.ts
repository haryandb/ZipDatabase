import { invoke } from '@tauri-apps/api/core';

import { downloadDir } from '@tauri-apps/api/path'; // Import downloadDir

interface FileEntry {
  id: number;
  archive_name: string;
  file_name: string;
  file_size: number;
  compressed_size: number;
  zip_path: string; // Path lengkap ke file zip
}

// --- Fungsi Baru untuk memformat ukuran file ---
function formatBytes(bytes: number, decimals = 2): string {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const dm = decimals < 0 ? 0 : decimals;
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

window.addEventListener("DOMContentLoaded", () => {
  const buildCacheBtn = document.querySelector<HTMLButtonElement>("#build-cache-btn");
  const searchBtn = document.querySelector<HTMLButtonElement>("#search-btn");
  
  const statusContainer = document.querySelector<HTMLElement>("#status-container");
  const resultsContainer = document.querySelector<HTMLElement>("#results-container");
  const statusEl = document.querySelector("#status-messages");
  
  // --- Referensi baru untuk tabel ---
  const resultsHeader = document.querySelector("#results-header");
  const resultsTbody = document.querySelector<HTMLTableSectionElement>("#results-tbody");

  function showStatus(message: string) {
    if (statusContainer && statusEl) {
      statusContainer.style.display = 'block';
      statusEl.textContent = message;
    }
  }

  // --- Fungsi yang diperbarui untuk menampilkan hasil di tabel ---
  function renderResults(results: FileEntry[]) {
    if (!resultsContainer || !resultsTbody || !resultsHeader) return;

    resultsContainer.style.display = 'block';
    resultsHeader.textContent = `Found ${results.length} results.`;
    // Kosongkan hasil sebelumnya
    resultsTbody.innerHTML = '';

    if (results.length === 0) {
      const row = resultsTbody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 4; // Diperbarui menjadi 4
      cell.textContent = 'No results found.';
      cell.style.textAlign = 'center';
      return;
    }

    results.forEach(entry => {
      const row = resultsTbody.insertRow();
      const cellFile = row.insertCell();
      const cellSize = row.insertCell();
      const cellArchive = row.insertCell();
      const cellAction = row.insertCell(); // Sel untuk tombol

      cellFile.textContent = entry.file_name;
      cellSize.textContent = formatBytes(entry.file_size);
      cellArchive.textContent = entry.archive_name;

      // Buat tombol Extract
      const extractBtn = document.createElement('button');
      extractBtn.textContent = 'Extract';
      extractBtn.classList.add('pico-button', 'pico-button--secondary', 'pico-button--small');
      cellAction.appendChild(extractBtn);

      // Tambahkan event listener
      extractBtn.addEventListener('click', async () => {
        showStatus(`Extracting ${entry.file_name}...`);
        extractBtn.setAttribute('aria-busy', 'true');
        extractBtn.disabled = true;
        try {
          const downloadsPath = await downloadDir();
          const extractedFilePath: string = await invoke('extract_file', { 
            zipPath: entry.zip_path, 
            fileName: entry.file_name,
            destination: downloadsPath
          });
          showStatus(`'${entry.file_name}' extracted. Opening location in file explorer...`);
          await invoke('show_item_in_folder_custom', { path: extractedFilePath }); // Buka lokasi file yang diekstrak di file explorer
        } catch (e) {
          showStatus(`Error extracting file: ${entry.file_name} ${e}`);
        } finally {
          extractBtn.setAttribute('aria-busy', 'false');
          extractBtn.disabled = false;
        }
      });
    });
  }

  buildCacheBtn?.addEventListener("click", async () => {
    const dirPathInput = document.querySelector<HTMLInputElement>("#zip-dir-path");
    if (dirPathInput && buildCacheBtn) {
      showStatus("Building cache... This might take several minutes. See terminal for progress.");
      if (resultsContainer) resultsContainer.style.display = 'none';
      
      buildCacheBtn.setAttribute('aria-busy', 'true');
      buildCacheBtn.disabled = true;

      try {
        await invoke('build_cache', { zipDirPath: dirPathInput.value });
        showStatus("Cache successfully built!");
      } catch (e) {
        showStatus(`Error: ${e}`);
      } finally {
        buildCacheBtn.setAttribute('aria-busy', 'false');
        buildCacheBtn.disabled = false;
      }
    }
  });

  searchBtn?.addEventListener("click", async () => {
    const searchInput = document.querySelector<HTMLInputElement>("#search-query");
    if (searchInput && searchBtn) {
      showStatus("Searching...");
      if (resultsContainer) resultsContainer.style.display = 'none';

      searchBtn.setAttribute('aria-busy', 'true');
      searchBtn.disabled = true;

      try {
        const results: FileEntry[] = await invoke('search_files', { query: searchInput.value });
        showStatus("Search complete."); // Status sekarang hanya konfirmasi
        renderResults(results); // Panggil fungsi render tabel
      } catch (e) {
        showStatus(`Error: ${e}`);
      } finally {
        searchBtn.setAttribute('aria-busy', 'false');
        searchBtn.disabled = false;
      }
    }
  });
});