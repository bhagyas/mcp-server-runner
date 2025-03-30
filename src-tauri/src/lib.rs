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

#[derive(Debug, Clone, serde::Serialize)]
struct CommandInfo {
    id: String,
    is_running: bool,
    has_error: bool,
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
            if info.is_running {
                return Err(format!("Command '{}' is already running according to backend state.", id));
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

    let mut child = command.spawn().map_err(|e| {
        format!("Failed to start command '{}': {}. Full command: {}", id, e, full_command)
    })?;

    let stdout_opt = child.stdout.take();
    let stderr_opt = child.stderr.take();
    let child_arc = Arc::new(Mutex::new(Some(child)));

    // Initial info reflects the intention to run
    let command_info = CommandInfo {
        id: id.clone(),
        is_running: true, 
        has_error: false,
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
                 Ok(status) => (status.success(), status.code().unwrap_or(-1)),
                 Err(_) => (false, -1), // Treat wait error as failure
            };
            
            // Update backend state
            if let Ok(mut store) = process_store_clone.lock() {
                if let Some((_, info)) = store.get_mut(&id_clone) {
                    info.is_running = false;
                    info.has_error = !success;
                    println!("Monitor: Process {} finished. Success: {}. Updating state.", id_clone, success);
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
                        Ok(_status) => format!("Process exited with status: {}", exit_code),
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
        println!("Inserted process {} into store.", id);
    } // process_store lock released

    Ok(command_info) // Return the initial info (is_running: true)
}

#[tauri::command]
async fn stop_command(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let store_guard = process_store.inner.lock().map_err(|e| e.to_string())?;
    
    if let Some((child_arc, info)) = store_guard.get(&id) {
        println!("Graceful stop requested for: {}", id);
        
        let child_option_guard = child_arc.lock().map_err(|e| format!("Stop: Failed to lock child arc for {}: {}", id, e))?;
        
        if let Some(child_instance) = child_option_guard.as_ref() { // Borrow without taking
             let pid = child_instance.id() as i32; // Get process ID

            #[cfg(unix)]
            {
                let os_pid = Pid::from_raw(pid);
                match signal::kill(os_pid, Signal::SIGTERM) {
                    Ok(_) => println!("Graceful stop: Sent SIGTERM to process {}.", id),
                    Err(e) => eprintln!("Graceful stop: Failed to send SIGTERM to process {}: {}", id, e),
                }
            }

            #[cfg(windows)]
            {
                // On Windows, sending SIGTERM isn't directly supported by standard libraries easily.
                // We'll rely on the force_kill_command if the process doesn't exit.
                println!("Graceful stop: Requested on Windows for process {}. Relying on process self-termination or eventual force kill.", id);
                // Could potentially use winapi::um::wincon::GenerateConsoleCtrlEvent here later
            }

        } else {
            println!("Graceful stop: Child process for {} was already taken/exited.", id);
            // Return current info even if already exited, monitor will finalize state
        }
        
        // Release child lock explicitly before returning info
        drop(child_option_guard);

        // Return the *current* info. Frontend handles "Stopping..." state.
        // Monitor thread will update is_running later when process actually exits.
        println!("Graceful stop: Returning current info for {}: is_running={}, has_error={}", id, info.is_running, info.has_error);
        Ok(info.clone())

    } else {
        Err(format!("Graceful stop: Command '{}' not found in process store.", id))
    }
    // store_guard is released here
}

#[tauri::command]
async fn force_kill_command(
    id: String,
    process_store: State<'_, ProcessStore>,
) -> Result<CommandInfo, String> {
    let store_guard = process_store.inner.lock().map_err(|e| e.to_string())?;

    if let Some((child_arc, info)) = store_guard.get(&id) {
        println!("Force kill command invoked for: {}", id);

        // Lock the specific child's mutex to attempt kill
        let mut child_option_guard = child_arc.lock().map_err(|e| format!("ForceKill: Failed to lock child arc for {}: {}", id, e))?;

        if let Some(child_instance) = child_option_guard.as_mut() { // Borrow mutably without taking
            println!("ForceKill: Found child process for {}, attempting kill.", id);
            match child_instance.kill() {
                Ok(_) => println!("ForceKill: Kill signal sent successfully to process {}.", id),
                Err(e) => {
                    // Process might have already exited between check and kill
                    if e.kind() == std::io::ErrorKind::InvalidInput {
                        println!("ForceKill: Process {} likely already exited (InvalidInput on kill).", id);
                    } else {
                        // Log other kill errors but proceed, maybe it's already stopping
                        eprintln!("ForceKill: Error sending kill signal to {}: {}", id, e);
                        // We still return the current info; monitor thread handles final state.
                    }
                }
            }
        } else {
            // Child was already taken (likely by monitor thread because it exited)
            println!("ForceKill: Child process for {} was already taken/exited.", id);
        }

        // Release child lock explicitly before returning info
        drop(child_option_guard);

        // Return the *current* info. The monitor thread will update is_running later.
        println!("ForceKill: Returning current info for {}: is_running={}, has_error={}", id, info.is_running, info.has_error);
        Ok(info.clone())

    } else {
        Err(format!("ForceKill: Command '{}' not found in process store.", id))
    }
    // store_guard is released here
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
        Err("Command not found".to_string())
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
