function normalizeScope(value) {
  const scope = String(value || "").trim();
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(scope)) throw new Error("异步操作范围无效");
  return scope;
}

export function createLatestOperationGuard() {
  let generation = 0;
  let sequence = 0;
  const active = new Map();

  function begin(scopeValue) {
    const scope = normalizeScope(scopeValue);
    const token = Object.freeze({ scope, generation, sequence: ++sequence });
    active.set(scope, token);
    return token;
  }

  function isCurrent(token) {
    return Boolean(
      token
      && typeof token === "object"
      && token.generation === generation
      && active.get(token.scope) === token
    );
  }

  function end(token) {
    if (!isCurrent(token)) return false;
    active.delete(token.scope);
    return true;
  }

  function cancel(scopeValue) {
    return active.delete(normalizeScope(scopeValue));
  }

  function invalidateAll() {
    generation += 1;
    active.clear();
  }

  return Object.freeze({ begin, isCurrent, end, cancel, invalidateAll });
}

export function createRevisionOperationGuard({ getRevision, isAvailable = () => true } = {}) {
  if (typeof getRevision !== "function" || typeof isAvailable !== "function") throw new Error("修订操作保护器参数无效");
  let sequence = 0;
  let active = null;
  const issued = new WeakSet();

  function readRevision() {
    const revision = Number(getRevision());
    if (!Number.isSafeInteger(revision) || revision < 0) throw new Error("修订号无效");
    return revision;
  }

  function begin() {
    const revision = readRevision();
    const token = Object.freeze({ sequence: ++sequence, revision });
    issued.add(token);
    active = token;
    return token;
  }

  function isLatest(token) {
    return active === token;
  }

  function matchesRevision(token) {
    if (!token || typeof token !== "object" || !issued.has(token)) return false;
    try {
      return token.revision === readRevision() && isAvailable() === true;
    } catch {
      return false;
    }
  }

  function isCurrent(token) {
    return isLatest(token) && matchesRevision(token);
  }

  function invalidate() {
    sequence += 1;
    active = null;
  }

  return Object.freeze({ begin, isLatest, matchesRevision, isCurrent, invalidate });
}
