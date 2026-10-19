import test from 'node:test';
import assert from 'node:assert/strict';
import { listItems } from './api-list.ts';

test('intent and finding convenience lists unwrap paged responses without discarding rows', () => {
  const items = [{ id: '1', state: 'open' }, { id: '2', state: 'blocked' }];
  for (const response of [items, { items, has_more: false }, { items, total: 2, page: 1, page_size: 20 }]) {
    assert.deepEqual(listItems(response), items);
    assert.equal(listItems(response).filter(item => item.state === 'blocked').length, 1);
  }
});
test('empty and incomplete lists do not reach rendering as objects or undefined', () => {
  for (const response of [null, undefined, {}, [], { items: null }, { items: [] }, { items: {} }]) {
    assert.deepEqual(listItems(response), []);
  }
});
