// Writes fixtures/records.bin from fixture.ts: `pnpm --filter @mark1russell7/prober fixture`. A
// test compares the committed bytes with the output of the generator, so nobody edits the fixture
// by hand.
import { writeFileSync } from "node:fs";
import { fixture } from "./fixture.ts";

writeFileSync(new URL("../fixtures/records.bin", import.meta.url), fixture());
