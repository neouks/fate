import { describe, it, expect } from "vitest";
import { coldBlocks, type ColdNode } from "./coldgraph.js";
const node = (id: number, kind: string, state: string, coldSince: number | null = 1): ColdNode => ({ id, kind, state, coldSince });
describe("cold graph structural invariants", () => {
  it("keeps live intent ancestry and fresh children hot, never folds goals/findings", () => {
    const nodes = [node(1,"fact","confirmed"),node(2,"intent","paused"),node(3,"fact","confirmed"),node(4,"goal","open"),node(5,"finding","confirmed")];
    expect([...coldBlocks(nodes, [{ from:1,to:2 },{ from:2,to:3 }], 10).cold]).toEqual([]);
  });
  it("folds cold connected blocks only after six rounds and rescues sibling singletons", () => {
    const nodes = [node(1,"goal","open"),node(2,"intent","done"),node(3,"fact","confirmed"),node(4,"intent","done"),node(5,"intent","blocked")];
    const edges = [{from:2,to:3},{from:1,to:4},{from:1,to:5}];
    expect(coldBlocks(nodes, edges, 6).blocks).toEqual([]);
    expect(coldBlocks(nodes, edges, 7).blocks).toEqual([[2,3],[4,5]]);
    nodes[1]!.state = "open";
    expect(coldBlocks(nodes, edges, 8).blocks).toEqual([[4,5]]);
  });
  it("handles cyclic graphs without recursion", () => {
    expect(coldBlocks([node(1,"fact","confirmed"),node(2,"intent","running")], [{from:1,to:2},{from:2,to:1}], 10).cold.size).toBe(0);
  });
});
