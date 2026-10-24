import type { Subject } from "@mark1russell7/harness";

/**
 * This commit is the commit of github.com/mark1russell7/client whose procedures subject the WS and
 * WST cells run (CLI-33). It is `@procedures/client` 0.22.0 and two PATCHes after it. The workflow
 * cells.yml checks the repository out at this commit. The machine documents of `procedures-ws` cite
 * its source.
 */
export const CLIENT_REF = "2408cea460d84dc7577b69c4ae68a559f2dc2bdd";

/**
 * This subject is the procedures subject of the client repository: its file
 * `harness/procedures-subject/subject.json` at `CLIENT_REF`. The client repository owns the image,
 * thus the cells examine the client of that commit. The context of the build is a checkout of
 * that repository: the folder `CELLS_CLIENT`, or `client` in the working folder of the process.
 *
 * The workflow gives the subject of its own checkout as `CELLS_SUBJECT`, which replaces this one. Thus
 * this copy gives the catalogs their names, their commands and their predictions.
 */
export const PROCEDURES: Subject = {
  name: "procedures",
  image: {
    kind: "build",
    name: "procedures-subject",
    context: process.env["CELLS_CLIENT"] ?? "client",
    dockerfile: "harness/procedures-subject/Dockerfile",
    files: ["package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "patches", "packages/client", "harness/procedures-subject"],
  },
  base: "node:24.21.0-alpine@sha256:ebfe2f90462722a7a4de65e91990e97fe0d401c70e0e762c5b53302f905ec1c1",
  programs: {
    client: ["node", "/opt/subject/client-ws.mjs"],
    server: ["node", "/opt/subject/server-ws.mjs"],
  },
};
