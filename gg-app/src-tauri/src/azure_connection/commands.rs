use super::lifecycle::{run_mutation_with_reload, NativeDaemonReloadClient};
use super::{
    production_manager, status_after_secure_removal, AzureConnectionError, AzureConnectionStatus,
    AzureEnvironment, SaveAzureConnection,
};

#[derive(Default)]
pub(crate) struct AzureConnectionMutations(tokio::sync::Mutex<()>);

#[tauri::command]
pub(crate) fn azure_connection_status() -> Result<AzureConnectionStatus, AzureConnectionError> {
    production_manager()?.status(&AzureEnvironment::inherited())
}

#[tauri::command]
pub(crate) async fn azure_connection_save(
    app: tauri::AppHandle,
    mutations: tauri::State<'_, AzureConnectionMutations>,
    connection: SaveAzureConnection,
) -> Result<AzureConnectionStatus, AzureConnectionError> {
    let _guard = mutations.0.lock().await;
    let manager = production_manager()?;
    let reloader = NativeDaemonReloadClient::new(app);
    run_mutation_with_reload(&reloader, manager.save(connection)).await
}

#[tauri::command]
pub(crate) async fn azure_connection_remove(
    app: tauri::AppHandle,
    mutations: tauri::State<'_, AzureConnectionMutations>,
) -> Result<AzureConnectionStatus, AzureConnectionError> {
    let _guard = mutations.0.lock().await;
    let manager = production_manager()?;
    let environment = AzureEnvironment::inherited();
    let reloader = NativeDaemonReloadClient::new(app);
    run_mutation_with_reload(&reloader, async {
        manager.remove()?;
        Ok(status_after_secure_removal(&environment))
    })
    .await
}
