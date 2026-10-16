# systems

This repository is the home of the systems program. The program asks one question first: when a client holds a connection and its peer goes silent, when does the client know?

The site is at [mark1russell7.github.io/systems](https://mark1russell7.github.io/systems/). It has the thesis, a lab that computes the first detector for your settings, and the results of the harness.

## Where the code lives

The engines of the program are packages in this repository, and each package goes to npm under `@mark1russell7`. The corpus stays in jarvis, because it is a part of a larger graph. The site holds a copy of the results that it shows, and tests hold each copy to its figures.

## Packages

| Package | Function |
| --- | --- |
| `packages/quantity` | [`@mark1russell7/quantity`](https://www.npmjs.com/package/@mark1russell7/quantity): amounts in typed units, with exact arithmetic |
| `packages/algebra` | [`@mark1russell7/algebra`](https://www.npmjs.com/package/@mark1russell7/algebra): state machines as data, and the timer algebra over them: detection and recovery |
| `packages/service` | [`@mark1russell7/service`](https://www.npmjs.com/package/@mark1russell7/service): a service declared as data, and the timer-ordering law on that declaration |
| `packages/prober` | [`@mark1russell7/prober`](https://www.npmjs.com/package/@mark1russell7/prober): an eBPF prober that records what the kernel did to each TCP socket |
| `packages/harness` | [`@mark1russell7/harness`](https://www.npmjs.com/package/@mark1russell7/harness): a fault-injection harness that measures connection timers in Docker |
| `packages/kind` | [`@mark1russell7/kind`](https://www.npmjs.com/package/@mark1russell7/kind): Kubernetes in Docker as a lab for connection timers, and a judge of its raw records |
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

## Releases

CI publishes the packages to npm (`.github/workflows/release.yml`). To release a package, change its version in its `package.json` and push to main. The workflow does the gates of CI, packs each package, and tests each tarball in an empty project. Then it publishes each version that npm does not have. The trust of npm comes from OpenID Connect, thus the workflow uses no npm token, and each version gets a provenance statement.

npm trusts a workflow only for a package that exists. Thus the first version of a new package goes out by hand, and then the workflow becomes its trusted publisher.

## Writing style

All prose of this repository follows ASD-STE100 Simplified Technical English. The linter `ste-lint` examines it in CI.

## Disclosure

An AI model (Claude, from Anthropic) wrote most of the text and the code of this repository, under the direction of the author. The tests and the STE linter examine them.
