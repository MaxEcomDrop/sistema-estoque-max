const crypto = require('crypto');
const mysql = require('mysql2/promise');

const TYPE_KEY = '__estoqueMaxType';
const SERVER_TIMESTAMP = Symbol('serverTimestamp');
const ARRAY_UNION = Symbol('arrayUnion');

class CompatTimestamp {
  constructor(value) {
    this.value = value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }

  toDate() {
    return new Date(this.value);
  }

  toMillis() {
    return this.toDate().getTime();
  }

  valueOf() {
    return this.toMillis();
  }

  toJSON() {
    return this.value;
  }
}

const FieldValue = {
  serverTimestamp: () => ({ [SERVER_TIMESTAMP]: true }),
  arrayUnion: (...values) => ({ [ARRAY_UNION]: values }),
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && !(value instanceof Date) && !(value instanceof CompatTimestamp);
}

function clone(value) {
  return deserializeValue(serializeValue(value));
}

function resolveSpecialValues(value, currentValue) {
  if (value?.[SERVER_TIMESTAMP]) return new CompatTimestamp(new Date());
  if (value?.[ARRAY_UNION]) {
    const existing = Array.isArray(currentValue) ? currentValue : [];
    const result = existing.map(item => clone(item));
    const fingerprints = new Set(result.map(item => JSON.stringify(serializeValue(item))));
    for (const item of value[ARRAY_UNION]) {
      const fingerprint = JSON.stringify(serializeValue(item));
      if (!fingerprints.has(fingerprint)) {
        fingerprints.add(fingerprint);
        result.push(clone(item));
      }
    }
    return result;
  }
  if (value instanceof Date || value instanceof CompatTimestamp) return new CompatTimestamp(value instanceof Date ? value : value.value);
  if (Array.isArray(value)) return value.map((item, index) => resolveSpecialValues(item, currentValue?.[index]));
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, resolveSpecialValues(item, currentValue?.[key])]));
  }
  return value;
}

function mergeObjects(current, incoming) {
  if (!isPlainObject(current) || !isPlainObject(incoming)) return clone(incoming);
  const result = clone(current);
  for (const [key, value] of Object.entries(incoming)) {
    result[key] = isPlainObject(value) && isPlainObject(result[key])
      ? mergeObjects(result[key], value)
      : clone(value);
  }
  return result;
}

function serializeValue(value) {
  if (value instanceof CompatTimestamp) return { [TYPE_KEY]: 'date', value: value.value };
  if (value instanceof Date) return { [TYPE_KEY]: 'date', value: value.toISOString() };
  if (Array.isArray(value)) return value.map(serializeValue);
  if (isPlainObject(value)) {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .map(([key, item]) => [key, serializeValue(item)]));
  }
  return value;
}

function deserializeValue(value) {
  if (Array.isArray(value)) return value.map(deserializeValue);
  if (value && typeof value === 'object') {
    if (value[TYPE_KEY] === 'date') return new CompatTimestamp(value.value);
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, deserializeValue(item)]));
  }
  return value;
}

function parseStoredJson(value) {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === 'string' ? JSON.parse(value) : value;
  return deserializeValue(parsed);
}

function stringifyStoredJson(value) {
  return JSON.stringify(serializeValue(value));
}

function fieldValue(data, field) {
  return String(field).split('.').reduce((value, key) => value?.[key], data);
}

function comparable(value) {
  if (value instanceof CompatTimestamp) return value.toMillis();
  if (value instanceof Date) return value.getTime();
  return value;
}

function matchesFilter(data, filter) {
  const left = comparable(fieldValue(data, filter.field));
  const right = comparable(filter.value);
  if (filter.operator === '==') return left === right;
  if (filter.operator === '>=') return left >= right;
  if (filter.operator === '<=') return left <= right;
  if (filter.operator === '>') return left > right;
  if (filter.operator === '<') return left < right;
  throw new Error(`Operador de consulta MySQL não suportado: ${filter.operator}`);
}

class DocumentSnapshot {
  constructor(ref, row, selectedFields = null) {
    this.ref = ref;
    this.id = ref.id;
    this.exists = Boolean(row);
    const data = row ? parseStoredJson(row.dataJson) : undefined;
    this._fullData = data;
    this._data = data && selectedFields
      ? Object.fromEntries(selectedFields.filter(field => field in data).map(field => [field, data[field]]))
      : data;
    this.updateTime = row ? new CompatTimestamp(Number(row.updatedAt)) : null;
  }

  data() {
    return this.exists ? clone(this._data) : undefined;
  }
}

