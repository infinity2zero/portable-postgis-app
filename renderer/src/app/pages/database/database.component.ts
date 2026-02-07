import { Component, OnInit, OnDestroy, HostListener } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScrollingModule } from '@angular/cdk/scrolling';
import { MonacoEditorModule } from 'ngx-monaco-editor-v2';
import { NgxGraphModule, DagreLayout } from '@swimlane/ngx-graph';
import type { Graph, Edge, Node, Layout } from '@swimlane/ngx-graph';
import { TitleWhenTruncatedDirective } from '../../shared/title-when-truncated.directive';
import { getElectronApi } from '../../core/electron-api';
import type { DbBrowserLayout, ExportFormat, ImportFormat, TableCopyOptions } from '../../core/electron-api';
import { ThemeService } from '../../core/theme.service';

interface SchemaNode {
  name: string;
  expanded: boolean;
  tables: string[];
  views: string[];
  functions: string[];
  sequences: string[];
  loading: boolean;
  /** Collapsible sections (Tables, Views, Sequences, Functions) */
  tablesSectionExpanded: boolean;
  viewsSectionExpanded: boolean;
  sequencesSectionExpanded: boolean;
  functionsSectionExpanded: boolean;
}

export interface CreateTableColumn {
  name: string;
  type: string;
  length: string;
  nullable: boolean;
  default: string;
  primaryKey: boolean;
  unique: boolean;
  comment: string;
}

/** Context for DB explorer right-click menu */
export type ExplorerNodeType =
  | 'root'
  | 'database'
  | 'schema'
  | 'table'
  | 'view'
  | 'column'
  | 'index'
  | 'constraint'
  | 'trigger'
  | 'sequence'
  | 'function'
  | 'extension'
  | 'extension_available';

export interface ExplorerContext {
  type: ExplorerNodeType;
  schema?: string;
  table?: string;
  name?: string;
  dataType?: string;
  version?: string;
  /** Set when type is 'database' */
  database?: string;
}

/** Editor tab (Overview, Query, table/view, or ER diagram) */
export interface EditorTab {
  id: string;
  type: 'overview' | 'table' | 'query' | 'er';
  schema?: string;
  table?: string;
  database?: string;
  pinned: boolean;
  title: string;
}

const SIDEBAR_MIN = 180;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = 240;

const QUERY_EDITOR_MIN = 120;
const QUERY_EDITOR_MAX = 600;
const QUERY_EDITOR_DEFAULT = 220;

/** ER diagram: row height and header height (must match template) for column-to-column edge points */
const ER_HEADER_HEIGHT = 28;
const ER_ROW_HEIGHT = 16;
const ER_NODE_WIDTH = 220;

/** Graphlib edge label key (must match dagre/graphlib) */
const EDGE_KEY_DELIM = '\x01';
const DEFAULT_EDGE_NAME = '\x00';

/** Layout wrapper so we can receive layoutSettings and use column-to-column edges */
interface ErLayoutWrapper extends Layout {
  settings: Record<string, unknown>;
}

/** Custom layout: FK arrows column-to-column; uses node center for stable drag; respects layoutSettings for spacing */
function createErDiagramLayout(): ErLayoutWrapper {
  const layoutObj: ErLayoutWrapper = {
    settings: {},
    run(graph: Graph): Graph {
      const dagre = new DagreLayout();
      const dagreAny = dagre as unknown as { settings: Record<string, unknown>; defaultSettings: Record<string, unknown> };
      dagreAny.settings = Object.assign({}, dagreAny.defaultSettings, layoutObj.settings);
      const g = dagre.run(graph);
      for (const edge of g.edges) {
        erLayoutUpdateEdge(g, edge);
      }
      return g;
    },
    updateEdge(graph: Graph, edge: Edge): Graph {
      return erLayoutUpdateEdge(graph, edge);
    },
  };
  return layoutObj;
}

/** Edge points from source column to target column. Node position is center (ngx-graph convention). */
function erLayoutUpdateEdge(graph: Graph, edge: Edge): Graph {
  const sourceNode = graph.nodes.find((n) => n.id === edge.source);
  const targetNode = graph.nodes.find((n) => n.id === edge.target);
  const d = edge.data as { sourceColumnIndex?: number; targetColumnIndex?: number } | undefined;
  const srcCol = d?.sourceColumnIndex ?? 0;
  const tgtCol = d?.targetColumnIndex ?? 0;
  if (!sourceNode?.position || !targetNode?.position || !sourceNode.dimension || !targetNode.dimension) {
    return graph;
  }
  const sw = sourceNode.dimension.width;
  const sh = sourceNode.dimension.height;
  const tw = targetNode.dimension.width;
  const th = targetNode.dimension.height;
  const srcCenterX = sourceNode.position.x;
  const srcCenterY = sourceNode.position.y;
  const tgtCenterX = targetNode.position.x;
  const tgtCenterY = targetNode.position.y;
  const srcLeft = srcCenterX - sw / 2;
  const srcRight = srcCenterX + sw / 2;
  const srcTop = srcCenterY - sh / 2;
  const tgtLeft = tgtCenterX - tw / 2;
  const tgtRight = tgtCenterX + tw / 2;
  const tgtTop = tgtCenterY - th / 2;
  const sourceY = srcTop + ER_HEADER_HEIGHT + (srcCol + 0.5) * ER_ROW_HEIGHT;
  const targetY = tgtTop + ER_HEADER_HEIGHT + (tgtCol + 0.5) * ER_ROW_HEIGHT;
  const curveDistance = 24;
  edge.points = [
    { x: srcRight, y: sourceY },
    { x: srcRight + curveDistance, y: sourceY },
    { x: tgtLeft - curveDistance, y: targetY },
    { x: tgtLeft, y: targetY },
  ];
  const edgeLabelId = `${edge.source}${EDGE_KEY_DELIM}${edge.target}${EDGE_KEY_DELIM}${DEFAULT_EDGE_NAME}`;
  const matchingEdgeLabel = graph.edgeLabels?.[edgeLabelId];
  if (matchingEdgeLabel) {
    matchingEdgeLabel.points = edge.points;
  }
  return graph;
}

@Component({
  selector: 'app-database',
  standalone: true,
  imports: [CommonModule, FormsModule, ScrollingModule, MonacoEditorModule, NgxGraphModule, TitleWhenTruncatedDirective],
  templateUrl: './database.component.html',
  styleUrl: './database.component.scss',
})
export class DatabaseComponent implements OnInit, OnDestroy {
  /** Open tabs: Overview + query/table/ER tabs */
  openTabs: EditorTab[] = [
    { id: 'overview', type: 'overview', pinned: true, title: 'Overview' },
    { id: 'query:postgres:0', type: 'query', database: 'postgres', pinned: false, title: '~postgres Query' },
  ];
  /** ID of the currently active tab */
  activeTabId = 'overview';
  schemas: SchemaNode[] = [];
  /** All tables/views for current DB (exact casing) for IntelliSense; loaded with schemas. */
  completionTablesAndViews: { schema_name: string; table_name: string; table_type: string }[] = [];
  /** Resizable explorer sidebar width (px). */
  sidebarWidth = SIDEBAR_DEFAULT;
  /** Dragging the splitter */
  private resizing = false;
  private resizeStartX = 0;
  private resizeStartWidth = 0;
  /** Panel 1/2 vertical resize */
  private panel1Resizing = false;
  private panel2Resizing = false;
  private panel1ResizeStartY = 0;
  private panel1ResizeStartHeight = 0;
  private panel2ResizeStartY = 0;
  private panel2ResizeStartHeight = 0;
  readonly PANEL1_MIN = 80;
  readonly PANEL1_MAX = 360;
  readonly PANEL2_MIN = 100;
  readonly PANEL2_MAX = 800;
  /** Schema/table for the currently active table tab (drives data load and table-detail view) */
  selectedSchema: string | null = null;
  selectedTable: string | null = null;
  tableColumns: string[] = [];
  tableRows: unknown[] = [];
  tableTotal = 0;
  tablePage = 0;
  readonly pageSize = 100;
  /** Sub-tab for table detail: columns | indexes | constraints | triggers | data */
  tableDetailSubTab: 'columns' | 'indexes' | 'constraints' | 'triggers' | 'data' = 'columns';

  /** ER diagram tab: graph data for ngx-graph */
  erGraphNodes: { id: string; label: string; data?: { columns: { name: string; type: string; isPk: boolean; isFk?: boolean }[] }; dimension?: { width: number; height: number } }[] = [];
  erGraphLinks: { id: string; source: string; target: string; label?: string; data?: { sourceColumnIndex: number; targetColumnIndex: number } }[] = [];
  erLoading = false;
  erError = '';
  /** Overview tab: stats for the selected database */
  overviewStats: {
    databaseSize: number;
    tableCount: number;
    indexCount: number;
    cacheHitRatio: number | null;
    tableHitRatio: number | null;
    indexHitRatio: number | null;
    tablespaces: { name: string; size: number }[];
    topTables: { schemaname: string; name: string; size: number }[];
    topIndexes: { schemaname: string; table_name: string; name: string; size: number }[];
  } | null = null;
  overviewLoading = false;
  overviewError = '';

  /** Custom layout for column-to-column FK arrows */
  readonly erLayout = createErDiagramLayout();
  /** Dagre spacing so nodes don't overlap on first load (rankPadding/nodePadding in px) */
  readonly erLayoutSettings = {
    marginX: 50,
    marginY: 50,
    rankPadding: 100,
    nodePadding: 80,
    edgePadding: 60,
  };

  /** Create database wizard */
  createDbWizardOpen = false;
  createDbName = '';
  createDbOwner = '';
  createDbComment = '';
  createDbError = '';
  createDbRunning = false;

  /** Create schema dialog (replaces prompt for Electron) */
  createSchemaOpen = false;
  createSchemaName = '';
  createSchemaDatabase = '';
  createSchemaError = '';
  createSchemaRunning = false;

  /** Create table wizard */
  createTableWizardOpen = false;
  createTableWizardStep = 1;
  createTableSchema = 'public';
  createTableName = '';
  createTableComment = '';
  createTableTablespace = '';
  createTableColumns: CreateTableColumn[] = [
    { name: 'id', type: 'integer', length: '', nullable: false, default: '', primaryKey: true, unique: false, comment: '' },
  ];
  createTableError = '';
  createTableRunning = false;
  readonly createTableTypeOptions = ['integer', 'bigint', 'smallint', 'serial', 'bigserial', 'real', 'double precision', 'numeric', 'varchar(255)', 'char(50)', 'text', 'boolean', 'date', 'time', 'timestamp', 'timestamptz', 'uuid', 'jsonb', 'json'];

  /** Export table wizard (DBeaver-style) */
  exportWizardOpen = false;
  exportWizardStep = 1;
  exportTarget: { database: string; schema: string; table: string } | null = null;
  exportFormat: ExportFormat = 'csv';
  exportOptions: TableCopyOptions = { format: 'csv', header: true, delimiter: ',', nullString: '\\N' };
  exportSelectedColumns: string[] = [];
  exportRunning = false;
  exportError = '';
  readonly exportFormats: { id: ExportFormat; label: string; desc: string }[] = [
    { id: 'csv', label: 'CSV', desc: 'Comma-separated values' },
    { id: 'text', label: 'Text', desc: 'Delimited text (e.g. tab)' },
    { id: 'binary', label: 'Binary', desc: 'PostgreSQL binary COPY format' },
    { id: 'json', label: 'JSON', desc: 'JSON array of rows' },
    { id: 'sql', label: 'SQL (INSERT)', desc: 'INSERT statements' },
    { id: 'html', label: 'HTML', desc: 'HTML table' },
    { id: 'markdown', label: 'Markdown', desc: 'Markdown table' },
    { id: 'xml', label: 'XML', desc: 'XML rows' },
  ];
  /** Import table wizard */
  importWizardOpen = false;
  importWizardStep = 1;
  importTarget: { database: string; schema: string; table: string } | null = null;
  importFormat: ImportFormat = 'csv';
  importOptions: TableCopyOptions = { format: 'csv', header: true };
  importSelectedColumns: string[] = [];
  importRunning = false;
  importError = '';
  readonly importFormats: { id: ImportFormat; label: string; desc: string }[] = [
    { id: 'csv', label: 'CSV', desc: 'Comma-separated values' },
    { id: 'text', label: 'Text', desc: 'Delimited text' },
    { id: 'binary', label: 'Binary', desc: 'PostgreSQL binary COPY format' },
    { id: 'json', label: 'JSON', desc: 'JSON array of objects' },
    { id: 'xml', label: 'XML', desc: 'XML row elements' },
  ];

