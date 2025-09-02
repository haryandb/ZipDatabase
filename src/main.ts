import { invoke } from '@tauri-apps/api/core';

interface FileEntry {
  id: number;
  archive_name: string;
  file_name: string;
  file_size: number;
  compressed_size: number;
}

window.addEventListener("DOMContentLoaded", () => {
  const buildCacheBtn = document.querySelector<HTMLButtonElement>("#build-cache-btn");
  const searchBtn = document.querySelector<HTMLButtonElement>("#search-btn");
  
  const statusContainer = document.querySelector<HTMLElement>("#status-container");
  const resultsContainer = document.querySelector<HTMLElement>("#results-container");
  const statusEl = document.querySelector("#status-messages");
  const resultsEl = document.querySelector("#search-results");

  function showStatus(message: string) {
    if (statusContainer && statusEl) {
      statusContainer.style.display = 'block';
      statusEl.textContent = message;
    }
  }

  function showResults(data: object) {
    if (resultsContainer && resultsEl) {
      resultsContainer.style.display = 'block';
      resultsEl.textContent = JSON.stringify(data, null, 2);
    }
  }

  buildCacheBtn?.addEventListener("click", async () => {
    const dirPathInput = document.querySelector<HTMLInputElement>("#zip-dir-path");
    if (dirPathInput && buildCacheBtn) {
      showStatus("Building cache... This might take several minutes depending on the size of your files. See terminal for progress.");
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
        showStatus(`Found ${results.length} results.`);
        showResults(results);
      } catch (e) {
        showStatus(`Error: ${e}`);
      } finally {
        searchBtn.setAttribute('aria-busy', 'false');
        searchBtn.disabled = false;
      }
    }
  });
});