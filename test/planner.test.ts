import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { autoReserveMb, heapForRss, planRam, rssForHeap, type Plan, type PlanServer } from '../src/ram/planner';

const proxy: PlanServer = { id: 'proxy', role: 'proxy', memory: {} };
const lobby: PlanServer = { id: 'lobby', role: 'backend', memory: { weight: 2 } };
const survival: PlanServer = { id: 'survival', role: 'backend', memory: { weight: 8 } };

const get = (plan: Plan, id: string) => {
  const a = plan.allocations.find((x) => x.id === id);
  assert.ok(a, `no allocation for ${id}`);
  return a;
};

describe('rssForHeap / heapForRss', () => {
  it('adds a fixed overhead for small heaps and a percentage for big ones, more for game servers than for a proxy', () => {
    assert.equal(rssForHeap(512), 1024); // game server: 512 MB fixed
    assert.equal(rssForHeap(512, 'proxy'), 768); // proxy: 256 MB fixed
    assert.equal(rssForHeap(4000), 4600); // 15 % beats the fixed part
    assert.equal(rssForHeap(4000, 'proxy'), 4600);
  });

  it('are inverse to each other', () => {
    for (const role of ['proxy', 'backend'] as const) {
      for (const heap of [256, 512, 1700, 3400, 3500, 8000]) assert.ok(Math.abs(heapForRss(rssForHeap(heap, role), role) - heap) < 0.5, `${role} heap ${heap}`);
    }
  });
});

describe('planRam', () => {
  it('reserves 12 % (at least 1 GB) for the system', () => {
    assert.equal(autoReserveMb(4096), 1024);
    assert.equal(autoReserveMb(32768), 3932);
    assert.equal(planRam({ totalMb: 16384, reserveMb: 0, servers: [] }).reserveMb, 1966);
    assert.equal(planRam({ totalMb: 16384, reserveMb: 4096, servers: [] }).budgetMb, 12288);
  });

  it('shares the budget by weight and stays inside it', () => {
    const plan = planRam({ totalMb: 16384, reserveMb: 0, servers: [proxy, lobby, survival] });
    assert.ok(plan.expectedRssMb <= plan.budgetMb + 1);
    assert.ok(get(plan, 'survival').xmxMb > get(plan, 'lobby').xmxMb * 3);
    assert.ok(get(plan, 'lobby').xmxMb > get(plan, 'proxy').xmxMb);
    assert.deepEqual(plan.warnings, []);
    for (const a of plan.allocations) assert.equal(a.xmxMb % 64, 0);
  });

  it('gives the proxy its full heap at start and backends a smaller start heap', () => {
    const plan = planRam({ totalMb: 16384, reserveMb: 0, servers: [proxy, survival] });
    assert.equal(get(plan, 'proxy').xmsMb, get(plan, 'proxy').xmxMb);
    assert.ok(get(plan, 'survival').xmsMb < get(plan, 'survival').xmxMb);
    assert.ok(get(plan, 'survival').xmsMb >= 256);
  });

  it('limits a proxy to 1 GB unless told otherwise', () => {
    const plan = planRam({ totalMb: 32768, reserveMb: 0, servers: [proxy, survival] });
    assert.equal(get(plan, 'proxy').xmxMb, 1024);
    assert.equal(get(plan, 'proxy').reason, 'max');
    assert.ok(get(plan, 'survival').xmxMb > 20000);
    const big = planRam({ totalMb: 32768, reserveMb: 0, servers: [{ id: 'proxy', role: 'proxy', memory: { maxMb: 4096, weight: 5 } }, survival] });
    assert.ok(get(big, 'proxy').xmxMb > 1024);
  });

  it('honours pinned sizes and gives the rest to the others', () => {
    const pinned: PlanServer = { id: 'creative', role: 'backend', memory: { pinnedMb: 2048 } };
    const plan = planRam({ totalMb: 16384, reserveMb: 0, servers: [pinned, survival] });
    assert.equal(get(plan, 'creative').xmxMb, 2048);
    assert.equal(get(plan, 'creative').xmsMb, 2048);
    assert.equal(get(plan, 'creative').reason, 'pinned');
    assert.ok(get(plan, 'survival').xmxMb > 8000);
  });

  it('caps a server at maxMb and redistributes the surplus', () => {
    const capped: PlanServer = { id: 'lobby', role: 'backend', memory: { weight: 8, maxMb: 1024 } };
    const plan = planRam({ totalMb: 16384, reserveMb: 0, servers: [capped, survival] });
    assert.equal(get(plan, 'lobby').xmxMb, 1024);
    assert.equal(get(plan, 'lobby').reason, 'max');
    assert.ok(get(plan, 'survival').xmxMb > 10000);
  });

  it('raises tiny shares to the minimum and takes it from the others', () => {
    const big: PlanServer = { id: 'big', role: 'backend', memory: { weight: 1000 } };
    const small: PlanServer = { id: 'small', role: 'backend', memory: { weight: 1, minMb: 1024 } };
    const plan = planRam({ totalMb: 8192, reserveMb: 0, servers: [big, small] });
    assert.equal(get(plan, 'small').xmxMb, 1024);
    assert.equal(get(plan, 'small').reason, 'min');
    assert.ok(plan.expectedRssMb <= plan.budgetMb + 1);
  });

  it('warns and falls back to the minimums when the RAM is not enough', () => {
    const plan = planRam({ totalMb: 2048, reserveMb: 0, servers: [proxy, lobby, survival] });
    assert.equal(plan.warnings.length, 1);
    assert.match(plan.warnings[0], /Not enough RAM/);
    assert.equal(get(plan, 'proxy').xmxMb, 512);
    assert.equal(get(plan, 'survival').xmxMb, 512);
  });

  it('warns when pinned servers alone exceed the budget', () => {
    const plan = planRam({ totalMb: 4096, reserveMb: 0, servers: [{ id: 'a', role: 'backend', memory: { pinnedMb: 8192 } }] });
    assert.match(plan.warnings[0], /only .* MB are available/);
  });

  it('plans nothing for an empty network', () => {
    const plan = planRam({ totalMb: 8192, reserveMb: 0, servers: [] });
    assert.deepEqual(plan.allocations, []);
    assert.equal(plan.expectedRssMb, 0);
  });

  it('never goes below 64 MB heap even for silly input', () => {
    const plan = planRam({ totalMb: 8192, reserveMb: 0, servers: [{ id: 'x', role: 'backend', memory: { minMb: 1 } }] });
    assert.ok(get(plan, 'x').xmxMb >= 64);
  });
});
