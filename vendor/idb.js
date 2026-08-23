/*
 * idb 8.0.3
 * Copyright (c) 2016, Jake Archibald
 * ISC License — see ./idb.LICENSE.txt
 * Source package: https://github.com/jakearchibald/idb/tree/77dd8bebf3669bbce9628e470a021ff63eb4acaf
 * Published build vendored locally; no runtime network loading.
 */
const instanceOfAny = (object, constructors) => constructors.some((constructor) => object instanceof constructor);

let idbProxyableTypes;
let cursorAdvanceMethods;

function getIdbProxyableTypes() {
  return idbProxyableTypes || (idbProxyableTypes = [IDBDatabase, IDBObjectStore, IDBIndex, IDBCursor, IDBTransaction]);
}

function getCursorAdvanceMethods() {
  return cursorAdvanceMethods || (cursorAdvanceMethods = [
    IDBCursor.prototype.advance,
    IDBCursor.prototype.continue,
    IDBCursor.prototype.continuePrimaryKey
  ]);
}

const transactionDoneMap = new WeakMap();
const transformCache = new WeakMap();
const reverseTransformCache = new WeakMap();

function promisifyRequest(request) {
  const promise = new Promise((resolve, reject) => {
    const unlisten = () => {
      request.removeEventListener("success", success);
      request.removeEventListener("error", error);
    };
    const success = () => {
      resolve(wrap(request.result));
      unlisten();
    };
    const error = () => {
      reject(request.error);
      unlisten();
    };
    request.addEventListener("success", success);
    request.addEventListener("error", error);
  });
  reverseTransformCache.set(promise, request);
  return promise;
}

function cacheDonePromiseForTransaction(transaction) {
  if (transactionDoneMap.has(transaction)) return;
  const done = new Promise((resolve, reject) => {
    const unlisten = () => {
      transaction.removeEventListener("complete", complete);
      transaction.removeEventListener("error", error);
      transaction.removeEventListener("abort", error);
    };
    const complete = () => {
      resolve();
      unlisten();
    };
    const error = () => {
      reject(transaction.error || new DOMException("AbortError", "AbortError"));
      unlisten();
    };
    transaction.addEventListener("complete", complete);
    transaction.addEventListener("error", error);
    transaction.addEventListener("abort", error);
  });
  transactionDoneMap.set(transaction, done);
}

let idbProxyTraps = {
  get(target, property, receiver) {
    if (target instanceof IDBTransaction) {
      if (property === "done") return transactionDoneMap.get(target);
      if (property === "store") {
        return receiver.objectStoreNames[1] ? undefined : receiver.objectStore(receiver.objectStoreNames[0]);
      }
    }
    return wrap(target[property]);
  },
  set(target, property, value) {
    target[property] = value;
    return true;
  },
  has(target, property) {
    if (target instanceof IDBTransaction && (property === "done" || property === "store")) return true;
    return property in target;
  }
};

function replaceTraps(callback) {
  idbProxyTraps = callback(idbProxyTraps);
}

function wrapFunction(func) {
  if (getCursorAdvanceMethods().includes(func)) {
    return function (...args) {
      func.apply(unwrap(this), args);
      return wrap(this.request);
    };
  }
  return function (...args) {
    return wrap(func.apply(unwrap(this), args));
  };
}

function transformCachableValue(value) {
  if (typeof value === "function") return wrapFunction(value);
  if (value instanceof IDBTransaction) cacheDonePromiseForTransaction(value);
  if (instanceOfAny(value, getIdbProxyableTypes())) return new Proxy(value, idbProxyTraps);
  return value;
}

function wrap(value) {
  if (value instanceof IDBRequest) return promisifyRequest(value);
  if (transformCache.has(value)) return transformCache.get(value);
  const transformed = transformCachableValue(value);
  if (transformed !== value) {
    transformCache.set(value, transformed);
    reverseTransformCache.set(transformed, value);
  }
  return transformed;
}

const unwrap = (value) => reverseTransformCache.get(value);

