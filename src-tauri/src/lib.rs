// Learn more about Tauri commands at https://tauri.app/develop/calling-rust/
use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Stdio};
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
// Add nix imports for signals
#[cfg(unix)]
use nix::sys::signal::{self, Signal};
#[cfg(unix)]
use nix::unistd::Pid;
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, Runtime, State,
};
use reqwest::header::{HeaderMap, AUTHORIZATION};
use serde_json::Value;

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct MCPServerConfig {
    command: String,
    args: Vec<String>,
    #[serde(default)]
    env: std::collections::HashMap<String, String>,
    port: Option<u16>,
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct Config {
    #[serde(rename = "mcpServers")]
    mcp_servers: HashMap<String, MCPServerConfig>,
}

impl Default for Config {
    fn default() -> Self {
        Config {
            mcp_servers: HashMap::new(),
        }
    }
}

// Store for running processes and their info
struct ProcessStore {
    inner: Arc<Mutex<HashMap<String, (Arc<Mutex<Option<Child>>>, CommandInfo)>>>,
}

impl ProcessStore {
    fn new() -> Self {
        ProcessStore {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// Store for process output
struct OutputStore {
    inner: Arc<Mutex<HashMap<String, Vec<String>>>>,
}

impl OutputStore {
    fn new() -> Self {
        OutputStore {
            inner: Arc::new(Mutex::new(HashMap::new())),
        }
    }
}

// Store for configuration
struct ConfigStore(Mutex<Config>);

// Define Command Status enum
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq)]
#[serde(tag = "state", content = "data")]
pub enum CommandStatus {
    Idle,
    Starting,
    Running,
    Stopping,
    Killing,
    Finished {
        code: Option<i32>,
        success: bool,
    },
    Error {
        message: String,
    },
}

// Updated CommandInfo struct with status field
#[derive(Debug, Clone, serde::Serialize)]
struct CommandInfo {
    id: String,
    status: CommandStatus,
    // Keep these for backwards compatibility during transition
    is_running: bool,
    has_error: bool,
    process_id: Option<u32>,
    port: Option<u16>,
}

#[tauri::command]
async fn load_config<R: Runtime>(
    config_path: Option<String>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let config = if let Some(path) = config_path {
        let content =
            fs::read_to_string(path).map_err(|e| format!("Failed to read config file: {}", e))?;
        serde_json::from_str(&content).map_err(|e| format!("Failed to parse config file: {}", e))?
    } else {
        // Try to load from default location
        let app_dir = app
            .path()
            .app_config_dir()
            .map_err(|_| "Failed to get app config directory".to_string())?;
        let config_path = app_dir.join("mcp-config.json");

        if config_path.exists() {
            let content = fs::read_to_string(config_path)
                .map_err(|e| format!("Failed to read config file: {}", e))?;
            serde_json::from_str(&content)
                .map_err(|e| format!("Failed to parse config file: {}", e))?
        } else {
            Config::default()
        }
    };

    let mut store = config_store.0.lock().map_err(|e| e.to_string())?;
    *store = config.clone();
    Ok(config)
}

#[tauri::command]
async fn save_config<R: Runtime>(
    config: Config,
    config_path: Option<String>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<(), String> {
    // Update the config store with the new configuration
    {
        let mut store = config_store.0.lock().map_err(|e| e.to_string())?;
        *store = config.clone();
    }

    let config_path = if let Some(path) = config_path {
        PathBuf::from(path)
    } else {
        let app_dir = app
            .path()
            .app_config_dir()
            .map_err(|_| "Failed to get app config directory".to_string())?;
        fs::create_dir_all(&app_dir)
            .map_err(|e| format!("Failed to create config directory: {}", e))?;
        app_dir.join("mcp-config.json")
    };

    let content = serde_json::to_string_pretty(&config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(config_path, content).map_err(|e| format!("Failed to write config file: {}", e))?;

    Ok(())
}

#[tauri::command]
async fn add_server<R: Runtime>(
    name: String,
    command: String,
    args: Vec<String>,
    env: Option<HashMap<String, String>>,
    port: Option<u16>,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let mut store = config_store.0.lock().map_err(|e| e.to_string())?;

    store.mcp_servers.insert(
        name,
        MCPServerConfig {
            command,
            args,
            env: env.unwrap_or_default(),
            port,
        },
    );

    // Ensure config directory exists and save the updated config
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Failed to get app config directory".to_string())?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    let config_path = app_dir.join("mcp-config.json");
    let content = serde_json::to_string_pretty(&*store)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(config_path, content).map_err(|e| format!("Failed to write config file: {}", e))?;

    Ok(store.clone())
}

#[tauri::command]
async fn start_command(
    id: String,
    process_store: State<'_, ProcessStore>,
    config_store: State<'_, ConfigStore>,
    output_store: State<'_, OutputStore>,
) -> Result<CommandInfo, String> {
    // --- Check Preconditions (Locks held briefly) ---
    {
        let process_map = process_store.inner.lock().map_err(|e| e.to_string())?;
        if let Some((_, info)) = process_map.get(&id) {
            if info.is_running || info.status == CommandStatus::Running || info.status == CommandStatus::Starting {
                // Return the current CommandInfo if already running
                return Ok(info.clone());
            }
            // If found but not running, proceed (cleanup should happen via stop/monitor)
            println!("Found non-running entry for {}, proceeding to start.", id);
        }
        // Entry not found, proceed
    } // process_store lock released

    let server_config = {
        let config = config_store.0.lock().map_err(|e| e.to_string())?;
        config.mcp_servers.get(&id).cloned()
             .ok_or_else(|| format!("Server '{}' not found in configuration", id))?
    }; // config_store lock released

    // --- Prepare and Spawn --- 
    {
        let mut output_map = output_store.inner.lock().map_err(|e| e.to_string())?;
        output_map.insert(id.clone(), Vec::new());
    } // output_store lock released

    // First, create a CommandInfo with Starting status and insert it
    let starting_info = CommandInfo {
        id: id.clone(),
        status: CommandStatus::Starting,
        is_running: true, 
        has_error: false,
        process_id: None,
        port: server_config.port,
    };
    
    // Insert the Starting status immediately so UI can show it
    {
        let mut store = process_store.inner.lock().map_err(|e| e.to_string())?;
        // Empty child arc since we haven't spawned yet
        store.insert(id.clone(), (Arc::new(Mutex::new(None)), starting_info.clone()));
    } // process_store lock released

    let (shell, shell_arg) = if cfg!(target_os = "windows") {
        ("cmd", "/C")
    } else {
        ("sh", "-c")
    };
    let full_command = format!("{} {}", server_config.command, server_config.args.join(" "));

    let mut command = std::process::Command::new(shell);
    command
        .arg(shell_arg)
        .arg(&full_command)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if !server_config.env.is_empty() {
        command.envs(&server_config.env);
    }

    // Try to spawn the process
    let spawn_result = command.spawn();
    
    match spawn_result {
        Ok(mut child) => {
            let stdout_opt = child.stdout.take();
            let stderr_opt = child.stderr.take();
            let child_arc = Arc::new(Mutex::new(Some(child)));
    
            // Update info to Running now that process is spawned
            let command_info = CommandInfo {
                id: id.clone(),
                status: CommandStatus::Running,
                is_running: true, 
                has_error: false,
                process_id: Some(child_arc.lock().unwrap().as_ref().unwrap().id()),
                port: server_config.port,
            };
    
            // --- Spawn Helper Threads --- 
            let process_store_clone = Arc::clone(&process_store.inner);
            let output_store_clone = Arc::clone(&output_store.inner);
            let child_arc_monitor = Arc::clone(&child_arc);
            let id_clone = id.clone();
    
            thread::spawn(move || { // Monitor Thread
                let mut child_option_guard = child_arc_monitor.lock().expect("Monitor: Failed to lock child arc");
                if let Some(mut child_instance) = child_option_guard.take() {
                    drop(child_option_guard); // Release lock early
                    let status_result = child_instance.wait();
                    let (success, exit_code) = match status_result {
                         Ok(status) => {
                             let success = status.success();
                             // Provide a default exit code of 0 for successful processes with None code
                             let code = if success && status.code().is_none() {
                                 Some(0)
                             } else {
                                 status.code()
                             };
                             (success, code)
                         },
                         Err(_) => (false, None), // Treat wait error as failure
                    };
                    
                    // Update backend state
                    if let Ok(mut store) = process_store_clone.lock() {
                        if let Some((_, info)) = store.get_mut(&id_clone) {
                            info.is_running = false;
                            info.has_error = !success;
                            info.status = CommandStatus::Finished { code: exit_code, success };
                            println!("Monitor: Process {} finished. Success: {}. Exit code: {:?}. Updating state.", 
                                     id_clone, success, exit_code);
                        } else {
                            println!("Monitor: Process {} not found in store after finishing.", id_clone);
                        }
                    } else {
                         eprintln!("Monitor: Failed to lock process store for {}", id_clone);
                    }
                    
                    // Log exit status to output
                    if let Ok(mut output) = output_store_clone.lock() {
                        if let Some(lines) = output.get_mut(&id_clone) {
                            let message = match status_result {
                                Ok(_status) => format!("Process exited with status: {:?} (Success: {})", exit_code, success),
                                Err(e) => format!("Error waiting for process exit: {}", e),
                            };
                            lines.push(message);
                        }
                    } else {
                         eprintln!("Monitor: Failed to lock output store for {}", id_clone);
                    }
                } else {
                    drop(child_option_guard);
                    println!("Monitor thread: Child for {} already taken.", id_clone);
                }
            });
    
            if let Some(stdout) = stdout_opt { // Stdout Thread
                let id_clone_stdout = id.clone();
                let output_store_stdout = Arc::clone(&output_store.inner);
                thread::spawn(move || {
                    let reader = BufReader::new(stdout);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            if let Ok(mut store) = output_store_stdout.lock() {
                                if let Some(output) = store.get_mut(&id_clone_stdout) {
                                    output.push(line);
                                }
                            } else {
                                 eprintln!("Stdout thread: Failed to lock output store for {}", id_clone_stdout);
                            }
                        }
                    }
                    println!("Stdout thread finished for {}", id_clone_stdout);
                });
            }
    
            if let Some(stderr) = stderr_opt { // Stderr Thread
                let id_clone_stderr = id.clone();
                let output_store_stderr = Arc::clone(&output_store.inner);
                let process_store_stderr = Arc::clone(&process_store.inner);
                thread::spawn(move || {
                    let reader = BufReader::new(stderr);
                    for line in reader.lines() {
                        if let Ok(line) = line {
                            let mut is_first_error = false;
                            if let Ok(mut store) = process_store_stderr.lock() {
                                if let Some((_, info)) = store.get_mut(&id_clone_stderr) {
                                    if !info.has_error {
                                        info.has_error = true;
                                        is_first_error = true;
                                    }
                                }
                            } else {
                                eprintln!("Stderr thread: Failed to lock process store for {}", id_clone_stderr);
                            }
                            if is_first_error {
                                println!("Stderr thread: Set error flag for {}", id_clone_stderr);
                            }
    
                            if let Ok(mut store) = output_store_stderr.lock() {
                                if let Some(output) = store.get_mut(&id_clone_stderr) {
                                    output.push(format!("ERROR: {}", line));
                                }
                            } else {
                                eprintln!("Stderr thread: Failed to lock output store for {}", id_clone_stderr);
                            }
                        }
                    }
                    println!("Stderr thread finished for {}", id_clone_stderr);
                });
            }
    
            // --- Store Process Info (Lock briefly) ---
            {
                let mut store = process_store.inner.lock().map_err(|e| e.to_string())?;
                store.insert(id.clone(), (child_arc, command_info.clone()));
                println!("Inserted process {} into store with Running status.", id);
            } // process_store lock released
    
            Ok(command_info) // Return the updated info (status: Running)
        },
        Err(e) => {
            let error_message = format!("Failed to start command '{}': {}. Full command: {}", id, e, full_command);
            eprintln!("{}", error_message);
            
            // Create an error CommandInfo
            let error_info = CommandInfo {
                id: id.clone(),
                status: CommandStatus::Error { message: error_message.clone() },
                is_running: false,
                has_error: true,
                process_id: None,
                port: server_config.port,
            };
            
            // Store the error state
            {
                let mut store = process_store.inner.lock().map_err(|e| e.to_string())?;
                store.insert(id.clone(), (Arc::new(Mutex::new(None)), error_info.clone()));
            }
            
            // Return the error CommandInfo
            Ok(error_info)
        }
    }
}

#[tauri::command]
async fn stop_command(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let mut store_guard = process_store.inner.lock().map_err(|e| e.to_string())?;
    
    if let Some((child_arc, info)) = store_guard.get_mut(&id) {
        // Check if it's already stopped or stopping
        if !info.is_running && 
           (info.status == CommandStatus::Idle || 
            matches!(info.status, CommandStatus::Finished {..}) || 
            matches!(info.status, CommandStatus::Error {..})) {
            return Ok(info.clone());
        }
        
        println!("Graceful stop requested for: {}", id);
        
        // Update status to Stopping first
        info.status = CommandStatus::Stopping;
        let updated_info = info.clone();
        
        let child_option_guard = child_arc.lock().map_err(|e| format!("Stop: Failed to lock child arc for {}: {}", id, e))?;
        
        if let Some(child_instance) = child_option_guard.as_ref() { // Borrow without taking
             let pid = child_instance.id() as i32; // Get process ID

            #[cfg(unix)]
            {
                let os_pid = Pid::from_raw(pid);
                match signal::kill(os_pid, Signal::SIGTERM) {
                    Ok(_) => println!("Graceful stop: Sent SIGTERM to process {}.", id),
                    Err(e) => {
                        eprintln!("Graceful stop: Failed to send SIGTERM to process {}: {}", id, e);
                        // Update status to Error if signal fails
                        info.status = CommandStatus::Error { message: format!("Failed to stop: {}", e) };
                    }
                }
            }
            
            #[cfg(windows)]
            {
                // On Windows, we can't send signals directly
                println!("Graceful stop: Windows doesn't support SIGTERM. Waiting for process {} to exit.", id);
                // The monitor thread will eventually clean up
            }
            
            // We leave the monitor thread to update the final status
        } else {
            println!("Stop: Child process for {} is no longer available.", id);
            // Update status since there's no process - use exit code 0 for manual stop
            info.status = CommandStatus::Finished { code: Some(0), success: true };
            info.is_running = false;
        }
        
        // Return the updated info to client
        Ok(updated_info)
    } else {
        Err(format!("Command '{}' not found", id))
    }
}

#[tauri::command]
async fn force_kill_command(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let mut store_guard = process_store.inner.lock().map_err(|e| e.to_string())?;
    
    if let Some((child_arc, info)) = store_guard.get_mut(&id) {
        // Check if already stopped
        if !info.is_running && 
           (info.status == CommandStatus::Idle || 
            matches!(info.status, CommandStatus::Finished {..}) || 
            matches!(info.status, CommandStatus::Error {..})) {
            return Ok(info.clone());
        }
        
        println!("Force kill requested for: {}", id);
        
        // Update status to Killing first
        info.status = CommandStatus::Killing;
        let updated_info = info.clone();
        
        let mut child_option_guard = child_arc.lock().map_err(|e| format!("Force kill: Failed to lock child arc for {}: {}", id, e))?;
        
        if let Some(child_instance) = child_option_guard.as_mut() {
            #[cfg(unix)]
            {
                let pid = child_instance.id() as i32;
                let os_pid = Pid::from_raw(pid);
                match signal::kill(os_pid, Signal::SIGKILL) {
                    Ok(_) => println!("Force kill: Sent SIGKILL to process {}.", id),
                    Err(e) => {
                        eprintln!("Force kill: Failed to send SIGKILL to process {}: {}", id, e);
                        // Update status to Error if kill fails
                        info.status = CommandStatus::Error { message: format!("Failed to force kill: {}", e) };
                    }
                }
            }
            
            #[cfg(windows)]
            {
                match child_instance.kill() {
                    Ok(_) => println!("Force kill: Killed process {} on Windows.", id),
                    Err(e) => {
                        eprintln!("Force kill: Failed to kill process {} on Windows: {}", id, e);
                        // Update status to Error if kill fails
                        info.status = CommandStatus::Error { message: format!("Failed to force kill: {}", e) };
                    }
                }
            }
            
            // Don't wait here, the monitor thread will handle that
        } else {
            println!("Force kill: Child process for {} is no longer available.", id);
            // Update status since there's no process - use exit code 1 for force kill
            info.status = CommandStatus::Finished { code: Some(1), success: false };
            info.is_running = false;
        }
        
        // Return the updated info with Killing status
        Ok(updated_info)
    } else {
        Err(format!("Command '{}' not found", id))
    }
}

#[tauri::command]
async fn get_command_info(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let store = process_store.inner.lock().map_err(|e| e.to_string())?;
    if let Some((_, info)) = store.get(&id) {
        Ok(info.clone())
    } else {
        // Instead of error, return a default CommandInfo with Idle status
        Ok(CommandInfo {
            id,
            status: CommandStatus::Idle,
            is_running: false,
            has_error: false,
            process_id: None,
            port: None,
        })
    }
}

#[tauri::command]
async fn get_command_output(
    id: String,
    output_store: State<'_, OutputStore>,
) -> Result<Vec<String>, String> {
    let store = output_store.inner.lock().map_err(|e| e.to_string())?;
    if let Some(output) = store.get(&id) {
        println!(
            "Retrieved {} lines of output for command {}",
            output.len(),
            id
        );
        Ok(output.clone())
    } else {
        println!("No output found for command {}", id);
        Ok(Vec::new())
    }
}

#[tauri::command]
async fn remove_server<R: Runtime>(
    name: String,
    config_store: State<'_, ConfigStore>,
    app: tauri::AppHandle<R>,
) -> Result<Config, String> {
    let mut config = config_store.0.lock().map_err(|e| e.to_string())?;

    if config.mcp_servers.remove(&name).is_none() {
        return Err("Server not found".to_string());
    }

    // Save the updated config
    let app_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| "Failed to get app config directory".to_string())?;
    fs::create_dir_all(&app_dir)
        .map_err(|e| format!("Failed to create config directory: {}", e))?;

    let config_path = app_dir.join("mcp-config.json");
    let content = serde_json::to_string_pretty(&*config)
        .map_err(|e| format!("Failed to serialize config: {}", e))?;

    fs::write(config_path, content).map_err(|e| format!("Failed to write config file: {}", e))?;

    Ok(config.clone())
}

#[tauri::command]
async fn fetch_smithery_servers(api_key: String, search_term: Option<String>) -> Result<Value, String> {
    let base_url = "https://registry.smithery.ai/servers";
    let mut query_params = vec![("q".to_string(), "is:deployed".to_string())];
    query_params.push(("pageSize".to_string(), "20".to_string())); // Fetch more items if searching

    if let Some(term) = search_term {
        if !term.trim().is_empty() {
            // Append the search term to the existing "is:deployed" query
            query_params[0].1 = format!("{} {}", query_params[0].1, term.trim());
        }
    }

    let mut url = reqwest::Url::parse(base_url).map_err(|e| e.to_string())?;
    url.query_pairs_mut().extend_pairs(query_params.iter().map(|(k,v)| (k.as_str(), v.as_str())));

    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, format!("Bearer {}", api_key).parse().unwrap());

    let client = reqwest::Client::new();
    let res = client
        .get(url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[tauri::command]
async fn fetch_smithery_server_details(api_key: String, qualified_name: String) -> Result<Value, String> {
    let url = format!("https://registry.smithery.ai/servers/{}", qualified_name);
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, format!("Bearer {}", api_key).parse().unwrap());

    let client = reqwest::Client::new();
    let res = client
        .get(&url)
        .headers(headers)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = res.status();
    let text = res.text().await.map_err(|e| e.to_string())?;

    if !status.is_success() {
        return Err(format!("HTTP {}: {}", status, text));
    }

    serde_json::from_str(&text).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(ProcessStore::new())
        .manage(ConfigStore(Mutex::new(Config::default())))
        .manage(OutputStore::new())
        .invoke_handler(tauri::generate_handler![
            start_command,
            stop_command,
            force_kill_command,
            load_config,
            save_config,
            add_server,
            get_command_info,
            get_command_output,
            remove_server,
            fetch_smithery_servers,
            fetch_smithery_server_details,
        ])
        .setup(|app| {
            // Create menu items
            let quit = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let show = MenuItem::with_id(app, "show", "Show Window", true, None::<&str>)?;

            // Create the menu
            let menu = Menu::with_items(app, &[&show, &quit])?;

            // Create the tray icon
            let _tray = TrayIconBuilder::new()
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "quit" => {
                        app.exit(0);
                    }
                    "show" => {
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.show();
                            let _ = window.set_focus();
                        }
                    }
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
