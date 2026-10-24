import { test } from 'node:test';
import assert from 'node:assert/strict';
import { traceDownstream, type TraceInput } from '../../spacetimedb/src/trace.ts';
import { fixtures } from '../fixtures.ts';

const input = (rootLotId: string): TraceInput => {
  const f = fixtures();
  return { rootLotId, lots: f.lots, lotEdges: f.lotEdges, shipments: f.shipments, shipmentLines: f.shipmentLines, locations: f.locations };
};

test('PEANUT-009 affects BAR-100 and BAR-101 only', () => {
  const r = traceDownstream(input('PEANUT-009'));
  assert.deepEqual([...r.affectedLotIds].sort(), ['BAR-100', 'BAR-101']);
  assert.ok(!r.affectedLotIds.includes('BAR-102'));
  assert.ok(!r.affectedLotIds.includes('PEANUT-009'), 'root lot is not listed');
});

test('PEANUT-009 reaches both warehouses and stores A-E, not Store F or the factory', () => {
  const r = traceDownstream(input('PEANUT-009'));
  assert.deepEqual([...r.affectedLocationIds].sort(), [
    'STORE-A', 'STORE-B', 'STORE-C', 'STORE-D', 'STORE-E', 'WAREHOUSE-02', 'WAREHOUSE-03',
  ]);
  assert.ok(!r.affectedLocationIds.includes('STORE-F'));
  assert.ok(!r.affectedLocationIds.includes('FACTORY-01'));
});

test('BFS order: warehouses come before stores', () => {
  const r = traceDownstream(input('PEANUT-009'));
  const lastWarehouse = Math.max(...['WAREHOUSE-02', 'WAREHOUSE-03'].map((id) => r.affectedLocationIds.indexOf(id)));
  const firstStore = Math.min(...r.affectedLocationIds.filter((id) => id.startsWith('STORE-')).map((id) => r.affectedLocationIds.indexOf(id)));
  assert.ok(lastWarehouse < firstStore);
});

test('OAT-017 affects only BAR-102 -> WAREHOUSE-03 -> STORE-F', () => {
  const r = traceDownstream(input('OAT-017'));
  assert.deepEqual(r.affectedLotIds, ['BAR-102']);
  assert.deepEqual(r.affectedLocationIds, ['WAREHOUSE-03', 'STORE-F']);
});

test('OAT-015 affects BAR-100 and its stores but not STORE-E', () => {
  const r = traceDownstream(input('OAT-015'));
  assert.deepEqual(r.affectedLotIds, ['BAR-100']);
  assert.deepEqual([...r.affectedLocationIds].sort(), ['STORE-A', 'STORE-B', 'STORE-C', 'STORE-D', 'WAREHOUSE-02']);
});

test('finished lot as root: BAR-100 has no downstream lots but still has locations', () => {
  const r = traceDownstream(input('BAR-100'));
  assert.deepEqual(r.affectedLotIds, []);
  assert.equal(r.affectedLocationIds.length, 5);
});

test('unknown root lot throws NOT_FOUND', () => {
  assert.throws(() => traceDownstream(input('NOPE-1')), /^Error: NOT_FOUND:/);
});

test('multi-level and cyclic lot graphs terminate and include every descendant once', () => {
  const lot = (lotId: string) => ({ lotId, sku: null, kind: 'INGREDIENT' as const, producedAt: '2026-01-01T00:00:00Z', quantity: 1 });
  const r = traceDownstream({
    rootLotId: 'A',
    lots: ['A', 'B', 'C', 'D', 'X'].map(lot),
    lotEdges: [
      { parentLotId: 'A', childLotId: 'B', quantityUsed: 1 },
      { parentLotId: 'B', childLotId: 'C', quantityUsed: 1 },
      { parentLotId: 'A', childLotId: 'C', quantityUsed: 1 },
      { parentLotId: 'C', childLotId: 'D', quantityUsed: 1 },
      { parentLotId: 'D', childLotId: 'B', quantityUsed: 1 }, // cycle
      { parentLotId: 'X', childLotId: 'D', quantityUsed: 1 }, // unrelated parent
    ],
    shipments: [],
    shipmentLines: [],
    locations: [],
  });
  assert.deepEqual(r.affectedLotIds, ['B', 'C', 'D']);
});

test('a shipment of the contaminated ingredient itself makes its destination affected', () => {
  const f = input('PEANUT-009');
  f.locations = [...f.locations, { id: 'CO-PACKER', orgId: 'ORG-ACME', name: 'Co-packer', type: 'FACTORY', x: 0, y: 0 }];
  f.shipments = [...f.shipments, { shipmentId: 'SHP-X', fromLocation: 'FACTORY-01', toLocation: 'CO-PACKER', status: 'RECEIVED' }];
  f.shipmentLines = [...f.shipmentLines, { shipmentId: 'SHP-X', lotId: 'PEANUT-009', qtyDispatched: 10, qtyReceived: 10, qtyDamaged: 0 }];
  assert.ok(traceDownstream(f).affectedLocationIds.includes('CO-PACKER'));
});

test('a warehouse that receives multiple affected lots is listed once', () => {
  const r = traceDownstream(input('PEANUT-009'));
  assert.equal(new Set(r.affectedLocationIds).size, r.affectedLocationIds.length);
});
