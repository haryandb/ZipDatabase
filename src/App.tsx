import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';

interface FileEntry {
  id: number;
  name: string;
  path: string;
  full_path: string;
  is_folder: boolean;
  zip_path: string;
}

interface SearchResult {
  entries: FileEntry[];
  total_count: number;
}

function App() {
  // State variables
  const [zipDirPath, setZipDirPath] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [excludePatterns, setExcludePatterns] = useState('');
  const [searchDepth, setSearchDepth] = useState<number | null>(null);
  const [uniqueResults, setUniqueResults] = useState(false);
  const [entryType, setEntryType] = useState('all');

  const [statusMessage, setStatusMessage] = useState('');
  const [showStatusContainer, setShowStatusContainer] = useState(false);

  const [results, setResults] = useState<FileEntry[]>([]);
  const [totalResults, setTotalResults] = useState(0);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(20);
  const [totalPages, setTotalPages] = useState(0);

  const [selectedFiles, setSelectedFiles] = useState<Set<number>>(new Set());

  const [isBuildingCache, setIsBuildingCache] = useState(false);
  const [isSearching, setIsSearching] = useState(false);
  const [isExtractingBulk, setIsExtractingBulk] = useState(false);
  const [isExtractingAll, setIsExtractingAll] = useState(false);

  // Helper to show status messages
  const showStatus = useCallback((message: string) => {
    setStatusMessage(message);
    setShowStatusContainer(true);
  }, []);

  // Function to perform search (memoized with useCallback)
  const performSearch = useCallback(async () => {
    showStatus("Searching...");
    setResults([]); // Clear previous results
    setShowStatusContainer(false); // Hide status container initially
    setIsSearching(true);
    setSelectedFiles(new Set()); // Reset selection

    try {
      const excludeArr = excludePatterns.split(',').map(p => p.trim()).filter(p => p.length > 0);
      const searchResult: SearchResult = await invoke('search_files', {
        query: searchQuery,
        page: currentPage,
        limit: itemsPerPage,
        exclude: excludeArr,
        searchDepth: searchDepth === null || isNaN(searchDepth) ? null : searchDepth,
        unique: uniqueResults,
        entryType: entryType
      });

      setTotalResults(searchResult.total_count);
      setTotalPages(Math.ceil(searchResult.total_count / itemsPerPage));
      setResults(searchResult.entries);
      showStatus("Search complete.");

    } catch (e) {
      showStatus(`Error: ${e}`);
      setTotalResults(0);
      setTotalPages(0);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [searchQuery, currentPage, itemsPerPage, excludePatterns, searchDepth, uniqueResults, entryType, showStatus]);

  // Effects for pagination and initial search
  useEffect(() => {
    // Initial search or when pagination/filter changes
    if (searchQuery) { // Only search if there's a query
      performSearch();
    }
  }, [currentPage, itemsPerPage, performSearch]); // Re-run when these change

  // Event Handlers
  const handleBuildCache = async () => {
    showStatus("Building cache... This might take several minutes. See terminal for progress.");
    setResults([]); // Clear results when building cache
    setIsBuildingCache(true);
    try {
      await invoke('build_cache', { zipDirPath: zipDirPath });
      showStatus("Cache successfully built!");
    } catch (e) {
      showStatus(`Error: ${e}`);
    } finally {
      setIsBuildingCache(false);
    }
  };

  const handleSearch = () => {
    setCurrentPage(1); // Reset to first page on new search
    performSearch();
  };

  const handlePrevPage = () => {
    if (currentPage > 1) {
      setCurrentPage(prev => prev - 1);
    }
  };

  const handleNextPage = () => {
    if (currentPage < totalPages) {
      setCurrentPage(prev => prev + 1);
    }
  };

  const handleItemsPerPageChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const value = e.target.value;
    if (value === "all") {
      setItemsPerPage(1000000000); // A very large number
    } else {
      setItemsPerPage(parseInt(value, 10));
    }
    setCurrentPage(1); // Reset to first page
  };

  const handleSelectAllChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    if (checked) {
      const allIds = new Set(results.map(entry => entry.id));
      setSelectedFiles(allIds);
    } else {
      setSelectedFiles(new Set());
    }
  };

  const handleFileCheckboxChange = (id: number, checked: boolean) => {
    setSelectedFiles(prev => {
      const newSelection = new Set(prev);
      if (checked) {
        newSelection.add(id);
      } else {
        newSelection.delete(id);
      }
      return newSelection;
    });
  };

  const handleExtractFile = async (entry: FileEntry) => {
    showStatus(`Extracting ${entry.full_path}...`);
    // This needs to be handled per-row, perhaps by passing a state setter down or managing it locally
    // For now, just show global status
    try {
      const downloadsPath = await downloadDir();
      const extractedFilePath: string = await invoke('extract_file', {
        id: entry.id,
        destination: downloadsPath
      });
      showStatus(`'${entry.full_path}' extracted. Opening location in file explorer...`);
      await invoke('show_item_in_folder_custom', { path: extractedFilePath });
    } catch (e) {
      showStatus(`Error extracting file: ${entry.full_path} ${e}`);
    }
  };

  const handleBulkExtract = async () => {
    if (selectedFiles.size === 0) return;

    showStatus(`Extracting ${selectedFiles.size} files...`);
    setIsExtractingBulk(true);

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
      setIsExtractingBulk(false);
    }
  };

  const handleExtractAll = async () => {
    if (totalResults === 0) return;

    showStatus(`Extracting all ${totalResults} files...`);
    setIsExtractingAll(true);

    try {
      // Fetch all results from the backend
      const excludeArr = excludePatterns.split(',').map(p => p.trim()).filter(p => p.length > 0);
      const searchResult: SearchResult = await invoke('search_files', {
        query: searchQuery,
        page: 1,
        limit: 1000000000, // A large number to get all results
        exclude: excludeArr,
        searchDepth: searchDepth === null || isNaN(searchDepth) ? null : searchDepth,
        unique: uniqueResults,
        entryType: entryType
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
      setIsExtractingAll(false);
    }
  };

  return (
    <main className="container">
      <header>
        <h1>ZipCache</h1>
        <p>Cache and search contents of large ZIP archives.</p>
      </header>

      <article>
        <header>
          <strong>1. Build Cache</strong>
        </header>
        <p>Enter the absolute path to the directory containing your .zip files.</p>
        <div className="grid">
          <input
            type="text"
            id="zip-dir-path"
            placeholder="e.g., /Users/yourname/Documents/Archives"
            value={zipDirPath}
            onChange={(e) => setZipDirPath(e.target.value)}
          />
          <button id="build-cache-btn" onClick={handleBuildCache} aria-busy={isBuildingCache} disabled={isBuildingCache}>
            Build Cache
          </button>
        </div>
      </article>

      <article>
        <header>
          <strong>2. Search Files</strong>
        </header>
        <div className="grid">
          <input
            type="search"
            id="search-query"
            placeholder="e.g., report.docx"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
          <input
            type="search"
            id="exclude-patterns"
            placeholder="Exclude patterns (e.g., *.tmp, *.log)"
            value={excludePatterns}
            onChange={(e) => setExcludePatterns(e.target.value)}
          />
          <input
            type="number"
            id="search-depth"
            placeholder="Search Depth"
            value={searchDepth === null ? '' : searchDepth}
            onChange={(e) => setSearchDepth(e.target.value === '' ? null : parseInt(e.target.value, 10))}
          />
          <select id="entry-type-select" value={entryType} onChange={(e) => setEntryType(e.target.value)}>
            <option value="all">All</option>
            <option value="file">File</option>
            <option value="folder">Folder</option>
          </select>
          <button id="search-btn" onClick={handleSearch} aria-busy={isSearching} disabled={isSearching}>
            Search
          </button>
          <label htmlFor="unique-results-checkbox">
            <input
              type="checkbox"
              id="unique-results-checkbox"
              checked={uniqueResults}
              onChange={(e) => setUniqueResults(e.target.checked)}
            />
            Show unique results
          </label>
        </div>
      </article>

      <article id="status-container" style={{ display: showStatusContainer ? 'block' : 'none' }}>
        <header><strong>Status</strong></header>
        <p id="status-messages">{statusMessage}</p>
      </article>

      <article id="results-container" style={{ display: results.length > 0 || totalResults > 0 ? 'block' : 'none' }}>
        <header>
          <strong id="results-header">Results ({totalResults})</strong>
          <div className="items-per-page-control">
            <label htmlFor="items-per-page">Items per page:</label>
            <select id="items-per-page" value={itemsPerPage} onChange={handleItemsPerPageChange}>
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="150">150</option>
              {/* <option value="all">All</option> */}
            </select>
          </div>
        </header>
        <div className="grid">
            <button
              id="bulk-extract-btn"
              onClick={handleBulkExtract}
              aria-busy={isExtractingBulk}
              disabled={selectedFiles.size === 0 || isExtractingBulk}
            >
              Bulk Extract Selected ({selectedFiles.size})
            </button>
            <button
              id="extract-all-btn"
              onClick={handleExtractAll}
              aria-busy={isExtractingAll}
              disabled={totalResults === 0 || isExtractingAll}
            >
              Extract All ({totalResults})
            </button>
          </div>
        <figure>
          <table role="grid">
            <thead>
              <tr>
                <th scope="col">
                  <input
                    type="checkbox"
                    id="select-all-checkbox"
                    checked={selectedFiles.size === results.length && results.length > 0}
                    onChange={handleSelectAllChange}
                  />
                </th>
                <th scope="col">File/Folder Name</th>
                <th scope="col">Type</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody id="results-tbody">
              {results.length === 0 && totalResults === 0 && !isSearching ? (
                <tr>
                  <td colSpan={4} style={{ textAlign: 'center' }}>No results found.</td>
                </tr>
              ) : (
                results.map((entry) => (
                  <tr key={entry.id}>
                    <td>
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(entry.id)}
                        onChange={(e) => handleFileCheckboxChange(entry.id, e.target.checked)}
                      />
                    </td>
                    <td>{entry.full_path}</td>
                    <td>{entry.is_folder ? 'Folder' : 'File'}</td>
                    <td>
                      <button
                        onClick={() => handleExtractFile(entry)}
                        className="pico-button pico-button--secondary pico-button--small"
                      >
                        Extract
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </figure>

        <nav aria-label="Pagination" className="pagination-controls">
          <ul>
            <li>
              <button onClick={handlePrevPage} role="link" disabled={currentPage === 1 || isSearching}>
                Previous
              </button>
            </li>
            <li><span id="page-info">Page {currentPage} of {totalPages}</span></li>
            <li>
              <button onClick={handleNextPage} role="link" disabled={currentPage === totalPages || totalPages === 0 || isSearching}>
                Next
              </button>
            </li>
          </ul>
        </nav>
      </article>
    </main>
  );
}

export default App;
