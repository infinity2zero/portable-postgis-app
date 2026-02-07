/** Export format (COPY-based + app-transformed). */
export type ExportFormat = 'csv' | 'text' | 'binary' | 'json' | 'sql' | 'html' | 'markdown' | 'xml';
/** Import format. */
export type ImportFormat = 'csv' | 'text' | 'binary' | 'json' | 'xml';

/** Table export/import options (pgAdmin-style COPY + wizard formats). */
export interface TableCopyOptions {
  format?: ExportFormat | ImportFormat;
  delimiter?: string;
  header?: boolean;
  quote?: string;
  escape?: string;
  nullString?: string;
  columns?: string[];
}

export interface DbBrowserLayout {
  sidebarWidth?: number;
  panel1Height?: number;
  panel2Height?: number;
  panel1Collapsed?: boolean;
  panel2Collapsed?: boolean;
  panel3Collapsed?: boolean;
  queryEditorHeight?: number;
}

export interface ElectronApi {
  startPostgres: (port: number) => Promise<{ success: boolean; error?: string }>;
  stopPostgres: () => Promise<{ success: boolean }>;
  getSettings: () => Promise<{ ports?: { postgres?: number; pgadmin?: number }; theme?: string; dbUser?: string; dbPassword?: string; dbBrowserLayout?: DbBrowserLayout; queryHistory?: string[]; firstRun?: boolean }>;
  saveSettings: (settings: { theme?: string; ports?: { postgres?: number; pgadmin?: number }; dbUser?: string; dbPassword?: string; dbBrowserLayout?: DbBrowserLayout; queryHistory?: string[]; firstRun?: boolean }) => Promise<unknown>;
  signalUiReady: () => void;
  getPostgresStatus: () => Promise<{ running: boolean }>;
  onLog: (cb: (msg: string) => void) => void;
  onServiceExit: (cb: (data: { id: string }) => void) => void;
  openExternal?: (url: string) => Promise<void>;
  wipeData?: () => Promise<unknown>;
  dbListDatabases?: () => Promise<{ rows?: string[]; error?: string }>;
  dbListRoles?: () => Promise<{ rows?: string[]; error?: string }>;
  dbListTablespaces?: () => Promise<{ rows?: string[]; error?: string }>;
  dbListExtensions?: (database: string) => Promise<{ rows?: { name: string; version: string }[]; error?: string }>;
  dbCreateDatabase?: (name: string, options?: { owner?: string }) => Promise<{ error?: string }>;
  dbListSchemas?: (database: string) => Promise<{ rows?: string[]; error?: string }>;
  dbListTables?: (database: string, schema: string) => Promise<{ rows?: string[]; error?: string }>;
  dbListViews?: (database: string, schema: string) => Promise<{ rows?: string[]; error?: string }>;
  dbListAllTablesAndViews?: (database: string) => Promise<{ rows?: { schema_name: string; table_name: string; table_type: string }[]; error?: string }>;
  dbListFunctions?: (database: string, schema: string) => Promise<{ rows?: string[]; error?: string }>;
  dbListSequences?: (database: string, schema: string) => Promise<{ rows?: string[]; error?: string }>;
  dbListColumns?: (database: string, schema: string, table: string) => Promise<{ rows?: { column_name: string; data_type: string; is_primary_key?: boolean }[]; error?: string }>;
  dbListIndexes?: (database: string, schema: string, table: string) => Promise<{ rows?: { name: string; definition?: string }[]; error?: string }>;
  dbListConstraints?: (database: string, schema: string, table: string) => Promise<{ rows?: { name: string; type: string }[]; error?: string }>;
  dbListTriggers?: (database: string, schema: string, table: string) => Promise<{ rows?: { name: string; event: string }[]; error?: string }>;
  dbListForeignKeys?: (database: string, schema: string) => Promise<{ rows?: { constraint_name: string; from_schema: string; from_table: string; from_columns: string[]; to_schema: string; to_table: string; to_columns: string[] }[]; error?: string }>;
  dbGetOverviewStats?: (database: string) => Promise<{
    error?: string;
    databaseSize?: number;
    tableCount?: number;
    indexCount?: number;
    cacheHitRatio?: number | null;
    tableHitRatio?: number | null;
    indexHitRatio?: number | null;
    tablespaces?: { name: string; size: number }[];
    topTables?: { schemaname: string; name: string; size: number }[];
    topIndexes?: { schemaname: string; table_name: string; name: string; size: number }[];
  }>;
  checkExtensions?: () => Promise<{ name: string; version: string }[]>;
  dbFetchRows?: (database: string, schema: string, table: string, limit?: number, offset?: number) => Promise<{ rows?: unknown[]; total?: number; error?: string }>;
  dbRunQuery?: (database: string, sql: string) => Promise<{ rows?: unknown[]; fields?: string[]; rowCount?: number; error?: string }>;
  dbRunScript?: (database: string, sql: string) => Promise<{ rows?: unknown[]; fields?: string[]; rowCount?: number; error?: string }>;
  dbRunExplain?: (database: string, sql: string) => Promise<{ plan?: string; error?: string }>;
  dbRunDdl?: (database: string, sql: string) => Promise<{ error?: string }>;
  dbBackupDatabase?: (database: string) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  dbRestoreDatabase?: (database: string) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  dbExportTableData?: (database: string, schema: string, table: string, options?: TableCopyOptions) => Promise<{ success?: boolean; cancelled?: boolean; error?: string }>;
  dbImportTableData?: (database: string, schema: string, table: string, options?: TableCopyOptions) => Promise<{ success?: boolean; cancelled?: boolean; error?: string }>;
  saveQueryToFile?: (content: string) => Promise<{ success: boolean; cancelled?: boolean; error?: string }>;
  loadQueryFromFile?: () => Promise<{ success: boolean; cancelled?: boolean; content?: string; error?: string }>;
  getAvailableExtensions?: () => Promise<string[]>;
  enableExtension?: (extName: string, database?: string) => Promise<{ success: boolean; error?: string }>;
  disableExtension?: (extName: string, database?: string) => Promise<{ success: boolean; error?: string }>;
}

declare global {
  interface Window {
    api?: ElectronApi;
  }
}

export function getElectronApi(): ElectronApi | undefined {
  return typeof window !== 'undefined' ? window.api : undefined;
}
