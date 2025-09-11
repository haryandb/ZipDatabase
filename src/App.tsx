import React, { useState, useEffect, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { downloadDir } from '@tauri-apps/api/path';
import { BrowserRouter as Router, Routes, Route, Link } from 'react-router-dom';
import CachedPaths from './components/CachedPaths';

interface FileEntry {
  id: number;
  name: string;
  path: string;
  full_path: string;
  is_folder: boolean;
  zip_path: string;
  source_dir_path: string;
}

interface SearchResult {
  entries: FileEntry[];
  total_count: number;
}

function Home() {
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
        destination: downloadsPath,
        exclude: excludePatterns.split(',').map(p => p.trim()).filter(p => p.length > 0)
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
        destination: destination,
        exclude: excludePatterns.split(',').map(p => p.trim()).filter(p => p.length > 0)
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
        destination: destination,
        exclude: excludeArr
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
    <main className="p-4">
      <header className="text-center mb-8">
        <h1 className="text-4xl font-bold mb-2">ZipCache</h1>
        <p className="text-lg text-gray-600">Cache and search contents of large ZIP archives.</p>
      </header>

      <article className="bg-white shadow-md rounded-lg p-6 mb-4">
        <header className="mb-4">
          <strong className="text-xl font-semibold">1. Build Cache</strong>
        </header>
        <p className="mb-4">Enter the absolute path to the directory containing your .zip files.</p>
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <input
            type="text"
            id="zip-dir-path"
            placeholder="e.g., /Users/yourname/Documents/Archives"
            value={zipDirPath}
            onChange={(e) => setZipDirPath(e.target.value)}
            className="border border-gray-300 rounded-md p-2 flex-grow focus:ring-blue-500 focus:border-blue-500"
          />
          <button id="build-cache-btn" onClick={handleBuildCache} aria-busy={isBuildingCache} disabled={isBuildingCache}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 flex-shrink-0">
            Build Cache
          </button>
        </div>
      </article>

      <article className="bg-white shadow-md rounded-lg p-6 mb-4">
        <header className="mb-4">
          <strong className="text-xl font-semibold">2. Search Files</strong>
        </header>
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          <input
            type="search"
            id="search-query"
            placeholder="e.g., report.docx"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="border border-gray-300 rounded-md p-2 w-full focus:ring-blue-500 focus:border-blue-500"
          />
          <input
            type="search"
            id="exclude-patterns"
            placeholder="Exclude patterns (e.g., *.tmp, *.log)"
            value={excludePatterns}
            onChange={(e) => setExcludePatterns(e.target.value)}
            className="border border-gray-300 rounded-md p-2 w-full focus:ring-blue-500 focus:border-blue-500"
          />
          <input
            type="number"
            id="search-depth"
            placeholder="Search Depth"
            value={searchDepth === null ? '' : searchDepth}
            onChange={(e) => setSearchDepth(e.target.value === '' ? null : parseInt(e.target.value, 10))}
            className="border border-gray-300 rounded-md p-2 w-full focus:ring-blue-500 focus:border-blue-500"
          />
          <select id="entry-type-select" value={entryType} onChange={(e) => setEntryType(e.target.value)}
            className="border border-gray-300 rounded-md p-2 w-full focus:ring-blue-500 focus:border-blue-500"
          >
            <option value="all">All</option>
            <option value="file">File</option>
            <option value="folder">Folder</option>
          </select>
          <button id="search-btn" onClick={handleSearch} aria-busy={isSearching} disabled={isSearching}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50 inline-block">
            Search
          </button>
          <label htmlFor="unique-results-checkbox" className="flex items-center space-x-2">
            <input
              type="checkbox"
              id="unique-results-checkbox"
              checked={uniqueResults}
              onChange={(e) => setUniqueResults(e.target.checked)}
              className="form-checkbox h-5 w-5 text-blue-600"
            />
            <span>Show unique results</span>
          </label>
        </div>
      </article>

      <article id="status-container" className="bg-white shadow-md rounded-lg p-6 mb-4"
        style={{ display: showStatusContainer ? 'block' : 'none' }}>
        <header className="mb-2">
          <strong className="text-xl font-semibold">Status</strong>
        </header>
        <p id="status-messages" className="text-gray-700">{statusMessage}</p>
      </article>

      <article id="results-container" className="bg-white shadow-md rounded-lg p-6 mb-4"
        style={{ display: results.length > 0 || totalResults > 0 ? 'block' : 'none' }}>
        <header className="mb-4 flex justify-between items-center">
          <strong id="results-header" className="text-xl font-semibold">Results ({totalResults})</strong>
          <div className="items-per-page-control flex items-center space-x-2">
            <label htmlFor="items-per-page" className="text-gray-700">Items per page:</label>
            <select id="items-per-page" value={itemsPerPage} onChange={handleItemsPerPageChange}
              className="border border-gray-300 rounded-md p-1 focus:ring-blue-500 focus:border-blue-500">
              <option value="20">20</option>
              <option value="50">50</option>
              <option value="150">150</option>
              {/* <option value="all">All</option> */}
            </select>
          </div>
        </header>
        <div className="flex flex-col md:flex-row gap-4 mb-4">
          <button
            id="bulk-extract-btn"
            onClick={handleBulkExtract}
            aria-busy={isExtractingBulk}
            disabled={selectedFiles.size === 0 || isExtractingBulk}
            className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-green-500 focus:ring-opacity-50 disabled:opacity-50"
          >
            Bulk Extract Selected ({selectedFiles.size})
          </button>
          <button
            id="extract-all-btn"
            onClick={handleExtractAll}
            aria-busy={isExtractingAll}
            disabled={totalResults === 0 || isExtractingAll}
            className="bg-purple-500 hover:bg-purple-700 text-white font-bold py-2 px-4 rounded focus:outline-none focus:ring-2 focus:ring-purple-500 focus:ring-opacity-50 disabled:opacity-50"
          >
            Extract All ({totalResults})
          </button>
        </div>
        <figure className="overflow-x-auto">
          <table className="min-w-full bg-white divide-y divide-gray-200">
            <thead className="bg-gray-50">
              <tr>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider w-12">
                  <input
                    type="checkbox"
                    id="select-all-checkbox"
                    checked={selectedFiles.size === results.length && results.length > 0}
                    onChange={handleSelectAllChange}
                    className="form-checkbox h-4 w-4 text-blue-600"
                  />
                </th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">File/Folder Name</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Cache Build Path</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">Type</th>
                <th scope="col" className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">Actions</th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {results.length === 0 && totalResults === 0 && !isSearching ? (
                <tr>
                  <td colSpan={4} className="px-6 py-4 whitespace-nowrap text-center text-sm text-gray-500">No results found.</td>
                </tr>
              ) : (
                results.map((entry) => (
                  <tr key={entry.id} className="hover:bg-gray-100 even:bg-gray-50">
                    <td className="px-6 py-4 whitespace-nowrap w-12">
                      <input
                        type="checkbox"
                        checked={selectedFiles.has(entry.id)}
                        onChange={(e) => handleFileCheckboxChange(entry.id, e.target.checked)}
                        className="form-checkbox h-4 w-4 text-blue-600"
                      />
                    </td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{entry.full_path}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{entry.source_dir_path}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{entry.is_folder ? 'Folder' : 'File'}</td>
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      <button
                        onClick={() => handleExtractFile(entry)}
                        className="bg-blue-500 hover:bg-blue-700 text-white text-xs py-1 px-2 rounded focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-opacity-50"
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

        <nav aria-label="Pagination" className="flex justify-center items-center space-x-4 mt-4">
          <ul className="flex items-center space-x-2">
            <li>
              <button onClick={handlePrevPage} disabled={currentPage === 1 || isSearching}
                className="bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-2 px-4 rounded-l disabled:opacity-50">
                Previous
              </button>
            </li>
            <li><span id="page-info" className="py-2 px-4 bg-gray-100 text-gray-700">Page {currentPage} of {totalPages}</span></li>
            <li>
              <button onClick={handleNextPage} disabled={currentPage === totalPages || totalPages === 0 || isSearching}
                className="bg-gray-300 hover:bg-gray-400 text-gray-800 font-bold py-2 px-4 rounded-r disabled:opacity-50">
                Next
              </button>
            </li>
          </ul>
        </nav>
      </article>
    </main>
  );
}

function App() {
  return (
    <Router>
      <nav className="bg-gray-800 p-4 text-white">
        <ul className="flex space-x-4">
          <li>
            <Link to="/" className="hover:text-gray-300">Home</Link>
          </li>
          <li>
            <Link to="/cached-paths" className="hover:text-gray-300">Cached Paths</Link>
          </li>
        </ul>
      </nav>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/cached-paths" element={<CachedPaths />} />
      </Routes>
    </Router>
  );
}

export default App;
