// List convenience methods return rows, even when the server uses a pagination
// envelope. Keep legacy array responses usable during rolling upgrades.
export function listItems<T>(response: T[] | { items?: T[] | null } | null): T[] {
  const items = Array.isArray(response) ? response : response?.items;
  return Array.isArray(items) ? items : [];
}
