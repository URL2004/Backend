'use strict';

const DELETE = Symbol('delete-field');

function clone(value) {
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  if (value.__increment !== undefined || value === DELETE) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
}

function valueAt(data, field) {
  return String(field).split('.').reduce((value, key) => value && value[key], data);
}

function setAt(data, field, value) {
  const keys = String(field).split('.');
  let cursor = data;
  for (const key of keys.slice(0, -1)) cursor = cursor[key] ||= {};
  const key = keys.at(-1);
  if (value === DELETE) delete cursor[key];
  else if (value && value.__increment !== undefined) cursor[key] = (Number(cursor[key]) || 0) + value.__increment;
  else cursor[key] = clone(value);
}

function mergeData(previous, patch) {
  const result = clone(previous || {});
  for (const [key, value] of Object.entries(patch || {})) setAt(result, key, value);
  return result;
}

class FakeDocRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').at(-1); }
  collection(name) { return new FakeCollectionRef(this.db, `${this.path}/${name}`); }
  async get() { return this.db.snapshot(this); }
  async set(value, options) {
    this.db.rows.set(this.path, options?.merge ? mergeData(this.db.rows.get(this.path), value) : clone(value));
  }
  async update(value) {
    if (!this.db.rows.has(this.path)) throw new Error('not-found');
    this.db.rows.set(this.path, mergeData(this.db.rows.get(this.path), value));
  }
  async delete() { this.db.rows.delete(this.path); }
}

class FakeQuery {
  constructor(collection, filters = [], max = Infinity) {
    this.collection = collection;
    this.filters = filters;
    this.max = max;
  }
  where(field, op, value) {
    if (op !== '==') throw new Error(`unsupported-op:${op}`);
    return new FakeQuery(this.collection, [...this.filters, [field, value]], this.max);
  }
  limit(max) { return new FakeQuery(this.collection, this.filters, max); }
  async get() {
    const prefix = `${this.collection.path}/`;
    const depth = this.collection.path.split('/').length + 1;
    const docs = [];
    for (const [path, data] of this.collection.db.rows) {
      if (!path.startsWith(prefix) || path.split('/').length !== depth) continue;
      if (!this.filters.every(([field, value]) => valueAt(data, field) === value)) continue;
      docs.push(this.collection.db.snapshot(new FakeDocRef(this.collection.db, path)));
      if (docs.length >= this.max) break;
    }
    return { empty: docs.length === 0, docs };
  }
}

class FakeCollectionRef extends FakeQuery {
  constructor(db, path) {
    const collection = { db, path };
    super(collection);
    this.db = db;
    this.path = path;
    this.collection = this;
  }
  doc(id = `auto_${this.db.autoId++}`) { return new FakeDocRef(this.db, `${this.path}/${id}`); }
}

class FakeFirestore {
  constructor(initial = {}) {
    this.rows = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]));
    this.autoId = 1;
  }
  collection(name) { return new FakeCollectionRef(this, name); }
  collectionGroup(name) {
    const db = this;
    return {
      where(field, op, value) {
        return {
          async get() {
            const docs = [];
            for (const [path, data] of db.rows) {
              const pieces = path.split('/');
              if (pieces.at(-2) === name && op === '==' && valueAt(data, field) === value) {
                docs.push(db.snapshot(new FakeDocRef(db, path)));
              }
            }
            return { empty: docs.length === 0, docs };
          }
        };
      }
    };
  }
  snapshot(ref) {
    const exists = this.rows.has(ref.path);
    return { id: ref.id, ref, exists, data: () => clone(this.rows.get(ref.path) || {}) };
  }
  batch() {
    const operations = [];
    return {
      delete: ref => operations.push(() => ref.delete()),
      set: (ref, value, options) => operations.push(() => ref.set(value, options)),
      update: (ref, value) => operations.push(() => ref.update(value)),
      async commit() { for (const operation of operations) await operation(); }
    };
  }
  async runTransaction(callback) {
    return callback({
      get: ref => ref.get(),
      set: (ref, value, options) => ref.set(value, options),
      update: (ref, value) => ref.update(value),
      delete: ref => ref.delete()
    });
  }
}

function fakeAdmin(events = []) {
  return {
    firestore: {
      FieldValue: {
        delete: () => DELETE,
        increment: amount => ({ __increment: Number(amount) }),
        serverTimestamp: () => ({ serverTimestamp: true })
      },
      Timestamp: {
        fromMillis: ms => ({ toMillis: () => Number(ms), ms: Number(ms) })
      }
    },
    auth() {
      return {
        async deleteUser(uid) { events.push(`auth.delete:${uid}`); }
      };
    }
  };
}

module.exports = { DELETE, FakeFirestore, fakeAdmin, valueAt };
