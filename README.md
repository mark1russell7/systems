# systems

This repository is the home of the systems program. The program asks one question first: when a client holds a connection and its peer goes silent, when does the client know?

The site is at [mark1russell7.github.io/systems](https://mark1russell7.github.io/systems/). It has the thesis, a lab that computes the first detector for your settings, and the results of the harness.

## Where the code lives

At this time, the code of the program lives in [jarvis](https://github.com/mark1russell7/jarvis): the corpus, the algebra, the harness, the prober and the service abstraction. The code moves here after the first system, Redis, is complete. Until then, the site holds copies of the parts that it shows, and tests hold each copy to the figures of jarvis.

## Packages

| Package | Function |
| --- | --- |
| `packages/site` | The site: Astro and Starlight, with React islands for the labs and the charts |
| `packages/cli` | The generator of the repository: `pnpm package add <name>` |

## Commands

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm lint:ste
pnpm --filter @systems/site dev
```

## Writing style

All prose of this repository follows ASD-STE100 Simplified Technical English. The linter `ste-lint` examines it in CI.

## Disclosure

An AI model (Claude, from Anthropic) wrote most of the text and the code of this repository, under the direction of the author. The tests and the STE linter examine them.
