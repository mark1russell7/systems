# Instructions for Claude

## What this repository is

This repository is the home of the systems program. At this time, its code lives in jarvis (`~/jarvis`). This repository holds the site, at `mark1russell7.github.io/systems`. The code moves here after the first system, Redis, is complete.

- The site copies a part of jarvis only to show it. Each copy has tests that hold it to the figures of jarvis.
- Push and deploy this repository without a question to Mark. Mark gave this permission on 2026-10-08.
- Do not publish a file that names a machine, a user, a path of the machine or an employer.

## Writing style

Write all prose of this repository in the style of ASD-STE100 Simplified Technical English (STE). This prose is the README files, this file, the TSDoc comments and the text that the site shows. The linter [`ste-lint`](https://github.com/mark1russell7/ste-lint) examines it.

- After a change to prose, start `pnpm lint:ste` and correct each finding. CI fails when there is an error.
- Keep each instruction to 20 words or fewer, and each description to 25 words or fewer.
- Do not use the modal verbs (`should`, `may`, `might`, `would`), semicolons or Latin abbreviations (`e.g.`, `i.e.`, `etc.`).
- Use the active voice. Start each sentence of a doc comment with its subject: "This function returns the value", not "Returns the value".
- Put code, file names and commands in code font. The linter counts each code span as one word.
- Add a word to the glossary in `ste.config.json` only if it is a real technical term of the project.
