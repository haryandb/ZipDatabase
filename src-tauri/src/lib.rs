
use rusqlite::{params, Connection, Result};
use std::fs;
use zip::ZipArchive;
use log::info;

// Struct untuk menampung data yang akan dikirim ke frontend
#[derive(serde::Serialize, Debug)]
struct FileEntry {
    id: i64,
    archive_name: String,
    file_name: String,
    file_size: u64,
    compressed_size: u64,
}

// Fungsi untuk mendapatkan path database
fn get_db_path() -> String {
    // Untuk kesederhanaan, kita simpan DB di direktori saat ini.
    // Dalam aplikasi nyata, pertimbangkan untuk menggunakan tauri::api::path::app_data_dir
    "cache.sqlite".to_string()
}

#[tauri::command]
async fn build_cache(zip_dir_path: String) -> Result<(), String> {
    info!("Starting cache build from path: {}", zip_dir_path);
    let db_path = get_db_path();
    // `conn` harus mutable untuk bisa membuat transaction
    let mut conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    conn.execute(
        "CREATE TABLE IF NOT EXISTS files (
            id              INTEGER PRIMARY KEY,
            archive_name    TEXT NOT NULL,
            file_name       TEXT NOT NULL,
            file_size       INTEGER,
            compressed_size INTEGER
        )",
        [],
    ).map_err(|e| e.to_string())?;
     // Buat index untuk percepat pencarian
    conn.execute(
        "CREATE INDEX IF NOT EXISTS idx_file_name ON files (file_name)",
        [],
    ).map_err(|e| e.to_string())?;


    let paths = fs::read_dir(zip_dir_path).map_err(|e| e.to_string())?;

    for path in paths {
        let path = path.map_err(|e| e.to_string())?.path();
        if path.is_file() && path.extension().and_then(std::ffi::OsStr::to_str) == Some("zip") {
            let archive_name = path.file_name().unwrap().to_str().unwrap().to_string();
            info!("Processing archive: {}", archive_name);

            let file = fs::File::open(&path).map_err(|e| e.to_string())?;
            let mut archive = ZipArchive::new(file).map_err(|e| e.to_string())?;
            
            // Gunakan transaction untuk performa insert yang jauh lebih cepat
            let tx = conn.transaction().map_err(|e| e.to_string())?;
            
            for i in 0..archive.len() {
                let file_in_zip = archive.by_index(i).map_err(|e| e.to_string())?;
                let file_name = file_in_zip.name().to_string();

                // Hanya proses file, abaikan direktori
                if !file_in_zip.is_dir() {
                    tx.execute(
                        "INSERT INTO files (archive_name, file_name, file_size, compressed_size) VALUES (?1, ?2, ?3, ?4)",
                        params![&archive_name, &file_name, file_in_zip.size(), file_in_zip.compressed_size()],
                    ).map_err(|e| e.to_string())?;
                }
            }
            tx.commit().map_err(|e| e.to_string())?;
            info!("Finished processing archive: {}", archive_name);
        }
    }

    info!("Cache build finished successfully.");
    Ok(())
}

#[tauri::command]
async fn search_files(query: String) -> Result<Vec<FileEntry>, String> {
    info!("Searching for: {}", query);
    let db_path = get_db_path();
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut stmt = conn.prepare("SELECT id, archive_name, file_name, file_size, compressed_size FROM files WHERE file_name LIKE ?1")
        .map_err(|e| e.to_string())?;
    
    let search_query = format!("%{}%", query);
    let entries = stmt.query_map(params![search_query], |row| {
        Ok(FileEntry {
            id: row.get(0)?,
            archive_name: row.get(1)?,
            file_name: row.get(2)?,
            file_size: row.get(3)?,
            compressed_size: row.get(4)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut result = Vec::new();
    for entry in entries {
        result.push(entry.map_err(|e| e.to_string())?);
    }
    
    info!("Found {} results.", result.len());
    Ok(result)
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Inisialisasi logger
    env_logger::init();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![build_cache, search_files])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
