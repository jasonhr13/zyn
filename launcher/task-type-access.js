// Optional modules are denied unless the signed license explicitly enables them. Target remains the
// built-in task type and therefore does not appear in this list. Adding a future optional module is
// one registry entry here plus its UI/engine implementation.
const OPTIONAL_TASK_TYPES = Object.freeze([
  { key: 'pokemoncenter', label: 'Pokémon Center' },
  { key: 'round1', label: 'Round1' },
]);

function normalizeTaskTypeAccess(raw, enabledByDefault = false) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return Object.fromEntries(OPTIONAL_TASK_TYPES.map(({ key }) => [
    key,
    Object.hasOwn(source, key) ? source[key] === true : enabledByDefault === true,
  ]));
}

function removedTaskTypes(previous, next) {
  const before = normalizeTaskTypeAccess(previous);
  const after = normalizeTaskTypeAccess(next);
  return OPTIONAL_TASK_TYPES.map(({ key }) => key).filter(key => before[key] && !after[key]);
}

module.exports = { OPTIONAL_TASK_TYPES, normalizeTaskTypeAccess, removedTaskTypes };
