import { describe, expect, it } from "vite-plus/test";

import { kinLinkPlace, type KinLinkRoute } from "./kinLinkStack";

const route = (name: string, key?: string): KinLinkRoute => {
  const param = { KinWorkItem: "task", KinClient: "party", KinProject: "project", KinDoc: "doc" }[
    name
  ];
  return param === undefined || key === undefined ? { name } : { name, params: { [param]: key } };
};
const label = (one: KinLinkRoute) => {
  const key = Object.values(one.params ?? {})[0];
  return key === undefined ? one.name : `${one.name}:${String(key)}`;
};
const opened = (routes: ReadonlyArray<KinLinkRoute>, next: KinLinkRoute) => {
  const place = kinLinkPlace(routes, next);
  return [...routes.slice(0, place.keep), next].map(label);
};

describe("kinLinkPlace", () => {
  it("opens a record over the page it was followed from, so Back retraces each step", () => {
    expect(opened([route("Home")], route("KinClient", "C-1"))).toEqual(["Home", "KinClient:C-1"]);
    // Search result, then its project, then a doc: Back goes doc, project, task, Tasks.
    expect(
      opened(
        [route("Home"), route("KinWorkItem", "W-13"), route("KinProject", "P-1")],
        route("KinDoc", "D-2"),
      ),
    ).toEqual(["Home", "KinWorkItem:W-13", "KinProject:P-1", "KinDoc:D-2"]);
    // Task to linked task: the first task stays under it.
    expect(
      opened([route("Home"), route("KinWorkItem", "W-1")], route("KinWorkItem", "W-2")),
    ).toEqual(["Home", "KinWorkItem:W-1", "KinWorkItem:W-2"]);
  });

  it("goes back to a page already open instead of stacking it twice", () => {
    const routes = [
      route("Home"),
      route("KinProject", "P-1"),
      route("KinWorkItem", "W-8"),
      route("KinDoc", "D-2"),
    ];
    expect(kinLinkPlace(routes, route("KinProject", "P-1"))).toEqual({ keep: 1, again: true });
    expect(opened(routes, route("KinWorkItem", "W-8"))).toEqual([
      "Home",
      "KinProject:P-1",
      "KinWorkItem:W-8",
    ]);
  });

  it("takes the place of a search or concern sheet", () => {
    expect(opened([route("Home"), route("KinSearch")], route("KinDoc", "D-1"))).toEqual([
      "Home",
      "KinDoc:D-1",
    ]);
    expect(opened([route("Home"), route("KinDealsConcern")], { name: "KinDeal" })).toEqual([
      "Home",
      "KinDeal",
    ]);
  });
});
