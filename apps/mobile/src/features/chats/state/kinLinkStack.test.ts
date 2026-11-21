import { describe, expect, it } from "vite-plus/test";

import { kinLinkKeeps } from "./kinLinkStack";

const opened = (routes: ReadonlyArray<string>, name: string) => [
  ...routes.slice(0, kinLinkKeeps(routes, name)),
  name,
];

describe("kinLinkKeeps", () => {
  it("opens a record from a list over the list", () => {
    expect(opened(["Home"], "KinClient")).toEqual(["Home", "KinClient"]);
    expect(opened(["Home", "KinList"], "KinWorkItem")).toEqual(["Home", "KinList", "KinWorkItem"]);
  });

  it("closes a sheet back to the record page it was opened on", () => {
    expect(opened(["Home", "KinClient"], "KinWorkItem")).toEqual([
      "Home",
      "KinClient",
      "KinWorkItem",
    ]);
    // Task to linked task: the sheet is replaced, the page under it stays.
    expect(opened(["Home", "KinProject", "KinWorkItem"], "KinWorkItem")).toEqual([
      "Home",
      "KinProject",
      "KinWorkItem",
    ]);
  });

  it("replaces every record above the list when a link opens another page", () => {
    // Task to client to project, and across a sheet and a page: Back returns to the list.
    expect(opened(["Home", "KinClient", "KinWorkItem"], "KinProject")).toEqual([
      "Home",
      "KinProject",
    ]);
    expect(opened(["Home", "KinList", "KinWorkItem"], "KinClient")).toEqual([
      "Home",
      "KinList",
      "KinClient",
    ]);
    expect(opened(["Home", "KinDoc"], "KinClient")).toEqual(["Home", "KinClient"]);
    // What search found takes the search sheet's place.
    expect(opened(["Home", "KinSearch"], "KinDoc")).toEqual(["Home", "KinDoc"]);
    // As does a deal opened from the deals one concern was raised on.
    expect(opened(["Home", "KinDealsConcern"], "KinDeal")).toEqual(["Home", "KinDeal"]);
  });
});
