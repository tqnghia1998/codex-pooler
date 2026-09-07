// Admin data portability: full JSON snapshot of the gateway record store and every
// product table. Import replaces the data of each collection present in the file.
export const PRODUCT_TABLES = [
  ['accounts', 'id'], ['account_sessions', 'id'], ['account_upstreams', 'upstream_id'], ['codex_login_attempts', 'id'],
  ['sharing_offers', 'id'], ['sharing_tickets', 'id'], ['sharing_sessions', 'id'], ['sharing_session_keys', 'id'],
  ['personal_api_keys', 'id'], ['personal_api_key_routes', "key_id || ':' || route_key"],
  ['sharing_activity', "subject_type || ':' || subject_id"], ['quota_requests', 'id'], ['provider_observations', 'upstream_id'],
  ['email_outbox', 'id'], ['sharing_events', 'id']
];
const LEGACY_REQUEST_TABLES = new Set(['sharing_session_settlements', 'sharing_reservations']);

export function exportAllData({ store, productStore }) {
  return {
    format: 'quotahub-export',
    version: 1,
    exportedAt: new Date().toISOString(),
    gateway: {
      records: store.sqlite.prepare('SELECT collection, key, value FROM records ORDER BY rowid').all()
    },
    product: Object.fromEntries(PRODUCT_TABLES.map(([table]) => [table, productStore.sqlite.prepare(`SELECT * FROM ${table}`).all()]))
  };
}

export function importAllData({ store, productStore, data }) {
  if (data?.format !== 'quotahub-export' || data?.version !== 1) throw new Error('not a QuotaHub export file');
  const gatewayRecords = data.gateway?.records;
  const product = data.product ?? {};
  if (gatewayRecords !== undefined && !Array.isArray(gatewayRecords)) throw new Error('gateway.records must be an array');
  const knownTables = new Set([...PRODUCT_TABLES.map(([table]) => table), ...LEGACY_REQUEST_TABLES]);
  for (const [table, rows] of Object.entries(product)) {
    if (!knownTables.has(table)) throw new Error(`unknown table "${table}"`);
    if (!Array.isArray(rows)) throw new Error(`table "${table}" must be an array of records`);
  }

  if (gatewayRecords) {
    const insertRecord = store.sqlite.prepare('INSERT INTO records (collection, key, value) VALUES (?, ?, ?)');
    store.sqlite.transaction(() => {
      store.sqlite.prepare('DELETE FROM records').run();
      for (const record of gatewayRecords) {
        if (typeof record?.collection !== 'string' || typeof record?.key !== 'string' || typeof record?.value !== 'string') {
          throw new Error('gateway records must be { collection, key, value } objects with string fields');
        }
        JSON.parse(record.value);
        insertRecord.run(record.collection, record.key, record.value);
      }
    })();
    store.db = null;
    store.load();
    store.notifyUpstreamsChange();
  }

  const imported = { gatewayRecords: gatewayRecords?.length ?? 0, product: {} };
  productStore.sqlite.pragma('foreign_keys = OFF');
  try {
    const importProduct = productStore.sqlite.transaction(() => {
      for (const [table] of PRODUCT_TABLES) {
        const rows = product[table];
        if (!rows) continue;
        productStore.sqlite.prepare(`DELETE FROM ${table}`).run();
        if (!rows.length) continue;
        const allowed = new Set(productStore.sqlite.pragma(`table_info(${table})`).map(({ name }) => name));
        const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((column) => allowed.has(column));
        if (!columns.length) throw new Error(`table "${table}" has no known columns`);
        const insert = productStore.sqlite.prepare(
          `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
        );
        for (const row of rows) {
          if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`table "${table}" records must be objects`);
          insert.run(...columns.map((column) => row[column] ?? null));
        }
        imported.product[table] = rows.length;
      }
    });
    importProduct();
  } finally {
    productStore.sqlite.pragma('foreign_keys = ON');
  }
  return imported;
}