class QuerySnapshot {
  constructor(docs) {
    this.docs = docs;
    this.size = docs.length;
    this.empty = docs.length === 0;
  }

  forEach(callback) {
    this.docs.forEach(callback);
  }
}

class DocumentReference {
  constructor(firestore, collectionName, id) {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.id = String(id);
  }

  async get(context = this.firestore._driver) {
    return new DocumentSnapshot(this, await context.get(this.collectionName, this.id));
  }

  async _set(data, options = {}, context = this.firestore._driver) {
    const currentRow = options.merge ? await context.get(this.collectionName, this.id) : null;
    const current = currentRow ? parseStoredJson(currentRow.dataJson) : {};
    const resolved = resolveSpecialValues(data, current);
    const next = options.merge ? mergeObjects(current, resolved) : resolved;
    await context.put(this.collectionName, this.id, stringifyStoredJson(next));
    return this;
  }

  async set(data, options = {}) {
    if (options.merge) {
      return this.firestore._driver.transaction(context => this._set(data, options, context));
    }
    return this._set(data, options);
  }

  async update(data) {
    return this.firestore._driver.transaction(async context => {
      const current = await context.get(this.collectionName, this.id);
      if (!current) throw new Error(`Documento inexistente: ${this.collectionName}/${this.id}`);
      return this._set(data, { merge: true }, context);
    });
  }

  async delete(context = this.firestore._driver) {
    await context.delete(this.collectionName, this.id);
  }
}

class Query {
  constructor(firestore, collectionName, state = {}) {
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.filters = state.filters || [];
    this.sort = state.sort || null;
    this.max = state.max || null;
    this.selectedFields = state.selectedFields || null;
  }

  _copy(changes) {
    return new Query(this.firestore, this.collectionName, {
      filters: this.filters,
      sort: this.sort,
      max: this.max,
      selectedFields: this.selectedFields,
      ...changes,
    });
  }

  where(field, operator, value) {
    return this._copy({ filters: [...this.filters, { field, operator, value }] });
  }

  orderBy(field, direction = 'asc') {
    return this._copy({ sort: { field, direction } });
  }

  limit(max) {
    return this._copy({ max: Math.max(0, Number(max) || 0) });
  }

  select(...fields) {
    return this._copy({ selectedFields: fields });
  }

  async get() {
    let docs = (await this.firestore._driver.list(this.collectionName))
      .map(row => new DocumentSnapshot(new DocumentReference(this.firestore, this.collectionName, row.id), row, this.selectedFields))
      .filter(doc => this.filters.every(filter => matchesFilter(doc._fullData, filter)));
    if (this.sort) {
      const multiplier = this.sort.direction === 'desc' ? -1 : 1;
      docs.sort((left, right) => {
        const a = comparable(fieldValue(left._fullData, this.sort.field));
        const b = comparable(fieldValue(right._fullData, this.sort.field));
        if (a === b) return 0;
        if (a === undefined || a === null) return multiplier;
        if (b === undefined || b === null) return -multiplier;
        return a > b ? multiplier : -multiplier;
      });
    }
    if (this.max !== null) docs = docs.slice(0, this.max);
    return new QuerySnapshot(docs);
  }
}

class CollectionReference extends Query {
  doc(id = crypto.randomUUID()) {
    return new DocumentReference(this.firestore, this.collectionName, id);
  }

  async add(data) {
    const ref = this.doc();
    await ref.set(data);
    return ref;
  }
}

class WriteBatch {
  constructor(firestore) {
    this.firestore = firestore;
    this.operations = [];
  }

  set(ref, data, options = {}) {
    this.operations.push({ type: 'set', ref, data, options });
    return this;
  }

  update(ref, data) {
    this.operations.push({ type: 'update', ref, data });
    return this;
  }

  delete(ref) {
    this.operations.push({ type: 'delete', ref });
    return this;
  }

  async commit() {
    return this.firestore._driver.transaction(async context => {
      for (const operation of this.operations) {
        if (operation.type === 'set') await operation.ref._set(operation.data, operation.options, context);
        if (operation.type === 'update') {
          const current = await context.get(operation.ref.collectionName, operation.ref.id);
          if (!current) throw new Error(`Documento inexistente: ${operation.ref.collectionName}/${operation.ref.id}`);
          await operation.ref._set(operation.data, { merge: true }, context);
        }
        if (operation.type === 'delete') await operation.ref.delete(context);
      }
      return [];
    });
  }
}

function createFirestoreAdapter(driver) {
  const firestore = {
    _driver: driver,
    collection(name) {
      return new CollectionReference(firestore, String(name));
    },
    async getAll(...refs) {
      return Promise.all(refs.map(ref => ref.get()));
    },
    batch() {
      return new WriteBatch(firestore);
    },
    async close() {
      await driver.close?.();
    },
  };
  return firestore;
}

