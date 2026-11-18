export function effectiveDiff(
  before: unknown,
  after: unknown,
  prefix = '',
): Record<string, { before?: unknown; after?: unknown }> {
  if (JSON.stringify(before) === JSON.stringify(after)) return {};
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (object(before) && object(after))
    return Object.assign(
      {},
      ...Array.from(new Set([...Object.keys(before), ...Object.keys(after)])).map((key) =>
        effectiveDiff(before[key], after[key], prefix ? prefix + '.' + key : key),
      ),
    );
  return {
    [prefix]: {
      ...(before !== undefined ? { before } : {}),
      ...(after !== undefined ? { after } : {}),
    },
  };
}