function openDB(name, version, { blocked, upgrade, blocking, terminated } = {}) {
  const request = indexedDB.open(name, version);
  const openPromise = wrap(request);
  if (upgrade) {
    request.addEventListener("upgradeneeded", (event) => {
      upgrade(wrap(request.result), event.oldVersion, event.newVersion, wrap(request.transaction), event);
    });
  }
  if (blocked) {
    request.addEventListener("blocked", (event) => blocked(event.oldVersion, event.newVersion, event));
  }
  openPromise.then((database) => {
    if (terminated) database.addEventListener("close", () => terminated());
    if (blocking) database.addEventListener("versionchange", (event) => blocking(event.oldVersion, event.newVersion, event));
  }).catch(() => {});
  return openPromise;
}

function deleteDB(name, { blocked } = {}) {
  const request = indexedDB.deleteDatabase(name);
  if (blocked) request.addEventListener("blocked", (event) => blocked(event.oldVersion, event));
  return wrap(request).then(() => undefined);
}

const readMethods = ["get", "getKey", "getAll", "getAllKeys", "count"];
const writeMethods = ["put", "add", "delete", "clear"];
const cachedMethods = new Map();

function getMethod(target, property) {
  if (!(target instanceof IDBDatabase && !(property in target) && typeof property === "string")) return;
  if (cachedMethods.get(property)) return cachedMethods.get(property);
  const targetFunctionName = property.replace(/FromIndex$/, "");
  const useIndex = property !== targetFunctionName;
  const isWrite = writeMethods.includes(targetFunctionName);
  if (!(targetFunctionName in (useIndex ? IDBIndex : IDBObjectStore).prototype) || !(isWrite || readMethods.includes(targetFunctionName))) return;
  const method = async function (storeName, ...args) {
    const transaction = this.transaction(storeName, isWrite ? "readwrite" : "readonly");
    let operationTarget = transaction.store;
    if (useIndex) operationTarget = operationTarget.index(args.shift());
    return (await Promise.all([operationTarget[targetFunctionName](...args), isWrite && transaction.done]))[0];
  };
  cachedMethods.set(property, method);
  return method;
}

replaceTraps((oldTraps) => ({
  ...oldTraps,
  get: (target, property, receiver) => getMethod(target, property) || oldTraps.get(target, property, receiver),
  has: (target, property) => Boolean(getMethod(target, property)) || oldTraps.has(target, property)
}));

const advanceMethodProps = ["continue", "continuePrimaryKey", "advance"];
const methodMap = {};
const advanceResults = new WeakMap();
const iteratorProxyToOriginal = new WeakMap();
const cursorIteratorTraps = {
  get(target, property) {
    if (!advanceMethodProps.includes(property)) return target[property];
    let cachedFunction = methodMap[property];
    if (!cachedFunction) {
      cachedFunction = methodMap[property] = function (...args) {
        advanceResults.set(this, iteratorProxyToOriginal.get(this)[property](...args));
      };
    }
    return cachedFunction;
  }
};

async function* iterate(...args) {
  let cursor = this;
  if (!(cursor instanceof IDBCursor)) cursor = await cursor.openCursor(...args);
  if (!cursor) return;
  const proxiedCursor = new Proxy(cursor, cursorIteratorTraps);
  iteratorProxyToOriginal.set(proxiedCursor, cursor);
  reverseTransformCache.set(proxiedCursor, unwrap(cursor));
  while (cursor) {
    yield proxiedCursor;
    cursor = await (advanceResults.get(proxiedCursor) || cursor.continue());
    advanceResults.delete(proxiedCursor);
  }
}

function isIteratorProp(target, property) {
  return (property === Symbol.asyncIterator && instanceOfAny(target, [IDBIndex, IDBObjectStore, IDBCursor]))
    || (property === "iterate" && instanceOfAny(target, [IDBIndex, IDBObjectStore]));
}

replaceTraps((oldTraps) => ({
  ...oldTraps,
  get(target, property, receiver) {
    if (isIteratorProp(target, property)) return iterate;
    return oldTraps.get(target, property, receiver);
  },
  has(target, property) {
    return isIteratorProp(target, property) || oldTraps.has(target, property);
  }
}));

export { deleteDB, openDB, unwrap, wrap };