function mysqlConfigFromEnv(env = process.env) {
  return {
    host: env.MYSQL_HOST || env.DB_HOST || 'localhost',
    port: Number(env.MYSQL_PORT || env.DB_PORT || 3306),
    user: env.MYSQL_USER || env.DB_USER || '',
    password: env.MYSQL_PASSWORD || env.DB_PASSWORD || '',
    database: env.MYSQL_DATABASE || env.DB_NAME || '',
    connectionLimit: Math.max(2, Number(env.MYSQL_CONNECTION_LIMIT || 5)),
    ssl: String(env.MYSQL_SSL || '').toLowerCase() === 'true'
      ? { rejectUnauthorized: String(env.MYSQL_SSL_REJECT_UNAUTHORIZED || 'true').toLowerCase() !== 'false' }
      : undefined,
  };
}

function isMySqlConfigured(env = process.env) {
  const config = mysqlConfigFromEnv(env);
  return Boolean(config.user && config.password && config.database);
}

function createMySqlDriver(config = mysqlConfigFromEnv()) {
  const pool = mysql.createPool({
    ...config,
    waitForConnections: true,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
    charset: 'utf8mb4',
  });
  let schemaPromise = null;

  const ensureSchema = () => {
    if (!schemaPromise) {
      schemaPromise = pool.execute(`
        CREATE TABLE IF NOT EXISTS app_documents (
          collection_name VARCHAR(191) NOT NULL,
          document_id VARCHAR(191) NOT NULL,
          data_json LONGTEXT NOT NULL,
          created_at BIGINT UNSIGNED NOT NULL,
          updated_at BIGINT UNSIGNED NOT NULL,
          PRIMARY KEY (collection_name, document_id),
          INDEX idx_app_documents_collection_updated (collection_name, updated_at)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
      `).catch(error => {
        schemaPromise = null;
        throw error;
      });
    }
    return schemaPromise;
  };

  const contextFor = executor => ({
    async get(collectionName, id) {
      await ensureSchema();
      const [rows] = await executor.execute(
        'SELECT data_json AS dataJson, updated_at AS updatedAt FROM app_documents WHERE collection_name = ? AND document_id = ? LIMIT 1',
        [collectionName, id]
      );
      return rows[0] || null;
    },
    async list(collectionName) {
      await ensureSchema();
      const [rows] = await executor.execute(
        'SELECT document_id AS id, data_json AS dataJson, updated_at AS updatedAt FROM app_documents WHERE collection_name = ?',
        [collectionName]
      );
      return rows;
    },
    async put(collectionName, id, dataJson) {
      await ensureSchema();
      const now = Date.now();
      await executor.execute(`
        INSERT INTO app_documents (collection_name, document_id, data_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE data_json = VALUES(data_json), updated_at = VALUES(updated_at)
      `, [collectionName, id, dataJson, now, now]);
    },
    async delete(collectionName, id) {
      await ensureSchema();
      await executor.execute(
        'DELETE FROM app_documents WHERE collection_name = ? AND document_id = ?',
        [collectionName, id]
      );
    },
  });

  const driver = contextFor(pool);
  driver.transaction = async callback => {
    await ensureSchema();
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(contextFor(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  };
  driver.close = () => pool.end();
  return driver;
}

function createMemoryDriver() {
  const rows = new Map();
  const key = (collectionName, id) => `${collectionName}\u0000${id}`;
  const context = {
    async get(collectionName, id) {
      const row = rows.get(key(collectionName, id));
      return row ? { ...row } : null;
    },
    async list(collectionName) {
      const prefix = `${collectionName}\u0000`;
      return [...rows.entries()]
        .filter(([storedKey]) => storedKey.startsWith(prefix))
        .map(([storedKey, row]) => ({ id: storedKey.slice(prefix.length), ...row }));
    },
    async put(collectionName, id, dataJson) {
      rows.set(key(collectionName, id), { dataJson, updatedAt: Date.now() });
    },
    async delete(collectionName, id) {
      rows.delete(key(collectionName, id));
    },
  };
  context.transaction = callback => callback(context);
  context.close = async () => {};
  return context;
}

function createMySqlFirestore(config = mysqlConfigFromEnv()) {
  return createFirestoreAdapter(createMySqlDriver(config));
}

module.exports = {
  CompatTimestamp,
  FieldValue,
  createFirestoreAdapter,
  createMemoryDriver,
  createMySqlFirestore,
  isMySqlConfigured,
  mysqlConfigFromEnv,
};
