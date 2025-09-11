import React, { useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

interface CachedPathInfo {
  source_dir_path: string;
  source_zip_file_path: string;
}

const CachedPaths: React.FC = () => {
  const [cachedPaths, setCachedPaths] = useState<CachedPathInfo[]>([]);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchCachedPaths = async () => {
      try {
        const data = await invoke<CachedPathInfo[]>('get_cached_paths');
        setCachedPaths(data);
      } catch (err) {
        setError(err as string);
      } finally {
        setLoading(false);
      }
    };

    fetchCachedPaths();
  }, []);

  if (loading) {
    return <div className="p-4">Loading cached paths...</div>;
  }

  if (error) {
    return <div className="p-4 text-red-500">Error: {error}</div>;
  }

  return (
    <div className="p-4">
      <h2 className="text-2xl font-bold mb-4">Cached Paths</h2>
      {cachedPaths.length === 0 ? (
        <p>No cached paths found.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full bg-white border border-gray-300">
            <thead>
              <tr>
                <th className="py-2 px-4 border-b">Source Directory Path</th>
                <th className="py-2 px-4 border-b">Source Zip File Path</th>
              </tr>
            </thead>
            <tbody>
              {cachedPaths.map((path, index) => (
                <tr key={index} className={index % 2 === 0 ? 'bg-gray-50' : ''}>
                  <td className="py-2 px-4 border-b text-sm break-all">{path.source_dir_path}</td>
                  <td className="py-2 px-4 border-b text-sm break-all">{path.source_zip_file_path}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default CachedPaths;
