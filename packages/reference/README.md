# @systems/reference

The reference service is the subject of the cells of SYS-93. It is a small service of documents
for many tenants. It operates on the parts that the program measures:

- one service of `@mark1russell7/service`, with its profile, its probes and its lifecycle.
- the procedure host of `@procedures/peer`, with HTTP and WebSocket on one listener.
- the Mongo client of `@mark1russell7/service/mongodb`, on a replica set.

## The procedures

| Procedure | Input | Output | Effects |
| --- | --- | --- | --- |
| `doc.put` | `{ id, body }` | `{ version }` | It writes `docs` and publishes `doc.<tenant>`. It is not idempotent. |
| `doc.get` | `{ id }` | `{ doc }`, or `{ doc: null }` | It reads `docs`. It is idempotent. |
| `doc.list` | `{ after, limit }` | `{ docs }`, in the order of their ids | It reads `docs`. It is idempotent. |

The tenant of a call comes from its token, not from its input. A call with no token, or with a
token that the service does not know, gets `UNAUTHORIZED`. A WebSocket client subscribes only to
the topic `doc.<tenant>` of its own tenant. Another topic gives `FORBIDDEN`.

## The settings

`src/main.ts` reads these variables of the environment:

| Variable | Meaning | Default |
| --- | --- | --- |
| `PORT`, `HOST` | The listener of HTTP and WebSocket. | `8080`, `0.0.0.0` |
| `TENANTS` | The path of a JSON file that maps each token to its tenant. | None: the start fails. |
| `MONGO_HOST`, `MONGO_PORT` | The seed of the replica set. Without `MONGO_HOST`, the documents stay in memory. | None, `27017` |
| `MONGO_REPLICA_SET`, `MONGO_DATABASE` | The name of the replica set and of the database. | None, `reference` |

## The store

Each document is one record of the collection `docs`, with the key `<tenant>/<id>`. A put is one
`findAndModify` with an upsert, which adds 1 to the version. A list reads the keys between
`<tenant>/<after>` and `<tenant>0`, in the order of the keys. A command that does not give `ok`
gives a `StoreError` with its outcome. The outcome `indeterminate` tells that a put can be in the store or not.

## The tests

`pnpm test` starts the service on a free port of `127.0.0.1`, with the store in memory. The tests
examine the data and the events of two tenants, and the refusals. A fake client examines the
commands of the Mongo store. The cells examine the service on a real replica set.
