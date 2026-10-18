# Instructions for Claude

## What this repository is

This repository is the home of the systems program. It holds the site, at `mark1russell7.github.io/systems`. It also holds the packages that the program publishes to npm, under the scope `@mark1russell7`. The other code of the program is in jarvis, and it moves here one package at a time.

- The site copies a part of jarvis only to show it. Each copy has tests that hold it to the figures of jarvis.
- A package moves here with its code unchanged. Only its comments change, to STE. Its jarvis tests then use the npm release.
- CI publishes each release (`.github/workflows/release.yml`). To release, change the version of a package and push to main.
- npm trusts CI only for a package that exists. Thus Mark publishes the first version of a new package by hand.
- Push and deploy this repository without a question to Mark. Mark gave this permission on 2026-10-08.
- Do not publish a file that names a machine, a user, a path of the machine or an employer.

## The roadmap

- `docs/ROADMAP.md` is the source of truth for the work of the program.
- The live tracker shows the same items (collection `items`). It is the folder `artifacts/systems-roadmap` of the private fleet repository. Its `artifact.json` gives the URL of the tracker for each Claude account.
- Change the file and the tracker together. Keep the tracker current as each item starts, ships or changes.

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

- After a change to prose, start `pnpm lint:ste` and correct each finding. CI fails when there is an error.
- Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
- Do not use the modal verbs (`should`, `may`, `might`, `would`), semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`).
- Use the active voice. Start each sentence of a doc comment with its subject: "This function returns the value", not "Returns the value".
- Put code, file names and commands in code font. The linter counts each code span as one word.
- Add a word to the glossary in `ste.config.json` only if it is a real technical term of the project.
