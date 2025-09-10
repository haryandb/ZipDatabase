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

interface SearchResult {
  entries: FileEntry[];
  total_count: number;
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

// Pagination state
let ITEMS_PER_PAGE = 20; // Changed to let
let currentPage = 1;
let totalResults = 0;
let totalPages = 0;

window.addEventListener("DOMContentLoaded", () => {
  const buildCacheBtn = document.querySelector<HTMLButtonElement>("#build-cache-btn");
  const searchBtn = document.querySelector<HTMLButtonElement>("#search-btn");
  const searchInput = document.querySelector<HTMLInputElement>("#search-query");
  const excludeInput = document.querySelector<HTMLInputElement>("#exclude-patterns");
  const searchDepthInput = document.querySelector<HTMLInputElement>("#search-depth");
  const uniqueResultsCheckbox = document.querySelector<HTMLInputElement>("#unique-results-checkbox");

  const statusContainer = document.querySelector<HTMLElement>("#status-container");
  const resultsContainer = document.querySelector<HTMLElement>("#results-container");
  const statusEl = document.querySelector("#status-messages");

  // --- Referensi baru untuk tabel ---
  const resultsHeader = document.querySelector("#results-header");
  const resultsTbody = document.querySelector<HTMLTableSectionElement>("#results-tbody");

  // Pagination controls
  const prevPageBtn = document.querySelector<HTMLButtonElement>("#prev-page-btn");
  const nextPageBtn = document.querySelector<HTMLButtonElement>("#next-page-btn");
  const pageInfo = document.querySelector<HTMLSpanElement>("#page-info");

  // Items per page control
  const itemsPerPageSelect = document.querySelector<HTMLSelectElement>("#items-per-page"); // New reference

  // Bulk extract controls
  const selectAllCheckbox = document.querySelector<HTMLInputElement>("#select-all-checkbox");
  const bulkExtractBtn = document.querySelector<HTMLButtonElement>("#bulk-extract-btn");
  const extractAllBtn = document.querySelector<HTMLButtonElement>("#extract-all-btn");

  const selectedFiles = new Set<number>();

  function showStatus(message: string) {
    if (statusContainer && statusEl) {
      statusContainer.style.display = 'block';
      statusEl.textContent = message;
    }
  }

  function updatePaginationControls() {
    if (prevPageBtn) prevPageBtn.disabled = currentPage === 1;
    if (nextPageBtn) nextPageBtn.disabled = currentPage === totalPages || totalPages === 0;
    if (pageInfo) pageInfo.textContent = `Page ${currentPage} of ${totalPages}`;
  }

  function updateBulkExtractButton() {
    if (bulkExtractBtn) {
      bulkExtractBtn.disabled = selectedFiles.size === 0;
      bulkExtractBtn.textContent = `Bulk Extract Selected (${selectedFiles.size})`;
    }
  }

  function updateExtractAllButton() {
    if (extractAllBtn) {
      extractAllBtn.disabled = totalResults === 0;
      extractAllBtn.textContent = `Extract All (${totalResults})`;
    }
  }

  // --- Fungsi yang diperbarui untuk menampilkan hasil di tabel ---
  function renderResults(entries: FileEntry[]) {
    if (!resultsContainer || !resultsTbody || !resultsHeader) return;

    resultsContainer.style.display = 'block';
    resultsHeader.textContent = `Found ${totalResults} results. Page ${currentPage} of ${totalPages}.`;
    // Kosongkan hasil sebelumnya
    resultsTbody.innerHTML = '';

    if (entries.length === 0 && totalResults === 0) {
      const row = resultsTbody.insertRow();
      const cell = row.insertCell();
      cell.colSpan = 5;
      cell.textContent = 'No results found.';
      cell.style.textAlign = 'center';
      return;
    }

    entries.forEach(entry => {
      const row = resultsTbody.insertRow();
      const cellCheckbox = row.insertCell();
      const cellFile = row.insertCell();
      const cellSize = row.insertCell();
      const cellArchive = row.insertCell();
      const cellAction = row.insertCell(); // Sel untuk tombol

      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.dataset.id = entry.id.toString();
      checkbox.checked = selectedFiles.has(entry.id);
      cellCheckbox.appendChild(checkbox);

      checkbox.addEventListener('change', () => {
        if (checkbox.checked) {
          selectedFiles.add(entry.id);
        } else {
          selectedFiles.delete(entry.id);
        }
        updateBulkExtractButton();
      });

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

    updateBulkExtractButton();
  }

  async function performSearch() {
    if (!searchInput || !searchBtn) return;

    showStatus("Searching...");
    if (resultsContainer) resultsContainer.style.display = 'none';

    searchBtn.setAttribute('aria-busy', 'true');
    searchBtn.disabled = true;
    updateExtractAllButton(); // Disable button during search

    // Reset selection
    selectedFiles.clear();
    if (selectAllCheckbox) selectAllCheckbox.checked = false;
    updateBulkExtractButton();

    try {
      const excludePatterns = excludeInput?.value.split(',').map(p => p.trim()).filter(p => p.length > 0) || [];
      const searchDepth = searchDepthInput?.value ? parseInt(searchDepthInput.value, 10) : null;
      const unique = uniqueResultsCheckbox?.checked || false;
      const searchResult: SearchResult = await invoke('search_files', {
        query: searchInput.value,
        page: currentPage,
        limit: ITEMS_PER_PAGE,
        exclude: excludePatterns,
        searchDepth: isNaN(searchDepth) ? null : searchDepth,
        unique: unique
      });

      totalResults = searchResult.total_count;
      totalPages = Math.ceil(totalResults / ITEMS_PER_PAGE);
      if (totalPages === 0 && totalResults > 0) totalPages = 1; // Handle case where totalResults < ITEMS_PER_PAGE but > 0

      showStatus("Search complete.");
      renderResults(searchResult.entries);
      updatePaginationControls();
      updateExtractAllButton(); // Update button with results

    } catch (e) {
      showStatus(`Error: ${e}`);
      totalResults = 0;
      totalPages = 0;
      renderResults([]); // Clear results on error
      updatePaginationControls();
      updateExtractAllButton(); // Update button on error
    } finally {
      searchBtn.setAttribute('aria-busy', 'false');
      searchBtn.disabled = false;
    }
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
    currentPage = 1; // Reset to first page on new search
    await performSearch();
  });

  prevPageBtn?.addEventListener("click", async () => {
    if (currentPage > 1) {
      currentPage--;
      await performSearch();
    }
  });

  nextPageBtn?.addEventListener("click", async () => {
    if (currentPage < totalPages) {
      currentPage++;
      await performSearch();
    }
  });

  // New event listener for items per page select
  itemsPerPageSelect?.addEventListener("change", async () => {
    if (itemsPerPageSelect.value === "all") {
      ITEMS_PER_PAGE = 1000000000;
    } else {
      ITEMS_PER_PAGE = parseInt(itemsPerPageSelect.value);
    }
    currentPage = 1; // Reset to first page when items per page changes
    await performSearch();
  });

  selectAllCheckbox?.addEventListener('change', () => {
    const checkboxes = resultsTbody?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    if (!checkboxes) return;

    checkboxes.forEach(checkbox => {
      const id = parseInt(checkbox.dataset.id || '0');
      if (selectAllCheckbox.checked) {
        selectedFiles.add(id);
        checkbox.checked = true;
      } else {
        selectedFiles.delete(id);
        checkbox.checked = false;
      }
    });

    updateBulkExtractButton();
  });

  bulkExtractBtn?.addEventListener('click', async () => {
    if (selectedFiles.size === 0) return;

    showStatus(`Extracting ${selectedFiles.size} files...`);
    bulkExtractBtn.setAttribute('aria-busy', 'true');
    bulkExtractBtn.disabled = true;

    try {
      const downloadsPath = await downloadDir();
      const destination = `${downloadsPath}/ZipCache_Extraction`;
      const result: string = await invoke('extract_files', {
        ids: Array.from(selectedFiles),
        destination: destination
      });
      showStatus(`${selectedFiles.size} files extracted to ${result}. Opening folder...`);
      await invoke('show_item_in_folder_custom', { path: result });
    } catch (e) {
      showStatus(`Error during bulk extraction: ${e}`);
    } finally {
      bulkExtractBtn.setAttribute('aria-busy', 'false');
      bulkExtractBtn.disabled = false;
    }
  });

  extractAllBtn?.addEventListener('click', async () => {
    if (totalResults === 0) return;

    showStatus(`Extracting all ${totalResults} files...`);
    extractAllBtn.setAttribute('aria-busy', 'true');
    extractAllBtn.disabled = true;

    try {
      // Fetch all results from the backend
      const excludePatterns = excludeInput?.value.split(',').map(p => p.trim()).filter(p => p.length > 0) || [];
      const searchDepth = searchDepthInput?.value ? parseInt(searchDepthInput.value, 10) : null;
      const unique = uniqueResultsCheckbox?.checked || false;
      const searchResult: SearchResult = await invoke('search_files', {
        query: searchInput.value,
        page: 1,
        limit: 1000000000, // A large number to get all results
        exclude: excludePatterns,
        searchDepth: isNaN(searchDepth) ? null : searchDepth,
        unique: unique
      });

      const downloadsPath = await downloadDir();
      const destination = `${downloadsPath}/ZipCache_Extraction_All`;
      const ids = searchResult.entries.map(entry => entry.id);
      const result: string = await invoke('extract_files', {
        ids: ids,
        destination: destination
      });
      showStatus(`${totalResults} files extracted to ${result}. Opening folder...`);
      await invoke('show_item_in_folder_custom', { path: result });
    } catch (e) {
      showStatus(`Error during bulk extraction: ${e}`);
    } finally {
      extractAllBtn.setAttribute('aria-busy', 'false');
      extractAllBtn.disabled = false;
    }
  });
});