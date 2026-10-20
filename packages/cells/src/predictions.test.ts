import { describe, expect, it } from "vitest";
import { ALL } from "./all.ts";
import { HZ } from "./catalog.ts";
import { T07_GRPC } from "./grpc/t07.ts";
import { HTTP_CAL, HTTP_CELLS } from "./http/catalog.ts";
import { T01_MONGO } from "./mongo/t01.ts";
import { T03_MONGO } from "./mongo/t03.ts";
import { T11_MONGO } from "./mongo/t11.ts";
import { T07_CELLS } from "./t07.ts";
import { T18_CELLS } from "./t18.ts";

/** each catalog that predicts its cells: the harness cells of each topology, the HTTP cells, the MongoDB cells and the kind cells */
const CATALOGS: Readonly<Record<string, ReadonlyArray<{ readonly name: string; readonly prediction: unknown }>>> = {
  ALL,
  HTTP_CELLS,
  HTTP_CAL,
  T01_MONGO,
  T03_MONGO,
  T11_MONGO,
  T07_CELLS,
  T18_CELLS,
  T07_GRPC,
};

/** one line for each cell, its catalog and name, then its prediction: a change of one prediction is a change of one line */
const text = (): string => {
  const lines = Object.entries(CATALOGS).flatMap(([catalog, cells]) =>
    cells.map((cell) => `${JSON.stringify(`${catalog}: ${cell.name}`)}: ${JSON.stringify(cell.prediction)}`),
  );
  return `{\n${lines.join(",\n")}\n}\n`;
};

describe("the predictions of the catalogs", () => {
  // the snapshot holds the predictions at HZ 250, the default of CELLS_HZ. A change to a machine
  // document, a model or a catalog that moves a prediction shows here, one line for each cell
  it.skipIf(HZ !== 250)("are the predictions of the snapshot, each cell on its own line", async () => {
    await expect(text()).toMatchFileSnapshot("__snapshots__/predictions.json");
  });
});
