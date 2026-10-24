import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcileLocation, type ReconcileInput } from '../../spacetimedb/src/reconcile.ts';
import { fixtures } from '../fixtures.ts';

const AFFECTED = ['BAR-100', 'BAR-101'];

const input = (locationId: string, lotIds = AFFECTED): ReconcileInput => {
  const f = fixtures();
  return {
    locationId,
    lotIds,
    shipments: f.shipments,
    shipmentLines: f.shipmentLines,
    events: f.events.filter((e) => e.locationId === locationId),
    balances: f.balances.filter((b) => b.locationId === locationId),
  };
};

test('Store D: 130 shipped, 120 received, 85 sold, 20 counted -> 10 lost, 15 unaccounted', () => {
  assert.deepEqual(reconcileLocation(input('STORE-D')), {
    locationId: 'STORE-D',
    expectedUnits: 120,
    soldUnits: 85,
    quarantinedUnits: 0,
    onHandUnits: 20,
    shippedOnwardUnits: 0,
    lostInTransitUnits: 10,
    unaccountedUnits: 15,
  });
});

test('stores A, B, C, E reconcile cleanly (section 6 numbers)', () => {
  const expected: Record<string, [received: number, sold: number, onHand: number]> = {
    'STORE-A': [200, 80, 120],
    'STORE-B': [150, 40, 110],
    'STORE-C': [120, 30, 90],
    'STORE-E': [300, 100, 200],
  };
  for (const [id, [received, sold, onHand]] of Object.entries(expected)) {
    const r = reconcileLocation(input(id));
    assert.equal(r.expectedUnits, received, `${id} received`);
    assert.equal(r.soldUnits, sold, `${id} sold`);
    assert.equal(r.onHandUnits, onHand, `${id} on hand`);
    assert.equal(r.lostInTransitUnits, 0, `${id} lost`);
    assert.equal(r.unaccountedUnits, 0, `${id} unaccounted`);
  }
});

test('warehouses: everything received was shipped onward', () => {
  const w2 = reconcileLocation(input('WAREHOUSE-02'));
  assert.equal(w2.expectedUnits, 600);
  assert.equal(w2.shippedOnwardUnits, 600);
  assert.equal(w2.unaccountedUnits, 0);

  // WAREHOUSE-03 also handled BAR-102, which must not be counted.
  const w3 = reconcileLocation(input('WAREHOUSE-03'));
  assert.equal(w3.expectedUnits, 300);
  assert.equal(w3.shippedOnwardUnits, 300);
  assert.equal(w3.unaccountedUnits, 0);
});

test('Store F has nothing affected: all zeros', () => {
  const r = reconcileLocation(input('STORE-F'));
  assert.equal(r.expectedUnits, 0);
  assert.equal(r.soldUnits, 0);
  assert.equal(r.onHandUnits, 0);
  assert.equal(r.unaccountedUnits, 0);
});

test('quarantine moves units but keeps them on hand (Store A after quarantine)', () => {
  const i = input('STORE-A');
  i.balances = i.balances.map((b) => ({ ...b, available: 0, quarantined: 120 }));
  i.events = [...i.events, { id: 99, lotId: 'BAR-100', locationId: 'STORE-A', type: 'QUARANTINED', qty: 120, at: '2026-10-24T12:00:00Z', actor: 'ORG-STORE-A' }];
  const r = reconcileLocation(i);
  assert.equal(r.quarantinedUnits, 120);
  assert.equal(r.onHandUnits, 120);
  assert.equal(r.unaccountedUnits, 0);
});

test('in-store damage and damaged-on-arrival units are accounted for', () => {
  const i = input('STORE-C');
  i.shipmentLines = i.shipmentLines.map((l) => (l.shipmentId === 'SHP-005' ? { ...l, qtyDamaged: 5 } : l));
  i.events = [...i.events, { id: 99, lotId: 'BAR-100', locationId: 'STORE-C', type: 'DAMAGED', qty: 3, at: '2026-10-20T12:00:00Z', actor: 'ORG-STORE-C' }];
  i.balances = i.balances.map((b) => ({ ...b, available: 82, damaged: 8 }));
  assert.equal(reconcileLocation(i).unaccountedUnits, 0);
});

test('surplus stock never yields negative unaccounted units', () => {
  const i = input('STORE-B');
  i.balances = i.balances.map((b) => ({ ...b, available: 500 }));
  assert.equal(reconcileLocation(i).unaccountedUnits, 0);
});

test('rows for other locations and unaffected lots are ignored when full tables are passed', () => {
  const f = fixtures();
  const r = reconcileLocation({
    locationId: 'STORE-D',
    lotIds: AFFECTED,
    shipments: f.shipments,
    shipmentLines: f.shipmentLines,
    events: f.events,
    balances: f.balances,
  });
  assert.equal(r.unaccountedUnits, 15);
  assert.equal(r.soldUnits, 85);
});
