// The types whose values service knows by identity (CLI-117). Service keeps state for some objects
// in module-level `WeakMap`s: the late holds of the drains and the outside counts by lifecycle, the
// owner of each request stream (`drains.ts`), and the mark of each HTTP answer (`http/answers.ts`).
// Each copy of service has its own maps. Thus a value that one copy makes and another copy reads
// loses that state with no error, for example a drain that does not wait for its late answers.

/**
 * The exported type names that hold or reach a value that service knows by identity. A package
 * whose public API takes or gives a value of one of these types has service as a peer dependency.
 * A plain dependency is not sufficient. Then the package and its caller use one copy of service.
 *
 * The roots are `Lifecycle` and `RequestStream`, the keys of the maps, and `TransportImpl` and
 * `RequestHandler`, whose values write to the maps of their own copy. The list is each exported type
 * that names a root, or names a type of the list, in its declaration. A type can be on the list
 * although its own use crosses copies safely: for that type, a peer is the safe choice.
 *
 * `identity.test.ts` calculates this list from the sources and from the maps, thus the list stays
 * current.
 */
export const IDENTITY_TYPES = [
  "Client",
  "GrpcClient",
  "HttpClient",
  "HttpTransport",
  "IterationContext",
  "JobContext",
  "Lifecycle",
  "MongoClient",
  "MountContext",
  "PgClient",
  "QueueDrain",
  "QueueDrainOptions",
  "RabbitClient",
  "RedisClient",
  "RedisSender",
  "RequestHandler",
  "RequestStream",
  "ServiceBuilder",
  "SubjectFactory",
  "TransportImpl",
  "TransportSubject",
  "UpgradeHandler",
  "WorkerLoop",
  "WorkerLoopOptions",
  "WsClient",
] as const;

/** A name of `IDENTITY_TYPES`. */
export type IdentityType = (typeof IDENTITY_TYPES)[number];