  loading = false;
  treeError = '';
  tableError = '';
  querySql = 'SELECT * FROM public.users LIMIT 100;';
  queryResult: { rows?: unknown[]; fields?: string[]; error?: string; rowCount?: number } | null = null;
  queryRunning = false;
  /** EXPLAIN result (plan text or error) */
  explainResult: { plan?: string; error?: string } | null = null;
  explainRunning = false;
  /** Last N queries for re-run (newest first) */
  queryHistory: string[] = [];
  readonly maxQueryHistory = 10;
  /** Output panel tab: results, messages, explain */
  queryOutputTab: 'results' | 'messages' | 'explain' = 'results';
  /** Query execution time (ms) */
  queryDurationMs: number | null = null;
  /** Per-tab state for query tabs (sql, result, output tab, etc.) */
  private queryTabState: Record<
    string,
    {
      sql: string;
      result: { rows?: unknown[]; fields?: string[]; error?: string; rowCount?: number } | null;
      outputTab: 'results' | 'messages' | 'explain';
      durationMs: number | null;
      explainResult: { plan?: string; error?: string } | null;
    }
  > = {};

  /** Monaco editor instance for Ctrl+Enter */
  private queryEditorInstance: unknown = null;
  /** Context menu for SQL editor */
  contextMenuOpen = false;
  contextMenuX = 0;
  contextMenuY = 0;
  /** Context menu for DB explorer tree */
  explorerContextMenuOpen = false;
  explorerContextMenuX = 0;
  explorerContextMenuY = 0;
  explorerContext: ExplorerContext | null = null;
  /** Context menu for ER diagram entity (table node) */
  erContextMenuOpen = false;
  erContextMenuX = 0;
  erContextMenuY = 0;
  erContextMenuNode: { id: string; label: string } | null = null;
  /** Row height for virtual scroll (px) */
  readonly queryRowHeight = 32;
  /** Resizable query editor height (px); splitter between editor and output panel */
  queryEditorHeight = QUERY_EDITOR_DEFAULT;
  private queryPanelResizing = false;
  private queryResizeStartY = 0;
  private queryResizeStartHeight = 0;

  /** Multi-database: list from server */
  databasesList: string[] = [];
  /** Currently selected database (drives tree and extensions) */
  selectedDatabase: string | null = null;
  /** Database for the currently active query tab (set when switching to a query tab; used for Run/Explain so execution always uses the right DB) */
  activeQueryTabDatabase: string | null = null;
  /** Panel 1: "Portable Postgres" connection expanded to show DB list */
  connectionExpanded = true;
  /** Panel 1/2/3 collapse state */
  panel1Collapsed = false;
  panel2Collapsed = false;
  panel3Collapsed = true;
  /** Panel 1 height (px); Panel 2 gets remaining until splitter2; Panel 3 below splitter2 */
  panel1Height = 140;
  panel2Height = 220;
  /** Live filter for tree in Panel 2 */
  treeSearchQuery = '';
  /** Panel 3: Server (cluster-wide) */
  rolesList: string[] = [];
  tablespacesList: string[] = [];
  rolesExpanded = true;
  tablespacesExpanded = false;
  /** Panel 3: Extensions for selected DB */
  extensionsExpanded = false;
  extensionsList: { name: string; version: string }[] = [];
  /** Extension names available on server (from .control files) */
  availableExtensionsList: string[] = [];
  extensionsLoading = false;
  /** Expandable tables/views: key = "schema.table", value = columns when expanded */
  expandedTableKeys: Record<string, boolean> = {};
  tableColumnsMap: Record<string, { column_name: string; data_type: string; is_primary_key?: boolean }[]> = {};
  tableIndexesMap: Record<string, { name: string; definition?: string }[]> = {};
  tableConstraintsMap: Record<string, { name: string; type: string }[]> = {};
  tableTriggersMap: Record<string, { name: string; event: string }[]> = {};
  expandedViewKeys: Record<string, boolean> = {};
  viewColumnsMap: Record<string, { column_name: string; data_type: string }[]> = {};

  private get api() {
    return getElectronApi();
  }

  /** Schemas (and their children) filtered by treeSearchQuery; empty query = all */
  get filteredSchemas(): SchemaNode[] {
    const q = this.treeSearchQuery.trim().toLowerCase();
    if (!q) return this.schemas;
    return this.schemas.map((s) => ({
      ...s,
      tables: s.tables.filter((t) => t.toLowerCase().includes(q)),
      views: s.views.filter((v) => v.toLowerCase().includes(q)),
      functions: s.functions.filter((f) => f.toLowerCase().includes(q)),
      sequences: s.sequences.filter((seq) => seq.toLowerCase().includes(q)),
    })).filter((s) =>
      s.name.toLowerCase().includes(q) ||
      s.tables.length > 0 ||
      s.views.length > 0 ||
      s.functions.length > 0 ||
      s.sequences.length > 0
    );
  }

  openCreateDbWizard(): void {
    this.createDbName = '';
    this.createDbOwner = '';
    this.createDbComment = '';
    this.createDbError = '';
    this.createDbWizardOpen = true;
  }

  closeCreateDbWizard(): void {
    this.createDbWizardOpen = false;
  }

  runCreateDatabase(): void {
    const api = this.api;
    if (!api?.dbCreateDatabase) return;
    const name = this.createDbName.trim();
    if (!name) {
      this.createDbError = 'Enter a database name.';
      return;
    }
    this.createDbError = '';
    this.createDbRunning = true;
    const options = this.createDbOwner.trim() ? { owner: this.createDbOwner.trim() } : undefined;
    api.dbCreateDatabase(name, options).then((res) => {
      this.createDbRunning = false;
      if (res.error) {
        this.createDbError = res.error;
        return;
      }
      this.closeCreateDbWizard();
      this.loadDatabases();
      this.selectedDatabase = name;
      this.loadSchemas();
      this.loadExtensionsForSelectedDb();
      const comment = this.createDbComment.trim();
      if (comment && api.dbRunDdl) {
        const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
        const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
        api.dbRunDdl(name, `COMMENT ON DATABASE ${q(name)} IS ${sqlStr(comment)};`).catch(() => {});
      }
    });
  }

  /** Monaco options for SQL editor — set once to avoid new object every CD (causes hang) */
  queryEditorOptions: {
    theme: string;
    language: string;
    automaticLayout: boolean;
    minimap: { enabled: boolean };
    fontSize: number;
    scrollBeyondLastLine: boolean;
    contextmenu: boolean;
    suggest?: { selectionMode?: string };
  } = {
    theme: 'vs',
    language: 'sql',
    automaticLayout: false,
    minimap: { enabled: false },
    fontSize: 13,
    scrollBeyondLastLine: false,
    contextmenu: false,
    suggest: { selectionMode: 'never' },
  };

  onQueryEditorInit(editor: unknown): void {
    this.queryEditorInstance = editor;
    const monacoEditor = editor as {
      addAction?: (descriptor: { id: string; label: string; keybindings: number[]; run: () => void }) => void;
      onDidContextMenu?: (fn: () => void) => { dispose: () => void };
      getContainerDomNode?: () => HTMLElement;
    };
    if (monacoEditor?.addAction) {
      monacoEditor.addAction({
        id: 'run-query',
        label: 'Run Query',
        keybindings: [2048 | 3], // Ctrl+Enter
        run: () => this.runQuery(),
      });
    }
    // Context menu: use our overlay (we'll attach contextmenu to editor wrapper in template)
    this.registerSqlCompletionProvider();
  }

  private sqlCompletionDisposable: { dispose: () => void } | null = null;

  /** Quote PostgreSQL identifier if it has mixed case or special chars so it works in SQL. */
  private quoteSqlIdentifier(name: string): string {
    if (!name) return '""';
    const needsQuotes = /[A-Z]/.test(name) || !/^[a-z_][a-z0-9_]*$/.test(name);
    return needsQuotes ? `"${String(name).replace(/"/g, '""')}"` : name;
  }

  private registerSqlCompletionProvider(): void {
    const monaco = (typeof window !== 'undefined' ? (window as unknown as { monaco?: unknown }) : undefined)?.monaco;
    if (!monaco || typeof (monaco as { languages?: { registerCompletionItemProvider?: (lang: string, provider: unknown) => { dispose: () => void } } }).languages?.registerCompletionItemProvider !== 'function') return;
    if (this.sqlCompletionDisposable) {
      this.sqlCompletionDisposable.dispose();
      this.sqlCompletionDisposable = null;
    }
    const lang = monaco as { languages: { registerCompletionItemProvider: (langId: string, provider: { triggerCharacters?: string[]; provideCompletionItems: (model: unknown, position: unknown) => { suggestions: { label: string; kind: number; insertText: string; detail?: string }[] } }) => { dispose: () => void } } };
    this.sqlCompletionDisposable = lang.languages.registerCompletionItemProvider('sql', {
      triggerCharacters: ['.', ' ', '\n'],
      provideCompletionItems: () => {
        const keywords = [
          'SELECT', 'FROM', 'WHERE', 'AND', 'OR', 'NOT', 'IN', 'EXISTS', 'JOIN', 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'ON',
          'GROUP BY', 'ORDER BY', 'HAVING', 'LIMIT', 'OFFSET', 'AS', 'DISTINCT', 'INSERT', 'INTO', 'VALUES', 'UPDATE', 'SET',
          'DELETE', 'CREATE', 'TABLE', 'VIEW', 'INDEX', 'DROP', 'ALTER', 'ADD', 'COLUMN', 'PRIMARY', 'KEY', 'FOREIGN',
          'REFERENCES', 'UNIQUE', 'NULL', 'NOT NULL', 'DEFAULT', 'CHECK', 'CONSTRAINT', 'WITH', 'RETURNING',
          'UNION', 'ALL', 'INTERSECT', 'EXCEPT', 'CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'BETWEEN', 'LIKE', 'ILIKE',
          'IS', 'TRUE', 'FALSE', 'NULL', 'CAST', 'COUNT', 'SUM', 'AVG', 'MIN', 'MAX', 'public',
        ];
        const suggestions = keywords.map((k) => ({
          label: k,
          kind: 14 as number, // Keyword
          insertText: k,
          detail: 'Keyword',
        }));
        this.schemas.forEach((s) => {
          suggestions.push({ label: s.name, kind: 9, insertText: this.quoteSqlIdentifier(s.name), detail: 'Schema' });
        });
        this.completionTablesAndViews.forEach((row) => {
          const schemaQuoted = this.quoteSqlIdentifier(row.schema_name);
          const nameQuoted = this.quoteSqlIdentifier(row.table_name);
          suggestions.push({
            label: `${row.schema_name}.${row.table_name}`,
            kind: 5,
            insertText: `${schemaQuoted}.${nameQuoted}`,
            detail: row.table_type === 'VIEW' ? 'View' : 'Table',
          });
        });
        return { suggestions };
      },
    });
  }

  onEditorContextMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.contextMenuOpen = true;
    this.contextMenuX = event.clientX;
    this.contextMenuY = event.clientY;
  }

  closeContextMenu(): void {
    this.contextMenuOpen = false;
  }

  contextMenuRun(): void {
    this.closeContextMenu();
    this.runQuery();
  }

  contextMenuExplain(): void {
    this.closeContextMenu();
    this.runExplain();
  }

  contextMenuCopy(): void {
    this.closeContextMenu();
    const ed = this.queryEditorInstance as { getModel?: () => { getValueInRange?: (r: unknown) => string }; getSelection?: () => unknown } | null;
    if (ed?.getSelection && ed?.getModel) {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (sel && model && (sel as { isEmpty?: () => boolean }).isEmpty && !(sel as { isEmpty: () => boolean }).isEmpty() && model.getValueInRange) {
        const range = sel as { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
        const text = model.getValueInRange(range);
        if (typeof navigator?.clipboard?.writeText === 'function') navigator.clipboard.writeText(text);
      } else {
        if (typeof navigator?.clipboard?.writeText === 'function') navigator.clipboard.writeText(this.querySql);
      }
    } else if (typeof navigator?.clipboard?.writeText === 'function') navigator.clipboard.writeText(this.querySql);
  }

  contextMenuPaste(): void {
    this.closeContextMenu();
    if (typeof navigator?.clipboard?.readText !== 'function') return;
    navigator.clipboard.readText().then((text) => {
      this.querySql = (this.querySql || '') + text;
    });
  }

  contextMenuSelectAll(): void {
    this.closeContextMenu();
    const ed = this.queryEditorInstance as { setSelection?: (r: unknown) => void; getModel?: () => { getLineCount?: () => number } } | null;
    if (ed?.setSelection && ed?.getModel) {
      const model = ed.getModel();
      const lineCount = model?.getLineCount?.() ?? 1;
      ed.setSelection({ startLineNumber: 1, startColumn: 1, endLineNumber: lineCount, endColumn: 999 });
    }
  }

  constructor(private themeService: ThemeService) {
    this.queryEditorOptions = {
      ...this.queryEditorOptions,
      theme: this.themeService.effectiveTheme === 'dark' ? 'vs-dark' : 'vs',
    };
  }

  ngOnInit(): void {
    this.loadLayoutFromSettings();
    this.loadDatabases();
    this.loadRolesAndTablespaces();
    this.queryTabState['query:postgres:0'] = {
      sql: 'SELECT * FROM pg_tables LIMIT 10;',
      result: null,
      outputTab: 'results',
      durationMs: null,
      explainResult: null,
    };
  }

  loadLayoutFromSettings(): void {
    const api = this.api;
    if (!api?.getSettings) return;
    api.getSettings().then((s) => {
      const layout = (s as { dbBrowserLayout?: DbBrowserLayout }).dbBrowserLayout;
      if (layout) {
        if (typeof layout.sidebarWidth === 'number' && layout.sidebarWidth >= SIDEBAR_MIN && layout.sidebarWidth <= SIDEBAR_MAX) this.sidebarWidth = layout.sidebarWidth;
        if (typeof layout.panel1Height === 'number') this.panel1Height = Math.max(this.PANEL1_MIN, Math.min(this.PANEL1_MAX, layout.panel1Height));
        if (typeof layout.panel2Height === 'number') this.panel2Height = Math.max(this.PANEL2_MIN, Math.min(this.PANEL2_MAX, layout.panel2Height));
        if (typeof layout.panel1Collapsed === 'boolean') this.panel1Collapsed = layout.panel1Collapsed;
        if (typeof layout.panel2Collapsed === 'boolean') this.panel2Collapsed = layout.panel2Collapsed;
        if (typeof layout.panel3Collapsed === 'boolean') this.panel3Collapsed = layout.panel3Collapsed;
        if (typeof layout.queryEditorHeight === 'number') this.queryEditorHeight = Math.max(QUERY_EDITOR_MIN, Math.min(QUERY_EDITOR_MAX, layout.queryEditorHeight));
      }
      if (Array.isArray((s as { queryHistory?: string[] }).queryHistory)) {
        this.queryHistory = ((s as { queryHistory: string[] }).queryHistory)
          .filter((q) => typeof q === 'string')
          .slice(0, this.maxQueryHistory);
      }
    });
  }

  saveLayoutToSettings(): void {
    const api = this.api;
    if (!api?.saveSettings) return;
    const layout: DbBrowserLayout = {
      sidebarWidth: this.sidebarWidth,
      panel1Height: this.panel1Height,
      panel2Height: this.panel2Height,
      panel1Collapsed: this.panel1Collapsed,
      panel2Collapsed: this.panel2Collapsed,
      panel3Collapsed: this.panel3Collapsed,
      queryEditorHeight: this.queryEditorHeight,
    };
    api.saveSettings({ dbBrowserLayout: layout });
  }

  togglePanel1(): void {
    this.panel1Collapsed = !this.panel1Collapsed;
    this.saveLayoutToSettings();
  }
  togglePanel2(): void {
    this.panel2Collapsed = !this.panel2Collapsed;
    this.saveLayoutToSettings();
  }
  togglePanel3(): void {
    this.panel3Collapsed = !this.panel3Collapsed;
    this.saveLayoutToSettings();
  }

  ngOnDestroy(): void {
    if (this.sqlCompletionDisposable) {
      this.sqlCompletionDisposable.dispose();
      this.sqlCompletionDisposable = null;
    }
  }

  loadDatabases(): void {
    const api = this.api;
    if (!api?.dbListDatabases) {
      this.databasesList = [];
      return;
    }
    api.dbListDatabases().then((res) => {
      const list = res.error ? [] : (res.rows || []);
      this.databasesList = Array.isArray(list) ? list : [];
      if (!this.selectedDatabase && this.databasesList.length > 0) {
        this.selectedDatabase = this.databasesList.includes('postgres') ? 'postgres' : this.databasesList[0];
        this.loadSchemas();
        this.loadExtensionsForSelectedDb();
        if (this.activeTabId === 'overview') this.loadOverviewStats();
      }
    });
  }

  loadSchemas(): void {
    const db = this.selectedDatabase;
    const api = this.api;
    if (!db || !api?.dbListSchemas) {
      if (!db) this.treeError = '';
      else if (!api?.dbListSchemas) this.treeError = 'Database browser not available.';
      this.schemas = [];
      this.completionTablesAndViews = [];
      return;
    }
    this.treeError = '';
    this.loading = true;
    api.dbListSchemas(db).then((res) => {
      this.loading = false;
      if (res.error) {
        this.treeError = res.error;
        this.schemas = [];
        this.completionTablesAndViews = [];
        return;
      }
      this.schemas = (res.rows || []).map((name: string) => ({
        name,
        expanded: false,
        tables: [],
        views: [],
        functions: [],
        sequences: [],
        loading: false,
        tablesSectionExpanded: true,
        viewsSectionExpanded: true,
        sequencesSectionExpanded: true,
        functionsSectionExpanded: true,
      }));
      this.loadCompletionTablesAndViews();
    });
  }

  /** Load all tables/views for current DB (exact casing) for query editor IntelliSense. */
  private loadCompletionTablesAndViews(): void {
    const db = this.selectedDatabase;
    const api = this.api?.dbListAllTablesAndViews;
    if (!db || !api) {
      this.completionTablesAndViews = [];
      return;
    }
    api(db).then((res) => {
      this.completionTablesAndViews = (res.rows || []) as { schema_name: string; table_name: string; table_type: string }[];
    }).catch(() => {
      this.completionTablesAndViews = [];
    });
  }

  /** Select database and reload tree + panel 3 extensions. If the active tab is a query tab for the previous DB, close it and replace with a query tab for the new DB. */
  selectDatabase(db: string): void {
    if (this.selectedDatabase === db) return;
    const prevDb = this.selectedDatabase;
    const activeTab = this.getTabById(this.activeTabId);
    const wasQueryTabForPrevDb = activeTab?.type === 'query' && activeTab.database === prevDb;

    this.selectedDatabase = db;
    this.expandedTableKeys = {};
    this.tableColumnsMap = {};
    this.tableIndexesMap = {};
    this.tableConstraintsMap = {};
    this.tableTriggersMap = {};
    this.expandedViewKeys = {};
    this.viewColumnsMap = {};
    this.schemas = this.schemas.map((s) => ({
      ...s,
      expanded: false,
      tables: [],
      views: [],
      functions: [],
      sequences: [],
      loading: false,
    }));
    this.loadSchemas();
    this.loadExtensionsForSelectedDb();
    if (this.activeTabId === 'overview') this.loadOverviewStats();

    // When switching DB: if query tool was open for the previous DB, close it and show query tool for the new DB
    if (wasQueryTabForPrevDb && this.activeTabId) {
      this.closeTab(this.activeTabId);
      const existingQueryForNewDb = this.openTabs.find((t) => t.type === 'query' && t.database === db);
      if (existingQueryForNewDb) {
        this.selectTab(existingQueryForNewDb.id);
      } else {
        this.openNewQueryTab(db);
      }
    }
  }

  loadRolesAndTablespaces(): void {
    const api = this.api;
    if (api?.dbListRoles) {
      api.dbListRoles().then((res) => {
        this.rolesList = res.error ? [] : (res.rows || []);
      });
    }
    if (api?.dbListTablespaces) {
      api.dbListTablespaces().then((res) => {
        this.tablespacesList = res.error ? [] : (res.rows || []);
      });
    }
  }

  loadExtensionsForSelectedDb(): void {
    const db = this.selectedDatabase;
    const api = this.api;
    if (!db || !api?.dbListExtensions) {
      this.extensionsList = [];
      this.availableExtensionsList = [];
      return;
    }
    this.extensionsLoading = true;
    const loadEnabled = api.dbListExtensions(db).then((res) => (res as { rows?: { name: string; version: string }[] })?.rows ?? []);
    const loadAvailable = api.getAvailableExtensions?.() ?? Promise.resolve([]);
    Promise.all([loadEnabled, loadAvailable]).then(([rows, available]) => {
      this.extensionsLoading = false;
      this.extensionsList = rows;
      this.availableExtensionsList = Array.isArray(available) ? available : [];
    }).catch(() => {
      this.extensionsLoading = false;
      this.extensionsList = [];
      this.availableExtensionsList = [];
    });
  }

  /** Extension names that are available on server but not enabled in the selected DB */
  get availableNotEnabled(): string[] {
    const enabledSet = new Set(this.extensionsList.map((e) => e.name));
    return this.availableExtensionsList.filter((n) => !enabledSet.has(n));
  }

  toggleSchema(schema: SchemaNode): void {
    if (schema.expanded) {
      this.schemas = this.schemas.map((s) =>
        s.name === schema.name ? { ...s, expanded: false } : s
      );
      return;
    }
    const db = this.selectedDatabase;
    if (!db) return;
    const api = this.api;
    this.schemas = this.schemas.map((s) =>
      s.name === schema.name ? { ...s, expanded: true, loading: true } : s
    );
    const schemaName = schema.name;
    const promises: Promise<{ rows?: string[] }>[] = [];
    if (api?.dbListTables) promises.push(api.dbListTables(db, schemaName));
    else promises.push(Promise.resolve({ rows: [] }));
    if (api?.dbListViews) promises.push(api.dbListViews(db, schemaName));
    else promises.push(Promise.resolve({ rows: [] }));
    if (api?.dbListFunctions) promises.push(api.dbListFunctions(db, schemaName));
    else promises.push(Promise.resolve({ rows: [] }));
    if (api?.dbListSequences) promises.push(api.dbListSequences(db, schemaName));
    else promises.push(Promise.resolve({ rows: [] }));

    type DbListResult = { rows?: string[]; error?: string };
    Promise.all(promises).then(([tablesRes, viewsRes, functionsRes, sequencesRes]) => {
      const t = tablesRes as DbListResult;
      const v = viewsRes as DbListResult;
      const f = functionsRes as DbListResult;
      const seq = sequencesRes as DbListResult;
      this.schemas = this.schemas.map((s) =>
        s.name === schemaName
          ? {
              ...s,
              loading: false,
              tables: t.error ? [] : (t.rows || []),
              views: v.error ? [] : (v.rows || []),
              functions: f.error ? [] : (f.rows || []),
              sequences: seq.error ? [] : (seq.rows || []),
              tablesSectionExpanded: s.tablesSectionExpanded ?? true,
              viewsSectionExpanded: s.viewsSectionExpanded ?? true,
              sequencesSectionExpanded: s.sequencesSectionExpanded ?? true,
              functionsSectionExpanded: s.functionsSectionExpanded ?? true,
            }
          : s
      );
    });
  }

  toggleConnection(): void {
    this.connectionExpanded = !this.connectionExpanded;
  }

  toggleExtensions(): void {
    if (this.extensionsExpanded) {
      this.extensionsExpanded = false;
      return;
    }
    this.extensionsExpanded = true;
    this.loadExtensionsForSelectedDb();
  }

  tableKey(schema: string, table: string): string {
    return `${schema}.${table}`;
  }

  isTableExpanded(schema: string, table: string): boolean {
    return !!this.expandedTableKeys[this.tableKey(schema, table)];
  }

  isViewExpanded(schema: string, view: string): boolean {
    return !!this.expandedViewKeys[this.tableKey(schema, view)];
  }

  toggleTable(schema: string, table: string): void {
    const db = this.selectedDatabase;
    if (!db) return;
    const key = this.tableKey(schema, table);
    if (this.expandedTableKeys[key]) {
      this.expandedTableKeys = { ...this.expandedTableKeys, [key]: false };
      return;
    }
    this.expandedTableKeys = { ...this.expandedTableKeys, [key]: true };
    const api = this.api;
    const hasData =
      this.tableColumnsMap[key] &&
      this.tableIndexesMap[key] !== undefined &&
      this.tableConstraintsMap[key] !== undefined &&
      this.tableTriggersMap[key] !== undefined;
    if (hasData) return;
    const promises: Promise<void>[] = [];
    if (!this.tableColumnsMap[key] && api?.dbListColumns) {
      promises.push(
        api.dbListColumns(db, schema, table).then((res) => {
          const rows = res.error ? [] : (res.rows || []);
          this.tableColumnsMap = { ...this.tableColumnsMap, [key]: rows };
        })
      );
    }
    if (this.tableIndexesMap[key] === undefined && api?.dbListIndexes) {
      promises.push(
        api.dbListIndexes(db, schema, table).then((res) => {
          const rows = res.error ? [] : (res.rows || []);
          this.tableIndexesMap = { ...this.tableIndexesMap, [key]: rows };
        })
      );
    }
    if (this.tableConstraintsMap[key] === undefined && api?.dbListConstraints) {
      promises.push(
        api.dbListConstraints(db, schema, table).then((res) => {
          const rows = res.error ? [] : (res.rows || []);
          this.tableConstraintsMap = { ...this.tableConstraintsMap, [key]: rows };
        })
      );
    }
    if (this.tableTriggersMap[key] === undefined && api?.dbListTriggers) {
      promises.push(
        api.dbListTriggers(db, schema, table).then((res) => {
          const rows = res.error ? [] : (res.rows || []);
          this.tableTriggersMap = { ...this.tableTriggersMap, [key]: rows };
        })
      );
    }
    if (!api?.dbListIndexes) this.tableIndexesMap = { ...this.tableIndexesMap, [key]: [] };
    if (!api?.dbListConstraints) this.tableConstraintsMap = { ...this.tableConstraintsMap, [key]: [] };
    if (!api?.dbListTriggers) this.tableTriggersMap = { ...this.tableTriggersMap, [key]: [] };
  }

  toggleView(schema: string, view: string): void {
    const db = this.selectedDatabase;
    if (!db) return;
    const key = this.tableKey(schema, view);
    if (this.expandedViewKeys[key]) {
      this.expandedViewKeys = { ...this.expandedViewKeys, [key]: false };
      return;
    }
    this.expandedViewKeys = { ...this.expandedViewKeys, [key]: true };
    if (this.viewColumnsMap[key]) return;
    const api = this.api;
    if (!api?.dbListColumns) return;
    api.dbListColumns(db, schema, view).then((res) => {
      const rows = res.error ? [] : (res.rows || []);
      this.viewColumnsMap = { ...this.viewColumnsMap, [key]: rows };
    });
  }

  getTableColumns(schema: string, table: string): { column_name: string; data_type: string; is_primary_key?: boolean }[] {
    return this.tableColumnsMap[this.tableKey(schema, table)] || [];
  }

  getTableIndexes(schema: string, table: string): { name: string; definition?: string }[] {
    return this.tableIndexesMap[this.tableKey(schema, table)] ?? [];
  }

  getTableConstraints(schema: string, table: string): { name: string; type: string }[] {
    return this.tableConstraintsMap[this.tableKey(schema, table)] ?? [];
  }

  getTableTriggers(schema: string, table: string): { name: string; event: string }[] {
    return this.tableTriggersMap[this.tableKey(schema, table)] ?? [];
  }

  getViewColumns(schema: string, view: string): { column_name: string; data_type: string }[] {
    return this.viewColumnsMap[this.tableKey(schema, view)] || [];
  }

  toggleSchemaSection(schema: SchemaNode, section: 'tables' | 'views' | 'sequences' | 'functions'): void {
    this.schemas = this.schemas.map((s) => {
      if (s.name !== schema.name) return s;
      switch (section) {
        case 'tables': return { ...s, tablesSectionExpanded: !s.tablesSectionExpanded };
        case 'views': return { ...s, viewsSectionExpanded: !s.viewsSectionExpanded };
        case 'sequences': return { ...s, sequencesSectionExpanded: !s.sequencesSectionExpanded };
        case 'functions': return { ...s, functionsSectionExpanded: !s.functionsSectionExpanded };
        default: return s;
      }
    });
  }

  isSectionExpanded(schema: SchemaNode, section: 'tables' | 'views' | 'sequences' | 'functions'): boolean {
    switch (section) {
      case 'tables': return schema.tablesSectionExpanded ?? true;
      case 'views': return schema.viewsSectionExpanded ?? true;
      case 'sequences': return schema.sequencesSectionExpanded ?? true;
      case 'functions': return schema.functionsSectionExpanded ?? true;
      default: return true;
    }
  }

  /** Get tab by id */
  getTabById(id: string): EditorTab | undefined {
    return this.openTabs.find((t) => t.id === id);
  }

  /** True if the active tab is the overview tab */
  get isOverviewActive(): boolean {
    return this.activeTabId === 'overview';
  }

  /** Load overview stats for the selected database (size, hit rates, tablespaces, top tables/indexes) */
  loadOverviewStats(): void {
    const db = this.selectedDatabase ?? 'postgres';
    const api = this.api?.dbGetOverviewStats;
    if (!api) return;
    this.overviewLoading = true;
    this.overviewError = '';
    this.overviewStats = null;
    api(db).then((res) => {
      this.overviewLoading = false;
      if (res.error) {
        this.overviewError = res.error;
        return;
      }
      this.overviewStats = {
        databaseSize: res.databaseSize ?? 0,
        tableCount: res.tableCount ?? 0,
        indexCount: res.indexCount ?? 0,
        cacheHitRatio: res.cacheHitRatio ?? null,
        tableHitRatio: res.tableHitRatio ?? null,
        indexHitRatio: res.indexHitRatio ?? null,
        tablespaces: res.tablespaces ?? [],
        topTables: res.topTables ?? [],
        topIndexes: res.topIndexes ?? [],
      };
    }).catch(() => {
      this.overviewLoading = false;
      this.overviewError = 'Failed to load overview stats';
    });
  }

  /** Format bytes for display */
  formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + ['B', 'KB', 'MB', 'GB', 'TB'][i];
  }

  /** Pie chart segments from size array (label, size, SVG path for slice). cx=50, cy=50, r=45. */
  getPieSegments(items: { name: string; size: number }[], maxSlices = 6): { label: string; size: number; path: string; color: string }[] {
    const total = items.reduce((s, i) => s + i.size, 0);
    if (total === 0) return [];
    const colors = ['var(--color-primary)', 'var(--color-success)', 'var(--color-info)', 'var(--color-warning)', 'var(--color-teal-600)', 'var(--color-slate-500)'];
    const take = items.slice(0, maxSlices);
    const rest = items.length > maxSlices ? items.slice(maxSlices).reduce((s, i) => s + i.size, 0) : 0;
    const segments = take.map((i, idx) => ({ label: i.name, size: i.size, color: colors[idx % colors.length] }));
    if (rest > 0) segments.push({ label: 'Others', size: rest, color: colors[colors.length - 1] });
    const cx = 50; const cy = 50; const r = 45;
    let startAngle = -Math.PI / 2;
    const total2 = segments.reduce((s, i) => s + i.size, 0);
    return segments.map((seg) => {
      const sweep = (seg.size / total2) * 2 * Math.PI;
      const endAngle = startAngle + sweep;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const large = sweep > Math.PI ? 1 : 0;
      const path = `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
      startAngle = endAngle;
      return { ...seg, path };
    });
  }

  /** Max size for bar chart scale (from top tables or top indexes). */
  getOverviewBarMax(items: { size: number }[]): number {
    if (!items.length) return 1;
    return Math.max(...items.map((i) => i.size), 1);
  }

  /** Pie segments for table size distribution (from overviewStats.topTables). */
  getOverviewTablePieSegments(): { label: string; size: number; path: string; color: string }[] {
    if (!this.overviewStats?.topTables?.length) return [];
    const items = this.overviewStats.topTables.map((t) => ({ name: `${t.schemaname}.${t.name}`, size: t.size }));
    return this.getPieSegments(items);
  }

  /** True if the active tab is the query tab */
  get isQueryActive(): boolean {
    return this.getTabById(this.activeTabId)?.type === 'query';
  }

  /** Database for Run/Explain and toolbar label. When on query tab use that tab's DB, else tree selection. */
  get activeQueryDatabase(): string {
    return this.getQueryRunDatabase();
  }

  /** True if the active tab is a table/view tab */
  get isTableTabActive(): boolean {
    const t = this.getTabById(this.activeTabId);
    return t?.type === 'table';
  }

  /** Active ER diagram tab (if any) */
  get activeErTab(): EditorTab | undefined {
    const t = this.getTabById(this.activeTabId);
    return t?.type === 'er' ? t : undefined;
  }

  /** True if the active tab is an ER diagram tab */
  get isErTabActive(): boolean {
    return !!this.activeErTab;
  }

  /** Close a tab (only Overview cannot be closed) */
  closeTab(id: string, event?: MouseEvent): void {
    if (event) event.stopPropagation();
    const tab = this.getTabById(id);
    if (!tab || tab.type === 'overview') return;
    const idx = this.openTabs.findIndex((t) => t.id === id);
    if (idx === -1) return;
    if (tab.type === 'query') delete this.queryTabState[id];
    this.openTabs = this.openTabs.filter((t) => t.id !== id);
    if (this.activeTabId === id) {
      const next = this.openTabs[Math.min(idx, this.openTabs.length - 1)];
      this.selectTab(next?.id ?? 'overview');
    }
  }

  /** Toggle pin state of a tab */
  pinTab(id: string, event?: MouseEvent): void {
    if (event) event.stopPropagation();
    this.openTabs = this.openTabs.map((t) =>
      t.id === id ? { ...t, pinned: !t.pinned } : t
    );
  }

  /** Switch to a tab by id; for table tabs loads that table's data; for ER tab loads diagram; for query tab loads its state */
  selectTab(id: string): void {
    const tab = this.getTabById(id);
    if (!tab) return;

    const prevId = this.activeTabId;
    const prevTab = this.getTabById(prevId);
    if (prevTab?.type === 'query') this.saveQueryTabState(prevId);

    this.activeTabId = id;
    if (tab.type === 'query') {
      // Same context as table tab: sync selectedDatabase from tab so Run and IntelliSense use it (like loadTableRows uses selectedDatabase).
      const tabDb = tab.database ?? (tab.id.startsWith('query:') ? tab.id.split(':')[1] : null) ?? this.selectedDatabase ?? 'postgres';
      this.selectedDatabase = tabDb;
      this.loadSchemas();
      this.loadExtensionsForSelectedDb();
      this.loadQueryTabState(id);
      this.layoutQueryEditor();
    } else {
      if (tab.type === 'table' && tab.schema && tab.table) {
        if (tab.database) this.selectedDatabase = tab.database;
        this.selectedSchema = tab.schema;
        this.selectedTable = tab.table;
        this.tableError = '';
        this.tablePage = 0;
        this.ensureTableMetadataLoaded(tab.schema, tab.table);
        this.loadTableRows();
      } else if (tab?.type === 'er') {
        this.loadErDiagram();
      } else if (id === 'overview' && this.selectedDatabase) {
        this.loadOverviewStats();
      }
    }
  }

  private saveQueryTabState(tabId: string): void {
    this.queryTabState[tabId] = {
      sql: this.querySql ?? '',
      result: this.queryResult,
      outputTab: this.queryOutputTab,
      durationMs: this.queryDurationMs,
      explainResult: this.explainResult,
    };
  }

  private loadQueryTabState(tabId: string): void {
    const state = this.queryTabState[tabId];
    if (state) {
      this.querySql = state.sql;
      this.queryResult = state.result;
      this.queryOutputTab = state.outputTab;
      this.queryDurationMs = state.durationMs;
      this.explainResult = state.explainResult;
    } else {
      const defaultSql = 'SELECT 1;';
      this.queryTabState[tabId] = {
        sql: defaultSql,
        result: null,
        outputTab: 'results',
        durationMs: null,
        explainResult: null,
      };
      this.querySql = defaultSql;
      this.queryResult = null;
      this.queryOutputTab = 'results';
      this.queryDurationMs = null;
      this.explainResult = null;
    }
  }

  /** Open a new query tab for the given database (or selected DB). Call from toolbar or DB context menu. */
  openNewQueryTab(database?: string): void {
    const db = database ?? this.selectedDatabase ?? 'postgres';
    const existing = this.openTabs.filter((t) => t.type === 'query' && t.database === db);
    const title = existing.length === 0 ? `~${db} Query` : `~${db} Query ${existing.length + 1}`;
    const tabId = `query:${db}:${Date.now()}`;
    const tab: EditorTab = { id: tabId, type: 'query', database: db, pinned: false, title };
    this.openTabs = [...this.openTabs, tab];
    this.selectTab(tabId);
  }

  /** Open or focus ER diagram tab (schema scope, or table scope when table is provided) */
  openErTab(schema: string, table?: string): void {
    const db = this.selectedDatabase ?? 'postgres';
    const tabId = table ? `er:${db}:${schema}.${table}` : `er:${db}:${schema}`;
    let tab = this.getTabById(tabId);
    if (!tab) {
      tab = {
        id: tabId,
        type: 'er',
        schema,
        table,
        database: db,
        pinned: false,
        title: table ? `ER: ${schema}.${table}` : `ER: ${schema}`,
      };
      this.openTabs = [...this.openTabs, tab];
    }
    this.selectTab(tabId);
  }

  /** Load ER diagram data for the active ER tab */
  loadErDiagram(): void {
    const tab = this.activeErTab;
    const db = this.selectedDatabase;
    const api = this.api;
    if (!tab || !db || !tab.schema || !api?.dbListTables || !api?.dbListForeignKeys) {
      this.erGraphNodes = [];
      this.erGraphLinks = [];
      return;
    }
    const schema = tab.schema;
    const scopeTable = tab.table;
    this.erError = '';
    this.erLoading = true;
    this.erGraphNodes = [];
    this.erGraphLinks = [];

    const tablesPromise = api.dbListTables(db, schema).then((r) => (r.error ? [] : (r.rows || [])));
    const fkPromise = api.dbListForeignKeys(db, schema).then((r) => (r.error ? [] : (r.rows || [])));

    Promise.all([tablesPromise, fkPromise]).then(([tableNames, fkRows]) => {
      let tablesToShow = new Set<string>(tableNames as string[]);
      if (scopeTable) {
        const related = new Set<string>([scopeTable]);
        const fkList = fkRows as { from_table: string; to_table: string }[];
        let changed = true;
        while (changed) {
          changed = false;
          for (const fk of fkList) {
            if (related.has(fk.from_table) && !related.has(fk.to_table)) {
              related.add(fk.to_table);
              changed = true;
            }
            if (related.has(fk.to_table) && !related.has(fk.from_table)) {
              related.add(fk.from_table);
              changed = true;
            }
          }
        }
        tablesToShow = related;
      }

      const columnPromises = Array.from(tablesToShow).map((t) =>
        api.dbListColumns!(db, schema, t).then((res) => ({
          table: t,
          columns: res.error ? [] : (res.rows || []).map((row: { column_name: string; data_type: string; is_primary_key?: boolean }) => ({
            name: row.column_name,
            type: row.data_type,
            isPk: !!row.is_primary_key,
          })),
        }))
      );

      Promise.all(columnPromises).then((tableColumns) => {
        const nodeId = (t: string) => `${schema}.${t}`;
        const tableToColumns = new Map<string | number, { name: string; type: string; isPk: boolean; isFk?: boolean }[]>();
        const nodes = tableColumns.map(({ table, columns }, idx) => {
          const colList = columns.map((c) => ({ ...c, isFk: false as boolean }));
          tableToColumns.set(nodeId(table), colList);
          const height = ER_HEADER_HEIGHT + Math.max(1, colList.length) * ER_ROW_HEIGHT;
          return {
            id: nodeId(table),
            label: table,
            data: { columns: colList, colorIndex: idx % 8 },
            dimension: { width: ER_NODE_WIDTH, height },
          };
        });
        const fkList = fkRows as { from_table: string; to_table: string; from_columns: string[]; to_columns: string[]; constraint_name: string }[];
        const links = fkList
          .filter((fk) => tablesToShow.has(fk.from_table) && tablesToShow.has(fk.to_table))
          .map((fk, i) => {
            const srcId = nodeId(fk.from_table);
            const tgtId = nodeId(fk.to_table);
            const srcCols = tableToColumns.get(srcId) ?? [];
            const tgtCols = tableToColumns.get(tgtId) ?? [];
            const sourceColumnIndex = Math.max(0, srcCols.findIndex((c) => c.name === fk.from_columns?.[0]));
            const targetColumnIndex = Math.max(0, tgtCols.findIndex((c) => c.name === fk.to_columns?.[0]));
            fk.from_columns?.forEach((colName) => {
              const col = srcCols.find((c) => c.name === colName);
              if (col) col.isFk = true;
            });
            return {
              id: `fk-${i}-${fk.constraint_name}`,
              source: srcId,
              target: tgtId,
              label: fk.from_columns.join(', ') + ' → ' + fk.to_columns.join(', '),
              data: { sourceColumnIndex, targetColumnIndex },
            };
          });
        this.erGraphNodes = nodes;
        this.erGraphLinks = links;
        this.erLoading = false;
      }).catch((err) => {
        this.erError = err?.message || 'Failed to load diagram';
        this.erLoading = false;
      });
    }).catch((err) => {
      this.erError = err?.message || 'Failed to load diagram';
      this.erLoading = false;
    });
  }

  /** Open table (called on double-click or from ER context menu) */
  onErNodeSelect(event: { node: { id: string; label: string } }): void {
    const id = event?.node?.id;
    if (!id) return;
    this.erOpenTableByNodeId(id);
  }

  private erOpenTableByNodeId(id: string): void {
    const parts = id.split('.');
    if (parts.length >= 2) {
      const schema = parts[0];
      const table = parts.slice(1).join('.');
      this.selectTable(schema, table);
    }
  }

  onErContextMenu(event: MouseEvent, node: { id: string; label: string }): void {
    event.preventDefault();
    event.stopPropagation();
    this.erContextMenuNode = node;
    this.erContextMenuOpen = true;
    this.erContextMenuX = event.clientX;
    this.erContextMenuY = event.clientY;
  }

  closeErContextMenu(): void {
    this.erContextMenuOpen = false;
    this.erContextMenuNode = null;
  }

  erOpenTableFromContextMenu(): void {
    const node = this.erContextMenuNode;
    if (!node?.id) return;
    this.erOpenTableByNodeId(node.id);
    this.closeErContextMenu();
  }

  /** Ensure columns/indexes/constraints/triggers are loaded for a table (e.g. when opening its tab) */
  ensureTableMetadataLoaded(schema: string, table: string): void {
    const db = this.selectedDatabase;
    if (!db) return;
    const key = this.tableKey(schema, table);
    const api = this.api;
    if (!this.tableColumnsMap[key] && api?.dbListColumns) {
      api.dbListColumns(db, schema, table).then((res) => {
        const rows = res.error ? [] : (res.rows || []);
        this.tableColumnsMap = { ...this.tableColumnsMap, [key]: rows };
      });
    }
    if (this.tableIndexesMap[key] === undefined && api?.dbListIndexes) {
      api.dbListIndexes(db, schema, table).then((res) => {
        const rows = res.error ? [] : (res.rows || []);
        this.tableIndexesMap = { ...this.tableIndexesMap, [key]: rows };
      });
    }
    if (this.tableConstraintsMap[key] === undefined && api?.dbListConstraints) {
      api.dbListConstraints(db, schema, table).then((res) => {
        const rows = res.error ? [] : (res.rows || []);
        this.tableConstraintsMap = { ...this.tableConstraintsMap, [key]: rows };
      });
    }
    if (this.tableTriggersMap[key] === undefined && api?.dbListTriggers) {
      api.dbListTriggers(db, schema, table).then((res) => {
        const rows = res.error ? [] : (res.rows || []);
        this.tableTriggersMap = { ...this.tableTriggersMap, [key]: rows };
      });
    }
    if (!api?.dbListIndexes) this.tableIndexesMap = { ...this.tableIndexesMap, [key]: [] };
    if (!api?.dbListConstraints) this.tableConstraintsMap = { ...this.tableConstraintsMap, [key]: [] };
    if (!api?.dbListTriggers) this.tableTriggersMap = { ...this.tableTriggersMap, [key]: [] };
  }

  /** Open or focus a table/view tab and load its data */
  selectTable(schema: string, table: string): void {
    const db = this.selectedDatabase ?? 'postgres';
    const tabId = `table:${db}:${schema}.${table}`;
    let tab = this.getTabById(tabId);
    if (!tab) {
      tab = {
        id: tabId,
        type: 'table',
        schema,
        table,
        database: db,
        pinned: false,
        title: `${schema}.${table}`,
      };
      this.openTabs = [...this.openTabs, tab];
    }
    this.selectTab(tabId);
  }

  loadTableRows(): void {
    const db = this.selectedDatabase;
    const api = this.api;
    if (!db || !this.selectedSchema || !this.selectedTable || !api?.dbFetchRows) return;
    this.tableError = '';
    const offset = this.tablePage * this.pageSize;
    api.dbFetchRows(db, this.selectedSchema, this.selectedTable, this.pageSize, offset).then((res) => {
      if (res.error) {
        this.tableError = res.error;
        this.tableRows = [];
        this.tableColumns = [];
        this.tableTotal = 0;
        return;
      }
      this.tableRows = res.rows || [];
      this.tableTotal = res.total ?? this.tableRows.length;
      this.tableColumns =
        this.tableRows.length > 0
          ? Object.keys(this.tableRows[0] as Record<string, unknown>)
          : [];
    });
  }

  prevPage(): void {
    if (this.tablePage > 0) {
      this.tablePage--;
      this.loadTableRows();
    }
  }

  nextPage(): void {
    if ((this.tablePage + 1) * this.pageSize < this.tableTotal) {
      this.tablePage++;
      this.loadTableRows();
    }
  }

  get tablePageStart(): number {
    return this.tablePage * this.pageSize + 1;
  }
  get tablePageEnd(): number {
    return Math.min((this.tablePage + 1) * this.pageSize, this.tableTotal);
  }

  /** Returns selected SQL in editor, or full editor content if no selection (for Run / Explain). */
  getSqlToRun(): string {
    const ed = this.queryEditorInstance as {
      getSelection?: () => { isEmpty?: () => boolean; startLineNumber?: number; startColumn?: number; endLineNumber?: number; endColumn?: number };
      getModel?: () => { getValueInRange?: (r: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }) => string };
    } | null;
    if (ed?.getSelection && ed?.getModel) {
      const sel = ed.getSelection();
      const model = ed.getModel();
      if (sel && model && typeof sel.isEmpty === 'function' && !sel.isEmpty() && model.getValueInRange) {
        const range = {
          startLineNumber: sel.startLineNumber ?? 1,
          startColumn: sel.startColumn ?? 1,
          endLineNumber: sel.endLineNumber ?? 1,
          endColumn: sel.endColumn ?? 1,
        };
        return model.getValueInRange(range).trim();
      }
    }
    return this.querySql.trim();
  }

  /** Database to use for Run/Explain: when on a query tab use that tab's DB (same as table tab context), else tree selection. */
  private getQueryRunDatabase(): string {
    const tab = this.getTabById(this.activeTabId);
    if (tab?.type === 'query') {
      const tabDb = tab.database ?? (tab.id.startsWith('query:') ? tab.id.split(':')[1] : null);
      if (tabDb) return tabDb;
    }
    return this.selectedDatabase ?? 'postgres';
  }

  runQuery(): void {
    const api = this.api;
    const db = this.getQueryRunDatabase();
    if (!api?.dbRunScript || !db) return;
    const sql = this.getSqlToRun();
    if (!sql) return;
    this.queryRunning = true;
    this.queryResult = null;
    this.explainResult = null;
    this.queryDurationMs = null;
    const start = performance.now();
    api.dbRunScript(db, sql).then((res) => {
      this.queryRunning = false;
      this.queryResult = res;
      this.queryDurationMs = Math.round(performance.now() - start);
      if (res.error) this.queryOutputTab = 'messages';
      else this.queryOutputTab = 'results';
      if (sql && !res.error) this.addQueryToHistory(sql);
      if (this.activeTabId) this.saveQueryTabState(this.activeTabId);
    });
  }

  runExplain(): void {
    const api = this.api;
    const db = this.getQueryRunDatabase();
    if (!api?.dbRunExplain || !db) return;
    const sql = this.getSqlToRun();
    if (!sql) return;
    this.explainRunning = true;
    this.explainResult = null;
    api.dbRunExplain(db, sql).then((res) => {
      this.explainRunning = false;
      this.explainResult = res;
      this.queryOutputTab = 'explain';
      if (this.activeTabId) this.saveQueryTabState(this.activeTabId);
    });
  }

  saveQuery(): void {
    const api = this.api;
    if (!api?.saveQueryToFile) return;
    api.saveQueryToFile(this.querySql ?? '').then((res) => {
      if (res.cancelled) return;
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Save failed: ${res.error}`);
      }
    });
  }

  loadQuery(): void {
    const api = this.api;
    if (!api?.loadQueryFromFile) return;
    api.loadQueryFromFile().then((res) => {
      if (res.cancelled) return;
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Load failed: ${res.error}`);
      } else if (res.success && res.content !== undefined) {
        this.querySql = res.content;
      }
    });
  }

  addQueryToHistory(sql: string): void {
    const s = sql.trim();
    if (!s) return;
    this.queryHistory = [s, ...this.queryHistory.filter((q) => q !== s)].slice(0, this.maxQueryHistory);
    this.saveQueryHistoryToSettings();
  }

  private saveQueryHistoryToSettings(): void {
    const api = this.api;
    if (!api?.saveSettings) return;
    api.saveSettings({ queryHistory: this.queryHistory });
  }

  onHistorySelect(value: string): void {
    const i = parseInt(value, 10);
    if (value === '' || Number.isNaN(i) || i < 0 || i >= this.queryHistory.length) return;
    const sql = this.queryHistory[i];
    if (sql) {
      this.querySql = sql;
      this.queryResult = null;
      this.explainResult = null;
    }
  }

  getQueryRows(): unknown[] {
    return this.queryResult?.rows ?? [];
  }
  getQueryFields(): string[] {
    return this.queryResult?.fields ?? [];
  }

  /** Format query error for display; clarifies duplicate key and other constraint errors */
  formatQueryError(error: string | undefined): string {
    if (!error) return '';
    if (/duplicate key value violates unique constraint/i.test(error)) {
      return (
        error +
        '\n\nThis usually means the row you are inserting or updating would create a duplicate value for a unique or primary key. Check the constraint name above and the values you are inserting (or the key columns in your UPDATE/INSERT).'
      );
    }
    if (/violates (foreign key|check|not-null|unique)/i.test(error)) {
      return error + '\n\nCheck the values you are inserting or updating and that they satisfy the constraint.';
    }
    return error;
  }

  refresh(): void {
    this.loadDatabases();
    this.loadRolesAndTablespaces();
    this.expandedTableKeys = {};
    this.tableColumnsMap = {};
    this.tableIndexesMap = {};
    this.tableConstraintsMap = {};
    this.tableTriggersMap = {};
    this.expandedViewKeys = {};
    this.viewColumnsMap = {};
    this.schemas = this.schemas.map((s) => ({
      ...s,
      expanded: false,
      tables: [],
      views: [],
      functions: [],
      sequences: [],
      loading: false,
      tablesSectionExpanded: true,
      viewsSectionExpanded: true,
      sequencesSectionExpanded: true,
      functionsSectionExpanded: true,
    }));
    if (this.selectedDatabase) {
      this.loadSchemas();
      this.loadExtensionsForSelectedDb();
    }
    const tab = this.getTabById(this.activeTabId);
    if (tab?.type === 'table' && tab.schema && tab.table) {
      this.selectedSchema = tab.schema;
      this.selectedTable = tab.table;
      this.loadTableRows();
    }
  }

  startResize(event: MouseEvent): void {
    event.preventDefault();
    this.resizing = true;
    this.resizeStartX = event.clientX;
    this.resizeStartWidth = this.sidebarWidth;
  }

  startPanel1Resize(event: MouseEvent): void {
    event.preventDefault();
    this.panel1Resizing = true;
    this.panel1ResizeStartY = event.clientY;
    this.panel1ResizeStartHeight = this.panel1Height;
  }

  startPanel2Resize(event: MouseEvent): void {
    event.preventDefault();
    this.panel2Resizing = true;
    this.panel2ResizeStartY = event.clientY;
    this.panel2ResizeStartHeight = this.panel2Height;
  }

  startQueryPanelResize(event: MouseEvent): void {
    event.preventDefault();
    this.queryPanelResizing = true;
    this.queryResizeStartY = event.clientY;
    this.queryResizeStartHeight = this.queryEditorHeight;
  }

  @HostListener('document:mousemove', ['$event'])
  onMouseMove(event: MouseEvent): void {
    if (this.panel1Resizing) {
      const dy = event.clientY - this.panel1ResizeStartY;
      this.panel1Height = Math.min(this.PANEL1_MAX, Math.max(this.PANEL1_MIN, this.panel1ResizeStartHeight + dy));
      return;
    }
    if (this.panel2Resizing) {
      const dy = event.clientY - this.panel2ResizeStartY;
      this.panel2Height = Math.min(this.PANEL2_MAX, Math.max(this.PANEL2_MIN, this.panel2ResizeStartHeight + dy));
      return;
    }
    if (this.queryPanelResizing) {
      const dy = event.clientY - this.queryResizeStartY;
      this.queryEditorHeight = Math.min(
        QUERY_EDITOR_MAX,
        Math.max(QUERY_EDITOR_MIN, this.queryResizeStartHeight + dy)
      );
      return;
    }
    if (!this.resizing) return;
    const dx = event.clientX - this.resizeStartX;
    this.sidebarWidth = Math.min(
      SIDEBAR_MAX,
      Math.max(SIDEBAR_MIN, this.resizeStartWidth + dx)
    );
  }

  @HostListener('document:mouseup')
  onMouseUp(): void {
    const wasQueryPanelResizing = this.queryPanelResizing;
    const wasResizing = this.resizing || this.panel1Resizing || this.panel2Resizing || this.queryPanelResizing;
    this.resizing = false;
    this.panel1Resizing = false;
    this.panel2Resizing = false;
    this.queryPanelResizing = false;
    if (wasResizing) this.saveLayoutToSettings();
    if (wasQueryPanelResizing) this.layoutQueryEditor();
  }

  /** Tell Monaco to re-layout after query panel resize */
  private layoutQueryEditor(): void {
    const ed = this.queryEditorInstance as { layout?: (dims?: { width?: number; height?: number }) => void } | null;
    if (ed?.layout) {
      setTimeout(() => ed.layout!(), 0);
    }
  }

  @HostListener('document:click')
  onDocumentClick(): void {
    this.closeContextMenu();
    this.closeExplorerContextMenu();
    this.closeErContextMenu();
  }

  // ---- DB Explorer context menu ----
  onExplorerContextMenu(event: MouseEvent, ctx: ExplorerContext): void {
    event.preventDefault();
    event.stopPropagation();
    this.explorerContext = ctx;
    this.explorerContextMenuOpen = true;
    this.explorerContextMenuX = event.clientX;
    this.explorerContextMenuY = event.clientY;
  }

  closeExplorerContextMenu(): void {
    this.explorerContextMenuOpen = false;
    this.explorerContext = null;
  }

  copyToClipboard(text: string): void {
    if (typeof navigator?.clipboard?.writeText === 'function') {
      navigator.clipboard.writeText(text);
    }
  }

  explorerCopyName(): void {
    const c = this.explorerContext;
    if (!c) return;
    const name: string =
      c.type === 'root' ? 'Portable Postgres' :
      c.type === 'database' ? (c.database ?? '') :
      c.type === 'schema' ? (c.schema ?? '') :
      c.type === 'table' || c.type === 'view' ? (c.table ?? '') :
      c.name ?? '';
    this.copyToClipboard(name);
    this.closeExplorerContextMenu();
  }

  explorerCopyQualified(): void {
    const c = this.explorerContext;
    if (!c) return;
    const q =
      c.type === 'database' && c.database ? c.database :
      (c.type === 'table' || c.type === 'view') && c.schema && c.table ? `${c.schema}.${c.table}` :
      c.type === 'column' && c.schema && c.table && c.name ? `${c.schema}.${c.table}.${c.name}` :
      (c.type === 'sequence' || c.type === 'function') && c.schema && c.name ? `${c.schema}.${c.name}` :
      (c.type === 'extension' || c.type === 'extension_available') && c.name ? c.name : '';
    if (q) {
      this.copyToClipboard(q);
    }
    this.closeExplorerContextMenu();
  }

  explorerViewData(): void {
    const c = this.explorerContext;
    if (!c || ((c.type !== 'table' && c.type !== 'view') || !c.schema || !c.table)) return;
    this.closeExplorerContextMenu();
    this.selectTable(c.schema, c.table);
  }

  explorerSelectInQuery(): void {
    const c = this.explorerContext;
    if (!c || ((c.type !== 'table' && c.type !== 'view') || !c.schema || !c.table)) return;
    this.closeExplorerContextMenu();
    const db = this.selectedDatabase ?? 'postgres';
    let queryTab = this.openTabs.find((t) => t.type === 'query' && t.database === db);
    if (!queryTab) {
      this.openNewQueryTab(db);
      queryTab = this.getTabById(this.activeTabId);
    } else {
      this.selectTab(queryTab.id);
    }
    const quoted = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    this.querySql = `SELECT * FROM ${quoted(c.schema)}.${quoted(c.table)} LIMIT 100;`;
    if (this.activeTabId) this.saveQueryTabState(this.activeTabId);
  }

  explorerRefreshTable(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || (c.type !== 'table' && c.type !== 'view') || !c.schema || !c.table || !db) return;
    this.closeExplorerContextMenu();
    const key = this.tableKey(c.schema, c.table);
    const { [key]: _, ...restCols } = this.tableColumnsMap;
    this.tableColumnsMap = restCols as Record<string, { column_name: string; data_type: string; is_primary_key?: boolean }[]>;
    const { [key]: __, ...restIdx } = this.tableIndexesMap;
    this.tableIndexesMap = restIdx;
    const { [key]: ___, ...restCon } = this.tableConstraintsMap;
    this.tableConstraintsMap = restCon;
    const { [key]: ____, ...restTrg } = this.tableTriggersMap;
    this.tableTriggersMap = restTrg;
    const { [key]: _____, ...restView } = this.viewColumnsMap;
    this.viewColumnsMap = restView;
    if (this.selectedSchema === c.schema && this.selectedTable === c.table) {
      this.loadTableRows();
    }
    const schema = this.schemas.find((s) => s.name === c.schema);
    if (schema?.expanded) {
      this.schemas = this.schemas.map((s) =>
        s.name === c.schema ? { ...s, expanded: false, tables: [], views: [], functions: [], sequences: [], loading: true } : s
      );
      const api = this.api;
      Promise.all([
        api?.dbListTables?.(db, c.schema) ?? Promise.resolve({ rows: [] }),
        api?.dbListViews?.(db, c.schema) ?? Promise.resolve({ rows: [] }),
        api?.dbListFunctions?.(db, c.schema) ?? Promise.resolve({ rows: [] }),
        api?.dbListSequences?.(db, c.schema) ?? Promise.resolve({ rows: [] }),
      ]).then(([tRes, vRes, fRes, seqRes]) => {
        const t = tRes as { rows?: string[]; error?: string };
        const v = vRes as { rows?: string[]; error?: string };
        const f = fRes as { rows?: string[]; error?: string };
        const s = seqRes as { rows?: string[]; error?: string };
        this.schemas = this.schemas.map((s0) =>
          s0.name === c.schema
            ? { ...s0, loading: false, tables: t.error ? [] : (t.rows ?? []), views: v.error ? [] : (v.rows ?? []), functions: f.error ? [] : (f.rows ?? []), sequences: s.error ? [] : (s.rows ?? []) }
            : s0
        );
      });
    }
  }

  explorerDropTable(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || (c.type !== 'table' && c.type !== 'view') || !c.schema || !c.table || !db) return;
    const kind = c.type === 'view' ? 'view' : 'table';
    const qualified = `${c.schema}.${c.table}`;
    const schema = c.schema;
    const table = c.table;
    if (typeof window !== 'undefined' && !window.confirm?.(`Drop ${kind} ${qualified}? This cannot be undone.`)) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.dbRunDdl) return;
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    const sql = c.type === 'view' ? `DROP VIEW ${q(schema)}.${q(table)};` : `DROP TABLE ${q(schema)}.${q(table)};`;
    api.dbRunDdl(db, sql).then((res) => {
      if (res.error && typeof window !== 'undefined' && window.alert) window.alert(res.error);
      else {
        this.refresh();
        const tabId = this.openTabs.find((t) => t.type === 'table' && t.schema === schema && t.table === table)?.id;
        if (tabId) {
          this.openTabs = this.openTabs.filter((t) => t.id !== tabId);
          if (this.activeTabId === tabId) {
            const next = this.openTabs[this.openTabs.length - 1];
            this.selectTab(next?.id ?? 'overview');
          }
        }
      }
    });
  }

  explorerTruncateTable(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'table' || !c.schema || !c.table || !db) return;
    if (typeof window !== 'undefined' && !window.confirm?.(`Truncate table ${c.schema}.${c.table}? All rows will be deleted.`)) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.dbRunDdl) return;
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    api.dbRunDdl(db, `TRUNCATE TABLE ${q(c.schema)}.${q(c.table)};`).then((res) => {
      if (res.error && typeof window !== 'undefined' && window.alert) window.alert(res.error);
      else if (this.selectedSchema === c.schema && this.selectedTable === c.table) this.loadTableRows();
    });
  }

  explorerRefresh(): void {
    this.closeExplorerContextMenu();
    this.refresh();
  }

  explorerRefreshSchema(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'schema' || !c.schema || !db) return;
    this.closeExplorerContextMenu();
    const schema = this.schemas.find((s) => s.name === c.schema);
    if (schema) {
      this.schemas = this.schemas.map((s) =>
        s.name === c.schema
          ? { ...s, expanded: false, tables: [], views: [], functions: [], sequences: [], loading: true }
          : s
      );
      const api = this.api;
      const schemaName = c.schema;
      Promise.all([
        api?.dbListTables?.(db, schemaName) ?? Promise.resolve({ rows: [] }),
        api?.dbListViews?.(db, schemaName) ?? Promise.resolve({ rows: [] }),
        api?.dbListFunctions?.(db, schemaName) ?? Promise.resolve({ rows: [] }),
        api?.dbListSequences?.(db, schemaName) ?? Promise.resolve({ rows: [] }),
      ]).then(([tRes, vRes, fRes, seqRes]) => {
        const t = tRes as { rows?: string[]; error?: string };
        const v = vRes as { rows?: string[]; error?: string };
        const f = fRes as { rows?: string[]; error?: string };
        const s = seqRes as { rows?: string[]; error?: string };
        this.schemas = this.schemas.map((s0) =>
          s0.name === schemaName
            ? {
                ...s0,
                loading: false,
                tables: t.error ? [] : (t.rows ?? []),
                views: v.error ? [] : (v.rows ?? []),
                functions: f.error ? [] : (f.rows ?? []),
                sequences: s.error ? [] : (s.rows ?? []),
              }
            : s0
        );
      });
    }
  }

  /** Whether to show "Copy name" in explorer context menu */
  explorerCanCopyName(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type !== 'root';
  }

  /** Whether to show "Copy qualified name" in explorer context menu */
  explorerCanCopyQualified(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (
      (ctx.type === 'database' && !!ctx.database) ||
      (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table ||
      (ctx.type === 'column' && !!ctx.schema && !!ctx.table && !!ctx.name) ||
      ((ctx.type === 'sequence' || ctx.type === 'function') && !!ctx.schema && !!ctx.name) ||
      (ctx.type === 'extension' || ctx.type === 'extension_available') && !!ctx.name
    );
  }

  /** Whether to show "Enable" in explorer context menu (available-but-not-enabled extension) */
  explorerCanEnableExtension(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'extension_available' && !!ctx.name;
  }

  /** Whether to show "Disable" in explorer context menu (enabled extension) */
  explorerCanDisableExtension(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'extension' && !!ctx.name;
  }

  /** Whether to show "View ER diagram" in explorer context menu (schema) */
  explorerCanViewErDiagram(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'schema' && !!ctx.schema;
  }

  /** Whether to show "View ER diagram (this table)" in explorer context menu (table/view) */
  explorerCanViewErDiagramTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table;
  }

  explorerViewErDiagram(): void {
    const c = this.explorerContext;
    if (!c || !c.schema) return;
    this.closeExplorerContextMenu();
    this.openErTab(c.schema);
  }

  explorerViewErDiagramTable(): void {
    const c = this.explorerContext;
    if (!c || !c.schema || !c.table) return;
    this.closeExplorerContextMenu();
    this.openErTab(c.schema, c.table);
  }

  /** Whether to show "View data" in explorer context menu */
  explorerCanViewData(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "SELECT in Query" in explorer context menu */
  explorerCanSelectInQuery(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Refresh" for table/view (reload data and metadata) */
  explorerCanRefreshTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Drop table/view" in explorer context menu */
  explorerCanDropTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return (ctx.type === 'table' || ctx.type === 'view') && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Truncate" in explorer context menu (tables only) */
  explorerCanTruncateTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'table' && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Export table…" in explorer context menu (tables only, not views) */
  explorerCanExportTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'table' && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Import into table…" in explorer context menu (tables only) */
  explorerCanImportTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'table' && !!ctx.schema && !!ctx.table;
  }

  /** Whether to show "Refresh" (full) in explorer context menu */
  explorerCanRefresh(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'root';
  }

  /** Whether to show "Create database" in explorer context menu (root / connection) */
  explorerCanCreateDatabase(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'root';
  }

  explorerCreateDatabase(): void {
    this.closeExplorerContextMenu();
    this.openCreateDbWizard();
  }

  /** Open connection (root) context menu at event position (e.g. from three-dots click) */
  openConnectionMenu(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();
    this.onExplorerContextMenu(event, { type: 'root' });
  }

  /** Whether to show "Create schema" in explorer context menu (database node) */
  explorerCanCreateSchema(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'database' && !!ctx.database;
  }

  /** Whether to show "Refresh" for a database node */
  explorerCanRefreshDatabase(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'database' && !!ctx.database;
  }

  /** Whether to show "Query tool" in database context menu (pgAdmin style) */
  explorerCanOpenQueryTool(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'database' && !!ctx.database;
  }

  explorerOpenQueryTool(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'database' || !c.database) return;
    this.closeExplorerContextMenu();
    this.selectedDatabase = c.database;
    this.loadSchemas();
    this.loadExtensionsForSelectedDb();
    this.openNewQueryTab(c.database);
  }

  /** Whether to show "Backup database…" in explorer context menu */
  explorerCanBackupDatabase(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'database' && !!ctx.database;
  }

  /** Whether to show "Restore…" in explorer context menu */
  explorerCanRestoreDatabase(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'database' && !!ctx.database;
  }

  explorerCreateSchema(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'database' || !c.database) return;
    this.closeExplorerContextMenu();
    this.openCreateSchemaDialog(c.database);
  }

  openCreateSchemaDialog(database: string): void {
    this.createSchemaDatabase = database;
    this.createSchemaName = '';
    this.createSchemaError = '';
    this.createSchemaOpen = true;
  }

  closeCreateSchemaDialog(): void {
    this.createSchemaOpen = false;
  }

  runCreateSchema(): void {
    const api = this.api;
    const name = this.createSchemaName.trim();
    if (!name) {
      this.createSchemaError = 'Enter a schema name.';
      return;
    }
    if (!api?.dbRunDdl) return;
    this.createSchemaError = '';
    this.createSchemaRunning = true;
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    const sql = `CREATE SCHEMA ${q(name)}`;
    api.dbRunDdl(this.createSchemaDatabase, sql).then((res) => {
      this.createSchemaRunning = false;
      if (res.error) {
        this.createSchemaError = res.error;
        return;
      }
      this.closeCreateSchemaDialog();
      this.selectedDatabase = this.createSchemaDatabase;
      this.loadSchemas();
    });
  }

  explorerRefreshDatabase(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'database' || !c.database) return;
    this.closeExplorerContextMenu();
    this.selectDatabase(c.database);
  }

  explorerBackupDatabase(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'database' || !c.database) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.dbBackupDatabase) return;
    api.dbBackupDatabase(c.database).then((res) => {
      if (res.cancelled) return;
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Backup failed: ${res.error}`);
      }
    });
  }

  explorerRestoreDatabase(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'database' || !c.database) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.dbRestoreDatabase) return;
    if (typeof window !== 'undefined' && !window.confirm?.(`Restore into database "${c.database}"? This will run the selected SQL file. Existing objects may be affected. Continue?`)) return;
    api.dbRestoreDatabase(c.database).then((res) => {
      if (res.cancelled) return;
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Restore failed: ${res.error}`);
      } else if (res.success) {
        this.loadSchemas();
      }
    });
  }

  explorerExportTable(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'table' || !c.schema || !c.table || !db) return;
    this.closeExplorerContextMenu();
    this.openExportWizard(db, c.schema, c.table);
  }

  explorerImportTable(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'table' || !c.schema || !c.table || !db) return;
    this.closeExplorerContextMenu();
    this.openImportWizard(db, c.schema, c.table);
  }

  openExportWizard(database: string, schema: string, table: string): void {
    this.exportTarget = { database, schema, table };
    this.exportWizardStep = 1;
    this.exportFormat = 'csv';
    this.exportOptions = { format: 'csv', header: true, delimiter: ',', nullString: '\\N' };
    this.exportSelectedColumns = [];
    this.exportError = '';
    this.exportWizardOpen = true;
    this.ensureExportTargetColumnsLoaded();
  }

  closeExportWizard(): void {
    this.exportWizardOpen = false;
    this.exportTarget = null;
    this.exportRunning = false;
  }

  ensureExportTargetColumnsLoaded(): void {
    const t = this.exportTarget || this.importTarget;
    if (!t || this.api?.dbListColumns == null) return;
    const key = this.tableKey(t.schema, t.table);
    if (this.tableColumnsMap[key]?.length) return;
    this.api.dbListColumns(t.database, t.schema, t.table).then((res) => {
      const rows = res.error ? [] : (res.rows || []);
      this.tableColumnsMap = { ...this.tableColumnsMap, [key]: rows };
    });
  }

  getExportWizardColumns(): { column_name: string; data_type: string }[] {
    if (!this.exportTarget) return [];
    return this.getTableColumns(this.exportTarget.schema, this.exportTarget.table);
  }

  getExportFormatLabel(): string {
    const f = this.exportFormats.find((x) => x.id === this.exportFormat);
    return f ? f.label : this.exportFormat;
  }

  getImportFormatLabel(): string {
    const f = this.importFormats.find((x) => x.id === this.importFormat);
    return f ? f.label : this.importFormat;
  }

  toggleExportColumn(col: string): void {
    const all = this.getExportWizardColumns().map((c) => c.column_name);
    if (this.exportSelectedColumns.length === 0) {
      this.exportSelectedColumns = all.filter((n) => n !== col);
    } else {
      if (this.exportSelectedColumns.includes(col)) {
        this.exportSelectedColumns = this.exportSelectedColumns.filter((n) => n !== col);
      } else {
        this.exportSelectedColumns = [...this.exportSelectedColumns, col];
      }
    }
  }

  toggleImportColumn(col: string): void {
    const all = this.getImportWizardColumns().map((c) => c.column_name);
    if (this.importSelectedColumns.length === 0) {
      this.importSelectedColumns = all.filter((n) => n !== col);
    } else {
      if (this.importSelectedColumns.includes(col)) {
        this.importSelectedColumns = this.importSelectedColumns.filter((n) => n !== col);
      } else {
        this.importSelectedColumns = [...this.importSelectedColumns, col];
      }
    }
  }

  exportWizardNext(): void {
    if (this.exportWizardStep < 3) {
      this.exportOptions.format = this.exportFormat;
      this.exportWizardStep++;
    }
  }

  exportWizardBack(): void {
    if (this.exportWizardStep > 1) this.exportWizardStep--;
  }

  runExport(): void {
    const t = this.exportTarget;
    const api = this.api;
    if (!t || !api?.dbExportTableData) return;
    this.exportError = '';
    this.exportRunning = true;
    const opts: TableCopyOptions = {
      format: this.exportFormat,
      header: this.exportOptions.header,
      delimiter: this.exportOptions.delimiter ?? (this.exportFormat === 'text' ? '\t' : ','),
      quote: this.exportOptions.quote,
      escape: this.exportOptions.escape,
      nullString: this.exportOptions.nullString ?? '\\N',
      columns: this.exportSelectedColumns.length > 0 ? this.exportSelectedColumns : undefined,
    };
    api.dbExportTableData(t.database, t.schema, t.table, opts).then((res) => {
      this.exportRunning = false;
      if (res.cancelled) return;
      if (res.error) this.exportError = res.error;
      else this.closeExportWizard();
    });
  }

  openImportWizard(database: string, schema: string, table: string): void {
    this.importTarget = { database, schema, table };
    this.importWizardStep = 1;
    this.importFormat = 'csv';
    this.importOptions = { format: 'csv', header: true };
    this.importSelectedColumns = [];
    this.importError = '';
    this.importWizardOpen = true;
    this.ensureExportTargetColumnsLoaded();
  }

  closeImportWizard(): void {
    this.importWizardOpen = false;
    this.importTarget = null;
    this.importRunning = false;
  }

  getImportWizardColumns(): { column_name: string; data_type: string }[] {
    if (!this.importTarget) return [];
    return this.getTableColumns(this.importTarget.schema, this.importTarget.table);
  }

  importWizardNext(): void {
    if (this.importWizardStep < 3) {
      this.importOptions.format = this.importFormat;
      this.importWizardStep++;
    }
  }

  importWizardBack(): void {
    if (this.importWizardStep > 1) this.importWizardStep--;
  }

  runImport(): void {
    const t = this.importTarget;
    const api = this.api;
    if (!t || !api?.dbImportTableData) return;
    this.importError = '';
    this.importRunning = true;
    const opts: TableCopyOptions = {
      format: this.importFormat,
      header: this.importOptions.header,
      delimiter: this.importOptions.delimiter ?? (this.importFormat === 'text' ? '\t' : ','),
      quote: this.importOptions.quote,
      escape: this.importOptions.escape,
      nullString: this.importOptions.nullString ?? '\\N',
      columns: this.importSelectedColumns.length > 0 ? this.importSelectedColumns : undefined,
    };
    api.dbImportTableData(t.database, t.schema, t.table, opts).then((res) => {
      this.importRunning = false;
      if (res.cancelled) return;
      if (res.error) this.importError = res.error;
      else {
        this.closeImportWizard();
        this.loadSchemas();
      }
    });
  }

  explorerEnableExtension(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'extension_available' || !c.name || !db) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.enableExtension) return;
    api.enableExtension(c.name, db).then((res) => {
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Enable failed: ${res.error}`);
      } else {
        this.loadExtensionsForSelectedDb();
      }
    });
  }

  explorerDisableExtension(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'extension' || !c.name || !db) return;
    if (typeof window !== 'undefined' && !window.confirm?.(`Disable extension "${c.name}" in this database? This may drop dependent objects.`)) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.disableExtension) return;
    api.disableExtension(c.name, db).then((res) => {
      if (!res.success && res.error && typeof window !== 'undefined' && window.alert) {
        window.alert(`Disable failed: ${res.error}`);
      } else {
        this.loadExtensionsForSelectedDb();
      }
    });
  }

  /** Open database context menu at event position (e.g. from three-dots on a DB row) */
  openDatabaseMenu(event: MouseEvent, database: string): void {
    event.preventDefault();
    event.stopPropagation();
    this.onExplorerContextMenu(event, { type: 'database', database });
  }

  /** Whether to show "Refresh schema" in explorer context menu */
  explorerCanRefreshSchema(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'schema' && !!ctx.schema;
  }

  /** Whether to show "Drop schema" in explorer context menu */
  explorerCanDropSchema(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'schema' && !!ctx.schema;
  }

  explorerDropSchema(): void {
    const c = this.explorerContext;
    const db = this.selectedDatabase;
    if (!c || c.type !== 'schema' || !c.schema || !db) return;
    const schemaName = c.schema;
    if (typeof window !== 'undefined' && !window.confirm?.(`Drop schema "${schemaName}"? All objects in the schema (tables, views, etc.) will be permanently deleted. This cannot be undone.`)) return;
    this.closeExplorerContextMenu();
    const api = this.api;
    if (!api?.dbRunDdl) return;
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    api.dbRunDdl(db, `DROP SCHEMA ${q(schemaName)} CASCADE;`).then((res) => {
      if (res.error && typeof window !== 'undefined' && window.alert) window.alert(res.error);
      else this.loadSchemas();
    });
  }

  /** Whether to show "Create table" in explorer context menu */
  explorerCanCreateTable(ctx: ExplorerContext | null): boolean {
    if (!ctx) return false;
    return ctx.type === 'schema' && !!ctx.schema;
  }

  explorerCreateTable(): void {
    const c = this.explorerContext;
    if (!c || c.type !== 'schema' || !c.schema) return;
    this.closeExplorerContextMenu();
    this.openCreateTableWizard(c.schema);
  }

  openCreateTableWizard(schema: string): void {
    this.createTableSchema = schema;
    this.createTableName = '';
    this.createTableComment = '';
    this.createTableTablespace = '';
    this.createTableColumns = [
      { name: 'id', type: 'integer', length: '', nullable: false, default: '', primaryKey: true, unique: false, comment: '' },
    ];
    this.createTableWizardStep = 1;
    this.createTableError = '';
    this.createTableWizardOpen = true;
  }

  closeCreateTableWizard(): void {
    this.createTableWizardOpen = false;
  }

  addCreateTableColumn(): void {
    this.createTableColumns = [...this.createTableColumns, { name: '', type: 'text', length: '', nullable: true, default: '', primaryKey: false, unique: false, comment: '' }];
  }

  removeCreateTableColumn(index: number): void {
    if (this.createTableColumns.length <= 1) return;
    this.createTableColumns = this.createTableColumns.filter((_, i) => i !== index);
  }

  getCreateTableDdl(): string {
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    const parts = this.createTableColumns
      .filter((c) => c.name.trim())
      .map((c) => {
        const name = q(c.name.trim());
        let def = c.type;
        const len = c.length.trim();
        if (len) {
          if (c.type.startsWith('varchar')) def = `varchar(${len})`;
          else if (c.type.startsWith('char')) def = `char(${len})`;
          else if (c.type === 'numeric') def = `numeric(${len})`;
        }
        if (c.default.trim()) def += ` DEFAULT ${c.default.trim()}`;
        if (!c.nullable) def += ' NOT NULL';
        if (c.primaryKey) def += ' PRIMARY KEY';
        if (c.unique && !c.primaryKey) def += ' UNIQUE';
        return `  ${name} ${def}`;
      });
    const tableName = `${q(this.createTableSchema)}.${q(this.createTableName.trim())}`;
    if (parts.length === 0) return '';
    let ddl = `CREATE TABLE ${tableName}(\n${parts.join(',\n')}\n)`;
    if (this.createTableTablespace.trim()) {
      ddl += `\nTABLESPACE ${q(this.createTableTablespace.trim())}`;
    }
    ddl += ';';
    return ddl;
  }

  getCreateTableCommentSql(): string {
    if (!this.createTableComment.trim()) return '';
    const q = (s: string) => (/^[a-z_][a-z0-9_]*$/i.test(s) ? s : `"${s.replace(/"/g, '""')}"`);
    const sqlStr = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const tableName = `${q(this.createTableSchema)}.${q(this.createTableName.trim())}`;
    return `COMMENT ON TABLE ${tableName} IS ${sqlStr(this.createTableComment.trim())};`;
  }

  runCreateTable(): void {
    const api = this.api;
    const db = this.selectedDatabase;
    if (!api?.dbRunDdl || !db) {
      this.createTableError = 'Database not available.';
      return;
    }
    if (!this.createTableName.trim()) {
      this.createTableError = 'Enter a table name.';
      return;
    }
    const hasColumns = this.createTableColumns.some((c) => c.name.trim());
    if (!hasColumns) {
      this.createTableError = 'Add at least one column.';
      return;
    }
    const ddl = this.getCreateTableDdl();
    if (!ddl) {
      this.createTableError = 'Invalid definition.';
      return;
    }
    this.createTableError = '';
    this.createTableRunning = true;
    const runDdl = api.dbRunDdl;
    runDdl(db, ddl).then((res) => {
      if (res.error) {
        this.createTableRunning = false;
        this.createTableError = res.error;
        return;
      }
      const commentSql = this.getCreateTableCommentSql();
      if (!commentSql) {
        this.createTableRunning = false;
        this.closeCreateTableWizard();
        this.refresh();
        this.selectTable(this.createTableSchema, this.createTableName.trim());
        return;
      }
      runDdl(db, commentSql).then((res2) => {
        this.createTableRunning = false;
        if (res2.error) this.createTableError = res2.error;
        else {
          this.closeCreateTableWizard();
          this.refresh();
          this.selectTable(this.createTableSchema, this.createTableName.trim());
        }
      });
    });
  }

  /** Template helper: get cell value from a row object by column key */
  getCell(row: unknown, col: string): string {
    const r = row as Record<string, unknown>;
    const v = r?.[col];
    return v != null ? String(v) : '';
  }

  /** Template helper: get query result cell value (rows from API are arrays by column index) */
  getQueryCell(row: unknown, field: string): string {
    const fields = this.getQueryFields();
    const idx = fields.indexOf(field);
    if (idx === -1) return '';
    if (Array.isArray(row)) {
      const v = row[idx];
      return v != null ? String(v) : '';
    }
    const r = row as Record<string, unknown>;
    const v = r?.[field];
    return v != null ? String(v) : '';
  }

  /** Escape a value for CSV (RFC 4180): wrap in quotes if contains comma, CR, LF, or quote; escape " as "" */
  private csvEscape(value: string): string {
    if (/[,\r\n"]/.test(value)) {
      return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
  }

  /** Build CSV string from headers and rows (each row: array of cell strings or object keyed by header) */
  private buildCsv(headers: string[], rows: unknown[], getCell: (row: unknown, col: string) => string): string {
    const headerLine = headers.map((h) => this.csvEscape(h)).join(',');
    const dataLines = rows.map((row) => headers.map((col) => this.csvEscape(getCell(row, col))).join(','));
    return [headerLine, ...dataLines].join('\r\n');
  }

  /** Download CSV for current query results */
  exportQueryResultsToCsv(): void {
    const fields = this.getQueryFields();
    const rows = this.getQueryRows();
    if (fields.length === 0 || rows.length === 0) return;
    const csv = this.buildCsv(fields, rows, (row, col) => this.getQueryCell(row, col));
    this.downloadCsv(csv, 'query-results.csv');
  }

  /** Download CSV for current table Data tab */
  exportTableDataToCsv(): void {
    if (this.tableColumns.length === 0 || this.tableRows.length === 0) return;
    const csv = this.buildCsv(this.tableColumns, this.tableRows, (row, col) => this.getCell(row, col));
    const name = [this.selectedSchema, this.selectedTable].filter(Boolean).join('_') || 'table-data';
    this.downloadCsv(csv, `${name}.csv`);
  }

  private downloadCsv(csv: string, filename: string): void {
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }
}
