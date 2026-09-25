# plugin runtime

Internal Effect service that composes T3 product plugins. Design constraints live in
[docs/internals/plugins.md](../../docs/internals/plugins.md).

Provide `PluginRuntime` through `layer()`; the composing scope owns shutdown. `reconcile(definitions)`
activates changed plugins and their dependents, publishes their contributions atomically, and keeps
the previous composition live if any activation fails.

## Contributions

Plugins register detached, deeply frozen, JSON-compatible metadata and an optional host-only live
value. Snapshots and `contributions(slot)` expose only the metadata; executable values never cross
the RPC boundary. Contribution ids are unique per slot, and a duplicate fails the reconcile.

`contributions(slot)` returns the committed generation with its entries. Pass that generation to
`useContribution(...)`; a stale generation fails instead of invoking a handler from another
composition. Invocations do not wait for reconcile or for each other, so a handler can still be
running after its plugin retires.
