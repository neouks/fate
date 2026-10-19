/** Drop only identical repeated values. Different versions/observations remain visible. */
export function compactPlannerChanges(changes: unknown[], overview: Record<string, unknown>, taskID: number): unknown[] {
  const entries = Object.entries(overview).flatMap(([section, items]) => Array.isArray(items)
    ? items.filter((item): item is Record<string, unknown> => !!item && typeof item === 'object').map(item => ({section,item})) : []);
  return changes.map(change => {
    if (!change || typeof change !== 'object') return change;
    const value = change as Record<string, unknown>;
    if (value.source_task_id !== taskID) return change;
    const found = entries.find(({item}) => `node:${item.id}` === value.ref);
    if (!found) return change;
    const copy = {...value};
    for (const key of ['summary','progress','result']) {
      if (key in copy && JSON.stringify(copy[key]) === JSON.stringify(found.item[key])) {
        delete copy[key]; copy.details_in = `${found.section}:${value.ref}`;
      }
    }
    return copy;
  });
}
