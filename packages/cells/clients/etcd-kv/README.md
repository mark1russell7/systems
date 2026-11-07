# The client etcd-kv

This program is the client of the read cells of etcd (SYS-75). It is clientv3 of etcd v3.6.15. It writes a history that the [checker of linearizability](../../checkers/linearizability/README.md) reads.

```sh
etcd-kv http://e1:2379,http://e2:2379,http://e3:2379 --prefix r0-0- --reads serializable
```

## What it does

- Each worker has its own client with one endpoint. Worker `i` talks to member `i` of the list, modulo its length. Thus a fault on one member always meets the workers of that member.
- Each worker puts a unique value (`<worker>-<seq>`) or gets a key, with equal odds. The keys are `k0` to `k<n-1>`, under the prefix of the run.
- `--reads linearizable` gives a get with the ReadIndex of etcd. `--reads serializable` gives a get from the local store of the member, with no ReadIndex.
- A TERM or the end of the run cancels each operation in flight. Thus the line of each operation comes before `done`.

## The options

| Option | Default | Value |
| --- | --- | --- |
| first argument | none | The endpoints, with a comma between them |
| `--prefix` | none | The prefix of each key of the run |
| `--clients` | 6 | The count of workers |
| `--keys` | 8 | The count of keys |
| `--interval-ms` | 20 | The wait after each operation |
| `--max-s` | 120 | The longest run |
| `--reads` | `linearizable` | `linearizable` or `serializable` |
| `--timeout-ms` | 1000 | The deadline of each operation |
| `--seed` | 1 | The seed of the choices of the workers |

## The lines

Each line is one JSON object with `ev` and `t`, the time on CLOCK_MONOTONIC in nanoseconds.

| `ev` | Fields |
| --- | --- |
| `start` | `versions` (Go and each module of etcd and gRPC in the build), and the options |
| `clocks` | `real`: the wall clock in milliseconds, each second |
| `op` | `worker`, `at` (the endpoint), `client`, `op`, `key`, `value`, `call`, `return`, `result`, and `error` on a failure |
| `ready` | After the first operation with a response |
| `done` | At the end |
| `fail` | A bad option (exit 2) or a client that does not start (exit 1), with `why` |

- A put with no response has `result` `unknown` and no `return`. It can take effect after its call. The worker then takes a new client number, as a process of Jepsen does after an indeterminate operation.
- A get with an error has `result` `fail`. A read has no effect.
- A get of a key with no value has `value` `null`.

## The image

The Dockerfile in this folder builds the commander of the cells. Its context is the cells package. It holds `etcd-kv`, `linearizability` and `etcdctl`. The build fails on a source that `gofmt` or `go vet` refuses.
