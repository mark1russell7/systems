import type { BuildRecord } from "./image.ts";
import { PINNED } from "./image.ts";
import type { Manifest } from "./lab.ts";

/**
 * This module tells if a manifest pins each program that a run operated. A record that does not pin
 * them is not a record. A later run cannot operate the same programs, thus nobody can reproduce
 * its numbers (SYS-101). Each image is pulled by its digest, or the harness builds it. A build
 * records its bases by digest, the sha256 of each lockfile, and the versions of the packages that
 * its manifests name. The commit of the code that operated is a field of the record of a cell, and
 * `commitProblems` examines it.
 */

/** This pattern matches the id of an image: `sha256:` and 64 hex digits. */
const IMAGE_ID = /^sha256:[0-9a-f]{64}$/;
/** This pattern matches the tag of a build of the harness: its name, then 12 hex digits of the sha256 of its context. */
const BUILD_TAG = /^[a-z0-9][a-z0-9._\-/]*:[0-9a-f]{12}$/;
/** This pattern matches a commit of git: 40 hex digits. */
const COMMIT = /^[0-9a-f]{40}$/;

/** This function gives each problem of the record of a build. A problem is a base that no digest pins, or a tag of another form. */
const buildProblems = (what: string, build: BuildRecord): string[] => [
  ...(BUILD_TAG.test(build.tag) ? [] : [`${what}: the build has the tag ${build.tag}, which is not a tag of a build`]),
  ...build.bases.filter((base) => !PINNED.test(base)).map((base) => `${what}: the base ${base} is not pinned by digest`),
];

/**
 * This function gives each problem of an image of a manifest. A pulled image needs a digest. An
 * image that the harness builds needs its build record when the manifest can hold one (`build`).
 * Otherwise, it needs the tag of a build and the id of its image.
 */
const pinProblems = (what: string, image: string, id: string | undefined, build: BuildRecord | undefined, needsBuild: boolean): string[] => {
  if (PINNED.test(image)) return [];
  if (build !== undefined) return buildProblems(what, build);
  if (BUILD_TAG.test(image) && !needsBuild && id !== undefined && IMAGE_ID.test(id)) return [];
  return BUILD_TAG.test(image) && needsBuild
    ? [`${what}: the image ${image} is a build with no build record`]
    : [`${what}: the image ${image} has no digest`];
};

/**
 * This function gives each problem of a manifest that stops it from pinning the programs of its
 * run. An empty list means that the manifest pins each program.
 * - the target: an image by its digest, or the build of a subject with its build record and its base
 *   by digest.
 * - the harness: the version of its package, and the build record of its image.
 * - the client: an image by its digest, or a build with its build record.
 * - each hop: an image by its digest, or the tag of a build and the id of its image.
 */
export const manifestProblems = (manifest: Manifest): string[] => [
  ...pinProblems("the target", manifest.target.image, manifest.target.id, manifest.target.build, manifest.target.subject !== undefined),
  ...(manifest.target.subject !== undefined && (manifest.target.base === undefined || !PINNED.test(manifest.target.base))
    ? [`the target: the base ${manifest.target.base ?? "(none)"} of its subject is not pinned by digest`]
    : []),
  ...(manifest.harness.version === undefined ? ["the harness: the manifest has no version of the harness"] : []),
  ...(manifest.harness.build === undefined ? ["the harness: the image has no build record"] : buildProblems("the harness", manifest.harness.build)),
  ...pinProblems("the client", manifest.client.image, undefined, manifest.client.build, true),
  ...(manifest.hops ?? []).flatMap((hop) => pinProblems(`the hop ${hop.name}`, hop.image, hop.id, undefined, false)),
];

/** This function gives the problem of the commit of a record: no commit, or a text that is not a commit of git. */
export const commitProblems = (commit: string | undefined): string[] =>
  commit === undefined
    ? ["the record has no commit of the code that operated"]
    : COMMIT.test(commit)
      ? []
      : [`the record has the commit ${commit}, which is not 40 hex digits`];

/** The code of a record is the commit of the checkout that operated, and if its tracked files had changes. */
export interface RecordCode {
  readonly commit: string;
  readonly dirty: boolean;
}

/** These are the parts of a record that tell if it pins the programs of its runs. */
export interface Pinnable {
  readonly code?: RecordCode | undefined;
  readonly manifests: readonly Manifest[];
  /** A local debug run marks its record so. No page reads such a record. */
  readonly debug?: boolean | undefined;
}

/** This problem is the problem of a checkout with changes: its commit does not hold the code that operated. */
export const DIRTY = "the checkout has changes to tracked files that no commit holds";

/** This problem is the problem of a record of a local debug run. */
export const DEBUG = "the record is of a local debug run, and no page reads it";

/**
 * This function gives each problem that stops a record from pinning the programs of its runs. A
 * record with a problem is not a record (SYS-101). The writer of the cells refuses it, and the read
 * of a schedule refuses it. A commit with changes to tracked files is not a pin.
 */
export const recordProblems = (record: Pinnable): string[] => [
  ...new Set([
    ...commitProblems(record.code?.commit),
    ...(record.code?.dirty === true ? [DIRTY] : []),
    ...record.manifests.flatMap((manifest) => manifestProblems(manifest)),
    ...(record.debug === true ? [DEBUG] : []),
  ]),
];
