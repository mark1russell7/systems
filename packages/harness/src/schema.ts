// The entry "@mark1russell7/harness/schema": the zod schemas of the data that a caller gives the
// harness as JSON. These are the source of an image, a client and a subject. The root entry of
// the package does not import zod.
import { z } from "zod";
import type { Client, ClientImage, ImageSource, Subject } from "./cell.ts";
import { CLIENT_NAMES, SHIPPED_NAMES, imageProblems, subjectProblems } from "./image.ts";

/** This function adds each problem that a check finds as an issue of a schema. */
const issues =
  <T>(check: (value: T) => string[]) =>
  (value: T, ctx: z.RefinementCtx): void => {
    for (const message of check(value)) ctx.addIssue({ code: "custom", message });
  };

/** This schema accepts a command: argv of one text or more. */
const command = z.array(z.string().min(1)).min(1);

/** This schema accepts the shape of each kind of image source. The checks of its values come after it. */
const sourceShape = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("pinned"), image: z.string() }),
  z.strictObject({
    kind: z.literal("build"),
    name: z.string(),
    context: z.string(),
    dockerfile: z.string().optional(),
    files: z.array(z.string()).optional(),
  }),
  z.strictObject({ kind: z.literal("shipped"), name: z.enum(SHIPPED_NAMES) }),
]);

/**
 * This schema accepts the source of an image (`ImageSource`). It is a pinned image with its digest,
 * a build context whose paths stay in it, or an image that the harness ships.
 */
export const imageSourceSchema: z.ZodType<ImageSource> = sourceShape.superRefine(issues(imageProblems));

/** This schema accepts a client image (`ClientImage`): a stock image by its name or the source of an image, and its command. */
export const clientImageSchema: z.ZodType<ClientImage> = z.strictObject({
  image: z.union([z.string().min(1), imageSourceSchema]),
  command,
});

/** This schema accepts the client of a cell (`Cell.client`): a client that the harness ships by its name, or a client image. */
export const clientSchema: z.ZodType<Client | ClientImage> = z.union([z.enum(CLIENT_NAMES), clientImageSchema]);

/**
 * This schema accepts a subject (`Subject`): its name, the source of its image and its stock base.
 * It also accepts the command of each of its programs.
 */
export const subjectSchema: z.ZodType<Subject> = z
  .strictObject({
    name: z.string().min(1),
    image: sourceShape,
    base: z.string(),
    programs: z.record(z.string(), command),
  })
  .superRefine(issues(subjectProblems));
