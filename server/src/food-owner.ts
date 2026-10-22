// The local food-search owner rule: a foods row is visible when it belongs to
// the signed-in caller or has no owner. One bound parameter, the caller id.
// `alias` is a fixed identifier, never request data.
export function foodVisibleToCaller(alias: 'f' | '' = ''): string {
  const column = alias ? `${alias}.user_id` : 'user_id';
  return `(${column} = ? OR ${column} IS NULL)`;
}
