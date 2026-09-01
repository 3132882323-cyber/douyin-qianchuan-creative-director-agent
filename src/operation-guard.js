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
